/**
 * worker/index.ts — Cloudflare Worker entry point
 * ─────────────────────────────────────────────────────────────────
 * Routes:
 *   GET    /api/health                          -> { status: "ok" }
 *   WS     /api/exam/:sessionId                 -> ExamSessionDO (student)
 *   GET    /api/exam/:sessionId/history         -> ExamSessionDO GET /history
 *   WS     /api/hub/:examId                     -> ExamHubDO (professor live monitor)
 *   *      /api/professor/*                     -> handleProfessorApi (Phase 4a D1)
 *   *      /api/student/*                       -> handleStudentApi  (Phase 4b D1)
 *   All other paths                             -> serve static React SPA (Cloudflare Assets)
 * ─────────────────────────────────────────────────────────────────
 */

export { ExamSessionDO } from './ExamSessionDO.js';
export { ExamHubDO } from './ExamHubDO.js';
import { handleProfessorApi } from './api/exams.js';
import { handleStudentApi } from './api/student.js';
import { runAutoEndSweep } from './api/grading.js';
import { runRetentionSweep } from './api/sessions.js';
import { jsonNotFound } from './utils/internalAuth.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── Health check ─────────────────────────────────────────────────────────
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok' });
    }

    // ── WebSocket route for exam sessions (Student) ──────────────────────────
    // Rule: forward ONLY exact /api/exam/:sessionId with header Upgrade: websocket.
    // Session ID must match ^[A-Za-z0-9_-]{1,64}$. Sub-paths return JSON 404.
    // Check D1 for an attempts row with that session_id; return 404 if not found (creates no state).
    if (url.pathname.startsWith('/api/exam/') || url.pathname === '/api/exam') {
      const examMatch = url.pathname.match(/^\/api\/exam\/([A-Za-z0-9_-]{1,64})$/);
      const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

      if (!examMatch || !isWs) {
        return jsonNotFound();
      }

      const sessionId = examMatch[1];

      // Check D1 for an attempts row with that session_id before contacting DO
      if (env.DB) {
        const attempt = await env.DB.prepare('SELECT id FROM attempts WHERE session_id = ?')
          .bind(sessionId)
          .first<{ id: string }>();

        if (!attempt) {
          return jsonNotFound();
        }
      }

      const doId = env.EXAM_SESSION.idFromName(sessionId);
      const stub = env.EXAM_SESSION.get(doId);
      const doUrl = new URL(request.url);
      doUrl.searchParams.set('sessionId', sessionId);
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // ── WebSocket route for professor hub (Live Monitor) ─────────────────────
    // Rule: forward ONLY exact /api/hub/:examId with header Upgrade: websocket.
    // Exam ID must match ^[A-Za-z0-9_-]{1,64}$. Any sub-path (/internal/*) returns JSON 404.
    if (url.pathname.startsWith('/api/hub/') || url.pathname === '/api/hub') {
      const hubMatch = url.pathname.match(/^\/api\/hub\/([A-Za-z0-9_-]{1,64})$/);
      const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

      if (!hubMatch || !isWs) {
        return jsonNotFound();
      }

      const examId = hubMatch[1];

      // Keep existing professor key check on the hub socket
      const expectedKey = (env as unknown as Record<string, unknown>).PROFESSOR_KEY as string | undefined;
      const providedKey = url.searchParams.get('key') || '';
      if (expectedKey && providedKey !== expectedKey) {
        return new Response('Unauthorized: Invalid or missing professor key.', { status: 401 });
      }

      const hubId = env.EXAM_HUB.idFromName(examId);
      const stub = env.EXAM_HUB.get(hubId);
      const hubUrl = new URL(request.url);
      hubUrl.pathname = '/ws';
      return stub.fetch(new Request(hubUrl.toString(), request));
    }

    // ── Professor exam management REST API (Phase 4a, D1) ─────────────────
    if (url.pathname.startsWith('/api/professor')) {
      return handleProfessorApi(request, env as unknown as Parameters<typeof handleProfessorApi>[1]);
    }

    // ── Student exam-taking REST API (Phase 4b, D1) ────────────────────
    if (url.pathname.startsWith('/api/student')) {
      return handleStudentApi(request, env as unknown as Parameters<typeof handleStudentApi>[1]);
    }

    // ── Any other /api/ path returns JSON 404 ─────────────────────────────────
    if (url.pathname.startsWith('/api/')) {
      return jsonNotFound();
    }

    // ── Catch-all: let Cloudflare serve the React SPA assets ─────────────
    // The SPA index.html fallback must apply ONLY to non-/api/ GET requests that accept text/html.
    const assets = (env as unknown as Record<string, unknown>).ASSETS as Fetcher | undefined;
    if (assets) {
      const res = await assets.fetch(request);
      if (res.status === 404 && request.method === 'GET') {
        const accept = request.headers.get('accept') || '';
        if (accept.includes('text/html')) {
          const indexUrl = new URL('/index.html', request.url);
          return assets.fetch(new Request(indexUrl.toString()));
        }
      }
      return res;
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === '0 3 * * *') {
      ctx.waitUntil(runRetentionSweep(env as unknown as Parameters<typeof runRetentionSweep>[0]));
    } else {
      ctx.waitUntil(runAutoEndSweep(env as unknown as Parameters<typeof runAutoEndSweep>[0]));
    }
  },
} satisfies ExportedHandler<Env>;

