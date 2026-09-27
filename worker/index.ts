/**
 * worker/index.ts — Cloudflare Worker entry point
 * ─────────────────────────────────────────────────────────────────
 * Routes:
 *   GET /api/health              → { status: "ok" }
 *   GET /api/exam/:sessionId     → WebSocket upgrade, routed to ExamSessionDO
 *   All other paths              → serve static React app (via Cloudflare Assets)
 * ─────────────────────────────────────────────────────────────────
 */

export { ExamSessionDO } from './ExamSessionDO.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── Health check ─────────────────────────────────────────────────────────
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok' });
    }

    // ── WebSocket route for exam sessions ────────────────────────────────────
    // Pattern: /api/exam/:sessionId
    // The sessionId is used to look up (or create) a specific Durable Object instance.
    const examMatch = url.pathname.match(/^\/api\/exam\/([^/]+)$/);
    if (examMatch) {
      const sessionId = examMatch[1];

      // Get a stable Durable Object ID derived from the session ID string.
      // The same sessionId string always maps to the same DO instance.
      const doId = env.EXAM_SESSION.idFromName(sessionId);
      const stub = env.EXAM_SESSION.get(doId);

      // Forward the request (with WebSocket upgrade headers) to the DO.
      // The DO's fetch() handler will complete the WebSocket handshake.
      const doUrl = new URL(request.url);
      doUrl.searchParams.set('sessionId', sessionId);

      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // ── Catch-all: let Cloudflare serve the React SPA assets ─────────────────
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
