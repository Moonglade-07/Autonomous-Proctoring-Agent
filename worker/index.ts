/**
 * worker/index.ts — Cloudflare Worker entry point (Phase 5a)
 * ─────────────────────────────────────────────────────────────────
 * Routes:
 *   GET    /api/health                          -> { status: "ok" }
 *   *      /api/auth/*                          -> handleAuthApi (Signup, Login, Logout, Me)
 *   *      /api/admin/*                         -> handleAdminApi (User management, Claim legacy exams)
 *   WS     /api/exam/:sessionId                 -> ExamSessionDO (student proctoring socket, auth & user_id bound)
 *   WS     /api/hub/:examId                     -> ExamHubDO (professor live monitor socket, auth & ownership bound)
 *   *      /api/professor/*                     -> handleProfessorApi (Exam management, grading, sessions)
 *   *      /api/student/*                       -> handleStudentApi (Exam taking, join, autosave, results)
 *   All other paths                             -> serve static React SPA (Cloudflare Assets)
 * ─────────────────────────────────────────────────────────────────
 */

export { ExamSessionDO } from './ExamSessionDO.js';
export { ExamHubDO } from './ExamHubDO.js';
import { handleAuthApi } from './api/auth.js';
import { handleAdminApi } from './api/admin.js';
import { handleProfessorApi } from './api/exams.js';
import { handleStudentApi } from './api/student.js';
import { runAutoEndSweep } from './api/grading.js';
import { runRetentionSweep } from './api/sessions.js';
import { jsonNotFound } from './utils/internalAuth.js';
import { requireAuth, isAuthResponse } from './auth/requireAuth.js';
import { canAccessExam } from './utils/auth.js';
import { verifyOrigin } from './utils/csrf.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // ── Health check ─────────────────────────────────────────────────────────
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok' });
    }

    // ── CSRF & Cross-Site WebSocket Protection ────────────────────────────────
    // Required for every non-GET request and WebSocket upgrade
    const csrfErr = await verifyOrigin(request, env as any);
    if (csrfErr) {
      return csrfErr;
    }

    // ── Authentication REST API (Phase 5a) ────────────────────────────────────
    if (url.pathname.startsWith('/api/auth/')) {
      return handleAuthApi(request, env as any);
    }

    // ── Admin Management REST API (Phase 5a) ──────────────────────────────────
    if (url.pathname.startsWith('/api/admin/')) {
      return handleAdminApi(request, env as any);
    }

    // ── WebSocket route for exam sessions (Student / Preview) ─────────────────
    // Forward ONLY exact /api/exam/:sessionId with header Upgrade: websocket.
    // Session ID must match ^[A-Za-z0-9_-]{1,64}$.
    // Requires authenticated user whose account owns the attempt.
    if (url.pathname.startsWith('/api/exam/') || url.pathname === '/api/exam') {
      const examMatch = url.pathname.match(/^\/api\/exam\/([A-Za-z0-9_-]{1,64})$/);
      const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

      if (!examMatch || !isWs) {
        return jsonNotFound();
      }

      const sessionId = examMatch[1];

      // 1. Authenticate user via cookie
      const auth = await requireAuth(request, env as any);
      if (isAuthResponse(auth)) {
        return auth;
      }
      const user = auth.user;

      // 2. Validate attempt ownership in D1 before contacting DO
      let examId = '';
      let studentName = user.name;
      if (env.DB) {
        const attempt = await env.DB.prepare(
          'SELECT id, exam_id, user_id, student_name, is_test FROM attempts WHERE session_id = ?',
        )
          .bind(sessionId)
          .first<{ id: string; exam_id: string; user_id: string | null; student_name: string | null; is_test: number }>();

        if (!attempt) {
          return jsonNotFound();
        }

        if (attempt.is_test === 1) {
          // Preview attempt: must belong to the logged-in professor or admin
          if (attempt.user_id !== user.id && user.role !== 'admin') {
            return jsonNotFound();
          }
        } else {
          // Real student attempt: must be student role AND attempt.user_id === user.id
          if (user.role !== 'student' || attempt.user_id !== user.id) {
            return jsonNotFound();
          }
        }

        examId = attempt.exam_id;
        if (attempt.student_name) {
          studentName = attempt.student_name;
        }
      }

      const doId = env.EXAM_SESSION.idFromName(sessionId);
      const stub = env.EXAM_SESSION.get(doId);

      // Build identity forwarded to Durable Object from verified token ONLY (Requirement 4)
      // Strips any client-supplied identity parameters by constructing a clean internal URL
      const doUrl = new URL('http://session.internal/');
      doUrl.searchParams.set('sessionId', sessionId);
      doUrl.searchParams.set('userId', user.id);
      doUrl.searchParams.set('userRole', user.role);
      doUrl.searchParams.set('role', user.role);
      doUrl.searchParams.set('tokenVersion', String(user.token_version ?? 0));
      if (examId) {
        doUrl.searchParams.set('examId', examId);
      }
      if (studentName) {
        doUrl.searchParams.set('name', studentName);
        doUrl.searchParams.set('studentName', studentName);
      }
      return stub.fetch(new Request(doUrl.toString(), request));
    }

    // ── WebSocket route for professor hub (Live Monitor) ─────────────────────
    // Forward ONLY exact /api/hub/:examId with header Upgrade: websocket.
    // Requires professor or admin role with canAccessExam.
    if (url.pathname.startsWith('/api/hub/') || url.pathname === '/api/hub') {
      const hubMatch = url.pathname.match(/^\/api\/hub\/([A-Za-z0-9_-]{1,64})$/);
      const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

      if (!hubMatch || !isWs) {
        return jsonNotFound();
      }

      const examId = hubMatch[1];

      // 1. Authenticate user: professor or admin only
      const auth = await requireAuth(request, env as any, ['professor', 'admin']);
      if (isAuthResponse(auth)) {
        return auth;
      }
      const user = auth.user;

      // 2. Ownership check: exam must exist and user must have access
      if (env.DB) {
        const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?')
          .bind(examId)
          .first<Record<string, unknown>>();

        if (!exam || !canAccessExam(exam, user)) {
          // Return 404, not 403, for another professor's exam
          return jsonNotFound();
        }
      }

      const hubId = env.EXAM_HUB.idFromName(examId);
      const stub = env.EXAM_HUB.get(hubId);

      // Build identity forwarded to Durable Object from verified token ONLY (Requirement 4)
      // Strips any client-supplied identity parameters by constructing a clean internal URL
      const hubUrl = new URL('http://hub.internal/ws');
      hubUrl.searchParams.set('userId', user.id);
      hubUrl.searchParams.set('userRole', user.role);
      hubUrl.searchParams.set('role', user.role);
      hubUrl.searchParams.set('examId', examId);
      hubUrl.searchParams.set('tokenVersion', String(user.token_version ?? 0));
      return stub.fetch(new Request(hubUrl.toString(), request));
    }

    // ── Professor exam management REST API (Phase 4a & 5a, D1) ───────────────
    if (url.pathname.startsWith('/api/professor')) {
      return handleProfessorApi(request, env as any);
    }

    // ── Student exam-taking REST API (Phase 4b & 5a, D1) ──────────────────────
    if (url.pathname.startsWith('/api/student')) {
      return handleStudentApi(request, env as any);
    }

    // ── Any other /api/ path returns JSON 404 ─────────────────────────────────
    if (url.pathname.startsWith('/api/')) {
      return jsonNotFound();
    }

    // ── Catch-all: let Cloudflare serve the React SPA assets ──────────────────
    // The SPA index.html fallback applies ONLY to non-/api/ GET requests accepting text/html.
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
