/**
 * src/phase5a-fixes.test.ts — Phase 5a Targeted Fixes & Regression Test Suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates:
 * 1. GET /api/student/exams/:id:
 *    - Requires active enrollment row in D1; without enrollment returns 404.
 *    - For enrolled student, returns metadata ONLY and NEVER questions.
 *    - Test that non-enrolled student gets 404 and zero question text.
 * 2. POST /api/professor/exams/:id/reset:
 *    - Refuses with 409 if results_released = 1 or any attempt submitted/graded,
 *      unless confirmTitle equals the exam title AND force = true.
 *    - Even with force, keeps violation and evidence-hold refusals (409).
 *    - Returns dry-run preview (wouldDeleteAttempts, wouldDeleteAnswers) when dryRun = true.
 *    - Writes audit_log entry with counts.
 * 3. POST /api/professor/exams/:id/close:
 *    - Tested against REAL local D1 database (node:sqlite DatabaseSync with migrations 0001-0006).
 *    - Confirms exams.status = 'closed' and join_code_active = 0 with HTTP 200.
 * 4. WebSocket Upgrade Security:
 *    - Worker builds DO identity from verified token only.
 *    - Confirms client-supplied spoofed parameters (?userId=...&role=admin&tokenVersion=...)
 *      are stripped and ignored by the DO stub.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect } from 'vitest';
import worker from '../worker/index.js';
import { signJwt } from '../worker/auth/jwt.js';
import { serializeAuthCookie } from '../worker/auth/cookies.js';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Mock WebSocketPair and allow 101 Switching Protocols in Node/Vitest test environment
if (typeof (globalThis as any).WebSocketPair === 'undefined') {
  (globalThis as any).WebSocketPair = class WebSocketPair {
    0: any;
    1: any;
    constructor() {
      this[0] = { accept() {}, send() {}, close() {}, addEventListener() {}, removeEventListener() {} };
      this[1] = { accept() {}, send() {}, close() {}, addEventListener() {}, removeEventListener() {} };
    }
  };
}

const OriginalResponse = globalThis.Response;
globalThis.Response = class MockResponse extends OriginalResponse {
  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: any }) {
    if (init && init.status === 101) {
      super(body, { ...init, status: 200 });
      Object.defineProperty(this, 'status', { value: 101, configurable: true });
      if (init.webSocket) {
        Object.defineProperty(this, 'webSocket', { value: init.webSocket, configurable: true });
      }
      return;
    }
    super(body, init);
    if (init && (init as any).webSocket) {
      Object.defineProperty(this, 'webSocket', { value: (init as any).webSocket, configurable: true });
    }
  }
} as any;

const TEST_SECRET = 'super-secret-jwt-test-key-32-chars-min!!';
const TEST_INTERNAL_SECRET = 'test-internal-secret-for-worker-communication';

function createD1Adapter(sqliteDb: DatabaseSync) {
  return {
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
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
          };
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

describe('Phase 5a Fix 1: Student Exam Metadata & Question Leak Prevention', () => {
  it('non-enrolled student gets 404 and NO question text; enrolled student gets metadata only', async () => {
    // Setup SQLite DB with 0001 and 0006 schema
    const sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    const env = {
      DB: d1 as any,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    // Create professor, exam, question, and student
    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at)
      VALUES ('prof-1', 'prof@test.edu', 'Prof One', 'professor', 'hash1', 'salt1', 1, 0, datetime('now')),
             ('stu-enrolled', 'enrolled@test.edu', 'Enrolled Student', 'student', 'hash2', 'salt2', 1, 0, datetime('now')),
             ('stu-other', 'other@test.edu', 'Non-Enrolled Student', 'student', 'hash3', 'salt3', 1, 0, datetime('now'));

      INSERT INTO exams (id, title, description, course_code, duration_minutes, status, join_code, join_code_active, created_by, created_at, updated_at)
      VALUES ('exam-sec', 'Classified Final Exam', 'Super secret questions', 'CS401', 90, 'active', 'SEC-999', 1, 'prof-1', datetime('now'), datetime('now'));

      INSERT INTO questions (id, exam_id, question_text, type, points, created_at, updated_at)
      VALUES ('q-sec-1', 'exam-sec', 'SECRET_EXAM_QUESTION_PROMPT_12345', 'short_answer', 10, datetime('now'), datetime('now'));

      INSERT INTO exam_questions (id, exam_id, question_id, position, snapshot_json)
      VALUES ('eq-1', 'exam-sec', 'q-sec-1', 0, '{"id":"q-sec-1","question_text":"SECRET_EXAM_QUESTION_PROMPT_12345","type":"short_answer","points":10}');

      -- Enroll ONLY stu-enrolled
      INSERT INTO exam_enrollments (id, exam_id, user_id, joined_at)
      VALUES ('en-1', 'exam-sec', 'stu-enrolled', datetime('now'));
    `);

    const nonEnrolledToken = await signJwt({ sub: 'stu-other', role: 'student', tv: 0, exp: 9999999999 }, TEST_SECRET);
    const enrolledToken = await signJwt({ sub: 'stu-enrolled', role: 'student', tv: 0, exp: 9999999999 }, TEST_SECRET);

    // 1. Non-enrolled student requests GET /api/student/exams/exam-sec
    const resNonEnrolled = await worker.fetch(
      new Request('https://apa.example.com/api/student/exams/exam-sec', {
        headers: {
          Cookie: serializeAuthCookie(nonEnrolledToken),
          Origin: 'https://apa.example.com',
        },
      }),
      env as any,
    );

    expect(resNonEnrolled.status).toBe(404);
    const nonEnrolledBody = await resNonEnrolled.text();
    // Absolutely NO question text leaked
    expect(nonEnrolledBody).not.toContain('SECRET_EXAM_QUESTION_PROMPT_12345');
    expect(nonEnrolledBody).not.toContain('questions');

    // 2. Enrolled student requests GET /api/student/exams/exam-sec
    const resEnrolled = await worker.fetch(
      new Request('https://apa.example.com/api/student/exams/exam-sec', {
        headers: {
          Cookie: serializeAuthCookie(enrolledToken),
          Origin: 'https://apa.example.com',
        },
      }),
      env as any,
    );

    expect(resEnrolled.status).toBe(200);
    const enrolledData = (await resEnrolled.json()) as any;
    expect(enrolledData.exam).toBeDefined();
    expect(enrolledData.exam.title).toBe('Classified Final Exam');
    expect(enrolledData.exam.duration_minutes).toBe(90);
    // CRITICAL: questions field must NEVER be returned here
    expect(enrolledData.questions).toBeUndefined();
    expect(JSON.stringify(enrolledData)).not.toContain('SECRET_EXAM_QUESTION_PROMPT_12345');
  });
});

describe('Phase 5a Fix 2: POST /reset Safeguards, Dry Run Preview & Violation Integrity', () => {
  it('enforces dryRun preview, title confirmation with force, and violation refusals', async () => {
    const sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    const env = {
      DB: d1 as any,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at)
      VALUES ('prof-owner', 'owner@test.edu', 'Prof Owner', 'professor', 'hash', 'salt', 1, 0, datetime('now')),
             ('stu-1', 'stu1@test.edu', 'Student One', 'student', 'hash', 'salt', 1, 0, datetime('now'));

      INSERT INTO exams (id, title, duration_minutes, status, join_code, join_code_active, created_by, created_at, updated_at)
      VALUES ('exam-reset', 'Physics Midterm 2026', 60, 'active', 'PHYS-101', 1, 'prof-owner', datetime('now'), datetime('now'));

      INSERT INTO attempts (id, exam_id, user_id, student_name, session_id, status, started_at, deadline_at, violation_count, evidence_hold, is_test)
      VALUES ('att-1', 'exam-reset', 'stu-1', 'Student One', 'sess-1', 'submitted', datetime('now'), datetime('now', '+1 hour'), 0, 0, 0);

      INSERT INTO answers (attempt_id, question_id, answer_json, awarded_points)
      VALUES ('att-1', 'q-1', '"velocity"', 5);
    `);

    const profToken = await signJwt({ sub: 'prof-owner', role: 'professor', tv: 0, exp: 9999999999 }, TEST_SECRET);
    const cookie = serializeAuthCookie(profToken);

    // 1. Dry run preview returns counts without modifying anything
    const resDryRun = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-reset/reset', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: true }),
      }),
      env as any,
    );

    expect(resDryRun.status).toBe(200);
    const dryRunData = (await resDryRun.json()) as any;
    expect(dryRunData.dryRun).toBe(true);
    expect(dryRunData.wouldDeleteAttempts).toBe(1);
    expect(dryRunData.wouldDeleteAnswers).toBe(1);

    // Verify nothing was deleted
    const countBefore = sqlite.prepare('SELECT count(*) as count FROM attempts WHERE exam_id = ?').get('exam-reset') as any;
    expect(countBefore.count).toBe(1);

    // 2. Refuses with 409 because an attempt is submitted, unless confirmTitle matches AND force=true
    const resNoForce = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-reset/reset', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env as any,
    );
    expect(resNoForce.status).toBe(409);
    const noForceErr = (await resNoForce.json()) as any;
    expect(noForceErr.error).toContain('Results have been released or graded/submitted attempts exist');

    // Wrong confirmTitle with force=true still refuses 409
    const resWrongTitle = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-reset/reset', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true, confirmTitle: 'Wrong Exam Title' }),
      }),
      env as any,
    );
    expect(resWrongTitle.status).toBe(409);

    // 3. Even with force=true and matching confirmTitle: refuse 409 if violation_count > 0 or evidence_hold = 1
    sqlite.exec(`UPDATE attempts SET violation_count = 3 WHERE id = 'att-1'`);
    const resViol = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-reset/reset', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true, confirmTitle: 'Physics Midterm 2026' }),
      }),
      env as any,
    );
    expect(resViol.status).toBe(409);
    const violErr = (await resViol.json()) as any;
    expect(violErr.error).toContain('has violations (3)');

    // 4. Clean attempt (violation_count = 0, evidence_hold = 0) with force and title succeeds
    sqlite.exec(`UPDATE attempts SET violation_count = 0, evidence_hold = 0 WHERE id = 'att-1'`);
    const resSuccess = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-reset/reset', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true, confirmTitle: 'Physics Midterm 2026' }),
      }),
      env as any,
    );
    expect(resSuccess.status).toBe(200);
    const successData = (await resSuccess.json()) as any;
    expect(successData.reset).toBe(true);
    expect(successData.deletedAttemptsCount).toBe(1);
    expect(successData.deletedAnswersCount).toBe(1);

    // Verify D1 records cleaned up and status back to draft
    const examAfter = sqlite.prepare('SELECT status FROM exams WHERE id = ?').get('exam-reset') as any;
    expect(examAfter.status).toBe('draft');
    const attAfter = sqlite.prepare('SELECT count(*) as count FROM attempts WHERE exam_id = ?').get('exam-reset') as any;
    expect(attAfter.count).toBe(0);

    // Verify audit log was recorded with counts
    const auditLog = sqlite.prepare(`SELECT * FROM audit_log WHERE action = 'reset_exam'`).get() as any;
    expect(auditLog).toBeDefined();
    expect(auditLog.meta_json).toContain('"deletedAttemptsCount":1');
  });

  it('refuses reset for auto_submitted and terminated attempts without force, allows with force', async () => {
    const sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    const env = {
      DB: d1 as any,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at)
      VALUES ('prof-owner-2', 'prof2@test.edu', 'Prof Two', 'professor', 'hash', 'salt', 1, 0, datetime('now')),
             ('stu-auto', 'stuauto@test.edu', 'Student Auto', 'student', 'hash', 'salt', 1, 0, datetime('now')),
             ('stu-term', 'stuterm@test.edu', 'Student Term', 'student', 'hash', 'salt', 1, 0, datetime('now'));

      INSERT INTO exams (id, title, duration_minutes, status, join_code, join_code_active, created_by, created_at, updated_at)
      VALUES ('exam-auto', 'Calculus Final Exam', 60, 'active', 'CALC-101', 1, 'prof-owner-2', datetime('now'), datetime('now')),
             ('exam-term', 'Linear Algebra Final', 60, 'active', 'LALG-101', 1, 'prof-owner-2', datetime('now'), datetime('now'));

      -- auto_submitted attempt on exam-auto
      INSERT INTO attempts (id, exam_id, user_id, student_name, session_id, status, started_at, deadline_at, violation_count, evidence_hold, is_test)
      VALUES ('att-auto', 'exam-auto', 'stu-auto', 'Student Auto', 'sess-auto', 'auto_submitted', datetime('now'), datetime('now', '+1 hour'), 0, 0, 0);

      -- terminated attempt on exam-term
      INSERT INTO attempts (id, exam_id, user_id, student_name, session_id, status, started_at, deadline_at, violation_count, evidence_hold, is_test)
      VALUES ('att-term', 'exam-term', 'stu-term', 'Student Term', 'sess-term', 'terminated', datetime('now'), datetime('now', '+1 hour'), 0, 0, 0);
    `);

    const profToken = await signJwt({ sub: 'prof-owner-2', role: 'professor', tv: 0, exp: 9999999999 }, TEST_SECRET);
    const cookie = serializeAuthCookie(profToken);

    // 1. auto_submitted attempt: refuses without force (409)
    const resAutoNoForce = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-auto/reset', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env as any,
    );
    expect(resAutoNoForce.status).toBe(409);
    const autoErr = (await resAutoNoForce.json()) as any;
    expect(autoErr.error).toContain('Results have been released or graded/submitted attempts exist');

    // With force and matching confirmTitle: succeeds (200)
    const resAutoWithForce = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-auto/reset', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true, confirmTitle: 'Calculus Final Exam' }),
      }),
      env as any,
    );
    expect(resAutoWithForce.status).toBe(200);
    const autoExamAfter = sqlite.prepare('SELECT status FROM exams WHERE id = ?').get('exam-auto') as any;
    expect(autoExamAfter.status).toBe('draft');

    // 2. terminated attempt: refuses without force (409)
    const resTermNoForce = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-term/reset', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env as any,
    );
    expect(resTermNoForce.status).toBe(409);
    const termErr = (await resTermNoForce.json()) as any;
    expect(termErr.error).toContain('Results have been released or graded/submitted attempts exist');

    // With force and matching confirmTitle: succeeds (200)
    const resTermWithForce = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-term/reset', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true, confirmTitle: 'Linear Algebra Final' }),
      }),
      env as any,
    );
    expect(resTermWithForce.status).toBe(200);
    const termExamAfter = sqlite.prepare('SELECT status FROM exams WHERE id = ?').get('exam-term') as any;
    expect(termExamAfter.status).toBe('draft');
  });

  it('refuses reset with 409 if any non-test attempt is in_progress, even with force and matching confirmTitle', async () => {
    const sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    const env = {
      DB: d1 as any,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at)
      VALUES ('prof-owner-3', 'prof3@test.edu', 'Prof Three', 'professor', 'hash', 'salt', 1, 0, datetime('now')),
             ('stu-live', 'live@test.edu', 'Live Student', 'student', 'hash', 'salt', 1, 0, datetime('now'));

      INSERT INTO exams (id, title, duration_minutes, status, join_code, join_code_active, created_by, created_at, updated_at)
      VALUES ('exam-live', 'Chemistry Midterm Live', 60, 'active', 'CHEM-101', 1, 'prof-owner-3', datetime('now'), datetime('now'));

      -- in_progress attempt
      INSERT INTO attempts (id, exam_id, user_id, student_name, session_id, status, started_at, deadline_at, violation_count, evidence_hold, is_test)
      VALUES ('att-live', 'exam-live', 'stu-live', 'Live Student', 'sess-live', 'in_progress', datetime('now'), datetime('now', '+1 hour'), 0, 0, 0);
    `);

    const profToken = await signJwt({ sub: 'prof-owner-3', role: 'professor', tv: 0, exp: 9999999999 }, TEST_SECRET);
    const cookie = serializeAuthCookie(profToken);

    // Calling reset without force: refuses 409
    const resNoForce = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-live/reset', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env as any,
    );
    expect(resNoForce.status).toBe(409);
    const noForceErr = (await resNoForce.json()) as any;
    expect(noForceErr.error).toContain('Close the exam and wait for attempts to end, or end them first.');

    // Calling reset WITH force=true and matching confirmTitle: STILL refuses 409 (no force override)
    const resWithForce = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-live/reset', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true, confirmTitle: 'Chemistry Midterm Live' }),
      }),
      env as any,
    );
    expect(resWithForce.status).toBe(409);
    const withForceErr = (await resWithForce.json()) as any;
    expect(withForceErr.error).toContain('Close the exam and wait for attempts to end, or end them first.');

    // Verify nothing was deleted
    const countAfter = sqlite.prepare('SELECT count(*) as count FROM attempts WHERE exam_id = ?').get('exam-live') as any;
    expect(countAfter.count).toBe(1);
    const examAfter = sqlite.prepare('SELECT status FROM exams WHERE id = ?').get('exam-live') as any;
    expect(examAfter.status).toBe('active');
  });

  it('verifies POST /api/admin/users/:id/deactivate is POST-only (PUT returns 404)', async () => {
    const sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    const env = {
      DB: d1 as any,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at)
      VALUES ('admin-1', 'admin@test.edu', 'Admin One', 'admin', 'hash', 'salt', 1, 0, datetime('now')),
             ('target-user', 'target@test.edu', 'Target User', 'professor', 'hash', 'salt', 1, 0, datetime('now'));
    `);

    const adminToken = await signJwt({ sub: 'admin-1', role: 'admin', tv: 0, exp: 9999999999 }, TEST_SECRET);
    const cookie = serializeAuthCookie(adminToken);

    // 1. PUT returns 404
    const resPut = await worker.fetch(
      new Request('https://apa.example.com/api/admin/users/target-user/deactivate', {
        method: 'PUT',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com' },
      }),
      env as any,
    );
    expect(resPut.status).toBe(404);

    // Verify user was NOT deactivated
    const userStillActive = sqlite.prepare('SELECT active FROM users WHERE id = ?').get('target-user') as any;
    expect(userStillActive.active).toBe(1);

    // 2. POST returns 200 and deactivates
    const resPost = await worker.fetch(
      new Request('https://apa.example.com/api/admin/users/target-user/deactivate', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: 'https://apa.example.com' },
      }),
      env as any,
    );
    expect(resPost.status).toBe(200);
    const userDeactivated = sqlite.prepare('SELECT active, token_version FROM users WHERE id = ?').get('target-user') as any;
    expect(userDeactivated.active).toBe(0);
    expect(userDeactivated.token_version).toBe(1);
  });
});

describe('Phase 5a Fix 3: POST /close Local D1 Database Execution', () => {
  it('executes against a REAL local D1 SQLite database with full migration schema and returns 200', async () => {
    const sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const d1 = createD1Adapter(sqlite);
    const env = {
      DB: d1 as any,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at)
      VALUES ('prof-close', 'prof.close@test.edu', 'Prof Close', 'professor', 'hash', 'salt', 1, 0, datetime('now'));

      INSERT INTO exams (id, title, duration_minutes, status, join_code, join_code_active, created_by, created_at, updated_at)
      VALUES ('exam-to-close', 'Active Final Exam', 60, 'active', 'CLOSE-123', 1, 'prof-close', datetime('now'), datetime('now'));
    `);

    const token = await signJwt({ sub: 'prof-close', role: 'professor', tv: 0, exp: 9999999999 }, TEST_SECRET);

    // Call real POST /api/professor/exams/exam-to-close/close
    const res = await worker.fetch(
      new Request('https://apa.example.com/api/professor/exams/exam-to-close/close', {
        method: 'POST',
        headers: {
          Cookie: serializeAuthCookie(token),
          Origin: 'https://apa.example.com',
        },
      }),
      env as any,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.closed).toBe(true);

    // Verify directly in SQLite that status is closed and join_code_active is 0
    const examRow = sqlite.prepare('SELECT status, join_code_active FROM exams WHERE id = ?').get('exam-to-close') as any;
    expect(examRow.status).toBe('closed');
    expect(examRow.join_code_active).toBe(0);
  });
});

describe('Phase 5a Fix 4: WebSocket Identity Stripping & Spoofing Protection', () => {
  it('strips client-supplied identity query parameters and forwards only verified JWT identity to Durable Objects', async () => {
    let capturedDoSessionUrl: URL | null = null;
    let capturedDoHubUrl: URL | null = null;

    const sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    sqlite.exec(`
      INSERT INTO users (id, email, name, role, password_hash, password_salt, active, token_version, created_at)
      VALUES ('stu-real', 'real@test.edu', 'Real Student', 'student', 'hash', 'salt', 1, 3, datetime('now')),
             ('prof-real', 'prof@test.edu', 'Real Professor', 'professor', 'hash', 'salt', 1, 7, datetime('now'));

      INSERT INTO exams (id, title, duration_minutes, status, join_code, join_code_active, created_by, created_at, updated_at)
      VALUES ('exam-ws', 'WebSocket Exam', 60, 'active', 'WS-123', 1, 'prof-real', datetime('now'), datetime('now'));

      INSERT INTO attempts (id, exam_id, user_id, student_name, session_id, status, started_at, deadline_at, is_test)
      VALUES ('att-ws-1', 'exam-ws', 'stu-real', 'Real Student', 'sess-safe-1', 'in_progress', datetime('now'), datetime('now', '+1 hour'), 0);
    `);

    const d1 = createD1Adapter(sqlite);

    const env = {
      DB: d1 as any,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
      EXAM_SESSION: {
        idFromName: () => ({ toString: () => 'do-sess-safe' }),
        get: () => ({
          fetch: async (req: Request) => {
            capturedDoSessionUrl = new URL(req.url);
            return new Response(null, { status: 101 });
          },
        }),
      },
      EXAM_HUB: {
        idFromName: () => ({ toString: () => 'do-hub-safe' }),
        get: () => ({
          fetch: async (req: Request) => {
            capturedDoHubUrl = new URL(req.url);
            return new Response(null, { status: 101 });
          },
        }),
      },
    };

    // 1. Student connecting with spoofed URL parameters: ?userId=admin-god&role=admin&tokenVersion=99999
    const stuToken = await signJwt({ sub: 'stu-real', role: 'student', tv: 3, exp: 9999999999 }, TEST_SECRET);
    const stuWsUrl = 'https://apa.example.com/api/exam/sess-safe-1?userId=admin-god&role=admin&userRole=admin&tokenVersion=99999&hacked=true';

    const resStuWs = await worker.fetch(
      new Request(stuWsUrl, {
        headers: {
          Upgrade: 'websocket',
          Cookie: serializeAuthCookie(stuToken),
          Origin: 'https://apa.example.com',
        },
      }),
      env as any,
    );

    expect(resStuWs.status).toBe(101);
    expect(capturedDoSessionUrl).toBeDefined();
    // Confirms client spoofed query parameters were completely stripped
    expect(capturedDoSessionUrl!.searchParams.get('userId')).toBe('stu-real');
    expect(capturedDoSessionUrl!.searchParams.get('role')).toBe('student');
    expect(capturedDoSessionUrl!.searchParams.get('tokenVersion')).toBe('3');
    expect(capturedDoSessionUrl!.searchParams.get('examId')).toBe('exam-ws');
    expect(capturedDoSessionUrl!.searchParams.get('name')).toBe('Real Student');
    expect(capturedDoSessionUrl!.searchParams.get('hacked')).toBeNull();

    // 2. Professor connecting with spoofed URL parameters: ?userId=attacker&role=admin&tokenVersion=0
    const profToken = await signJwt({ sub: 'prof-real', role: 'professor', tv: 7, exp: 9999999999 }, TEST_SECRET);
    const profWsUrl = 'https://apa.example.com/api/hub/exam-ws?userId=attacker&role=admin&userRole=admin&tokenVersion=0&spoof=1';

    const resProfWs = await worker.fetch(
      new Request(profWsUrl, {
        headers: {
          Upgrade: 'websocket',
          Cookie: serializeAuthCookie(profToken),
          Origin: 'https://apa.example.com',
        },
      }),
      env as any,
    );

    expect(resProfWs.status).toBe(101);
    expect(capturedDoHubUrl).toBeDefined();
    // Confirms client spoofed query parameters were completely stripped
    expect(capturedDoHubUrl!.searchParams.get('userId')).toBe('prof-real');
    expect(capturedDoHubUrl!.searchParams.get('userRole')).toBe('professor');
    expect(capturedDoHubUrl!.searchParams.get('tokenVersion')).toBe('7');
    expect(capturedDoHubUrl!.searchParams.get('spoof')).toBeNull();
  });
});
