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
} from './types.js';

// ─── Module-level helpers ────────────────────────────────────────────────────

/** Returns a short random ID (8 hex chars) for violation records. */
function uid(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Naive risk delta applied before the AI refines the score.
 * These values provide instant feedback while the AI call is in-flight.
 */
const RISK_DELTAS: Record<string, number> = {
  tab_switch:         15,
  face_not_detected:  20,
  multiple_faces:     25,
  normal:             -5,
};

/** Maps each event type to the corresponding Violation category. */
const VIOLATION_TYPE_MAP: Record<string, Violation['type']> = {
  tab_switch:        'behavioral',
  face_not_detected: 'vision',
  multiple_faces:    'vision',
  normal:            'system',
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
  private session: ExamSessionState = {
    sessionId: '',
    riskScore: 0,
    riskHistory: [],
    violations: [],
  };

  /** Set of all currently open WebSocket connections to this DO instance. */
  private sockets: Set<WebSocket> = new Set();

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

    const stored = await this.state.storage.get<ExamSessionState>('session');
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
  }

  // ─── Durable Object fetch handler ────────────────────────────────────────

  /**
   * Entry point for all requests forwarded from the Worker (index.ts).
   *
   * Handles:
   *   • WebSocket upgrade requests → completes the WebSocket handshake and
   *     sets up message/close/error listeners.
   *   • All other requests → returns 426 Upgrade Required.
   *
   * @param request - The forwarded HTTP request from the Worker.
   * @returns A 101 Switching Protocols response with the client-side WebSocket,
   *          or a 426 error response.
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId') ?? 'unknown';

    await this.initialize(sessionId);

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Create a WebSocket pair: client is returned to the browser,
    // server stays inside this DO and receives all incoming messages.
    const { 0: client, 1: server } = new WebSocketPair();

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
    });

    server.addEventListener('error', (err) => {
      console.error('[ExamSessionDO] WebSocket error event:', err);
      this.sockets.delete(server);
    });

    // Send the full session snapshot to the newly connected client so it can
    // hydrate its React state without waiting for the first event.
    this.send(server, {
      type: 'session_snapshot',
      session: this.session,
    } satisfies WSOutboundMsg);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── Message handler ─────────────────────────────────────────────────────

  /**
   * Processes an incoming WebSocket message from the React frontend.
   *
   * Pipeline:
   *   1. Parse the JSON payload as a `BehavioralEventMsg`.
   *   2. Apply a naive risk delta (fast, pre-AI estimate).
   *   3. Call Workers AI to get a refined score + explanation.
   *   4. Append the new `RiskEvent` and (if applicable) `Violation` to session state.
   *   5. Persist the updated session to Durable Object Storage.
   *   6. Broadcast the `risk_update` message to all connected WebSocket clients.
   *
   * @param socket - The server-side WebSocket that sent this message.
   * @param evt    - The raw MessageEvent from the WebSocket listener.
   */
  private async handleMessage(socket: WebSocket, evt: MessageEvent): Promise<void> {
    let msg: BehavioralEventMsg;

    try {
      msg = JSON.parse(evt.data as string) as BehavioralEventMsg;
    } catch {
      this.send(socket, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    const { eventType } = msg;

    // Step 1: Naive risk delta (applied before AI so state always progresses)
    const delta = RISK_DELTAS[eventType] ?? 0;
    const rawNewScore = Math.min(100, Math.max(0, this.session.riskScore + delta));

    // Step 2: AI-powered risk assessment via Llama 3.3-70B
    const aiResult = await this.callWorkersAI(eventType, rawNewScore);

    // Step 3: Build the risk event record
    const now = new Date().toISOString();
    const riskEvent: RiskEvent = {
      timestamp: now,
      score: aiResult.score,
      triggers: [eventType],
      aiExplanation: aiResult.explanation,
    };

    // Step 4: Update in-memory state
    this.session.riskScore = aiResult.score;
    this.session.riskHistory = [...this.session.riskHistory, riskEvent].slice(-50);

    if (eventType !== 'normal') {
      const violation: Violation = {
        id: uid(),
        sessionId: this.session.sessionId,
        type: VIOLATION_TYPE_MAP[eventType] ?? 'system',
        severity: scoreSeverity(aiResult.score),
        timestamp: now,
        aiConfidence: aiResult.confidence,
        humanReviewed: false,
      };
      this.session.violations = [...this.session.violations, violation].slice(-100);
    }

    // Step 5: Persist to Durable Object Storage
    // This call survives DO evictions — if the runtime reclaims this DO's memory,
    // the next `initialize()` call will restore state from here.
    await this.state.storage.put('session', this.session);

    // Step 6: Broadcast AI result to all connected clients
    this.broadcast({
      type: 'risk_update',
      riskScore: this.session.riskScore,
      riskEvent,
      violations: this.session.violations,
    } satisfies WSOutboundMsg);
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

    const userPrompt = `Current exam session risk score: ${rawScore}/100
New behavioral event detected: "${eventType}"

Recent history (last 5 events):
${recentHistory || '  (none yet)'}

Assess the risk. Return an updated score (0-100), a brief warning or reassurance for the student/proctor, and your confidence (0-1).
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

      // The model returns { response: string } — extract and parse the JSON
      const text = (response as { response: string }).response?.trim() ?? '';
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
      tab_switch:        'Tab switch detected — this may indicate accessing external resources.',
      face_not_detected: 'Face not detected in camera — please ensure you remain visible.',
      multiple_faces:    'Multiple faces detected — only the exam taker should be present.',
      normal:            'Behavior appears normal. No violations detected.',
    };
    return map[eventType] ?? 'Behavioral event recorded and flagged for review.';
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
