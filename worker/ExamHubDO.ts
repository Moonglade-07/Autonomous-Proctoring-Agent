/**
 * @file ExamHubDO.ts
 * @description Cloudflare Durable Object — one instance per examId (keyed by examId string).
 *
 * Architecture role (Phase 3a + 3b):
 *   ExamSessionDO (one per student) -> HTTP POST -> ExamHubDO (one per exam)
 *                                                        WS (bidirectional)
 *                                                  ProfessorDashboard
 *
 * The hub holds lightweight SessionSummary records for every student connected
 * to this exam. Professors connect via WebSocket and receive:
 *   • `snapshot`        — full map of all sessions on connect
 *   • `session_update`  — pushed whenever a student's session changes
 *   • `alert`           — pushed for every high-significance violation
 *   • `command_result`  — Phase 3b: delivery acknowledgement for issued commands
 *   • `command_ack`     — Phase 3b: student acknowledgement forwarded to professor
 *
 * Internal HTTP API (called by ExamSessionDO only):
 *   POST /internal/update  — update a session summary + optionally push alert
 *   POST /session-event    — alias for /internal/update
 *   POST /command-ack      — Phase 3b: forward student ack back to professors
 *   GET  /internal/history/:sessionId — fetch summary for a session
 *
 * Phase 3b additions:
 *   • Professor WebSocket now accepts inbound messages of type 'command'.
 *   • The hub validates the PROFESSOR_KEY and routes commands to the target
 *     ExamSessionDO via POST /command.
 *   • The hub broadcasts command_result back to the issuing professor.
 */

import type {
  SessionSummary,
  HubAlert,
  HubOutboundMsg,
  HubInternalUpdate,
  CommandMsg,
  InterventionAction,
} from './types.js';
import { verifyInternalAuth, forbiddenResponse, jsonNotFound } from './utils/internalAuth.js';

