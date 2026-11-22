/**
 * src/phase5c.test.ts — Phase 5c Comprehensive Test Suite (Vitest)
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates:
 * 1. Change password:
 *    - Correct current password succeeds, updates token_version, re-issues cookie.
 *    - Wrong current password fails with 400.
 *    - Rate limiting: 5 wrong attempts in 15 minutes returns 429.
 *    - Old JWT token from before change is rejected with 401.
 *    - New JWT token from Set-Cookie header succeeds.
 * 2. Privacy notice and consent:
 *    - Student join and start return 403 { code: 'privacy_required' } until accepted.
 *    - POST /api/student/accept-privacy records consent.
 *    - After consent, join and start succeed.
 *    - Professor preview attempts are exempt from privacy gate.
 * 3. Professor home isolation and metrics:
 *    - Professor B's data never appears for Professor A.
 *    - Admin sees all exams with owner information.
 *    - Test attempts (is_test = 1) are strictly excluded from counts and averages.
 * 4. Exam archive and unarchive:
 *    - Cannot archive a live exam (HTTP 409).
 *    - Archiving disables join code and sets archived = 1.
 *    - Archived exams hidden from default GET /exams list.
 *    - Non-owner professor gets 404 on archive/unarchive.
 *    - Unarchive restores exam to active lists.
 * 5. Results CSV export:
 *    - Owner only (non-owner gets 404).
 *    - Formula injection defense: cells starting with =, +, -, @ prefixed with single quote.
 *    - Test attempts excluded; contains no answers and no evidence.
 * 6. Student home isolation:
 *    - Returns only the logged-in student's own in_progress, upcoming, and past exams.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.js';
import { signJwt } from '../worker/auth/jwt.js';
import { serializeAuthCookie } from '../worker/auth/cookies.js';
import { hashPassword } from '../worker/auth/crypto.js';
import { escapeCsv } from '../worker/utils/csv.js';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_SECRET = 'super-secret-jwt-test-key-32-chars-min!!';
const TEST_INTERNAL_SECRET = 'test-internal-secret-for-worker-communication';
const LOCAL_ORIGIN = 'http://localhost';

function createD1Adapter(sqliteDb: DatabaseSync) {
  return {
    prepare(sql: string) {
      const execStmt = (...args: any[]) => ({
        async first<T = any>(): Promise<T | null> {
          const stmt = sqliteDb.prepare(sql);
          const res = stmt.get(...args);
          return (res as T) ?? null;
        },
        async all<T = any>(): Promise<{ results: T[] }> {
          const stmt = sqliteDb.prepare(sql);
          const res = stmt.all(...args);
          return { results: res as T[] };
        },
        async run(): Promise<{ success: boolean }> {
          const stmt = sqliteDb.prepare(sql);
          stmt.run(...args);
          return { success: true };
        },
      });

      return {
        ...execStmt(),
        bind(...args: any[]) {
          return execStmt(...args);
        },
      };
    },
    async batch(stmts: any[]) {
      for (const s of stmts) {
        if (s.run) await s.run();
      }
      return [];
    },
  };
}

describe('Phase 5c: Change Password & Multi-Device Session Invalidation', () => {
  let sqlite: DatabaseSync;
  let env: any;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    env = {
      DB: d1,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    const { hashHex, saltHex } = await hashPassword('InitialPassword123!');
    const nowIso = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at)
      VALUES ('u-test-1', 'user1@test.edu', 'User One', 'student', '${hashHex}', '${saltHex}', 1, 0, '${nowIso}');
    `);
  });

  it('correct current password changes password, increments token_version, and issues new working cookie', async () => {
    const oldToken = await signJwt({ sub: 'u-test-1', role: 'student', tv: 0 }, TEST_SECRET);
    const oldCookie = serializeAuthCookie(oldToken!, false);

    // Change password request with proper Origin header
    const req = new Request('http://localhost/api/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: oldCookie,
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({
        currentPassword: 'InitialPassword123!',
        newPassword: 'BrandNewPassword456!',
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    // Check Set-Cookie was returned
    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toBeTruthy();
    expect(setCookie).toContain('auth_token=');

    // Extract new token from Set-Cookie
    const newTokenMatch = setCookie?.match(/auth_token=([^;]+)/);
    const newToken = newTokenMatch ? newTokenMatch[1] : '';

    // Verify database token_version incremented to 1
    const userRow = sqlite.prepare('SELECT token_version, password_changed_at FROM users WHERE id = ?').get('u-test-1') as any;
    expect(userRow.token_version).toBe(1);
    expect(userRow.password_changed_at).toBeTruthy();

    // Verify that the OLD token is now rejected with 401
    const testOldReq = new Request('http://localhost/api/auth/me', {
      headers: { Cookie: oldCookie },
    });
    const testOldRes = await worker.fetch(testOldReq, env);
    expect(testOldRes.status).toBe(401);

    // Verify that the NEW token succeeds
    const testNewReq = new Request('http://localhost/api/auth/me', {
      headers: { Cookie: `auth_token=${newToken}` },
    });
    const testNewRes = await worker.fetch(testNewReq, env);
    expect(testNewRes.status).toBe(200);
  });

  it('wrong current password fails with 400 and rate-limits after 5 failures', async () => {
    const token = await signJwt({ sub: 'u-test-1', role: 'student', tv: 0 }, TEST_SECRET);
    const cookie = serializeAuthCookie(token!, false);

    // 4 wrong attempts return 400
    for (let i = 0; i < 4; i++) {
      const req = new Request('http://localhost/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: LOCAL_ORIGIN,
        },
        body: JSON.stringify({
          currentPassword: 'WrongPassword999!',
          newPassword: 'BrandNewPassword456!',
        }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
    }

    // 5th wrong attempt also returns 400 and locks the rate limit
    const req5 = new Request('http://localhost/api/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({
        currentPassword: 'WrongPassword999!',
        newPassword: 'BrandNewPassword456!',
      }),
    });
    const res5 = await worker.fetch(req5, env);
    expect(res5.status).toBe(400);

    // 6th attempt returns 429 Too Many Requests
    const req6 = new Request('http://localhost/api/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({
        currentPassword: 'InitialPassword123!',
        newPassword: 'BrandNewPassword456!',
      }),
    });
    const res6 = await worker.fetch(req6, env);
    expect(res6.status).toBe(429);
  });

  it('pwd:<user_id> rows write to login_attempts (from 0006_auth.sql) and never count toward email lockout or IP throttle', async () => {
    // Database was constructed purely by executing migrations 0001 through 0007
    const token = await signJwt({ sub: 'u-test-1', role: 'student', tv: 0 }, TEST_SECRET);
    const cookie = serializeAuthCookie(token!, false);

    // 1. Perform 5 failed change-password attempts
    for (let i = 0; i < 5; i++) {
      const cpReq = new Request('http://localhost/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: LOCAL_ORIGIN,
          'CF-Connecting-IP': '198.51.100.42',
        },
        body: JSON.stringify({
          currentPassword: 'WrongPassword!',
          newPassword: 'BrandNewPassword456!',
        }),
      });
      const cpRes = await worker.fetch(cpReq, env);
      expect(cpRes.status).toBe(400);
    }

    // Verify 6th change-password attempt is rate-limited (429)
    const cp6Req = new Request('http://localhost/api/auth/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
        'CF-Connecting-IP': '198.51.100.42',
      },
      body: JSON.stringify({
        currentPassword: 'InitialPassword123!',
        newPassword: 'BrandNewPassword456!',
      }),
    });
    const cp6Res = await worker.fetch(cp6Req, env);
    expect(cp6Res.status).toBe(429);

    // 2. Verify rows in login_attempts table directly
    const rows = sqlite.prepare('SELECT email, ip, success FROM login_attempts WHERE email = ?').all('pwd:u-test-1') as any[];
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.email).toBe('pwd:u-test-1');
      expect(r.ip).toBe('-');
      expect(r.success).toBe(0);
    }

    // 3. Regular login with the user's email is NOT locked out (returns 200 with correct password)
    const loginReq = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: LOCAL_ORIGIN,
        'CF-Connecting-IP': '198.51.100.42',
      },
      body: JSON.stringify({
        email: 'user1@test.edu',
        password: 'InitialPassword123!',
      }),
    });
    const loginRes = await worker.fetch(loginReq, env);
    expect(loginRes.status).toBe(200);

    // 4. Regular failed login with wrong password returns 401, NOT 429 (not locked out by change-password rows)
    const badLoginReq = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: LOCAL_ORIGIN,
        'CF-Connecting-IP': '198.51.100.42',
      },
      body: JSON.stringify({
        email: 'user1@test.edu',
        password: 'WrongPassword!',
      }),
    });
    const badLoginRes = await worker.fetch(badLoginReq, env);
    expect(badLoginRes.status).toBe(401);
  });
});

describe('Phase 5c: Privacy Notice & Consent Gate for Students', () => {
  let sqlite: DatabaseSync;
  let env: any;
  const examId = 'exam-privacy-test';
  const joinCode = 'PRIV1234';

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    env = {
      DB: d1,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    const nowIso = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at, privacy_accepted_at)
      VALUES
        ('prof-1', 'prof@test.edu', 'Prof 1', 'professor', 'h1', 's1', 1, 0, '${nowIso}', NULL),
        ('stu-unconsented', 'stu@test.edu', 'Student Unconsented', 'student', 'h2', 's2', 1, 0, '${nowIso}', NULL);

      INSERT INTO exams (id, title, duration_minutes, status, join_code, join_code_active, created_by, created_at, updated_at)
      VALUES ('${examId}', 'Privacy Test Exam', 60, 'active', '${joinCode}', 1, 'prof-1', '${nowIso}', '${nowIso}');

      INSERT INTO questions (id, exam_id, question_text, type, points, grading_mode, created_at, updated_at)
      VALUES ('q1', '${examId}', 'What is 2+2?', 'mcq', 10, 'auto', '${nowIso}', '${nowIso}');
    `);
  });

  it('student join and start return 403 privacy_required until accepted, then succeed', async () => {
    const studentToken = await signJwt({ sub: 'stu-unconsented', role: 'student', tv: 0 }, TEST_SECRET);
    const cookie = serializeAuthCookie(studentToken!, false);

    // 1. Join before privacy acceptance returns 403 { code: 'privacy_required' }
    const joinReq = new Request('http://localhost/api/student/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({ code: 'PRIV-1234' }),
    });
    const joinRes = await worker.fetch(joinReq, env);
    expect(joinRes.status).toBe(403);
    const joinJson = (await joinRes.json()) as { code: string };
    expect(joinJson.code).toBe('privacy_required');

    // 2. Accept privacy notice
    const acceptReq = new Request('http://localhost/api/student/accept-privacy', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
    });
    const acceptRes = await worker.fetch(acceptReq, env);
    expect(acceptRes.status).toBe(200);

    // Check database
    const userRow = sqlite.prepare('SELECT privacy_accepted_at FROM users WHERE id = ?').get('stu-unconsented') as any;
    expect(userRow.privacy_accepted_at).toBeTruthy();

    // 3. Now join succeeds with hyphenated code!
    const joinSuccessReq = new Request('http://localhost/api/student/join', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({ code: 'PRIV-1234' }),
    });
    const joinSuccessRes = await worker.fetch(joinSuccessReq, env);
    expect(joinSuccessRes.status).toBe(200);

    // 4. Start attempt succeeds!
    const startReq = new Request(`http://localhost/api/student/exams/${examId}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({}),
    });
    const startRes = await worker.fetch(startReq, env);
    expect(startRes.status).toBe(200);
  });

  it('professor preview attempts are exempt from privacy gate', async () => {
    const profToken = await signJwt({ sub: 'prof-1', role: 'professor', tv: 0 }, TEST_SECRET);
    const cookie = serializeAuthCookie(profToken!, false);

    const previewReq = new Request(`http://localhost/api/professor/exams/${examId}/preview-start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({}),
    });
    const previewRes = await worker.fetch(previewReq, env);
    expect(previewRes.status).toBe(200);
  });

  it('attempt is not created or modified while privacy consent is pending, and in-progress answers are not lost', async () => {
    const studentToken = await signJwt({ sub: 'stu-unconsented', role: 'student', tv: 0 }, TEST_SECRET);
    const cookie = serializeAuthCookie(studentToken!, false);

    // Enroll user first
    const nowIso = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO exam_enrollments (id, exam_id, user_id, joined_at)
      VALUES ('en-priv-test', '${examId}', 'stu-unconsented', '${nowIso}');
    `);

    // 1. Without privacy consent, start attempt returns 403 and creates NO attempt record
    const startReq = new Request(`http://localhost/api/student/exams/${examId}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({}),
    });
    const startRes = await worker.fetch(startReq, env);
    expect(startRes.status).toBe(403);
    const errBody = (await startRes.json()) as any;
    expect(errBody.code).toBe('privacy_required');

    const attemptCount = sqlite.prepare('SELECT COUNT(*) as cnt FROM attempts WHERE user_id = ?').get('stu-unconsented') as any;
    expect(attemptCount.cnt).toBe(0);

    // 2. Pre-existing in-progress attempt with answers
    sqlite.exec(`
      INSERT INTO attempts (id, session_id, exam_id, user_id, student_name, status, score, is_test, started_at, deadline_at)
      VALUES ('att-existing-1', 'sess-priv-1', '${examId}', 'stu-unconsented', 'Student Unconsented', 'in_progress', NULL, 0, '${nowIso}', '${nowIso}');

      INSERT INTO answers (attempt_id, question_id, answer_json, marked_for_review, updated_at)
      VALUES ('att-existing-1', 'q1', '"Paris"', 1, '${nowIso}');
    `);

    // Resuming start without privacy consent must return 403 and NOT touch or delete the existing attempt or answers
    const resumeReq = new Request(`http://localhost/api/student/exams/${examId}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({}),
    });
    const resumeRes = await worker.fetch(resumeReq, env);
    expect(resumeRes.status).toBe(403);

    const attRow = sqlite.prepare('SELECT id, status FROM attempts WHERE id = ?').get('att-existing-1') as any;
    expect(attRow.id).toBe('att-existing-1');
    expect(attRow.status).toBe('in_progress');

    const ansRow = sqlite.prepare('SELECT answer_json FROM answers WHERE attempt_id = ? AND question_id = ?').get('att-existing-1', 'q1') as any;
    expect(ansRow.answer_json).toBe('"Paris"');

    // 3. Once privacy is accepted, resumption succeeds and preserves the existing answers
    const acceptReq = new Request('http://localhost/api/student/accept-privacy', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
    });
    const acceptRes = await worker.fetch(acceptReq, env);
    expect(acceptRes.status).toBe(200);

    const resumeSuccessReq = new Request(`http://localhost/api/student/exams/${examId}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({}),
    });
    const resumeSuccessRes = await worker.fetch(resumeSuccessReq, env);
    expect(resumeSuccessRes.status).toBe(200);
    const resumeData = (await resumeSuccessRes.json()) as any;
    expect(resumeData.resumed).toBe(true);
    expect(resumeData.attempt.id).toBe('att-existing-1');
    expect(resumeData.answers).toHaveLength(1);
    expect(resumeData.answers[0].answer_json).toBe('"Paris"');
  });
});

describe('Phase 5c: Professor Home Dashboard Scoping & Metrics', () => {
  let sqlite: DatabaseSync;
  let env: any;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    env = {
      DB: d1,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    const nowIso = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at)
      VALUES
        ('prof-A', 'profA@test.edu', 'Prof A', 'professor', 'h1', 's1', 1, 0, '${nowIso}'),
        ('prof-B', 'profB@test.edu', 'Prof B', 'professor', 'h2', 's2', 1, 0, '${nowIso}'),
        ('admin-1', 'admin@test.edu', 'Admin', 'admin', 'h3', 's3', 1, 0, '${nowIso}'),
        ('stu-1', 'stu1@test.edu', 'Stu 1', 'student', 'h4', 's4', 1, 0, '${nowIso}');

      -- Exam A owned by Prof A (ended, 1 real submission needing grading, 1 test attempt)
      INSERT INTO exams (id, title, duration_minutes, status, join_code, created_by, created_at, updated_at)
      VALUES ('exam-A', 'Exam Alpha', 60, 'completed', 'CODE-AAAA', 'prof-A', '${nowIso}', '${nowIso}');

      INSERT INTO questions (id, exam_id, question_text, type, points, grading_mode, created_at, updated_at)
      VALUES ('qa1', 'exam-A', 'Q1', 'short_answer', 20, 'manual', '${nowIso}', '${nowIso}');

      -- Real attempt for student needing grading
      INSERT INTO attempts (id, session_id, exam_id, user_id, student_name, status, score, is_test, grading_status, fully_graded, violation_count, started_at, deadline_at)
      VALUES ('att-real-1', 'sess-real-1', 'exam-A', 'stu-1', 'Stu 1', 'submitted', NULL, 0, 'pending_manual', 0, 2, '${nowIso}', '${nowIso}');

      -- Test attempt by Prof A (must be EXCLUDED from counts)
      INSERT INTO attempts (id, session_id, exam_id, user_id, student_name, status, score, is_test, grading_status, fully_graded, violation_count, started_at, deadline_at)
      VALUES ('att-test-1', 'sess-test-1', 'exam-A', 'prof-A', 'Prof A (Test)', 'submitted', 20, 1, 'pending_manual', 0, 5, '${nowIso}', '${nowIso}');

      -- Exam B owned by Prof B (active)
      INSERT INTO exams (id, title, duration_minutes, status, join_code, created_by, created_at, updated_at)
      VALUES ('exam-B', 'Exam Beta', 45, 'active', 'CODE-BBBB', 'prof-B', '${nowIso}', '${nowIso}');
    `);
  });

  it("Professor A sees only Exam A; Professor B's data never appears for A", async () => {
    const profAToken = await signJwt({ sub: 'prof-A', role: 'professor', tv: 0 }, TEST_SECRET);
    const cookie = serializeAuthCookie(profAToken!, false);

    const req = new Request('http://localhost/api/professor/home', {
      headers: { Cookie: cookie },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const data = (await res.json()) as any;
    expect(data.exams.length).toBe(1);
    expect(data.exams[0].id).toBe('exam-A');

    // Needs grading count across Prof A's exams must be 1 (excluding test attempt)
    expect(data.summary.needs_grading).toBe(1);
    // Flagged exams count must be 1 (real attempt has 2 violations; test attempt excluded)
    expect(data.summary.flagged_exams).toBe(1);
  });

  it('Admin sees all exams across all professors with owner information', async () => {
    const adminToken = await signJwt({ sub: 'admin-1', role: 'admin', tv: 0 }, TEST_SECRET);
    const cookie = serializeAuthCookie(adminToken!, false);

    const req = new Request('http://localhost/api/professor/home', {
      headers: { Cookie: cookie },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const data = (await res.json()) as any;
    expect(data.exams.length).toBe(2);
    const titles = data.exams.map((e: any) => e.title);
    expect(titles).toContain('Exam Alpha');
    expect(titles).toContain('Exam Beta');

    const alpha = data.exams.find((e: any) => e.id === 'exam-A');
    expect(alpha.owner_name).toBe('Prof A');
  });
});

describe('Phase 5c: Exam Archive & Unarchive Lifecycle', () => {
  let sqlite: DatabaseSync;
  let env: any;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    env = {
      DB: d1,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    const nowIso = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at)
      VALUES
        ('prof-A', 'profA@test.edu', 'Prof A', 'professor', 'h1', 's1', 1, 0, '${nowIso}'),
        ('prof-B', 'profB@test.edu', 'Prof B', 'professor', 'h2', 's2', 1, 0, '${nowIso}');

      -- Completed exam owned by Prof A
      INSERT INTO exams (id, title, duration_minutes, status, join_code, join_code_active, created_by, created_at, updated_at)
      VALUES ('exam-ended', 'Ended Exam', 60, 'completed', 'CODE-END1', 1, 'prof-A', '${nowIso}', '${nowIso}');

      -- Live exam owned by Prof A (active with no schedule = live)
      INSERT INTO exams (id, title, duration_minutes, status, join_code, join_code_active, created_by, created_at, updated_at)
      VALUES ('exam-live', 'Live Exam', 60, 'active', 'CODE-LIVE', 1, 'prof-A', '${nowIso}', '${nowIso}');
    `);
  });

  it('cannot archive a live exam (refuses with 409)', async () => {
    const profAToken = await signJwt({ sub: 'prof-A', role: 'professor', tv: 0 }, TEST_SECRET);
    const cookie = serializeAuthCookie(profAToken!, false);

    const req = new Request('http://localhost/api/professor/exams/exam-live/archive', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: LOCAL_ORIGIN,
      },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.error).toContain('Cannot archive a live exam');
  });

  it('can archive ended exam: disables join code, hides from default list, and non-owner gets 404', async () => {
    const profAToken = await signJwt({ sub: 'prof-A', role: 'professor', tv: 0 }, TEST_SECRET);
    const cookieA = serializeAuthCookie(profAToken!, false);
    const profBToken = await signJwt({ sub: 'prof-B', role: 'professor', tv: 0 }, TEST_SECRET);
    const cookieB = serializeAuthCookie(profBToken!, false);

    // Non-owner professor B gets 404
    const nonOwnerReq = new Request('http://localhost/api/professor/exams/exam-ended/archive', {
      method: 'POST',
      headers: {
        Cookie: cookieB,
        Origin: LOCAL_ORIGIN,
      },
    });
    const nonOwnerRes = await worker.fetch(nonOwnerReq, env);
    expect(nonOwnerRes.status).toBe(404);

    // Owner professor A archives ended exam
    const archiveReq = new Request('http://localhost/api/professor/exams/exam-ended/archive', {
      method: 'POST',
      headers: {
        Cookie: cookieA,
        Origin: LOCAL_ORIGIN,
      },
    });
    const archiveRes = await worker.fetch(archiveReq, env);
    expect(archiveRes.status).toBe(200);

    // Check DB: archived = 1, join_code_active = 0
    const examRow = sqlite.prepare('SELECT archived, join_code_active, archived_at FROM exams WHERE id = ?').get('exam-ended') as any;
    expect(examRow.archived).toBe(1);
    expect(examRow.join_code_active).toBe(0);
    expect(examRow.archived_at).toBeTruthy();

    // Default GET /api/professor/exams hides archived exams
    const listReq = new Request('http://localhost/api/professor/exams', {
      headers: { Cookie: cookieA },
    });
    const listRes = await worker.fetch(listReq, env);
    const listData = (await listRes.json()) as any;
    const ids = listData.exams.map((e: any) => e.id);
    expect(ids).not.toContain('exam-ended');

    // GET /api/professor/exams?archived=true includes it
    const listArchivedReq = new Request('http://localhost/api/professor/exams?archived=true', {
      headers: { Cookie: cookieA },
    });
    const listArchivedRes = await worker.fetch(listArchivedReq, env);
    const listArchivedData = (await listArchivedRes.json()) as any;
    const archivedIds = listArchivedData.exams.map((e: any) => e.id);
    expect(archivedIds).toContain('exam-ended');

    // Unarchive restores it
    const unarchiveReq = new Request('http://localhost/api/professor/exams/exam-ended/unarchive', {
      method: 'POST',
      headers: {
        Cookie: cookieA,
        Origin: LOCAL_ORIGIN,
      },
    });
    const unarchiveRes = await worker.fetch(unarchiveReq, env);
    expect(unarchiveRes.status).toBe(200);

    const restoredRow = sqlite.prepare('SELECT archived, archived_at FROM exams WHERE id = ?').get('exam-ended') as any;
    expect(restoredRow.archived).toBe(0);
    expect(restoredRow.archived_at).toBeNull();
  });
});

describe('Phase 5c: Results CSV Export & Formula Injection Defense', () => {
  let sqlite: DatabaseSync;
  let env: any;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    env = {
      DB: d1,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    const nowIso = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at, student_id)
      VALUES
        ('prof-1', 'prof@test.edu', 'Prof 1', 'professor', 'h1', 's1', 1, 0, '${nowIso}', NULL),
        ('prof-2', 'prof2@test.edu', 'Prof 2', 'professor', 'h2', 's2', 1, 0, '${nowIso}', NULL),
        ('stu-formula', '=cmd|''/C calc''!A0@test.edu', '=HYPERLINK("http://evil.com","Click Me")', 'student', 'h3', 's3', 1, 0, '${nowIso}', '+123456'),
        ('stu-tab', 'tab@test.edu', char(9) || 'TabStudent', 'student', 'h4', 's4', 1, 0, '${nowIso}', 'S-TAB'),
        ('stu-complex', 'complex@test.edu', 'Smith, "Neo"' || char(10) || 'Thomas', 'student', 'h5', 's5', 1, 0, '${nowIso}', 'S-COMPLEX');

      INSERT INTO exams (id, title, duration_minutes, status, join_code, created_by, created_at, updated_at)
      VALUES ('exam-csv', 'CSV Test Exam', 60, 'completed', 'CODE-CSV1', 'prof-1', '${nowIso}', '${nowIso}');

      INSERT INTO questions (id, exam_id, question_text, type, points, grading_mode, created_at, updated_at)
      VALUES ('q1', 'exam-csv', 'Question 1', 'mcq', 50, 'auto', '${nowIso}', '${nowIso}');

      -- Non-test attempts
      INSERT INTO attempts (id, session_id, exam_id, user_id, student_name, status, score, is_test, grading_status, fully_graded, violation_count, started_at, deadline_at)
      VALUES
        ('att-csv-1', 'sess-csv-1', 'exam-csv', 'stu-formula', '=HYPERLINK("http://evil.com","Click Me")', 'submitted', 45, 0, 'auto_graded', 1, 0, '${nowIso}', '${nowIso}'),
        ('att-csv-tab', 'sess-csv-tab', 'exam-csv', 'stu-tab', char(9) || 'TabStudent', 'submitted', 40, 0, 'auto_graded', 1, 0, '${nowIso}', '${nowIso}'),
        ('att-csv-complex', 'sess-csv-complex', 'exam-csv', 'stu-complex', 'Smith, "Neo"' || char(10) || 'Thomas', 'submitted', 35, 0, 'auto_graded', 1, 0, '${nowIso}', '${nowIso}');

      -- Test attempt (must be excluded from CSV)
      INSERT INTO attempts (id, session_id, exam_id, user_id, student_name, status, score, is_test, grading_status, fully_graded, violation_count, started_at, deadline_at)
      VALUES ('att-test-csv', 'sess-test-csv', 'exam-csv', 'prof-1', 'Prof 1 (Test)', 'submitted', 50, 1, 'auto_graded', 1, 0, '${nowIso}', '${nowIso}');
    `);
  });

  it('CSV export neutralizes formulas, excludes test attempts, and enforces owner-only access', async () => {
    const prof1Token = await signJwt({ sub: 'prof-1', role: 'professor', tv: 0 }, TEST_SECRET);
    const cookie1 = serializeAuthCookie(prof1Token!, false);
    const prof2Token = await signJwt({ sub: 'prof-2', role: 'professor', tv: 0 }, TEST_SECRET);
    const cookie2 = serializeAuthCookie(prof2Token!, false);

    // Non-owner gets 404
    const nonOwnerReq = new Request('http://localhost/api/professor/exams/exam-csv/results.csv', {
      headers: { Cookie: cookie2 },
    });
    const nonOwnerRes = await worker.fetch(nonOwnerReq, env);
    expect(nonOwnerRes.status).toBe(404);

    // Owner gets CSV
    const csvReq = new Request('http://localhost/api/professor/exams/exam-csv/results.csv', {
      headers: { Cookie: cookie1 },
    });
    const csvRes = await worker.fetch(csvReq, env);
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get('Content-Type')).toContain('text/csv');

    const csvText = await csvRes.text();

    // Verify test attempt excluded
    expect(csvText).not.toContain('Prof 1 (Test)');

    // Verify student starting with tab is neutralized with leading quote
    expect(csvText).toContain("'\tTabStudent");

    // Verify student with comma, quote, and newline is RFC 4180 quoted
    expect(csvText).toContain('"Smith, ""Neo""\nThomas"');

    // Verify student with formula name has leading quote and escaped double quotes
    expect(csvText).toContain('\'=HYPERLINK');
    expect(csvText).toContain('\'+123456');

    // No questions and no answers in the CSV
    expect(csvText).not.toContain('Question 1');
  });

  it('escapeCsv helper correctly neutralizes formula prefixes and applies RFC 4180 quoting', () => {
    // 1. Tab prefix is neutralized with single quote
    expect(escapeCsv('\tAlice')).toBe("'\tAlice");

    // 2. Spaces followed by tab are neutralized
    expect(escapeCsv('   \tAlice')).toBe("'   \tAlice");

    // 3. Name with comma, double quote, and newline adheres to RFC 4180
    expect(escapeCsv('Smith, "Neo"\nThomas')).toBe('"Smith, ""Neo""\nThomas"');

    // 4. Tab prefix AND comma/quote/newline
    expect(escapeCsv('\tSmith, "Neo"\nThomas')).toBe('"\'\tSmith, ""Neo""\nThomas"');

    // 5. Formula prefixes: =, +, -, @, \r (with and without leading spaces)
    expect(escapeCsv('=1+1')).toBe("'=1+1");
    expect(escapeCsv('  =SUM(A1)')).toBe("'  =SUM(A1)");
    expect(escapeCsv('+cmd|calc')).toBe("'+cmd|calc");
    expect(escapeCsv('-cmd|calc')).toBe("'-cmd|calc");
    expect(escapeCsv('@SUM(A1:A5)')).toBe("'@SUM(A1:A5)");
    expect(escapeCsv('\rCarriage')).toBe('"\'\rCarriage"');

    // 6. Safe values without special characters remain untouched
    expect(escapeCsv('Regular Student')).toBe('Regular Student');
    expect(escapeCsv(100)).toBe('100');
    expect(escapeCsv(null)).toBe('');
    expect(escapeCsv(undefined)).toBe('');
  });
});

describe('Phase 5c: Student Home Dashboard Scoping & Isolation', () => {
  let sqlite: DatabaseSync;
  let env: any;

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    env = {
      DB: d1,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    const nowIso = new Date().toISOString();
    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at, privacy_accepted_at)
      VALUES
        ('prof-1', 'prof@test.edu', 'Prof 1', 'professor', 'h1', 's1', 1, 0, '${nowIso}', '${nowIso}'),
        ('stu-A', 'stuA@test.edu', 'Student A', 'student', 'h2', 's2', 1, 0, '${nowIso}', '${nowIso}'),
        ('stu-B', 'stuB@test.edu', 'Student B', 'student', 'h3', 's3', 1, 0, '${nowIso}', '${nowIso}');

      INSERT INTO exams (id, title, duration_minutes, status, join_code, created_by, created_at, updated_at)
      VALUES
        ('exam-progress', 'In Progress Exam', 60, 'active', 'CODE-PROG', 'prof-1', '${nowIso}', '${nowIso}'),
        ('exam-past', 'Completed Exam', 45, 'completed', 'CODE-PAST', 'prof-1', '${nowIso}', '${nowIso}');

      -- Student A is enrolled in both
      INSERT INTO exam_enrollments (id, exam_id, user_id, joined_at)
      VALUES
        ('enr-1', 'exam-progress', 'stu-A', '${nowIso}'),
        ('enr-2', 'exam-past', 'stu-A', '${nowIso}');

      -- Student A in-progress attempt
      INSERT INTO attempts (id, session_id, exam_id, user_id, student_name, status, is_test, started_at, deadline_at)
      VALUES ('att-A-prog', 'sess-A-1', 'exam-progress', 'stu-A', 'Student A', 'in_progress', 0, '${nowIso}', '${nowIso}');

      -- Student A past submitted attempt
      INSERT INTO attempts (id, session_id, exam_id, user_id, student_name, status, score, is_test, grading_status, fully_graded, started_at, submitted_at, deadline_at)
      VALUES ('att-A-past', 'sess-A-2', 'exam-past', 'stu-A', 'Student A', 'submitted', 40, 0, 'auto_graded', 1, '${nowIso}', '${nowIso}', '${nowIso}');

      -- Student B attempts in the same exams (must never appear for Student A)
      INSERT INTO attempts (id, session_id, exam_id, user_id, student_name, status, score, is_test, grading_status, fully_graded, started_at, deadline_at)
      VALUES ('att-B-prog', 'sess-B-1', 'exam-progress', 'stu-B', 'Student B', 'in_progress', NULL, 0, 'pending_manual', 0, '${nowIso}', '${nowIso}');
    `);
  });

  it('GET /api/student/home returns only student A own attempts and exams', async () => {
    const stuAToken = await signJwt({ sub: 'stu-A', role: 'student', tv: 0 }, TEST_SECRET);
    const cookie = serializeAuthCookie(stuAToken!, false);

    const req = new Request('http://localhost/api/student/home', {
      headers: { Cookie: cookie },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const data = (await res.json()) as any;
    expect(data.in_progress.length).toBe(1);
    expect(data.in_progress[0].id).toBe('exam-progress');
    expect(data.in_progress[0].attempt_id).toBe('att-A-prog');

    expect(data.past.length).toBe(1);
    expect(data.past[0].id).toBe('exam-past');
    expect(data.past[0].attempt_id).toBe('att-A-past');
    expect(data.past[0].score).toBe(40);
  });
});
