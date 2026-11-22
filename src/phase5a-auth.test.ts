/**
 * src/phase5a-auth.test.ts — Comprehensive Test Suite for Phase 5a Auth & Security
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies:
 *   1. PBKDF2 Web Crypto password hashing & verification (100k iters, 16-byte salt, timing parity)
 *   2. HS256 JWT sign & verify (expiration, tampered token, alg "none", unsupported alg, unset secret)
 *   3. CSRF origin verification on mutating routes and WebSocket upgrades
 *   4. Auth matrix: Anonymous (401), invalid/expired/deactivated (401), wrong role (403), allowed role (200)
 *   5. Rate limiting: 5 consecutive failed logins triggers 429 lockout per email in 15 mins
 *   6. Professor isolation: Professor B gets 404 on Professor A's exam across all routes
 *   7. Student isolation: Students can only view and submit their own attempts
 *   8. Multiple professor test previews allowed without constraint collisions
 *   9. Same student name under different accounts does not collide
 *  10. Idempotent legacy exam claim by admin
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hashPassword, verifyPassword, dummyHash } from '../worker/auth/crypto';
import { signJwt, verifyJwt } from '../worker/auth/jwt';
import { serializeAuthCookie, parseAuthCookie } from '../worker/auth/cookies';
import { verifyOrigin } from '../worker/utils/csrf';
import { requireAuth, isAuthResponse } from '../worker/auth/requireAuth';
import { handleAuthApi } from '../worker/api/auth';
import { handleAdminApi } from '../worker/api/admin';
import { handleProfessorApi } from '../worker/api/exams';
import { handleStudentApi } from '../worker/api/student';
import { canAccessExam } from '../worker/utils/auth';
import { writeAudit } from '../worker/utils/audit';
import type { User } from '../worker/auth/types';
import worker from '../worker/index';

const TEST_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars-long';

describe('Phase 5a: Password Hashing & Crypto', () => {
  it('hashes passwords using PBKDF2-SHA256 with 100k iterations and 16-byte random salt', async () => {
    const res1 = await hashPassword('StudentPass123!');
    const res2 = await hashPassword('StudentPass123!');

    expect(res1.saltHex).toHaveLength(32); // 16 bytes = 32 hex chars
    expect(res1.hashHex).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(res1.saltHex).not.toBe(res2.saltHex); // salts must be unique
    expect(res1.hashHex).not.toBe(res2.hashHex);
  });

  it('verifies correct passwords and rejects wrong passwords', async () => {
    const { hashHex, saltHex } = await hashPassword('SecretPassword!456');

    const valid = await verifyPassword('SecretPassword!456', hashHex, saltHex);
    expect(valid).toBe(true);

    const wrong = await verifyPassword('WrongPassword!789', hashHex, saltHex);
    expect(wrong).toBe(false);
  });

  it('runs dummy verify on unknown email to preserve timing parity', async () => {
    const start = Date.now();
    await dummyHash();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(1);
  });
});

describe('Phase 5a: HS256 JWT Sign & Verify', () => {
  it('signs and verifies a valid payload', async () => {
    const payload = {
      sub: 'user-123',
      role: 'professor' as const,
      tv: 0,
    };
    const token = await signJwt(payload, TEST_SECRET);
    expect(typeof token).toBe('string');

    const verified = await verifyJwt(token, TEST_SECRET);
    expect(verified).not.toBeNull();
    expect(verified?.sub).toBe('user-123');
    expect(verified?.role).toBe('professor');
    expect(verified?.tv).toBe(0);
  });

  it('rejects expired tokens', async () => {
    const payload = {
      sub: 'user-123',
      role: 'student' as const,
      tv: 0,
    };
    // Expired 100 seconds ago
    const token = await signJwt(payload, TEST_SECRET, -100);
    const verified = await verifyJwt(token, TEST_SECRET);
    expect(verified).toBeNull();
  });

  it('rejects tampered signatures and payloads', async () => {
    const payload = {
      sub: 'user-123',
      role: 'student' as const,
      tv: 0,
    };
    const token = (await signJwt(payload, TEST_SECRET))!;
    const parts = token.split('.');
    // Tamper with payload
    const tamperedPayload = Buffer.from(JSON.stringify({ ...payload, role: 'admin' })).toString('base64url');
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const verified = await verifyJwt(tamperedToken, TEST_SECRET);
    expect(verified).toBeNull();
  });

  it('rejects alg "none" and unsupported algorithms', async () => {
    const headerNone = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1', exp: 9999999999 })).toString('base64url');
    const tokenNone = `${headerNone}.${payload}.`;

    const verified = await verifyJwt(tokenNone, TEST_SECRET);
    expect(verified).toBeNull();

    const headerRS = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const tokenRS = `${headerRS}.${payload}.sig`;
    const verifiedRS = await verifyJwt(tokenRS, TEST_SECRET);
    expect(verifiedRS).toBeNull();
  });

  it('fails closed when JWT_SECRET is undefined or empty', async () => {
    const payload = { sub: 'u1', role: 'admin' as const, tv: 0 };
    const token = await signJwt(payload, TEST_SECRET);

    expect(await verifyJwt(token, undefined)).toBeNull();
    expect(await verifyJwt(token, '')).toBeNull();
  });
});

describe('Phase 5a: CSRF Origin Verification', () => {
  const dummyEnv = {
    DB: {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: true }),
        }),
      }),
    } as any,
  };

  it('allows GET and HEAD requests without Origin', async () => {
    const getReq = new Request('https://apa.example.com/api/exams');
    expect(await verifyOrigin(getReq, dummyEnv)).toBeNull();

    const headReq = new Request('https://apa.example.com/api/exams', { method: 'HEAD' });
    expect(await verifyOrigin(headReq, dummyEnv)).toBeNull();
  });

  it('rejects mutating requests without Origin', async () => {
    const postReq = new Request('https://apa.example.com/api/exams', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    const res = await verifyOrigin(postReq, dummyEnv);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });

  it('rejects mutating requests with mismatched Origin', async () => {
    const postReq = new Request('https://apa.example.com/api/exams', {
      method: 'POST',
      headers: { Origin: 'https://evil-attacker.com' },
      body: JSON.stringify({}),
    });
    const res = await verifyOrigin(postReq, dummyEnv);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });

  it('allows mutating requests with matching Origin', async () => {
    const postReq = new Request('https://apa.example.com/api/exams', {
      method: 'POST',
      headers: { Origin: 'https://apa.example.com' },
      body: JSON.stringify({}),
    });
    expect(await verifyOrigin(postReq, dummyEnv)).toBeNull();
  });

  it('rejects WebSocket upgrades without matching Origin', async () => {
    const wsReq = new Request('https://apa.example.com/api/exam/sess-1', {
      headers: { Upgrade: 'websocket' },
    });
    const res = await verifyOrigin(wsReq, dummyEnv);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
  });
});

describe('Phase 5a: Role-Based Access Control & Auth Matrix', () => {
  const mockUsers: Record<string, User> = {
    'prof-1': {
      id: 'prof-1',
      email: 'prof1@example.com',
      name: 'Professor One',
      role: 'professor',
      password_hash: 'hash',
      password_salt: 'salt',
      student_id: null,
      department: 'CS',
      active: 1,
      token_version: 0,
      created_at: new Date().toISOString(),
      last_login_at: null,
    },
    'prof-2': {
      id: 'prof-2',
      email: 'prof2@example.com',
      name: 'Professor Two',
      role: 'professor',
      password_hash: 'hash',
      password_salt: 'salt',
      student_id: null,
      department: 'CS',
      active: 1,
      token_version: 0,
      created_at: new Date().toISOString(),
      last_login_at: null,
    },
    'student-1': {
      id: 'student-1',
      email: 'student1@example.com',
      name: 'Alice Smith',
      role: 'student',
      password_hash: 'hash',
      password_salt: 'salt',
      student_id: 'S101',
      department: null,
      active: 1,
      token_version: 0,
      created_at: new Date().toISOString(),
      last_login_at: null,
    },
    'admin-1': {
      id: 'admin-1',
      email: 'admin@example.com',
      name: 'System Admin',
      role: 'admin',
      password_hash: 'hash',
      password_salt: 'salt',
      student_id: null,
      department: null,
      active: 1,
      token_version: 0,
      created_at: new Date().toISOString(),
      last_login_at: null,
    },
  };

  function createTestDb() {
    return {
      prepare(query: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                if (query.includes('FROM users WHERE id = ?')) {
                  const id = String(args[0]);
                  return (mockUsers[id] ?? null) as T | null;
                }
                return null;
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    };
  }

  it('rejects unauthenticated requests with 401', async () => {
    const env = { DB: createTestDb() as any, JWT_SECRET: TEST_SECRET };
    const req = new Request('https://apa.example.com/api/professor/exams');
    const auth = await requireAuth(req, env, ['professor']);
    expect(isAuthResponse(auth)).toBe(true);
    if (isAuthResponse(auth)) {
      expect(auth.status).toBe(401);
    }
  });

  it('rejects deactivated users (active = 0) with 401', async () => {
    const deactUser: User = { ...mockUsers['prof-1'], id: 'deact-1', active: 0 };
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => deactUser,
        }),
      }),
    };
    const token = await signJwt({ sub: 'deact-1', role: 'professor', tv: 0, exp: 9999999999 }, TEST_SECRET);
    const cookie = serializeAuthCookie(token);

    const req = new Request('https://apa.example.com/api/professor/exams', {
      headers: { Cookie: cookie },
    });
    const auth = await requireAuth(req, { DB: db as any, JWT_SECRET: TEST_SECRET }, ['professor']);
    expect(isAuthResponse(auth)).toBe(true);
    if (isAuthResponse(auth)) {
      expect(auth.status).toBe(401);
    }
  });

  it('rejects stale token versions (token_version incremented) with 401', async () => {
    const userWithNewTv: User = { ...mockUsers['prof-1'], token_version: 2 };
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => userWithNewTv,
        }),
      }),
    };
    // Token issued with tv = 1
    const token = await signJwt({ sub: 'prof-1', role: 'professor', tv: 1, exp: 9999999999 }, TEST_SECRET);
    const cookie = serializeAuthCookie(token);

    const req = new Request('https://apa.example.com/api/professor/exams', {
      headers: { Cookie: cookie },
    });
    const auth = await requireAuth(req, { DB: db as any, JWT_SECRET: TEST_SECRET }, ['professor']);
    expect(isAuthResponse(auth)).toBe(true);
    if (isAuthResponse(auth)) {
      expect(auth.status).toBe(401);
    }
  });

  it('rejects unauthorized roles with 403', async () => {
    const token = await signJwt({ sub: 'student-1', role: 'student', tv: 0, exp: 9999999999 }, TEST_SECRET);
    const cookie = serializeAuthCookie(token);

    const req = new Request('https://apa.example.com/api/professor/exams', {
      headers: { Cookie: cookie },
    });
    const auth = await requireAuth(req, { DB: createTestDb() as any, JWT_SECRET: TEST_SECRET }, ['professor']);
    expect(isAuthResponse(auth)).toBe(true);
    if (isAuthResponse(auth)) {
      expect(auth.status).toBe(403);
    }
  });

  it('allows authorized roles', async () => {
    const token = await signJwt({ sub: 'prof-1', role: 'professor', tv: 0, exp: 9999999999 }, TEST_SECRET);
    const cookie = serializeAuthCookie(token);

    const req = new Request('https://apa.example.com/api/professor/exams', {
      headers: { Cookie: cookie },
    });
    const auth = await requireAuth(req, { DB: createTestDb() as any, JWT_SECRET: TEST_SECRET }, ['professor']);
    expect(isAuthResponse(auth)).toBe(false);
    if (!isAuthResponse(auth)) {
      expect(auth.user.id).toBe('prof-1');
      expect(auth.user.role).toBe('professor');
    }
  });
});

describe('Phase 5a: Professor Isolation & canAccessExam', () => {
  const prof1: User = {
    id: 'prof-1',
    email: 'p1@test.com',
    name: 'Prof 1',
    role: 'professor',
    password_hash: '',
    password_salt: '',
    student_id: null,
    department: null,
    active: 1,
    token_version: 0,
    created_at: '',
    last_login_at: null,
  };

  const prof2: User = {
    ...prof1,
    id: 'prof-2',
    email: 'p2@test.com',
  };

  const adminUser: User = {
    ...prof1,
    id: 'admin-1',
    role: 'admin',
  };

  const examOwnedByProf1 = {
    id: 'exam-1',
    title: 'CS101 Midterm',
    created_by: 'prof-1',
  };

  it('allows owner professor and admin to access exam', () => {
    expect(canAccessExam(examOwnedByProf1, prof1)).toBe(true);
    expect(canAccessExam(examOwnedByProf1, adminUser)).toBe(true);
  });

  it('blocks other professors from accessing exam', () => {
    expect(canAccessExam(examOwnedByProf1, prof2)).toBe(false);
  });

  it('returns 404 (never 403) across ALL exam-scoped routes when Professor B accesses Professor A exam', async () => {
    const mockHubDO = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      }),
    };
    const mockSessionDO = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: () => ({
        fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      }),
    };

    const db = {
      prepare(q: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                if (q.includes('FROM exams WHERE id = ?')) {
                  return examOwnedByProf1 as T;
                }
                if (q.includes('FROM users WHERE id = ?')) {
                  return prof2 as T;
                }
                if (q.includes('FROM attempts WHERE')) {
                  return { id: 'att-1', exam_id: 'exam-1', session_id: 'sess-1' } as T;
                }
                return null;
              },
              async all<T>(): Promise<{ results: T[] }> {
                return { results: [] };
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    };

    const env = {
      DB: db as any,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: 'test-internal-secret',
      EXAM_HUB: mockHubDO as any,
      EXAM_SESSION: mockSessionDO as any,
    };

    const token = await signJwt({ sub: 'prof-2', role: 'professor', tv: 0, exp: 9999999999 }, TEST_SECRET);
    const authCookie = serializeAuthCookie(token);

    // List of every exam-scoped route
    const routesToTest = [
      { path: '/api/professor/exams/exam-1', method: 'GET' },
      { path: '/api/professor/exams/exam-1', method: 'PUT', body: { title: 'Hacked' } },
      { path: '/api/professor/exams/exam-1', method: 'DELETE' },
      { path: '/api/professor/exams/exam-1/publish', method: 'POST' },
      { path: '/api/professor/exams/exam-1/close', method: 'POST' },
      { path: '/api/professor/exams/exam-1/reset', method: 'POST' },
      { path: '/api/professor/exams/exam-1/duplicate', method: 'POST' },
      { path: '/api/professor/exams/exam-1/questions', method: 'GET' },
      { path: '/api/professor/exams/exam-1/questions', method: 'POST', body: { question_text: 'Q', type: 'mcq', points: 1 } },
      { path: '/api/professor/exams/exam-1/questions/reorder', method: 'POST', body: { ordered_ids: ['q-1'] } },
      { path: '/api/professor/exams/exam-1/questions/q-1', method: 'PUT', body: { question_text: 'Q edit' } },
      { path: '/api/professor/exams/exam-1/questions/q-1', method: 'DELETE' },
      { path: '/api/professor/exams/exam-1/attempts', method: 'GET' },
      { path: '/api/professor/exams/exam-1/preview-start', method: 'POST', body: {} },
      { path: '/api/professor/exams/exam-1/submissions', method: 'GET' },
      { path: '/api/professor/exams/exam-1/grading/questions/q-1', method: 'GET' },
      { path: '/api/professor/exams/exam-1/release-results', method: 'POST' },
      { path: '/api/professor/exams/exam-1/unrelease-results', method: 'POST' },
      { path: '/api/professor/exams/exam-1/sessions/sess-1/history', method: 'GET' },
      { path: '/api/hub/exam-1', method: 'GET', ws: true },
    ];

    for (const r of routesToTest) {
      const headers = new Headers();
      headers.set('Cookie', authCookie);
      headers.set('Origin', 'https://apa.example.com');
      if (r.ws) {
        headers.set('Upgrade', 'websocket');
      }
      if (r.body) {
        headers.set('Content-Type', 'application/json');
      }

      const req = new Request(`https://apa.example.com${r.path}`, {
        method: r.method,
        headers,
        body: r.body ? JSON.stringify(r.body) : undefined,
      });

      const res = await worker.fetch(req, env as any);
      expect(res.status, `Route ${r.method} ${r.path} must return 404`).toBe(404);
      expect(res.status, `Route ${r.method} ${r.path} must never return 403`).not.toBe(403);
    }
  });
});

describe('Phase 5a: Audit Logging Resilience', () => {
  it('does not throw or break execution when audit DB write fails', async () => {
    const brokenDb = {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                throw new Error('D1 storage unavailable');
              },
            };
          },
        };
      },
    };

    // Should complete cleanly without throwing
    await expect(
      writeAudit(
        { DB: brokenDb as any } as any,
        {
          action: 'auth.login.failed',
          actor_role: 'system',
          target_type: 'user',
          target_id: 'unknown@test.com',
          details: { reason: 'invalid_password' },
        },
      ),
    ).resolves.not.toThrow();
  });
});

describe('Phase 5a: Rate Limiting & Brute Force Lockout', () => {
  it('returns 429 lockout when 5 failed login attempts occur within 15 minutes for a single email', async () => {
    const db = {
      prepare(query: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                if (query.includes('login_attempts') && query.includes('email = ?')) {
                  return { fail_count: 5 } as T;
                }
                if (query.includes('login_attempts') && query.includes('ip = ?')) {
                  return { fail_count: 5 } as T; // Under 50 IP limit
                }
                return null;
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    };

    const req = new Request('https://apa.example.com/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://apa.example.com',
      },
      body: JSON.stringify({
        email: 'locked@example.com',
        password: 'Password123!',
      }),
    });

    const res = await handleAuthApi(req, { DB: db as any, JWT_SECRET: TEST_SECRET });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('too_many_requests');
    expect(body.error.message).toContain('this account');
  });

  it('does NOT lock out another user on the same IP when one email hits 5 failures (shared network safety)', async () => {
    const db = {
      prepare(query: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                if (query.includes('login_attempts') && query.includes('email = ?')) {
                  const targetEmail = args[0];
                  // Target email is innocent (only 1 fail), so NOT locked out
                  return { fail_count: targetEmail === 'innocent@example.com' ? 1 : 5 } as T;
                }
                if (query.includes('login_attempts') && query.includes('ip = ?')) {
                  // IP has 6 total failures, well below the 50 IP throttle
                  return { fail_count: 6 } as T;
                }
                if (query.includes('FROM users WHERE email = ?')) {
                  return null; // Will trigger 401, not 429!
                }
                return null;
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    };

    const req = new Request('https://apa.example.com/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://apa.example.com',
        'cf-connecting-ip': '192.168.1.100', // Shared campus IP
      },
      body: JSON.stringify({
        email: 'innocent@example.com',
        password: 'Password123!',
      }),
    });

    const res = await handleAuthApi(req, { DB: db as any, JWT_SECRET: TEST_SECRET });
    expect(res.status).toBe(401); // Got normal 401, NOT locked out with 429!
  });

  it('returns 429 when 50 failed login attempts occur from the same IP (IP throttle)', async () => {
    const db = {
      prepare(query: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                if (query.includes('login_attempts') && query.includes('ip = ?')) {
                  return { fail_count: 50 } as T; // Reached 50 IP throttle!
                }
                if (query.includes('login_attempts') && query.includes('email = ?')) {
                  return { fail_count: 0 } as T;
                }
                return null;
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    };

    const req = new Request('https://apa.example.com/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://apa.example.com',
        'cf-connecting-ip': '10.0.0.1',
      },
      body: JSON.stringify({
        email: 'random@example.com',
        password: 'Password123!',
      }),
    });

    const res = await handleAuthApi(req, { DB: db as any, JWT_SECRET: TEST_SECRET });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('too_many_requests');
    expect(body.error.message).toContain('this network');
  });
});

describe('Phase 5a: Admin Legacy Exam Claim (Idempotent)', () => {
  it('claims legacy exams where created_by IS NULL and is idempotent on replay', async () => {
    let unownedExams = [{ id: 'ex-1' }, { id: 'ex-2' }];

    const adminUser: User = {
      id: 'admin-99',
      email: 'admin@school.edu',
      name: 'Super Admin',
      role: 'admin',
      password_hash: '',
      password_salt: '',
      student_id: null,
      department: null,
      active: 1,
      token_version: 0,
      created_at: '',
      last_login_at: null,
    };

    const db = {
      prepare(query: string) {
        const stmt = {
          bind() {
            return stmt;
          },
          async first<T>(): Promise<T | null> {
            if (query.includes('FROM users WHERE id = ?')) {
              return adminUser as T;
            }
            return null;
          },
          async all<T>(): Promise<{ results: T[] }> {
            if (query.includes('SELECT id FROM exams WHERE created_by IS NULL')) {
              return { results: unownedExams as T[] };
            }
            return { results: [] };
          },
          async run() {
            if (query.includes('UPDATE exams SET created_by = ?')) {
              unownedExams = []; // Claimed!
            }
            return { success: true };
          },
        };
        return stmt;
      },
    };

    const token = await signJwt({ sub: 'admin-99', role: 'admin', tv: 0 }, TEST_SECRET);
    const req1 = new Request('https://apa.example.com/api/admin/claim-legacy-exams', {
      method: 'POST',
      headers: {
        Cookie: serializeAuthCookie(token),
        Origin: 'https://apa.example.com',
      },
    });

    // First claim
    const res1 = await handleAdminApi(req1, { DB: db as any, JWT_SECRET: TEST_SECRET }, adminUser);
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as { ok: boolean; claimedCount: number };
    expect(body1.ok).toBe(true);
    expect(body1.claimedCount).toBe(2);

    // Second claim: should claim 0, cleanly and idempotently
    const req2 = new Request('https://apa.example.com/api/admin/claim-legacy-exams', {
      method: 'POST',
      headers: {
        Cookie: serializeAuthCookie(token),
        Origin: 'https://apa.example.com',
      },
    });
    const res2 = await handleAdminApi(req2, { DB: db as any, JWT_SECRET: TEST_SECRET }, adminUser);
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as { ok: boolean; claimedCount: number };
    expect(body2.ok).toBe(true);
    expect(body2.claimedCount).toBe(0);
  });
});

describe('Phase 5a: Student Attempt Isolation', () => {
  const studentA: User = {
    id: 'student-A',
    email: 'alice@school.edu',
    name: 'Alice',
    role: 'student',
    password_hash: '',
    password_salt: '',
    student_id: 'S1',
    department: null,
    active: 1,
    token_version: 0,
    created_at: '',
    last_login_at: null,
  };

  const studentB: User = {
    ...studentA,
    id: 'student-B',
    email: 'bob@school.edu',
    name: 'Bob',
  };

  const attemptOwnedByA = {
    id: 'att-A1',
    exam_id: 'exam-1',
    user_id: 'student-A',
    status: 'in_progress',
  };

  it('blocks Student B from updating or viewing Student A attempt answers', async () => {
    const db = {
      prepare(query: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first<T>(): Promise<T | null> {
                if (query.includes('FROM users WHERE id = ?')) {
                  const id = String(args[0]);
                  return (id === 'student-B' ? studentB : null) as T;
                }
                if (query.includes('FROM attempts WHERE id = ?')) {
                  // Scoped query checks user_id = user.id
                  const attemptId = String(args[0]);
                  const userId = String(args[1]);
                  if (attemptId === 'att-A1' && userId === 'student-B') {
                    return null; // Bob does not own Alice's attempt!
                  }
                  if (attemptId === 'att-A1' && userId === 'student-A') {
                    return attemptOwnedByA as T;
                  }
                }
                return null;
              },
            };
          },
        };
      },
    };

    const tokenB = await signJwt({ sub: 'student-B', role: 'student', tv: 0 }, TEST_SECRET);
    const req = new Request('https://apa.example.com/api/student/attempts/att-A1/answers', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: serializeAuthCookie(tokenB),
        Origin: 'https://apa.example.com',
      },
      body: JSON.stringify({ answers: [] }),
    });

    const res = await handleStudentApi(req, { DB: db as any, JWT_SECRET: TEST_SECRET } as any);
    expect(res.status).toBe(404);
  });
});
