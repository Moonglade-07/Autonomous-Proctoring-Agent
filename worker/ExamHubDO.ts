/**
 * @file ExamHubDO.ts
 * @description Cloudflare Durable Object — one instance per examId (keyed by examId string).
 *
 * Architecture role (Phase 3a):
 *   ExamSessionDO (one per student) → HTTP POST → ExamHubDO (one per exam)
 *                                                        ↕ WebSocket
 *                                                  ProfessorDashboard
 *
 * The hub holds lightweight SessionSummary records for every student connected
 * to this exam. Professors connect via WebSocket and receive:
 *   • `snapshot`       — full map of all sessions on connect
 *   • `session_update` — pushed whenever a student's session changes
 *   • `alert`          — pushed for every high-significance violation
 *
 * Internal HTTP API (called by ExamSessionDO only):
 *   POST /internal/update  — update a session summary + optionally push alert
 *   GET  /internal/history/:sessionId — fetch full RiskEvent history for a session
 */

import type { SessionSummary, HubAlert, HubOutboundMsg, HubInternalUpdate } from './types.js';

export class ExamHubDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  /** In-memory map of sessionId → SessionSummary */
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

      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.profSockets.add(server);

      // Send full snapshot immediately on connect
      this.sendToSocket(server, {
        type: 'snapshot',
        sessions: Object.fromEntries(this.sessions),
        alerts: this.alerts.slice(-100),
      } satisfies HubOutboundMsg);

      server.addEventListener('close', () => {
        this.profSockets.delete(server);
      });

      server.addEventListener('error', () => {
        this.profSockets.delete(server);
      });

      return new Response(null, { status: 101, webSocket: client });
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

    return new Response('Not found', { status: 404 });
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
