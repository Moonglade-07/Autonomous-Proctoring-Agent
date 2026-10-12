/**
 * worker/index.ts — Cloudflare Worker entry point
 * ─────────────────────────────────────────────────────────────────
 * Routes:
 *   GET  /api/health              → { status: "ok" }
 *   WS   /api/exam/:sessionId     → ExamSessionDO (student)
 *   WS   /api/hub/:examId         → ExamHubDO (professor live monitor)
 *   All other paths               → serve static React SPA (Cloudflare Assets)
 * ─────────────────────────────────────────────────────────────────
 */

export { ExamSessionDO } from './ExamSessionDO.js';
export { ExamHubDO } from './ExamHubDO.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── Health check ─────────────────────────────────────────────────────────
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok' });
    }

    // ── WebSocket route for exam sessions ─────────────────────────────────
    // Pattern: /api/exam/:sessionId
    const examMatch = url.pathname.match(/^\/api\/exam\/([^/]+)$/);
    if (examMatch) {
      const sessionId = examMatch[1];
      const doId = env.EXAM_SESSION.idFromName(sessionId);
      const stub = env.EXAM_SESSION.get(doId);
      const doUrl = new URL(request.url);
      doUrl.searchParams.set('sessionId', sessionId);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // ── GET /history for a session (for professor detail drawer) ──────────
    // Pattern: /api/exam/:sessionId/history
    const historyMatch = url.pathname.match(/^\/api\/exam\/([^/]+)\/history$/);
    if (historyMatch && request.method === 'GET') {
      const sessionId = historyMatch[1];
      const doId = env.EXAM_SESSION.idFromName(sessionId);
      const stub = env.EXAM_SESSION.get(doId);
      const doUrl = new URL(request.url);
      doUrl.searchParams.set('sessionId', sessionId);
      // Forward to DO — it handles GET /history internally
      return stub.fetch(new Request(doUrl.toString(), { method: 'GET' }));
    }

    // ── WebSocket route for professor hub ─────────────────────────────────
    // Pattern: /api/hub/:examId  (WebSocket connection from professor dashboard)
    const hubMatch = url.pathname.match(/^\/api\/hub\/([^/]+)$/);
    if (hubMatch) {
      const examId = hubMatch[1];
      const hubId = env.EXAM_HUB.idFromName(examId);
      const stub = env.EXAM_HUB.get(hubId);
      // Append /ws so the hub DO can distinguish WebSocket from internal calls
      const hubUrl = new URL(request.url);
      hubUrl.pathname = '/ws';
      return stub.fetch(new Request(hubUrl.toString(), request));
    }

    // ── Catch-all: let Cloudflare serve the React SPA assets ─────────────
    const assets = (env as unknown as Record<string, unknown>).ASSETS as Fetcher | undefined;
    if (assets) {
      const res = await assets.fetch(request);
      if (res.status === 404 && request.method === 'GET') {
        const indexUrl = new URL('/index.html', request.url);
        return assets.fetch(new Request(indexUrl.toString()));
      }
      return res;
    }

    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
