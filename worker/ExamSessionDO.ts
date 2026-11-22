/**
 * @file ExamSessionDO.ts
 * @description Cloudflare Durable Object — one instance per exam session.
 *
 * Architecture role:
 *   The Worker (index.ts) receives an HTTP/WebSocket request for a specific
 *   sessionId, looks up (or creates) a Durable Object instance keyed by that
 *   sessionId, then forwards the request to this class via `stub.fetch()`.
 *
 *   This class is responsible for:
 *     1. Accepting the WebSocket connection from the React frontend.
 *     2. Receiving behavioral-event messages ({eventType: string}).
 *     3. Calling Workers AI (Llama 3.3-70B) to produce a risk score + explanation.
 *     4. Updating and persisting session state to Durable Object Storage.
 *     5. Broadcasting the AI result back to all connected WebSocket clients.
 *     6. (Phase 3a) Reporting session summaries and alerts to ExamHubDO.
 *     7. (Phase 3b) Handling professor commands: warn, pause, resume, force_submit.
 *        - Commands are persisted as Intervention records and survive reconnects.
 *        - While paused, behavioral events are recorded but do NOT change riskScore.
 *        - After force_submit, the session is terminated; further events are ignored.
 *
 * WebSocket API choice:
 *   We use `server.accept()` (non-hibernatable mode) together with `addEventListener`.
 *   The alternative — `state.acceptWebSocket()` — uses the Hibernatable WS API, which
 *   requires implementing `webSocketMessage()` / `webSocketClose()` as class methods
 *   and CANNOT be mixed with `addEventListener`. Mixing the two silently drops messages.
 *
 * State persistence:
 *   Session state (`riskScore`, `riskHistory`, `violations`) is stored in Durable Object
 *   Storage via `this.state.storage.put('session', …)` after every event. This means:
 *     • State survives DO evictions (the runtime may evict idle DOs to free memory).
 *     • Reconnecting clients receive the full history via the `session_snapshot` message.
 *
 * Workers AI:
 *   The AI binding is declared in wrangler.jsonc as `"ai": { "binding": "AI" }`.
 *   We call `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via `this.env.AI.run(...)`.
 *   A 20-second timeout is applied so the fallback always fires if the model is slow.
 */

import type {
  RiskEvent,
  Violation,
  ExamSessionState,
  BehavioralEventMsg,
  WSOutboundMsg,
  SessionSummary,
  HubAlert,
  HubInternalUpdate,
  ThumbnailPayload,
  Intervention,
  InterventionAction,
} from './types.js';
import { doSubmit } from './api/student.js';
import { verifyInternalAuth, forbiddenResponse, jsonNotFound } from './utils/internalAuth.js';

// ─── Module-level helpers ────────────────────────────────────────────────────

