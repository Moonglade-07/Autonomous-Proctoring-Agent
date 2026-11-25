/**
 * src/phase7.test.ts — Phase 7 Admin Panel Comprehensive Test Suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates:
 * 1. Authorization matrix across all admin routes (401 anonymous, 403 student/prof, 200 admin)
 * 2. User list sanitization, wildcard escaping, keyset pagination
 * 3. Deactivation & reactivation token_version invalidation, self & last-admin protection
 * 4. Exam reassignment permissions, 409 for in-progress attempts, ownership transfer
 * 5. Overview counters excluding test attempts
 * 6. Audit log filters, resolved actor names, plain text strings, XSS/formula payloads
 * 7. Security failed-logins excluding pwd: rows, 15-minute lockout detection
 * 8. SQLite triggers enforcing append-only audit_log
 * 9. cron_runs upsert recording and error containment in sweeps
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.js';
import { signJwt } from '../worker/auth/jwt.js';
import { serializeAuthCookie } from '../worker/auth/cookies.js';
import { escapeLike } from '../worker/api/admin.js';
import { runAutoEndSweep } from '../worker/api/grading.js';
import { runRetentionSweep } from '../worker/api/sessions.js';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TEST_SECRET = 'super-secret-jwt-test-key-32-chars-min!!';
const TEST_INTERNAL_SECRET = 'test-internal-secret-for-worker-communication';
const LOCAL_ORIGIN = 'https://apa.example.com';

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

describe('Phase 7: Admin Panel & Governance Suite', () => {
  let sqlite: DatabaseSync;
  let env: any;
  let adminToken: string;
  let admin2Token: string;
  let profToken: string;
  let studentToken: string;

  const now = '2026-11-25T10:00:00.000Z';

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    // Seed users
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, password_salt, name, role, active, token_version, privacy_accepted_at, created_at)
      VALUES
        ('admin-1', 'admin1@test.edu', 'hash', 'salt', 'Admin Primary', 'admin', 1, 0, '${now}', '2026-11-25T01:00:00.000Z'),
        ('admin-2', 'admin2@test.edu', 'hash', 'salt', 'Admin Secondary', 'admin', 1, 0, '${now}', '2026-11-25T01:05:00.000Z'),
        ('prof-1', 'prof1@test.edu', 'hash', 'salt', 'Prof One', 'professor', 1, 0, '${now}', '2026-11-25T02:00:00.000Z'),
        ('prof-2', 'prof2@test.edu', 'hash', 'salt', 'Prof Two', 'professor', 1, 0, '${now}', '2026-11-25T02:05:00.000Z'),
        ('stu-1', 'stu1@test.edu', 'hash', 'salt', 'Student One', 'student', 1, 0, '${now}', '2026-11-25T03:00:00.000Z'),
        ('stu-xss', 'stuxss@test.edu', 'hash', 'salt', '<script>alert(1)</script>', 'student', 1, 0, '${now}', '2026-11-25T03:05:00.000Z'),
        ('stu-formula', 'formula@test.edu', 'hash', 'salt', '=HYPERLINK("evil.com")', 'student', 1, 0, '${now}', '2026-11-25T03:10:00.000Z');
    `);

    // Seed exams
    sqlite.exec(`
      INSERT INTO exams (id, title, course_code, created_by, duration_minutes, max_risk_score, join_code, join_code_active, status, archived, retention_days, created_at, updated_at)
      VALUES
        ('exam-idle', 'Data Structures', 'CS 201', 'prof-1', 60, 80, 'CS201', 1, 'active', 0, 90, '2026-11-25T04:00:00.000Z', '${now}'),
        ('exam-live', 'Algorithms', 'CS 301', 'prof-1', 60, 80, 'CS301', 1, 'active', 0, 90, '2026-11-25T04:30:00.000Z', '${now}'),
        ('exam-draft', 'Compilers', 'CS 401', 'prof-2', 60, 80, 'CS401', 0, 'draft', 0, 90, '2026-11-25T05:00:00.000Z', '${now}'),
        ('exam-archived', 'Old History', 'HIST 101', 'prof-2', 60, 80, 'HIST1', 0, 'completed', 1, 90, '2026-11-25T05:30:00.000Z', '${now}');
    `);

    // Seed attempts (including a test attempt)
    sqlite.exec(`
      INSERT INTO attempts (id, exam_id, user_id, student_name, session_id, status, started_at, deadline_at, submitted_at, final_risk_score, violation_count, fully_graded, is_test)
      VALUES
        ('att-live', 'exam-live', 'stu-1', 'Student One', 'sess-live', 'in_progress', '2026-11-25T09:30:00.000Z', '2026-11-25T10:30:00.000Z', NULL, 10, 0, 0, 0),
        ('att-submitted', 'exam-idle', 'stu-1', 'Student One', 'sess-sub', 'submitted', '2026-11-25T08:00:00.000Z', '2026-11-25T09:00:00.000Z', '2026-11-25T08:50:00.000Z', 75, 2, 0, 0),
        ('att-test', 'exam-idle', 'prof-1', 'Prof One', 'sess-test', 'in_progress', '2026-11-25T09:00:00.000Z', '2026-11-25T10:00:00.000Z', NULL, 0, 0, 0, 1);
    `);

    // Seed login attempts
    sqlite.exec(`
      INSERT INTO login_attempts (id, email, ip, attempted_at, success)
      VALUES
        ('la-1', 'victim@test.edu', '192.168.1.10', '2026-11-25T09:50:00.000Z', 0),
        ('la-2', 'victim@test.edu', '192.168.1.10', '2026-11-25T09:51:00.000Z', 0),
        ('la-3', 'victim@test.edu', '192.168.1.10', '2026-11-25T09:52:00.000Z', 0),
        ('la-4', 'victim@test.edu', '192.168.1.10', '2026-11-25T09:53:00.000Z', 0),
        ('la-5', 'victim@test.edu', '192.168.1.10', '2026-11-25T09:54:00.000Z', 0),
        ('la-pwd', 'pwd:user-123', '127.0.0.1', '2026-11-25T09:54:00.000Z', 0);
    `);

    env = {
      DB: createD1Adapter(sqlite),
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
    };

    adminToken = (await signJwt({ sub: 'admin-1', role: 'admin', tv: 0 }, TEST_SECRET))!;
    admin2Token = (await signJwt({ sub: 'admin-2', role: 'admin', tv: 0 }, TEST_SECRET))!;
    profToken = (await signJwt({ sub: 'prof-1', role: 'professor', tv: 0 }, TEST_SECRET))!;
    studentToken = (await signJwt({ sub: 'stu-1', role: 'student', tv: 0 }, TEST_SECRET))!;
  });

  // ── 1. Authorization Matrix ────────────────────────────────────────────────
  describe('Authorization Matrix (All Admin Routes)', () => {
    const adminRoutes = [
      { method: 'GET', url: 'https://apa.example.com/api/admin/users' },
      { method: 'POST', url: 'https://apa.example.com/api/admin/users', body: { email: 'new@test.com', name: 'New', password: 'password12345', role: 'professor' } },
      { method: 'POST', url: 'https://apa.example.com/api/admin/users/stu-1/deactivate' },
      { method: 'POST', url: 'https://apa.example.com/api/admin/users/stu-1/reactivate' },
      { method: 'GET', url: 'https://apa.example.com/api/admin/exams' },
      { method: 'POST', url: 'https://apa.example.com/api/admin/exams/exam-idle/reassign', body: { newOwnerId: 'prof-2' } },
      { method: 'GET', url: 'https://apa.example.com/api/admin/overview' },
      { method: 'GET', url: 'https://apa.example.com/api/admin/audit' },
      { method: 'GET', url: 'https://apa.example.com/api/admin/security/failed-logins' },
    ];

    for (const r of adminRoutes) {
      it(`rejects anonymous requests with 401 for ${r.method} ${r.url}`, async () => {
        const req = new Request(r.url, {
          method: r.method,
          headers: { 'Content-Type': 'application/json', Origin: LOCAL_ORIGIN },
          body: r.body ? JSON.stringify(r.body) : undefined,
        });
        const res = await worker.fetch(req, env);
        expect(res.status).toBe(401);
      });

      it(`rejects student with 403 for ${r.method} ${r.url}`, async () => {
        const req = new Request(r.url, {
          method: r.method,
          headers: {
            'Content-Type': 'application/json',
            Cookie: serializeAuthCookie(studentToken),
            Origin: LOCAL_ORIGIN,
          },
          body: r.body ? JSON.stringify(r.body) : undefined,
        });
        const res = await worker.fetch(req, env);
        expect(res.status).toBe(403);
      });

      it(`rejects professor with 403 for ${r.method} ${r.url}`, async () => {
        const req = new Request(r.url, {
          method: r.method,
          headers: {
            'Content-Type': 'application/json',
            Cookie: serializeAuthCookie(profToken),
            Origin: LOCAL_ORIGIN,
          },
          body: r.body ? JSON.stringify(r.body) : undefined,
        });
        const res = await worker.fetch(req, env);
        expect(res.status).toBe(403);
      });
    }
  });

  // ── 2. Users API ───────────────────────────────────────────────────────────
  describe('GET /api/admin/users', () => {
    it('never exposes password_hash, password_salt, or token_version', async () => {
      const req = new Request('https://apa.example.com/api/admin/users', {
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.users.length).toBeGreaterThan(0);
      for (const u of data.users) {
        expect(u).not.toHaveProperty('password_hash');
        expect(u).not.toHaveProperty('password_salt');
        expect(u).not.toHaveProperty('token_version');
        expect(u).toHaveProperty('email');
        expect(u).toHaveProperty('name');
        expect(u).toHaveProperty('role');
        expect(u).toHaveProperty('active');
      }
    });

    it('escapes search wildcards correctly', () => {
      expect(escapeLike('50% off')).toBe('50\\% off');
      expect(escapeLike('user_name')).toBe('user\\_name');
      expect(escapeLike('C:\\Users')).toBe('C:\\\\Users');
    });

    it('filters users by role and status', async () => {
      const req = new Request('https://apa.example.com/api/admin/users?role=professor&status=active', {
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.users.every((u: any) => u.role === 'professor' && u.active)).toBe(true);
    });

    it('implements keyset pagination returning rows across pages', async () => {
      const req1 = new Request('https://apa.example.com/api/admin/users?limit=3', {
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res1 = await worker.fetch(req1, env);
      const page1 = (await res1.json()) as any;
      expect(page1.users.length).toBe(3);
      expect(page1.next_cursor).toBeDefined();

      const req2 = new Request(`https://apa.example.com/api/admin/users?limit=3&cursor=${encodeURIComponent(page1.next_cursor)}`, {
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res2 = await worker.fetch(req2, env);
      const page2 = (await res2.json()) as any;
      expect(page2.users.length).toBeGreaterThan(0);

      // Verify no overlap between page 1 and page 2
      const ids1 = page1.users.map((u: any) => u.id);
      const ids2 = page2.users.map((u: any) => u.id);
      expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
    });
  });

  // ── 3. User Deactivation & Reactivation ────────────────────────────────────
  describe('User Deactivation & Reactivation', () => {
    it('deactivates user and increments token_version', async () => {
      const req = new Request('https://apa.example.com/api/admin/users/prof-1/deactivate', {
        method: 'POST',
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.active).toBe(0);

      const dbUser = sqlite.prepare('SELECT active, token_version FROM users WHERE id = ?').get('prof-1') as any;
      expect(dbUser.active).toBe(0);
      expect(dbUser.token_version).toBe(1);

      // An old token with token_version 0 now fails authentication
      const profReq = new Request('https://apa.example.com/api/professor/exams', {
        headers: { Cookie: serializeAuthCookie(profToken), Origin: LOCAL_ORIGIN },
      });
      const profRes = await worker.fetch(profReq, env);
      expect(profRes.status).toBe(401);
    });

    it('refuses self-deactivation with 409', async () => {
      const req = new Request('https://apa.example.com/api/admin/users/admin-1/deactivate', {
        method: 'POST',
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe('cannot_deactivate_self');
    });

    it('refuses deactivation of the last active administrator with 409', async () => {
      // Deactivate admin-2 in DB first so admin-1 is the only remaining active admin
      sqlite.prepare("UPDATE users SET active = 0 WHERE id = 'admin-2'").run();

      // Now admin-1 attempts to deactivate admin-1 (the last active admin)
      const req = new Request('https://apa.example.com/api/admin/users/admin-1/deactivate', {
        method: 'POST',
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe('last_admin');
    });

    it('returns 404 for unknown user id', async () => {
      const req = new Request('https://apa.example.com/api/admin/users/non-existent-user/deactivate', {
        method: 'POST',
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(404);
    });

    it('reactivates user and increments token_version', async () => {
      // First deactivate
      sqlite.prepare("UPDATE users SET active = 0, token_version = 1 WHERE id = 'prof-2'").run();

      const req = new Request('https://apa.example.com/api/admin/users/prof-2/reactivate', {
        method: 'POST',
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.active).toBe(1);

      const dbUser = sqlite.prepare('SELECT active, token_version FROM users WHERE id = ?').get('prof-2') as any;
      expect(dbUser.active).toBe(1);
      expect(dbUser.token_version).toBe(2);
    });
  });

  // ── 4. Exam Reassignment ──────────────────────────────────────────────────
  describe('Exam Reassignment (POST /api/admin/exams/:id/reassign)', () => {
    it('refuses reassignment with 409 when student attempts are in progress', async () => {
      const req = new Request('https://apa.example.com/api/admin/exams/exam-live/reassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
        body: JSON.stringify({ newOwnerId: 'prof-2' }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe('exam_in_progress');
    });

    it('refuses reassignment to a student or inactive user with 400', async () => {
      const req = new Request('https://apa.example.com/api/admin/exams/exam-idle/reassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
        body: JSON.stringify({ newOwnerId: 'stu-1' }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe('invalid_owner');
    });

    it('successfully reassigns exam to another professor when no in-progress attempts exist', async () => {
      const req = new Request('https://apa.example.com/api/admin/exams/exam-idle/reassign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
        body: JSON.stringify({ newOwnerId: 'prof-2' }),
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      // Verify exam owner updated in DB
      const exam = sqlite.prepare('SELECT created_by FROM exams WHERE id = ?').get('exam-idle') as any;
      expect(exam.created_by).toBe('prof-2');

      // Verify attempts and answers are intact
      const attempt = sqlite.prepare('SELECT exam_id, student_name FROM attempts WHERE id = ?').get('att-submitted') as any;
      expect(attempt.exam_id).toBe('exam-idle');

      // Old owner (prof-1) now gets 404 when opening the exam
      const oldOwnerReq = new Request('https://apa.example.com/api/professor/exams/exam-idle', {
        headers: { Cookie: serializeAuthCookie(profToken), Origin: LOCAL_ORIGIN },
      });
      const oldOwnerRes = await worker.fetch(oldOwnerReq, env);
      expect(oldOwnerRes.status).toBe(404);

      // New owner (prof-2) can now access the exam
      const prof2Token = (await signJwt({ sub: 'prof-2', role: 'professor', tv: 0 }, TEST_SECRET))!;
      const newOwnerReq = new Request('https://apa.example.com/api/professor/exams/exam-idle', {
        headers: { Cookie: serializeAuthCookie(prof2Token), Origin: LOCAL_ORIGIN },
      });
      const newOwnerRes = await worker.fetch(newOwnerReq, env);
      expect(newOwnerRes.status).toBe(200);
    });
  });

  // ── 5. Platform Overview ──────────────────────────────────────────────────
  describe('GET /api/admin/overview', () => {
    it('returns exact counts and strictly excludes test attempts', async () => {
      const req = new Request('https://apa.example.com/api/admin/overview', {
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;

      expect(data.users.total).toBe(7);
      expect(data.users.admins.active).toBe(2);
      expect(data.users.professors.active).toBe(2);
      expect(data.users.students.active).toBe(3);

      expect(data.exams.total).toBe(4);
      expect(data.exams.active).toBe(2);
      expect(data.exams.draft).toBe(1);
      expect(data.exams.archived).toBe(1);

      // Attempts: att-live (in_progress), att-submitted (submitted), att-test (is_test=1, excluded)
      expect(data.attempts.in_progress_now).toBe(1);
      expect(data.attempts.needs_grading).toBe(1);
      expect(data.attempts.unreviewed_flagged).toBe(1);
    });
  });

  // ── 6. Audit Trail & XSS Safety ───────────────────────────────────────────
  describe('Audit Trail & Safe Plain-Text Rendering', () => {
    it('filters audit records and returns meta_json as raw uninterpreted string', async () => {
      // Record an audit action
      sqlite.prepare(`
        INSERT INTO audit_log (id, ts, actor_user_id, action, target, ip, meta_json)
        VALUES ('aud-1', '2026-11-25T10:00:00.000Z', 'admin-1', 'create_user', 'usr-test', '127.0.0.1', '{"role":"professor","dept":"CS"}')
      `).run();

      const req = new Request('https://apa.example.com/api/admin/audit?action=create_user', {
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;

      expect(data.audit_logs.length).toBeGreaterThan(0);
      const entry = data.audit_logs.find((a: any) => a.id === 'aud-1');
      expect(entry).toBeDefined();
      expect(entry.actor_name).toBe('Admin Primary');
      expect(typeof entry.meta_json).toBe('string');
      expect(entry.meta_json).toContain('"role":"professor"');
    });

    it('returns XSS and formula injection strings safely as plain text data', async () => {
      const req = new Request('https://apa.example.com/api/admin/users?search=script', {
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      const xssUser = data.users.find((u: any) => u.id === 'stu-xss');
      expect(xssUser.name).toBe('<script>alert(1)</script>');

      const req2 = new Request('https://apa.example.com/api/admin/users?search=HYPERLINK', {
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res2 = await worker.fetch(req2, env);
      const data2 = (await res2.json()) as any;
      const formulaUser = data2.users.find((u: any) => u.id === 'stu-formula');
      expect(formulaUser.name).toBe('=HYPERLINK("evil.com")');
    });
  });

  // ── 7. Security & Failed Logins ───────────────────────────────────────────
  describe('GET /api/admin/security/failed-logins', () => {
    it('excludes pwd: rows and identifies accounts with 5+ failures in last 15m as locked', async () => {
      const req = new Request('https://apa.example.com/api/admin/security/failed-logins?hours=24', {
        headers: { Cookie: serializeAuthCookie(adminToken), Origin: LOCAL_ORIGIN },
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;

      // pwd: row must never be included
      expect(data.by_email.some((r: any) => r.email.startsWith('pwd:'))).toBe(false);
      expect(data.locked_accounts.some((r: any) => r.email.startsWith('pwd:'))).toBe(false);

      // victim@test.edu had 5 failures and should be locked
      const locked = data.locked_accounts.find((r: any) => r.email === 'victim@test.edu');
      expect(locked).toBeDefined();
      expect(locked.failure_count).toBe(5);

      // by_ip groups by IP
      const ipGroup = data.by_ip.find((r: any) => r.ip === '192.168.1.10');
      expect(ipGroup).toBeDefined();
      expect(ipGroup.failure_count).toBe(5);
    });
  });

  // ── 8. Triggers: Append-Only Audit Log ─────────────────────────────────────
  describe('Audit Log Append-Only Triggers', () => {
    it('allows INSERT into audit_log but rejects UPDATE and DELETE with error', () => {
      // 1. INSERT works
      sqlite.prepare(`
        INSERT INTO audit_log (id, ts, actor_user_id, action, target)
        VALUES ('trigger-test', '2026-11-25T10:00:00.000Z', 'admin-1', 'test_insert', 'target-1')
      `).run();

      const inserted = sqlite.prepare('SELECT id FROM audit_log WHERE id = ?').get('trigger-test') as any;
      expect(inserted.id).toBe('trigger-test');

      // 2. UPDATE fails
      expect(() => {
        sqlite.prepare("UPDATE audit_log SET action = 'tampered' WHERE id = 'trigger-test'").run();
      }).toThrow(/audit_log is append-only/);

      // 3. DELETE fails
      expect(() => {
        sqlite.prepare("DELETE FROM audit_log WHERE id = 'trigger-test'").run();
      }).toThrow(/audit_log is append-only/);
    });
  });

  // ── 9. Cron Sweeps Recording ──────────────────────────────────────────────
  describe('Cron Sweeps cron_runs Recording & Resilience', () => {
    it('records auto_end_sweep run in cron_runs', async () => {
      await runAutoEndSweep(env);
      const row = sqlite.prepare("SELECT * FROM cron_runs WHERE job = 'auto_end_sweep'").get() as any;
      expect(row).toBeDefined();
      expect(row.job).toBe('auto_end_sweep');
      expect(row.last_ok).toBe(1);
      expect(row.last_run_at).toBeDefined();
    });

    it('records retention_sweep run in cron_runs', async () => {
      await runRetentionSweep(env);
      const row = sqlite.prepare("SELECT * FROM cron_runs WHERE job = 'retention_sweep'").get() as any;
      expect(row).toBeDefined();
      expect(row.job).toBe('retention_sweep');
      expect(row.last_ok).toBe(1);
      expect(row.last_run_at).toBeDefined();
    });

    it('contains cron_runs write failure without breaking sweep execution', async () => {
      // Simulate D1 error on cron_runs insert by dropping the table in a separate test sqlite db
      const brokenSqlite = new DatabaseSync(':memory:');
      const brokenEnv = {
        DB: {
          prepare: (sql: string) => {
            if (sql.includes('cron_runs')) {
              throw new Error('Simulated D1 failure on cron_runs table');
            }
            return env.DB.prepare(sql);
          },
        },
      };

      // Both sweeps should return their normal result without throwing
      const resAuto = await runAutoEndSweep(brokenEnv as any);
      expect(resAuto).toHaveProperty('processed');

      const resRetention = await runRetentionSweep(brokenEnv as any);
      expect(resRetention).toHaveProperty('purgedCount');
    });
  });
});