export class ExamHubDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  /** In-memory map of sessionId -> SessionSummary */
  private sessions: Map<string, SessionSummary> = new Map();

  /** All connected professor WebSocket connections */
  private profSockets: Set<WebSocket> = new Set();

  /** Recent alert feed — capped at 200 */
  private alerts: HubAlert[] = [];

  /** Whether in-memory state has been hydrated from storage */
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    void this.env;
  }

  // ─── Hydrate from storage ─────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const [storedSessions, storedAlerts] = await Promise.all([
      this.state.storage.get<Record<string, SessionSummary>>('sessions'),
      this.state.storage.get<HubAlert[]>('alerts'),
    ]);

    if (storedSessions) {
      for (const [id, s] of Object.entries(storedSessions)) {
        this.sessions.set(id, s);
      }
    }
    if (storedAlerts) {
      this.alerts = storedAlerts;
    }
  }

  // ─── Persist to storage ──────────────────────────────────────────────────

  private async persist(): Promise<void> {
    const sessionsObj: Record<string, SessionSummary> = {};
    for (const [id, s] of this.sessions) sessionsObj[id] = s;
    await Promise.all([
      this.state.storage.put('sessions', sessionsObj),
      this.state.storage.put('alerts', this.alerts.slice(-200)),
    ]);
  }

  // ─── Fetch handler ────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    await this.initialize();

    const url = new URL(request.url);

    // ── Professor WebSocket connection ───────────────────────────────────────
    if (url.pathname.endsWith('/ws')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      // Phase 3b: Key guard (temporary, until Phase 5 auth)
      const expectedKey = (this.env as any).PROFESSOR_KEY as string | undefined;
      const providedKey = url.searchParams.get('key') || '';
      if (expectedKey && providedKey !== expectedKey) {
        return new Response('Unauthorized: Invalid or missing professor key.', { status: 401 });
      }

      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.profSockets.add(server);

      // Send full snapshot immediately on connect
      this.sendToSocket(server, {
        type: 'snapshot',
        sessions: Object.fromEntries(this.sessions),
        alerts: this.alerts.slice(-100),
      } satisfies HubOutboundMsg);

      // Phase 3b: listen for inbound professor commands (bidirectional WS)
      server.addEventListener('message', (evt) => {
        this.handleProfessorMessage(server, evt).catch((err) => {
          console.error('[ExamHubDO] Error handling professor message:', err);
        });
      });

      server.addEventListener('close', () => {
        this.profSockets.delete(server);
      });

      server.addEventListener('error', () => {
        this.profSockets.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Internal Non-WebSocket Handlers ─────────────────────────────────────
    // Defense-in-depth: every internal handler MUST carry X-Internal-Auth matching INTERNAL_SECRET
    if (!verifyInternalAuth(request, this.env as any)) {
      return forbiddenResponse();
    }

    // ── Internal: update a session summary (/session-event or /internal/update) ──
    if ((url.pathname.endsWith('/session-event') || url.pathname.endsWith('/internal/update')) && request.method === 'POST') {
      const body = await request.json<HubInternalUpdate>();

      // Update session summary
      const existing = this.sessions.get(body.summary.sessionId);
      const merged: SessionSummary = { ...(existing ?? {}), ...body.summary } as SessionSummary;
      this.sessions.set(merged.sessionId, merged);

      // Broadcast session_updated to all professors
      this.broadcastToProfs({
        type: 'session_updated',
        summary: merged,
      } satisfies HubOutboundMsg);

      // Optionally broadcast alert
      if (body.alert) {
        this.alerts = [...this.alerts, body.alert].slice(-200);
        this.broadcastToProfs({
          type: 'alert',
          alert: body.alert,
        } satisfies HubOutboundMsg);
      }

      // Persist asynchronously — don't block response
      this.persist().catch((e) =>
        console.error('[ExamHubDO] persist error:', e)
      );

      return Response.json({ ok: true });
    }

    // ── Phase 3b: Internal: forward command ack from student ─────────────────
    if (url.pathname.endsWith('/command-ack') && request.method === 'POST') {
      const body = await request.json<{
        interventionId: string;
        sessionId: string;
        action: InterventionAction;
        acknowledgedAt: string;
      }>();

      // Broadcast the ack to all professor sockets
      this.broadcastToProfs({
        type: 'command_ack',
        interventionId: body.interventionId,
        sessionId: body.sessionId,
        action: body.action,
        acknowledgedAt: body.acknowledgedAt,
      } satisfies HubOutboundMsg);

      return Response.json({ ok: true });
    }

    // ── Internal: fetch history for a specific session ──────────────────────
    const historyMatch = url.pathname.match(/\/internal\/history\/([^/]+)$/);
    if (historyMatch && request.method === 'GET') {
      const sessionId = historyMatch[1];
      const summary = this.sessions.get(sessionId);
      if (!summary) {
        return Response.json({ error: 'Session not found' }, { status: 404 });
      }
      // Return the session summary (full history is stored in ExamSessionDO)
      return Response.json({ summary });
    }

    // ── Phase 4c-2b: Internal: remove a session (/internal/remove-session) ────
    if (url.pathname.endsWith('/internal/remove-session') && request.method === 'POST') {
      const body = await request.json<{ sessionId: string }>();
      const { sessionId } = body;
      if (sessionId) {
        this.sessions.delete(sessionId);
        this.alerts = this.alerts.filter((a) => a.sessionId !== sessionId);
        await this.persist();
        this.broadcastToProfs({
          type: 'session_removed',
          sessionId,
        } satisfies HubOutboundMsg);
      }
      return Response.json({ ok: true });
    }

    // ── Phase 4c-2b: Internal: list all hub sessions (/internal/sessions) ─────
    if (url.pathname.endsWith('/internal/sessions') && request.method === 'GET') {
      return Response.json({ sessions: Object.fromEntries(this.sessions) });
    }

    return jsonNotFound();
  }

  // ─── Phase 3b: Professor inbound message handler ─────────────────────────

  /**
   * Handles a message sent FROM the professor WebSocket TO the hub.
   * Currently handles: { type: 'command', sessionId, action, message }
   *
   * Validates the professor key (passed as a 'key' field in the message)
   * then routes the command to the target ExamSessionDO.
   */
  private async handleProfessorMessage(socket: WebSocket, evt: MessageEvent): Promise<void> {
    let msg: CommandMsg & { key?: string };

    try {
      msg = JSON.parse(evt.data as string) as CommandMsg & { key?: string };
    } catch {
      this.sendToSocket(socket, {
        type: 'command_result',
        sessionId: '',
        action: 'warn',
        status: 'error',
        message: 'Invalid JSON in command',
      } satisfies HubOutboundMsg);
      return;
    }

    if (msg.type !== 'command') return; // ignore unknown message types

    // ── Key validation ────────────────────────────────────────────────────────
    const expectedKey = (this.env as any).PROFESSOR_KEY as string | undefined;
    if (expectedKey && msg.key !== expectedKey) {
      this.sendToSocket(socket, {
        type: 'command_result',
        sessionId: msg.sessionId,
        action: msg.action,
        status: 'error',
        message: 'Unauthorized: incorrect professor key.',
      } satisfies HubOutboundMsg);
      return;
    }

    const { sessionId, action, message } = msg;

    // Look up the target session to get the examId for the DO stub
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.sendToSocket(socket, {
        type: 'command_result',
        sessionId,
        action,
        status: 'error',
        message: `Session "${sessionId}" not found in this exam hub.`,
      } satisfies HubOutboundMsg);
      return;
    }

    try {
      // Route to the target ExamSessionDO
      const doId = this.env.EXAM_SESSION.idFromName(sessionId);
      const stub = this.env.EXAM_SESSION.get(doId);
      const cmdUrl = new URL(`https://session.internal/command?sessionId=${encodeURIComponent(sessionId)}`);

      const resp = await stub.fetch(new Request(cmdUrl.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Auth': (this.env as any).INTERNAL_SECRET || '',
        },
        body: JSON.stringify({ action, message }),
      }));

      const result = await resp.json<{
        ok: boolean;
        status: string;
        message?: string;
        interventionId?: string;
      }>();

      // Broadcast delivery result to all professors (so all dashboards see it)
      this.broadcastToProfs({
        type: 'command_result',
        sessionId,
        action,
        status: result.status as 'delivered' | 'queued' | 'error' | 'noop',
        message: result.message ?? (result.status === 'delivered'
          ? `Command "${action}" delivered to ${session.studentName}.`
          : result.status === 'queued'
          ? `Command "${action}" queued — ${session.studentName} is offline.`
          : result.status === 'noop'
          ? `Command "${action}" is a no-op for current session state.`
          : `Command "${action}" failed.`),
      } satisfies HubOutboundMsg);

    } catch (err) {
      console.error('[ExamHubDO] Command routing failed:', err);
      this.sendToSocket(socket, {
        type: 'command_result',
        sessionId,
        action,
        status: 'error',
        message: `Failed to deliver command to session: ${String(err)}`,
      } satisfies HubOutboundMsg);
    }
  }

  // ─── WebSocket helpers ────────────────────────────────────────────────────

  private sendToSocket(socket: WebSocket, data: unknown): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(data));
    }
  }

  private broadcastToProfs(data: unknown): void {
    for (const s of this.profSockets) {
      this.sendToSocket(s, data);
    }
  }
}