/** Returns a short random ID (8 hex chars) for violation/intervention records. */
function uid(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Naive risk delta applied before the AI refines the score.
 * These values provide instant feedback while the AI call is in-flight.
 */
const RISK_DELTAS: Record<string, number> = {
  tab_switch:           15,
  face_not_detected:    20, // legacy
  no_face:              20,
  multiple_faces:       25,
  orientation_away:     15,
  identity_mismatch:    40,
  normal:               -5,
  clipboard_activity:   18,
  fullscreen_exit:      15,
};

/** Maps each event type to the corresponding Violation category. */
const VIOLATION_TYPE_MAP: Record<string, Violation['type']> = {
  tab_switch:          'behavioral',
  face_not_detected:   'vision', // legacy
  no_face:             'vision',
  multiple_faces:      'vision',
  orientation_away:    'vision',
  identity_mismatch:   'vision',
  normal:              'system',
  clipboard_activity:  'behavioral',
  fullscreen_exit:     'behavioral',
};

/**
 * Converts a numeric risk score to a human-readable severity level.
 *
 * @param score - Risk score in the range [0, 100]
 * @returns 'critical' | 'high' | 'medium' | 'low'
 */
function scoreSeverity(score: number): Violation['severity'] {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

/**
 * Races `promise` against a timeout.
 * Throws a TimeoutError if the timeout fires first.
 *
 * @param promise - The async operation to race.
 * @param ms      - Timeout in milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ─── Session status type ─────────────────────────────────────────────────────

type SessionStatus = 'active' | 'paused' | 'terminated' | 'submitted';

// ─── Durable Object class ────────────────────────────────────────────────────

export class ExamSessionDO implements DurableObject {
  /** Durable Object state — provides access to storage and WebSocket helpers. */
  private state: DurableObjectState;

  /** Environment bindings declared in wrangler.jsonc (AI, EXAM_SESSION). */
  private env: Env;

  /**
   * In-memory session cache.
   * Populated from Durable Object Storage on each `fetch()` call via `initialize()`.
   * Written back to storage after every behavioral event.
   */
  public session: ExamSessionState = {
    sessionId: '',
    riskScore: 0,
    riskHistory: [],
    violations: [],
  };

  /** Set of all currently open WebSocket connections to this DO instance. */
  private sockets: Set<WebSocket> = new Set();

  /** Phase 3a: examId and studentName read from connection query params. */
  private examId = 'exam-1';
  private studentName = '';
  private startedAt = new Date().toISOString();

  /** Phase 3a: latest webcam thumbnail (tiny, forwarded from student). */
  private latestThumbnail: string | undefined;

  // ── Phase 3b: intervention tracking ────────────────────────────────────────

  /** Persisted session status (active | paused | terminated | submitted). */
  private sessionStatus: SessionStatus = 'active';

  /** Ordered list of all interventions issued against this session. */
  private interventions: Intervention[] = [];

  /** Queue of commands issued while the student was disconnected. */
  private pendingCommands: Intervention[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // ─── State restoration ───────────────────────────────────────────────────

  /**
   * Restores session state from Durable Object Storage.
   * Called at the start of every `fetch()` to handle DO wake-ups (evictions).
   * Safe to call multiple times — subsequent calls are effectively no-ops once
   * the in-memory state has been hydrated.
   *
   * @param sessionId - The exam session identifier from the URL query param.
   */
  private async initialize(sessionId: string): Promise<void> {
    // Only initialize if session is empty (i.e., first call after construction or eviction)
    if (this.session.sessionId) return;

    const [stored, storedStatus, storedInterventions, storedPending] = await Promise.all([
      this.state.storage.get<ExamSessionState>('session'),
      this.state.storage.get<SessionStatus>('sessionStatus'),
      this.state.storage.get<Intervention[]>('interventions'),
      this.state.storage.get<Intervention[]>('pendingCommands'),
    ]);

    if (stored) {
      this.session = stored;
    } else {
      this.session = {
        sessionId,
        riskScore: 0,
        riskHistory: [],
        violations: [],
      };
    }

    if (storedStatus) this.sessionStatus = storedStatus;
    if (storedInterventions) this.interventions = storedInterventions;
    if (storedPending) this.pendingCommands = storedPending;
  }

  // ─── Durable Object fetch handler ────────────────────────────────────────

  /**
   * Entry point for all requests forwarded from the Worker (index.ts).
   *
   * Handles:
   *   • WebSocket upgrade requests → student WebSocket connection.
   *   • GET /history              → returns full riskHistory (for professor detail view).
   *   • POST /command             → professor intervention command (from ExamHubDO).
   *   • All other requests        → returns 426 Upgrade Required.
   *
   * @param request - The forwarded HTTP request from the Worker.
   * @returns A 101 Switching Protocols response with the client-side WebSocket,
   *          or a 426 error response.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId') ?? 'unknown';
    const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    // ── WebSocket route (Student Exam Session) ───────────────────────────────
    if (isWs) {
      // 4. NO STATE FOR UNKNOWN SESSIONS: check D1 before creating or writing any state
      if (this.env.DB && sessionId && sessionId !== 'unknown') {
        const attempt = await this.env.DB.prepare('SELECT id, exam_id, student_name FROM attempts WHERE session_id = ?')
          .bind(sessionId)
          .first<{ id: string; exam_id: string; student_name: string | null }>();
        if (!attempt) {
          return jsonNotFound();
        }
        if (attempt.exam_id) this.examId = attempt.exam_id;
        if (attempt.student_name) this.studentName = attempt.student_name;
      }

      await this.initialize(sessionId);

      // Phase 3a: read examId and studentName from verified query params
      if (url.searchParams.get('examId')) {
        this.examId = url.searchParams.get('examId')!;
      }
      const rawName = url.searchParams.get('studentName') || url.searchParams.get('name');
      if (rawName) {
        this.studentName = rawName;
      }
      if (!this.studentName) {
        this.studentName = `Student-${sessionId.slice(0, 6)}`;
      }

      // Create a WebSocket pair: client is returned to the browser,
      // server stays inside this DO and receives all incoming messages.
      const { 0: client, 1: server } = new WebSocketPair();

      // One live student connection per session: close any previous connection
      for (const existingSocket of this.sockets) {
        try {
          existingSocket.close(4001, 'This exam is open in another window');
        } catch {}
      }
      this.sockets.clear();

      // IMPORTANT: Use server.accept() (non-hibernatable mode) + addEventListener.
      // Do NOT use state.acceptWebSocket() here — that API uses the Hibernatable WS
      // protocol which requires webSocketMessage() class methods, not addEventListener.
      // Mixing the two APIs silently drops all incoming messages.
      server.accept();
      this.sockets.add(server);

      server.addEventListener('message', (evt) => {
        this.handleMessage(server, evt).catch((err) => {
          console.error('[ExamSessionDO] Unhandled error in handleMessage:', err);
          this.send(server, { type: 'error', message: String(err) });
        });
      });

      server.addEventListener('close', () => {
        this.sockets.delete(server);
        // Phase 3a: notify hub that student disconnected
        // Phase 3b: keep paused/terminated status even when disconnected
        const hubStatus = this.sessionStatus === 'terminated' ? 'terminated'
          : this.sessionStatus === 'submitted' ? 'submitted'
          : this.sessionStatus === 'paused' ? 'paused'
          : 'disconnected';
        this.reportToHub(undefined, hubStatus as SessionSummary['status']).catch(() => {});
      });

      server.addEventListener('error', (err) => {
        console.error('[ExamSessionDO] WebSocket error event:', err);
        this.sockets.delete(server);
      });

      // Send the full session snapshot to the newly connected client so it can
      // hydrate its React state without waiting for the first event.
      this.send(server, {
        type: 'session_snapshot',
        session: {
          ...this.session,
          sessionStatus: this.sessionStatus,
        },
      } satisfies WSOutboundMsg);

      // Phase 3b: If the session was already paused or terminated, re-push the command
      // so that client refreshes/reconnects immediately re-enter the paused or terminated screen.
      if (this.sessionStatus === 'paused') {
        const lastPause = [...this.interventions].reverse().find((i) => i.action === 'pause');
        this.send(server, {
          type: 'command',
          intervention: lastPause ?? {
            id: 'persisted-pause',
            action: 'pause',
            message: 'Your exam has been paused by the proctor.',
            issuedAt: new Date().toISOString(),
          },
        } satisfies WSOutboundMsg);
      } else if (this.sessionStatus === 'terminated') {
        const lastTerm = [...this.interventions].reverse().find((i) => i.action === 'force_submit');
        this.send(server, {
          type: 'command',
          intervention: lastTerm ?? {
            id: 'persisted-terminated',
            action: 'force_submit',
            message: 'Your exam has been ended by the proctor.',
            issuedAt: new Date().toISOString(),
          },
        } satisfies WSOutboundMsg);
      }

      // Phase 3b: deliver any pending commands that accumulated while student was offline
      if (this.pendingCommands.length > 0) {
        for (const intervention of this.pendingCommands) {
          this.send(server, { type: 'command', intervention } satisfies WSOutboundMsg);
        }
        // Commands delivered — clear queue
        this.pendingCommands = [];
        await this.state.storage.put('pendingCommands', []);
      }

      // Phase 3a: notify hub that a student connected
      const connectStatus = this.sessionStatus === 'paused' ? 'paused'
        : this.sessionStatus === 'terminated' ? 'terminated'
        : 'active';
      this.reportToHub(undefined, connectStatus as SessionSummary['status']).catch(() => {});

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Internal Non-WebSocket Handlers ─────────────────────────────────────
    // Defense-in-depth: every internal handler MUST carry X-Internal-Auth matching INTERNAL_SECRET
    if (!verifyInternalAuth(request, this.env as any)) {
      return forbiddenResponse();
    }

    await this.initialize(sessionId);

    // ── Phase 3a: GET /history endpoint ─────────────────────────────────────
    if (url.pathname.endsWith('/history') && request.method === 'GET') {
      return Response.json({
        sessionId: this.session.sessionId,
        riskScore: this.session.riskScore,
        riskHistory: this.session.riskHistory,
        violations: this.session.violations,
        sessionStatus: this.sessionStatus,
        interventions: this.interventions,
      });
    }

    // ── Phase 3b: POST /command endpoint (from ExamHubDO) ───────────────────
    if (url.pathname.endsWith('/command') && request.method === 'POST') {
      return this.handleCommand(request);
    }

    // ── Phase 4c-2b: POST /purge internal endpoint ──────────────────────────
    if (url.pathname.endsWith('/purge') && request.method === 'POST') {
      for (const ws of this.sockets) {
        try {
          ws.close(1000, 'Session purged');
        } catch {}
      }
      this.sockets.clear();
      await this.state.storage.deleteAll();
      this.session = {
        sessionId: this.session.sessionId,
        riskScore: 0,
        riskHistory: [],
        violations: [],
      };
      this.interventions = [];
      this.pendingCommands = [];
      this.latestThumbnail = undefined;
      return Response.json({ ok: true, purged: true });
    }

    // ── Phase 4c-2b: POST /end internal endpoint ────────────────────────────
    if (url.pathname.endsWith('/end') && request.method === 'POST') {
      let body: { endedReason?: 'submitted' | 'auto_submitted' | 'terminated'; message?: string } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {}
      const reason = body.endedReason || 'submitted';
      if (reason === 'submitted' || reason === 'auto_submitted') {
        this.sessionStatus = 'submitted';
      } else if (reason === 'terminated') {
        this.sessionStatus = 'terminated';
      }
      await this.state.storage.put('sessionStatus', this.sessionStatus);
      this.reportToHub(undefined, reason === 'terminated' ? 'terminated' : 'submitted').catch(() => {});
      if (body.message) {
        for (const ws of this.sockets) {
          try {
            this.send(ws, {
              type: 'command',
              intervention: {
                id: uid(),
                action: 'force_submit',
                message: body.message,
                issuedAt: new Date().toISOString(),
              },
            } satisfies WSOutboundMsg);
          } catch {}
        }
      }
      await this.syncToD1(reason);
      return Response.json({ ok: true, endedReason: reason });
    }

    return jsonNotFound();
  }

  // ─── Phase 3b: Command handler ───────────────────────────────────────────

  /**
   * Handles a professor command delivered via POST /command from ExamHubDO.
   * Persists the intervention, optionally changes session status,
   * and either pushes to connected student sockets or queues for delivery.
   */
  private async handleCommand(request: Request): Promise<Response> {
    const body = await request.json<{ action: InterventionAction; message?: string }>();
    const { action, message } = body;

    // Idempotency: pausing an already-paused session is a no-op
    if (action === 'pause' && this.sessionStatus === 'paused') {
      return Response.json({ ok: true, status: 'noop', message: 'Session is already paused.' });
    }
    if (action === 'resume' && this.sessionStatus !== 'paused') {
      return Response.json({ ok: true, status: 'noop', message: 'Session is not paused.' });
    }
    if (action === 'force_submit' && this.sessionStatus === 'terminated') {
      return Response.json({ ok: true, status: 'noop', message: 'Session already terminated.' });
    }

    // Build intervention record
    const intervention: Intervention = {
      id: uid(),
      action,
      message,
      issuedAt: new Date().toISOString(),
    };

    // Apply status change
    if (action === 'pause') {
      this.sessionStatus = 'paused';
    } else if (action === 'resume') {
      this.sessionStatus = 'active';
    } else if (action === 'force_submit') {
      this.sessionStatus = 'terminated';
    }

    // Store intervention
    this.interventions = [...this.interventions, intervention].slice(-50);

    // Persist status and interventions
    await Promise.all([
      this.state.storage.put('sessionStatus', this.sessionStatus),
      this.state.storage.put('interventions', this.interventions),
    ]);

    // Phase 4b: Update D1 attempt if present
    if (this.env.DB) {
      try {
        const nowIso = intervention.issuedAt;
        const attempt = await this.env.DB
          .prepare('SELECT * FROM attempts WHERE session_id = ?')
          .bind(this.session.sessionId)
          .first<Record<string, unknown>>();

        if (attempt && attempt.status === 'in_progress') {
          if (action === 'force_submit') {
            await doSubmit(this.env.DB, attempt, 'terminated');
            await this.syncToD1('terminated');
          } else if (action === 'pause') {
            if (!attempt.paused_at) {
              await this.env.DB
                .prepare('UPDATE attempts SET paused_at = ? WHERE id = ?')
                .bind(nowIso, attempt.id)
                .run();
            }
          } else if (action === 'resume') {
            if (attempt.paused_at) {
              const elapsedSec = Math.max(
                0,
                Math.floor((new Date(nowIso).getTime() - new Date(attempt.paused_at as string).getTime()) / 1000),
              );
              const newPausedSec = (attempt.paused_seconds as number) + elapsedSec;
              const oldDeadline = new Date(attempt.deadline_at as string).getTime();
              const newDeadline = new Date(oldDeadline + elapsedSec * 1000).toISOString();
              await this.env.DB
                .prepare(
                  `UPDATE attempts
                   SET paused_at = NULL, paused_seconds = ?, deadline_at = ?
                   WHERE id = ?`,
                )
                .bind(newPausedSec, newDeadline, attempt.id)
                .run();
            }
          }
        } else if (action === 'force_submit') {
          await this.syncToD1('terminated');
        }
      } catch (d1Err) {
        console.warn('[ExamSessionDO] Failed to sync attempt status to D1:', d1Err);
      }
    }

    // Determine delivery status
    const isConnected = this.sockets.size > 0;

    if (isConnected) {
      // Push command directly to all connected student sockets
      this.broadcast({ type: 'command', intervention } satisfies WSOutboundMsg);

      // Report status change to hub with intervention alert
      const hubStatus: SessionSummary['status'] =
        this.sessionStatus === 'terminated' ? 'terminated'
        : this.sessionStatus === 'paused' ? 'paused'
        : 'active';

      const alert: HubAlert = {
        sessionId: this.session.sessionId,
        studentName: this.studentName,
        eventType: `intervention_${action}`,
        severity: action === 'force_submit' ? 'critical' : action === 'pause' ? 'high' : 'medium',
        aiExplanation: message ?? this.defaultInterventionMessage(action),
        timestamp: intervention.issuedAt,
        kind: 'intervention',
      };

      this.reportToHub(alert, hubStatus).catch(() => {});

      return Response.json({ ok: true, status: 'delivered', interventionId: intervention.id });
    } else {
      // Student is offline — queue the command for delivery on reconnect
      // (Only warn can be safely queued; pause + force_submit must also queue since they persist)
      this.pendingCommands = [...this.pendingCommands, intervention].slice(-20);
      await this.state.storage.put('pendingCommands', this.pendingCommands);

      // Still report status to hub so grid shows paused/terminated even while offline
      const hubStatus: SessionSummary['status'] =
        this.sessionStatus === 'terminated' ? 'terminated'
        : this.sessionStatus === 'paused' ? 'paused'
        : 'disconnected';

      const alert: HubAlert = {
        sessionId: this.session.sessionId,
        studentName: this.studentName,
        eventType: `intervention_${action}`,
        severity: action === 'force_submit' ? 'critical' : action === 'pause' ? 'high' : 'medium',
        aiExplanation: `[Queued] ${message ?? this.defaultInterventionMessage(action)}`,
        timestamp: intervention.issuedAt,
        kind: 'intervention',
      };

      this.reportToHub(alert, hubStatus).catch(() => {});

      return Response.json({ ok: true, status: 'queued', interventionId: intervention.id, message: 'Student offline — command queued.' });
    }
  }

  /** Default human-readable description for each intervention action. */
  private defaultInterventionMessage(action: InterventionAction): string {
    const msgs: Record<InterventionAction, string> = {
      warn: 'You have been issued a warning by the proctor.',
      pause: 'Your exam has been paused by the proctor.',
      resume: 'Your exam has been resumed by the proctor.',
      force_submit: 'Your exam has been ended by the proctor.',
    };
    return msgs[action];
  }

  // ─── Message handler ─────────────────────────────────────────────────────

  /**
   * Processes an incoming WebSocket message from the React frontend.
   *
   * Pipeline:
   *   1. Parse the JSON payload as a `BehavioralEventMsg`.
   *   2. Handle thumbnail messages (Phase 3a) — forward to hub, skip AI.
   *   3. Phase 3b: if session is terminated, ignore further behavioral events.
   *   4. Apply a naive risk delta (fast, pre-AI estimate).
   *      Phase 3b: while paused, skip risk delta and AI call but still record.
   *   5. Call Workers AI to get a refined score + explanation.
   *   6. Append the new `RiskEvent` and (if applicable) `Violation` to session state.
   *   7. Persist the updated session to Durable Object Storage.
   *   8. Broadcast the `risk_update` message to all connected WebSocket clients.
   *   9. (Phase 3a) Report updated summary + optional alert to ExamHubDO.
   *   10. (Phase 3b) Handle `ack` messages from student and forward to hub.
   *
   * @param socket - The server-side WebSocket that sent this message.
   * @param evt    - The raw MessageEvent from the WebSocket listener.
   */
  private async handleMessage(socket: WebSocket, evt: MessageEvent): Promise<void> {
    let msg: BehavioralEventMsg & { type?: string; interventionId?: string; action?: string };

    try {
      msg = JSON.parse(evt.data as string) as BehavioralEventMsg & { type?: string; interventionId?: string; action?: string };
    } catch {
      this.send(socket, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    // Phase 3b: handle student acknowledgement of a command
    if (msg.type === 'command_ack' && msg.interventionId) {
      await this.handleCommandAck(msg.interventionId);
      return;
    }

    const { eventType, payload } = msg;

    // Phase 3a: thumbnail-only message — forward to hub, no AI processing
    if (eventType === ('thumbnail' as string) && payload && 'thumbnailBase64' in payload) {
      this.latestThumbnail = (payload as ThumbnailPayload).thumbnailBase64;
      // Forward to hub only (no AI, no storage)
      const status = this.sessionStatus as SessionSummary['status'];
      this.reportToHub(undefined, status).catch(() => {});
      return;
    }

    // Phase 3b: terminated session — ignore further behavioral events
    if (this.sessionStatus === 'terminated') {
      return;
    }

    // Phase 3a: submit exam event — update status in hub and acknowledge
    if (eventType === ('submit' as string)) {
      this.sessionStatus = 'submitted';
      await this.state.storage.put('sessionStatus', this.sessionStatus);
      this.reportToHub(undefined, 'submitted').catch(() => {});
      await this.syncToD1('submitted');
      this.send(socket, {
        type: 'session_snapshot',
        session: this.session,
      } satisfies WSOutboundMsg);
      return;
    }

    // Phase 3b: paused session — record event in history but skip risk score changes and AI
    if (this.sessionStatus === 'paused') {
      // Record a paused-event entry in history (score unchanged)
      const now = new Date().toISOString();
      const pausedEvent: RiskEvent = {
        timestamp: now,
        score: this.session.riskScore, // score unchanged
        triggers: [eventType],
        aiExplanation: '[Exam paused] Event recorded but risk score frozen.',
      };
      this.session.riskHistory = [...this.session.riskHistory, pausedEvent].slice(-50);
      await this.state.storage.put('session', this.session);
      // Do NOT broadcast risk_update or call AI; just update hub
      this.reportToHub(undefined, 'paused').catch(() => {});
      return;
    }

    // Step 1: Naive risk delta (applied before AI so state always progresses)
    const delta = RISK_DELTAS[eventType] ?? 0;
    const rawNewScore = Math.min(100, Math.max(0, this.session.riskScore + delta));

    // Step 2: Vision Model processing (if frame is provided)
    let visionDescription = '';
    let durationContext = '';
    
    if (payload && 'frameBase64' in payload && payload.frameBase64) {
      try {
        const base64Data = payload.frameBase64.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        
        const visionResponse = await withTimeout(
          this.env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
            prompt: "Analyze this image for an exam proctoring system. Describe how many faces are visible, their approximate orientation, and anything else notable (e.g., objects like phones, books, notes visible). Keep it concise.",
            image: [...buffer],
          }),
          25_000
        );
        visionDescription = (visionResponse as any).description || (visionResponse as any).response || JSON.stringify(visionResponse);
      } catch (err) {
        console.error('[ExamSessionDO] Vision model failed:', err);
        visionDescription = '(Vision analysis unavailable)';
      }
    }

    if (payload && 'durationSeconds' in payload) {
      durationContext = ` (duration: ${payload.durationSeconds}s, client flag: ${payload.clientDetection})`;
    }

    // Step 3: AI-powered risk assessment via Llama 3.3-70B
    // Include payload context and vision context in the AI prompt
    let payloadContext = payload ? ` (details: ${JSON.stringify(payload)})` : '';
    if (durationContext || visionDescription) {
       payloadContext = durationContext + (visionDescription ? `\nVision AI analysis of the scene: "${visionDescription.trim()}"` : '');
    }
    const aiResult = await this.callWorkersAI(eventType + payloadContext, this.session.riskScore, rawNewScore);

    // Step 4: Build the risk event record
    const now = new Date().toISOString();
    const riskEvent: RiskEvent = {
      timestamp: now,
      score: aiResult.score,
      triggers: [eventType],
      aiExplanation: aiResult.explanation,
    };

    // Step 5: Update in-memory state
    this.session.riskScore = aiResult.score;
    this.session.riskHistory = [...this.session.riskHistory, riskEvent].slice(-50);

    let newViolation: Violation | undefined;
    if (eventType !== 'normal') {
      newViolation = {
        id: uid(),
        sessionId: this.session.sessionId,
        type: VIOLATION_TYPE_MAP[eventType] ?? 'system',
        severity: scoreSeverity(aiResult.score),
        timestamp: now,
        aiConfidence: aiResult.confidence,
        humanReviewed: false,
      };
      this.session.violations = [...this.session.violations, newViolation].slice(-100);
    }

    // Step 6: Persist to Durable Object Storage
    // This call survives DO evictions — if the runtime reclaims this DO's memory,
    // the next `initialize()` call will restore state from here.
    await this.state.storage.put('session', this.session);
    this.syncToD1().catch(() => {});

    // Step 7: Broadcast AI result to all connected clients
    this.broadcast({
      type: 'risk_update',
      riskScore: this.session.riskScore,
      riskEvent,
      violations: this.session.violations,
    } satisfies WSOutboundMsg);

    // Step 8: Phase 3a — Report to ExamHubDO (fire and forget)
    let hubAlert: HubAlert | undefined;
    if (newViolation && eventType !== 'normal') {
      hubAlert = {
        sessionId: this.session.sessionId,
        studentName: this.studentName,
        eventType,
        severity: newViolation.severity,
        durationSeconds: (payload && 'durationSeconds' in payload)
          ? payload.durationSeconds
          : undefined,
        aiExplanation: aiResult.explanation,
        timestamp: now,
        kind: 'violation',
      };
    }
    this.reportToHub(hubAlert, 'active').catch(() => {});
  }

  // ─── Phase 3b: Command acknowledgement ──────────────────────────────────

  /**
   * Records that a student has acknowledged an intervention.
   * Forwards the ack to ExamHubDO so the professor sees it.
   */
  private async handleCommandAck(interventionId: string): Promise<void> {
    const now = new Date().toISOString();

    // Update the intervention record with acknowledgedAt
    this.interventions = this.interventions.map((inv) =>
      inv.id === interventionId ? { ...inv, acknowledgedAt: now } : inv
    );
    await this.state.storage.put('interventions', this.interventions);

    // Forward ack to hub so professor dashboard shows "Acknowledged"
    try {
      const hubId = this.env.EXAM_HUB.idFromName(this.examId);
      const hubStub = this.env.EXAM_HUB.get(hubId);
      await hubStub.fetch(new Request('https://hub.internal/command-ack', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Auth': (this.env as any).INTERNAL_SECRET || '',
        },
        body: JSON.stringify({
          interventionId,
          sessionId: this.session.sessionId,
          action: this.interventions.find((i) => i.id === interventionId)?.action ?? 'warn',
          acknowledgedAt: now,
        }),
      }));
    } catch (err) {
      console.warn('[ExamSessionDO] Could not forward command_ack to hub:', err);
    }
  }

  /**
   * Phase 4c-2b: Keep D1 in sync with the session Durable Object.
   * Writes violation_count, max_severity, last_violation_at, and final_risk_score
   * to the attempts row in D1.
   * When endedReason is provided ('submitted' | 'auto_submitted' | 'terminated'), this is the FINAL write:
   * it writes from stored violation list with 3 retry attempts (with backoff).
   * If all 3 attempts fail, it resets violation_count to NULL so the attempt is treated as unknown (archive only).
   */
  public async syncToD1(endedReason?: 'submitted' | 'auto_submitted' | 'terminated'): Promise<void> {
    if (!this.env.DB || !this.session.sessionId) return;

    const violationCount = this.session.violations.length;
    let maxSeverity: string | null = null;
    const severityRank: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
    for (const v of this.session.violations) {
      if (!maxSeverity || (severityRank[v.severity] ?? 0) > (severityRank[maxSeverity] ?? 0)) {
        maxSeverity = v.severity;
      }
    }
    const lastViolationAt =
      this.session.violations.length > 0
        ? this.session.violations[this.session.violations.length - 1].timestamp
        : null;
    const finalRiskScore = this.session.riskScore;

    if (!endedReason) {
      // Intermediate update during exam
      try {
        await this.env.DB.prepare(
          `UPDATE attempts
           SET violation_count = ?,
               max_severity = ?,
               last_violation_at = ?,
               final_risk_score = ?
           WHERE session_id = ?`,
        )
          .bind(violationCount, maxSeverity, lastViolationAt, finalRiskScore, this.session.sessionId)
          .run();
      } catch (err) {
        console.warn('[ExamSessionDO] Failed intermediate telemetry sync to D1:', err);
      }
      return;
    }

    // Final update at end of attempt: 3 attempts with backoff
    let writeSuccess = false;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.env.DB.prepare(
          `UPDATE attempts
           SET violation_count = ?,
               max_severity = ?,
               last_violation_at = ?,
               final_risk_score = ?,
               ended_reason = ?
           WHERE session_id = ?`,
        )
          .bind(violationCount, maxSeverity, lastViolationAt, finalRiskScore, endedReason, this.session.sessionId)
          .run();
        writeSuccess = true;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 50));
        }
      }
    }

    if (!writeSuccess) {
      console.error(
        `[ExamSessionDO] Final write failed after 3 attempts for session ${this.session.sessionId}; setting violation_count = NULL:`,
        lastError,
      );
      try {
        await this.env.DB.prepare(
          `UPDATE attempts
           SET violation_count = NULL,
               ended_reason = ?
           WHERE session_id = ?`,
        )
          .bind(endedReason, this.session.sessionId)
          .run();
      } catch (fallbackErr) {
        console.error(
          `[ExamSessionDO] Failed fallback write to reset violation_count = NULL for session ${this.session.sessionId}:`,
          fallbackErr,
        );
      }
    }
  }

  // ─── Phase 3a: Hub reporting ─────────────────────────────────────────────

  /**
   * Reports the current session summary (and optionally an alert) to the ExamHubDO.
   * Fire-and-forget — errors are suppressed so the student's flow is never blocked.
   *
   * @param alert  - Optional violation alert to push to the professor feed.
   * @param status - The student's current session status.
   */
  private async reportToHub(
    alert: HubAlert | undefined,
    status: SessionSummary['status']
  ): Promise<void> {
    try {
      const summary: SessionSummary = {
        sessionId: this.session.sessionId,
        studentName: this.studentName,
        riskScore: this.session.riskScore,
        status,
        violationCount: this.session.violations.length,
        lastEventType: this.session.riskHistory.at(-1)?.triggers[0] ?? '',
        lastEventAt: this.session.riskHistory.at(-1)?.timestamp ?? new Date().toISOString(),
        startedAt: this.startedAt,
        thumbnailBase64: this.latestThumbnail,
        examId: this.examId,
        recentViolations: this.session.violations.slice(-10),
        interventions: this.interventions.slice(-10),
      };

      const body: HubInternalUpdate = { summary, alert };

      // Get the hub DO stub for this examId
      const hubId = this.env.EXAM_HUB.idFromName(this.examId);
      const hubStub = this.env.EXAM_HUB.get(hubId);

      // Build an internal URL for the hub (/session-event)
      const hubUrl = new URL(`https://hub.internal/session-event`);
      await hubStub.fetch(new Request(hubUrl.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Auth': (this.env as any).INTERNAL_SECRET || '',
        },
        body: JSON.stringify(body),
      }));
    } catch (err) {
      // Never block the student's flow
      console.warn('[ExamSessionDO] Hub report failed (non-fatal):', err);
    }
  }

  // ─── Workers AI integration ───────────────────────────────────────────────

  /**
   * Calls `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via the Workers AI binding.
   *
   * Prompt strategy:
   *   - System prompt: instructs the model to return pure JSON only.
   *   - User prompt: provides the current raw score, the new event type,
   *     and the last 5 history entries for contextual reasoning.
   *
   * Response format (JSON):
   *   { "score": number, "explanation": string, "confidence": number }
   *
   * Resilience:
   *   - Wrapped in a 20-second `withTimeout()` guard.
   *   - On ANY error (timeout, model error, JSON parse failure), returns a
   *     deterministic fallback based on the naive delta score so the WebSocket
   *     always sends a response and the spinner never gets stuck.
   *
   * @param eventType - The behavioral event type (e.g., 'tab_switch').
   * @param rawScore  - The naively-computed score before AI refinement.
   * @returns Refined { score, explanation, confidence }.
   */
  private async callWorkersAI(
    eventType: string,
    previousScore: number,
    rawScore: number
  ): Promise<{ score: number; explanation: string; confidence: number }> {
    const recentHistory = this.session.riskHistory
      .slice(-5)
      .map((h: RiskEvent) => `  • [${h.timestamp}] score=${h.score} trigger=${h.triggers.join(',')}`)
      .join('\n');

    const systemPrompt = `You are an AI proctoring risk analysis engine.
Your job is to assess academic integrity violations in real-time.
You MUST respond with valid JSON only — no markdown, no explanation outside JSON.
JSON schema: { "score": <integer 0-100>, "explanation": "<one sentence>", "confidence": <float 0-1> }`;

    const userPrompt = `Previous cumulative risk score (before this event): ${previousScore}/100
Naively updated score (with this event): ${rawScore}/100
New behavioral event detected: "${eventType}"

Recent history (last 5 events):
${recentHistory || '  (none yet)'}

Assess the risk based on the event and its duration. If a Vision AI analysis is provided, compare it against the client flag. 
If the Vision AI contradicts the client flag (e.g., client flagged 'multiple faces' but Vision AI sees 1 face), it's a false positive! In this case, REVERT the score to the \`Previous cumulative risk score\` (${previousScore}). DO NOT reset the overall score to 0 unless the previous score was 0.
If it is a true positive, use the \`Naively updated score\` (${rawScore}) as a baseline, and adjust it up or down based on duration and severity.
The score is cumulative over the whole session. Never drop the score drastically just because one event is a false positive.
Return an updated cumulative score (0-100), a brief explanation, and your confidence (0-1).
Only respond with the JSON object.`;

    try {
      // Workers AI call — `this.env.AI` is the binding declared in wrangler.jsonc.
      // withTimeout ensures we don't hang indefinitely if the model is under load.
      const response = await withTimeout(
        this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: userPrompt },
          ],
          max_tokens: 150,
        }),
        20_000 // 20-second timeout
      );

      // The model returns { response: string } — extract and parse the JSON safely
      let text = '';
      if (typeof response === 'string') {
        text = response;
      } else if (response && typeof (response as any).response === 'string') {
        text = (response as any).response;
      } else {
        // Fallback if the AI binding returned a raw object (can happen with certain models/load)
        text = JSON.stringify((response as any).response ?? response);
      }
      text = text.trim();

      // Strip markdown code fences the model may add despite system prompt instructions
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(jsonStr) as { score: number; explanation: string; confidence: number };

      return {
        score:       Math.min(100, Math.max(0, Math.round(parsed.score))),
        explanation: parsed.explanation ?? 'Risk assessed.',
        confidence:  Math.min(1, Math.max(0, parsed.confidence ?? 0.8)),
      };
    } catch (err) {
      // Fallback: use naive delta score + canned explanation so the UI always responds.
      console.error('[ExamSessionDO] Workers AI call failed (using fallback):', err);
      return {
        score:       rawScore,
        explanation: this.fallbackExplanation(eventType),
        confidence:  0.5,
      };
    }
  }

  /**
   * Returns a deterministic fallback explanation used when the Workers AI call fails.
   * Ensures the frontend never receives an empty or broken message.
   *
   * @param eventType - The event type that triggered the fallback.
   * @returns A human-readable explanation string.
   */
  private fallbackExplanation(eventType: string): string {
    const map: Record<string, string> = {
      tab_switch:          'Tab switch detected — this may indicate accessing external resources.',
      face_not_detected:   'Face not detected in camera — please ensure you remain visible.',
      no_face:             'Face not detected in camera — please ensure you remain visible.',
      multiple_faces:      'Multiple faces detected — only the exam taker should be present.',
      orientation_away:    'Head turned away from screen — please look forward.',
      identity_mismatch:   'Identity verification mismatch — unauthorized person detected.',
      normal:              'Behavior appears normal. No violations detected.',
      clipboard_activity:  'Clipboard activity detected — copy/paste operations are monitored during exams.',
      fullscreen_exit:     'Fullscreen mode exited — exam requires fullscreen mode to be active.',
    };
    // Strip payload context suffix (e.g. " (details: ...)") if present
    const baseType = eventType.split(' (')[0];
    return map[baseType] ?? 'Behavioral event recorded and flagged for review.';
  }

  // ─── WebSocket helpers ────────────────────────────────────────────────────

  /**
   * Sends a JSON-serialized message to a single WebSocket client.
   * Silently skips if the socket is no longer in the OPEN state (readyState === 1).
   *
   * @param socket - The target WebSocket.
   * @param data   - Any JSON-serializable value.
   */
  private send(socket: WebSocket, data: unknown): void {
    // readyState 1 === WebSocket.OPEN
    // (WebSocket.READY_STATE_OPEN is not available in the Workers runtime)
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(data));
    }
  }

  /**
   * Broadcasts a message to all currently connected WebSocket clients.
   * Used to push AI results to every open tab/connection for this session.
   *
   * @param data - Any JSON-serializable value.
   */
  private broadcast(data: unknown): void {
    for (const socket of this.sockets) {
      this.send(socket, data);
    }
  }
}
