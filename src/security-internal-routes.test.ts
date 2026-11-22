/**
 * src/security-internal-routes.test.ts — Security & Defense-in-Depth Tests
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies:
 *   1. Public GET/POST to /api/exam/x/history, /end, /purge, /command, /session-event returns 404 JSON.
 *   2. Public GET to /api/hub/x/internal/sessions and other internal hub paths returns 404 JSON.
 *   3. Any unknown request under /api/* returns JSON 404, not HTML.
 *   4. SPA index.html fallback only applies to non-/api/ GET requests that accept text/html.
 *   5. Each internal handler in ExamSessionDO & ExamHubDO called without X-Internal-Auth or with wrong value returns 403.
 *   6. WebSocket upgrade for a session id with no attempts row returns 404 and creates no stored state.
 *   7. Valid sessions and preview attempts connect successfully.
 *   8. Professor internal history lookup (/api/professor/exams/:id/sessions/:sessionId/history) works.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect } from 'vitest';
import worker from '../worker/index';
import { ExamSessionDO } from '../worker/ExamSessionDO';
import { ExamHubDO } from '../worker/ExamHubDO';
import { constantTimeCompare, verifyInternalAuth } from '../worker/utils/internalAuth';
import { signJwt } from '../worker/auth/jwt';
import { serializeAuthCookie } from '../worker/auth/cookies';
import type { User } from '../worker/auth/types';

// ─── Test Helpers & Mocks ────────────────────────────────────────────────────

const TEST_JWT_SECRET = 'jwt-secret-key-for-test-32bytes-long-super-secure!';

const mockProfUser: User = {
  id: 'prof-test',
  email: 'prof@test.com',
  name: 'Professor Test',
  role: 'professor',
  password_hash: '',
  password_salt: '',
  student_id: null,
  department: null,
  active: 1,
  token_version: 0,
  created_at: new Date().toISOString(),
  last_login_at: null,
};

const mockStudentUser: User = {
  id: 'student-test',
  email: 'student@test.com',
  name: 'Student Test',
  role: 'student',
  password_hash: '',
  password_salt: '',
  student_id: 'S1',
  department: null,
  active: 1,
  token_version: 0,
  created_at: new Date().toISOString(),
  last_login_at: null,
};

async function createProfCookie() {
  const token = await signJwt({ sub: 'prof-test', role: 'professor', tv: 0 }, TEST_JWT_SECRET);
  return serializeAuthCookie(token);
}

async function createStudentCookie() {
  const token = await signJwt({ sub: 'student-test', role: 'student', tv: 0 }, TEST_JWT_SECRET);
  return serializeAuthCookie(token);
}

interface MockDbConfig {
  attempts?: Record<string, unknown>[];
  exams?: Record<string, unknown>[];
}

function createMockDb(config: MockDbConfig = {}) {
  const attempts = [...(config.attempts ?? [])];
  const exams = [...(config.exams ?? [])];
  const runLogs: Array<{ query: string; params: unknown[] }> = [];

  function makeStatement(query: string, boundArgs: unknown[] = []) {
    return {
      bind(...args: unknown[]) {
        return makeStatement(query, args);
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        if (query.includes('FROM users WHERE id = ?')) {
          const id = boundArgs[0];
          return (id === 'prof-test' ? mockProfUser : mockStudentUser) as T | null;
        }
        if (query.includes('FROM attempts WHERE session_id = ?')) {
          const sessId = boundArgs[0];
          const found = attempts.find((a) => a.session_id === sessId);
          return (found ? { user_id: 'student-test', is_test: 0, ...found } : null) as T | null;
        }
        if (query.includes('FROM attempts WHERE exam_id = ? AND session_id = ?')) {
          const examId = boundArgs[0];
          const sessId = boundArgs[1];
          const found = attempts.find((a) => a.exam_id === examId && a.session_id === sessId);
          return (found ? { user_id: 'student-test', is_test: 0, ...found } : null) as T | null;
        }
        if (query.includes('FROM exams WHERE id = ?')) {
          const examId = boundArgs[0];
          const found = exams.find((e) => e.id === examId);
          return (found ? { created_by: 'prof-test', ...found } : null) as T | null;
        }
        return null;
      },
      async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
        return { results: [] };
      },
      async run() {
        runLogs.push({ query, params: boundArgs });
        return { success: true };
      },
    };
  }

  return {
    prepare(query: string) {
      return makeStatement(query);
    },
    attempts,
    exams,
    runLogs,
  };
}

function createMockState() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined,
      put: async (key: string, value: unknown): Promise<void> => {
        store.set(key, value);
      },
      delete: async (key: string): Promise<boolean> => store.delete(key),
      deleteAll: async (): Promise<void> => {
        store.clear();
      },
    },
    store,
  };
}

const TEST_INTERNAL_SECRET = 'secret-internal-key-for-test-32bytes-long!';

function createMockEnv(db: ReturnType<typeof createMockDb>) {
  const doFetchCalls: Array<{ target: string; url: string; headers: Headers }> = [];

  const mockSessionDO = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString: () => string }) => ({
      fetch: async (reqOrUrl: string | Request, init?: RequestInit) => {
        const urlStr = typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url;
        const headers = new Headers(typeof reqOrUrl === 'string' ? init?.headers : reqOrUrl.headers);
        doFetchCalls.push({ target: 'session', url: urlStr, headers });
        return new Response(JSON.stringify({ ok: true, sessionId: id.toString() }), { status: 200 });
      },
    }),
  };

  const mockHubDO = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString: () => string }) => ({
      fetch: async (reqOrUrl: string | Request, init?: RequestInit) => {
        const urlStr = typeof reqOrUrl === 'string' ? reqOrUrl : reqOrUrl.url;
        const headers = new Headers(typeof reqOrUrl === 'string' ? init?.headers : reqOrUrl.headers);
        doFetchCalls.push({ target: 'hub', url: urlStr, headers });
        return new Response(JSON.stringify({ ok: true, examId: id.toString() }), { status: 200 });
      },
    }),
  };

  const assets = {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === '/index.html') {
        return new Response('<!DOCTYPE html><html><body>React SPA App</body></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }
      return new Response('Not found', { status: 404 });
    },
  };

  return {
    DB: db as unknown as D1Database,
    INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    JWT_SECRET: TEST_JWT_SECRET,
    EXAM_SESSION: mockSessionDO as unknown as DurableObjectNamespace,
    EXAM_HUB: mockHubDO as unknown as DurableObjectNamespace,
    ASSETS: assets as unknown as Fetcher,
    doFetchCalls,
  };
}

describe('Security & Internal Durable Object Routes', () => {
  // ── 1. Constant-Time Comparison Utility ────────────────────────────────────
  describe('constantTimeCompare', () => {
    it('compares identical strings correctly', () => {
      expect(constantTimeCompare('secret123', 'secret123')).toBe(true);
    });

    it('rejects differing strings without early exit timing leaks', () => {
      expect(constantTimeCompare('secret123', 'secret124')).toBe(false);
      expect(constantTimeCompare('secret123', 'secret12')).toBe(false);
      expect(constantTimeCompare('secret12', 'secret123')).toBe(false);
      expect(constantTimeCompare('a', 'b')).toBe(false);
    });

    it('rejects empty, null, or undefined strings', () => {
      expect(constantTimeCompare('', '')).toBe(false);
      expect(constantTimeCompare('secret', '')).toBe(false);
      expect(constantTimeCompare('', 'secret')).toBe(false);
      expect(constantTimeCompare(null, 'secret')).toBe(false);
      expect(constantTimeCompare('secret', undefined)).toBe(false);
    });

    it('verifyInternalAuth checks request header against env.INTERNAL_SECRET', () => {
      const validReq = new Request('http://localhost/test', {
        headers: { 'X-Internal-Auth': 'my-secret' },
      });
      expect(verifyInternalAuth(validReq, { INTERNAL_SECRET: 'my-secret' })).toBe(true);

      const invalidReq = new Request('http://localhost/test', {
        headers: { 'X-Internal-Auth': 'wrong-secret' },
      });
      expect(verifyInternalAuth(invalidReq, { INTERNAL_SECRET: 'my-secret' })).toBe(false);

      const missingReq = new Request('http://localhost/test');
      expect(verifyInternalAuth(missingReq, { INTERNAL_SECRET: 'my-secret' })).toBe(false);

      expect(verifyInternalAuth(validReq, {})).toBe(false);
    });
  });

  // ── 2. Strict Public Route Enforcement (worker/index.ts) ───────────────────
  describe('Strict Public Routes Enforcement', () => {
    it('returns JSON 404 for public requests to /api/exam/x/history, /end, /purge, /command, /session-event', async () => {
      const db = createMockDb();
      const env = createMockEnv(db);

      const forbiddenEndpoints = [
        { path: '/api/exam/x/history', method: 'GET' },
        { path: '/api/exam/x/end', method: 'POST' },
        { path: '/api/exam/x/purge', method: 'POST' },
        { path: '/api/exam/x/command', method: 'POST' },
        { path: '/api/exam/x/session-event', method: 'POST' },
      ];

      for (const ep of forbiddenEndpoints) {
        const req = new Request(`http://localhost${ep.path}`, {
          method: ep.method,
          headers: { Origin: 'http://localhost' },
        });
        const res = await worker.fetch(req, env as any);

        expect(res.status).toBe(404);
        expect(res.headers.get('Content-Type')).toContain('application/json');
        const body = await res.json();
        expect(body).toEqual({
          error: {
            code: 'not_found',
            message: 'Not found',
          },
        });
      }

      // No DO fetch should have been invoked
      expect(env.doFetchCalls.length).toBe(0);
    });

    it('returns JSON 404 for public requests to /api/hub/x/internal/sessions and internal hub sub-paths', async () => {
      const db = createMockDb();
      const env = createMockEnv(db);

      const endpoints = [
        { path: '/api/hub/exam-1/internal/sessions', method: 'GET' },
        { path: '/api/hub/exam-1/internal/remove-session', method: 'POST' },
        { path: '/api/hub/exam-1/session-event', method: 'POST' },
      ];

      for (const ep of endpoints) {
        const req = new Request(`http://localhost${ep.path}`, {
          method: ep.method,
          headers: { Origin: 'http://localhost' },
        });
        const res = await worker.fetch(req, env as any);

        expect(res.status).toBe(404);
        expect(res.headers.get('Content-Type')).toContain('application/json');
        const body = await res.json();
        expect(body).toEqual({
          error: {
            code: 'not_found',
            message: 'Not found',
          },
        });
      }

      expect(env.doFetchCalls.length).toBe(0);
    });

    it('returns JSON 404 for plain HTTP requests to /api/exam/:sessionId without WebSocket upgrade', async () => {
      const db = createMockDb({
        attempts: [{ session_id: 'sess-active-1', id: 'att-1' }],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/exam/sess-active-1', { method: 'GET' });
      const res = await worker.fetch(req, env as any);

      expect(res.status).toBe(404);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const body = await res.json();
      expect(body).toEqual({
        error: { code: 'not_found', message: 'Not found' },
      });
    });

    it('returns JSON 404 for plain HTTP requests to /api/hub/:examId without WebSocket upgrade', async () => {
      const db = createMockDb({
        exams: [{ id: 'exam-1' }],
      });
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/hub/exam-1', { method: 'GET' });
      const res = await worker.fetch(req, env as any);

      expect(res.status).toBe(404);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const body = await res.json();
      expect(body).toEqual({
        error: { code: 'not_found', message: 'Not found' },
      });
    });

    it('returns JSON 404 for session id with invalid characters or excessive length', async () => {
      const db = createMockDb();
      const env = createMockEnv(db);

      const invalidReq1 = new Request('http://localhost/api/exam/sess!invalid@id', {
        headers: { Upgrade: 'websocket', Origin: 'http://localhost' },
      });
      const res1 = await worker.fetch(invalidReq1, env as any);
      expect(res1.status).toBe(404);

      const tooLongId = 'a'.repeat(65);
      const invalidReq2 = new Request(`http://localhost/api/exam/${tooLongId}`, {
        headers: { Upgrade: 'websocket', Origin: 'http://localhost' },
      });
      const res2 = await worker.fetch(invalidReq2, env as any);
      expect(res2.status).toBe(404);
    });

    it('returns JSON 404 for any unknown /api/* path, never falling back to HTML', async () => {
      const db = createMockDb();
      const env = createMockEnv(db);

      const req = new Request('http://localhost/api/unknown-random-route', {
        method: 'GET',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      const res = await worker.fetch(req, env as any);

      expect(res.status).toBe(404);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const body = await res.json();
      expect(body).toEqual({
        error: {
          code: 'not_found',
          message: 'Not found',
        },
      });
    });

    it('applies SPA index.html fallback ONLY to non-/api/ GET requests that accept text/html', async () => {
      const db = createMockDb();
      const env = createMockEnv(db);

      // 1. Non-/api/ HTML request -> returns index.html
      const htmlReq = new Request('http://localhost/professor/dashboard', {
        method: 'GET',
        headers: { Accept: 'text/html' },
      });
      const htmlRes = await worker.fetch(htmlReq, env as any);
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get('Content-Type')).toContain('text/html');
      const htmlBody = await htmlRes.text();
      expect(htmlBody).toContain('React SPA App');

      // 2. Non-/api/ non-HTML request -> returns 404
      const assetReq = new Request('http://localhost/missing-script.js', {
        method: 'GET',
        headers: { Accept: '*/*' },
      });
      const assetRes = await worker.fetch(assetReq, env as any);
      expect(assetRes.status).toBe(404);
    });
  });

  // ── 3. No State for Unknown Sessions ───────────────────────────────────────
  describe('No State for Unknown Sessions', () => {
    it('WebSocket upgrade for session id with no attempts row returns 404 and creates no DO state', async () => {
      const db = createMockDb({
        attempts: [], // Empty attempts table
      });
      const env = createMockEnv(db);
      const studentCookie = await createStudentCookie();

      const req = new Request('http://localhost/api/exam/unknown-session-1234', {
        headers: { Upgrade: 'websocket', Origin: 'http://localhost', Cookie: studentCookie },
      });

      const res = await worker.fetch(req, env as any);
      expect(res.status).toBe(404);
      expect(res.headers.get('Content-Type')).toContain('application/json');
      const body = await res.json();
      expect(body.error.code).toBe('not_found');

      // DO was not contacted
      expect(env.doFetchCalls.length).toBe(0);
    });

    it('ExamSessionDO itself checks D1 before accepting WS and refuses unknown sessions with 404', async () => {
      const db = createMockDb({ attempts: [] });
      const mockState = createMockState();
      const mockDOEnv = {
        DB: db as unknown as D1Database,
        INTERNAL_SECRET: TEST_INTERNAL_SECRET,
      };

      const sessionDO = new ExamSessionDO(mockState as any, mockDOEnv as any);
      const wsReq = new Request('http://localhost/api/exam/unknown-direct-sess?sessionId=unknown-direct-sess', {
        headers: { Upgrade: 'websocket' },
      });

      const res = await sessionDO.fetch(wsReq);
      expect(res.status).toBe(404);
      // No storage was initialized or written
      expect(mockState.store.size).toBe(0);
    });

    it('WebSocket upgrade forwards when attempts row exists (including preview attempts)', async () => {
      const db = createMockDb({
        attempts: [
          {
            id: 'att-preview-1',
            exam_id: 'exam-1',
            session_id: 'sess-preview-1',
            student_name: 'Preview-ABCD',
            user_id: 'prof-test',
            is_test: 1,
          },
        ],
      });
      const env = createMockEnv(db);
      const profCookie = await createProfCookie();

      const req = new Request('http://localhost/api/exam/sess-preview-1', {
        headers: { Upgrade: 'websocket', Origin: 'http://localhost', Cookie: profCookie },
      });

      const res = await worker.fetch(req, env as any);
      expect(res.status).toBe(200);
      expect(env.doFetchCalls.length).toBe(1);
      expect(env.doFetchCalls[0].url).toContain('sessionId=sess-preview-1');
    });
  });

  // ── 4. Defense in Depth: Internal Handlers Reject Without X-Internal-Auth ─
  describe('Defense in Depth: Internal Handlers Reject Without X-Internal-Auth', () => {
    it('ExamSessionDO rejects /history, /command, /purge, /end with 403 when X-Internal-Auth is missing or invalid', async () => {
      const db = createMockDb();
      const mockState = createMockState();
      const mockDOEnv = {
        DB: db as unknown as D1Database,
        INTERNAL_SECRET: TEST_INTERNAL_SECRET,
      };

      const sessionDO = new ExamSessionDO(mockState as any, mockDOEnv as any);

      const endpoints = [
        { path: 'http://internal/history?sessionId=sess-1', method: 'GET' },
        { path: 'http://internal/command?sessionId=sess-1', method: 'POST', body: { action: 'warn' } },
        { path: 'http://internal/purge?sessionId=sess-1', method: 'POST' },
        { path: 'http://internal/end?sessionId=sess-1', method: 'POST', body: { endedReason: 'submitted' } },
      ];

      for (const ep of endpoints) {
        // 1. Without header -> 403
        const reqNoAuth = new Request(ep.path, {
          method: ep.method,
          headers: { 'Content-Type': 'application/json' },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        });
        const resNoAuth = await sessionDO.fetch(reqNoAuth);
        expect(resNoAuth.status).toBe(403);
        const bodyNoAuth = await resNoAuth.json();
        expect(bodyNoAuth.error.code).toBe('forbidden');

        // 2. With wrong header -> 403
        const reqWrongAuth = new Request(ep.path, {
          method: ep.method,
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Auth': 'incorrect-token',
          },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        });
        const resWrongAuth = await sessionDO.fetch(reqWrongAuth);
        expect(resWrongAuth.status).toBe(403);
      }
    });

    it('ExamSessionDO accepts internal endpoints when valid X-Internal-Auth is provided', async () => {
      const db = createMockDb();
      const mockState = createMockState();
      const mockDOEnv = {
        DB: db as unknown as D1Database,
        INTERNAL_SECRET: TEST_INTERNAL_SECRET,
      };

      const sessionDO = new ExamSessionDO(mockState as any, mockDOEnv as any);
      sessionDO.session = {
        sessionId: 'sess-auth-ok',
        riskScore: 10,
        riskHistory: [],
        violations: [],
      };

      const reqAuthOk = new Request('http://internal/history?sessionId=sess-auth-ok', {
        method: 'GET',
        headers: { 'X-Internal-Auth': TEST_INTERNAL_SECRET },
      });

      const resAuthOk = await sessionDO.fetch(reqAuthOk);
      expect(resAuthOk.status).toBe(200);
      const data = await resAuthOk.json();
      expect(data.sessionId).toBe('sess-auth-ok');
    });

    it('ExamHubDO rejects internal handlers with 403 when X-Internal-Auth is missing or invalid', async () => {
      const mockState = createMockState();
      const mockDOEnv = {
        INTERNAL_SECRET: TEST_INTERNAL_SECRET,
      };

      const hubDO = new ExamHubDO(mockState as any, mockDOEnv as any);

      const endpoints = [
        {
          path: 'http://internal/session-event',
          method: 'POST',
          body: {
            summary: {
              sessionId: 's1',
              studentName: 'Alice',
              riskScore: 0,
              violationCount: 0,
              status: 'active',
              lastUpdate: new Date().toISOString(),
            },
          },
        },
        { path: 'http://internal/internal/sessions', method: 'GET' },
        { path: 'http://internal/internal/history/s1', method: 'GET' },
        { path: 'http://internal/internal/remove-session', method: 'POST', body: { sessionId: 's1' } },
        {
          path: 'http://internal/command-ack',
          method: 'POST',
          body: { interventionId: 'i1', sessionId: 's1', action: 'warn', acknowledgedAt: new Date().toISOString() },
        },
      ];

      for (const ep of endpoints) {
        // Without header -> 403
        const reqNoAuth = new Request(ep.path, {
          method: ep.method,
          headers: { 'Content-Type': 'application/json' },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        });
        const resNoAuth = await hubDO.fetch(reqNoAuth);
        expect(resNoAuth.status).toBe(403);
        const bodyNoAuth = await resNoAuth.json();
        expect(bodyNoAuth.error.code).toBe('forbidden');

        // With wrong header -> 403
        const reqWrongAuth = new Request(ep.path, {
          method: ep.method,
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Auth': 'bad-token',
          },
          body: ep.body ? JSON.stringify(ep.body) : undefined,
        });
        const resWrongAuth = await hubDO.fetch(reqWrongAuth);
        expect(resWrongAuth.status).toBe(403);
      }
    });

    it('ExamHubDO accepts internal endpoints when valid X-Internal-Auth is provided', async () => {
      const mockState = createMockState();
      const mockDOEnv = {
        INTERNAL_SECRET: TEST_INTERNAL_SECRET,
      };

      const hubDO = new ExamHubDO(mockState as any, mockDOEnv as any);

      const reqAuthOk = new Request('http://internal/internal/sessions', {
        method: 'GET',
        headers: { 'X-Internal-Auth': TEST_INTERNAL_SECRET },
      });

      const resAuthOk = await hubDO.fetch(reqAuthOk);
      expect(resAuthOk.status).toBe(200);
      const data = await resAuthOk.json();
      expect(data).toHaveProperty('sessions');
    });

    // ── Fail-Closed Checks ───────────────────────────────────────────────────
    describe('Fail-Closed Behavior (secret unset, secret empty, header missing, header empty, header wrong)', () => {
      it('verifyInternalAuth fails closed in all invalid configurations', () => {
        const makeReq = (headerVal?: string) => {
          const headers = new Headers();
          if (headerVal !== undefined) headers.set('X-Internal-Auth', headerVal);
          return new Request('http://internal/test', { headers });
        };

        // 1. Secret unset
        expect(verifyInternalAuth(makeReq(), {})).toBe(false);
        expect(verifyInternalAuth(makeReq(''), {})).toBe(false);
        expect(verifyInternalAuth(makeReq('some-token'), {})).toBe(false);
        expect(verifyInternalAuth(makeReq(), { INTERNAL_SECRET: undefined })).toBe(false);

        // 2. Secret empty string
        expect(verifyInternalAuth(makeReq(), { INTERNAL_SECRET: '' })).toBe(false);
        expect(verifyInternalAuth(makeReq(''), { INTERNAL_SECRET: '' })).toBe(false);
        expect(verifyInternalAuth(makeReq('some-token'), { INTERNAL_SECRET: '' })).toBe(false);

        // 2b. Secret whitespace only
        expect(verifyInternalAuth(makeReq(), { INTERNAL_SECRET: '   ' })).toBe(false);
        expect(verifyInternalAuth(makeReq('   '), { INTERNAL_SECRET: '   ' })).toBe(false);

        // 3. Header missing (with valid secret configured)
        expect(verifyInternalAuth(makeReq(), { INTERNAL_SECRET: TEST_INTERNAL_SECRET })).toBe(false);

        // 4. Header empty (with valid secret configured)
        expect(verifyInternalAuth(makeReq(''), { INTERNAL_SECRET: TEST_INTERNAL_SECRET })).toBe(false);

        // 5. Header wrong (with valid secret configured)
        expect(verifyInternalAuth(makeReq('wrong-secret-value'), { INTERNAL_SECRET: TEST_INTERNAL_SECRET })).toBe(false);

        // 6. Header correct (must pass)
        expect(verifyInternalAuth(makeReq(TEST_INTERNAL_SECRET), { INTERNAL_SECRET: TEST_INTERNAL_SECRET })).toBe(true);
      });

      it('ExamSessionDO and ExamHubDO reject internal handlers with 403 when INTERNAL_SECRET is unset or empty in env', async () => {
        const db = createMockDb();
        const mockState1 = createMockState();
        const mockState2 = createMockState();

        // Test with both unset and empty secret in env
        for (const envWithoutSecret of [{}, { INTERNAL_SECRET: '' }, { INTERNAL_SECRET: undefined }]) {
          const sessionDO = new ExamSessionDO(mockState1 as any, { DB: db as any, ...envWithoutSecret } as any);
          const hubDO = new ExamHubDO(mockState2 as any, { ...envWithoutSecret } as any);

          // Internal session handler: even with empty header or arbitrary header, returns 403
          const sessionReq = new Request('http://internal/history?sessionId=sess-1', {
            headers: { 'X-Internal-Auth': '' },
          });
          const sessionRes = await sessionDO.fetch(sessionReq);
          expect(sessionRes.status).toBe(403);

          // Internal hub handler: returns 403
          const hubReq = new Request('http://internal/internal/sessions', {
            headers: { 'X-Internal-Auth': '' },
          });
          const hubRes = await hubDO.fetch(hubReq);
          expect(hubRes.status).toBe(403);
        }
      });
    });
  });

  // ── 5. Internal Professor History Lookup Route ─────────────────────────────
  describe('Internal Professor History Lookup Route', () => {
    it('allows authorized professors to lookup session history via /api/professor/exams/:id/sessions/:sessionId/history', async () => {
      const db = createMockDb({
        exams: [{ id: 'exam-1', created_by: 'prof-test' }],
        attempts: [
          {
            id: 'att-1',
            exam_id: 'exam-1',
            session_id: 'sess-history-ok',
            student_name: 'Alice',
            user_id: 'student-test',
            data_purged_at: null,
          },
        ],
      });
      const env = createMockEnv(db);
      const profCookie = await createProfCookie();

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/sess-history-ok/history', {
        method: 'GET',
        headers: {
          Cookie: profCookie,
        },
      });

      const res = await worker.fetch(req, env as any);
      expect(res.status).toBe(200);

      // Verify the internal call sent X-Internal-Auth
      expect(env.doFetchCalls.length).toBe(1);
      const call = env.doFetchCalls[0];
      expect(call.target).toBe('session');
      expect(call.url).toContain('/history');
      expect(call.headers.get('X-Internal-Auth')).toBe(TEST_INTERNAL_SECRET);
    });

    it('returns purged notice if session data was purged by retention policy', async () => {
      const db = createMockDb({
        exams: [{ id: 'exam-1', created_by: 'prof-test' }],
        attempts: [
          {
            id: 'att-purged',
            exam_id: 'exam-1',
            session_id: 'sess-purged-1',
            student_name: 'Bob',
            user_id: 'student-test',
            data_purged_at: new Date().toISOString(),
          },
        ],
      });
      const env = createMockEnv(db);
      const profCookie = await createProfCookie();

      const req = new Request('http://localhost/api/professor/exams/exam-1/sessions/sess-purged-1/history', {
        method: 'GET',
        headers: {
          Cookie: profCookie,
        },
      });

      const res = await worker.fetch(req, env as any);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.purged).toBe(true);
      expect(data.message).toContain('retention policy');

      // DO was not called because data is already marked purged
      expect(env.doFetchCalls.length).toBe(0);
    });

    it('rejects history lookup with 404 when session exists but belongs to a different exam (cross-exam isolation)', async () => {
      const db = createMockDb({
        exams: [
          { id: 'exam-A', created_by: 'prof-test' },
          { id: 'exam-B', created_by: 'prof-test' },
        ],
        attempts: [
          {
            id: 'att-b',
            exam_id: 'exam-B', // session belongs to exam-B
            session_id: 'sess-belonging-to-b',
            student_name: 'Charlie',
            user_id: 'student-test',
            data_purged_at: null,
          },
        ],
      });
      const env = createMockEnv(db);
      const profCookie = await createProfCookie();

      // Professor queries exam-A with a session ID that belongs to exam-B
      const req = new Request('http://localhost/api/professor/exams/exam-A/sessions/sess-belonging-to-b/history', {
        method: 'GET',
        headers: {
          Cookie: profCookie,
        },
      });

      const res = await worker.fetch(req, env as any);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Session not found in this exam');

      // The DO was never contacted
      expect(env.doFetchCalls.length).toBe(0);
    });
  });
});

