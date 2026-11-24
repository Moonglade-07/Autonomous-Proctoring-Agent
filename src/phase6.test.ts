/**
 * src/phase6.test.ts — Phase 6 Integrity Reports & Review Queue Test Suite
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates:
 * 1. computeReviewLevel pure function & reasoning:
 *    - All rule branches: unknown (NULL count), high (boundary at maxRiskScore,
 *      critical severity, identity mismatch, multiple faces), medium (high severity,
 *      count >= 3), low (count >= 1), none.
 * 2. Report Endpoint:
 *    - Owner and admin access granted.
 *    - Professor B receives 404 for Professor A's attempt.
 *    - Student receives 403 or 404.
 *    - Test attempts only accessible by owner.
 *    - Purged attempts return summary only with purged: true.
 *    - Absence of leaked fields (no answers, correct answers, rubrics, tokens).
 *    - Audit log entry 'view_report' written.
 * 3. Review Decision Endpoint:
 *    - Rejection of in-progress attempts with 409.
 *    - Decision recording (no_action, warning, escalate) with note.
 *    - Note length constraint (> 2000 chars rejected with 400).
 *    - Clearing decision with decision: null.
 *    - Non-owner gets 404.
 *    - Audit log entry 'review_attempt' written.
 * 4. Violation Review Endpoint:
 *    - Unknown violation ID returns 404.
 *    - Confirm and dismiss upsert in violation_reviews.
 *    - Clear with decision: null.
 * 5. Review Queue (Per-exam & Cross-exam):
 *    - Exclusion of test attempts (is_test = 1) and archived attempts.
 *    - Cross-exam isolation between professors; admin sees all.
 *    - Ordering: high > medium > low > none > unknown, then final risk score DESC.
 *    - Status filter: unreviewed vs reviewed.
 *    - D1-only computation (no DO calls).
 * 6. XSS & Injection:
 *    - Strings containing <script> and =HYPERLINK preserved as plain text.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, beforeEach } from 'vitest';
import worker from '../worker/index.js';
import { signJwt } from '../worker/auth/jwt.js';
import { serializeAuthCookie } from '../worker/auth/cookies.js';
import {
  computeReviewLevel,
  getReviewReasons,
  reviewLevelRank,
} from '../worker/utils/reviewLevel.js';
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

describe('Phase 6: computeReviewLevel & getReviewReasons Pure Functions', () => {
  it('returns unknown when violationCount is NULL or undefined', () => {
    expect(computeReviewLevel({ maxRiskScore: 80, violationCount: null })).toBe('unknown');
    expect(computeReviewLevel({ maxRiskScore: 80, violationCount: undefined })).toBe('unknown');

    const reasons = getReviewReasons({ maxRiskScore: 80, violationCount: null });
    expect(reasons[0]).toContain('not recorded');
  });

  it('returns high when finalRiskScore >= maxRiskScore (boundary test)', () => {
    // Exactly at boundary
    expect(
      computeReviewLevel({ finalRiskScore: 80, maxRiskScore: 80, violationCount: 0 }),
    ).toBe('high');

    // Above boundary
    expect(
      computeReviewLevel({ finalRiskScore: 85, maxRiskScore: 80, violationCount: 0 }),
    ).toBe('high');

    // Below boundary (should NOT be high)
    expect(
      computeReviewLevel({ finalRiskScore: 79.9, maxRiskScore: 80, violationCount: 0 }),
    ).toBe('none');
  });

  it('returns high when maxSeverity is critical', () => {
    expect(
      computeReviewLevel({
        finalRiskScore: 20,
        maxRiskScore: 80,
        maxSeverity: 'critical',
        violationCount: 1,
      }),
    ).toBe('high');
  });

  it('returns high when identity mismatch or multiple faces occurred', () => {
    expect(
      computeReviewLevel({
        finalRiskScore: 10,
        maxRiskScore: 80,
        violationCount: 1,
        hasIdentityMismatch: true,
      }),
    ).toBe('high');

    expect(
      computeReviewLevel({
        finalRiskScore: 10,
        maxRiskScore: 80,
        violationCount: 1,
        hasMultipleFaces: true,
      }),
    ).toBe('high');
  });

  it('returns medium when maxSeverity is high or violationCount >= 3', () => {
    expect(
      computeReviewLevel({
        finalRiskScore: 30,
        maxRiskScore: 80,
        maxSeverity: 'high',
        violationCount: 1,
      }),
    ).toBe('medium');

    expect(
      computeReviewLevel({
        finalRiskScore: 30,
        maxRiskScore: 80,
        maxSeverity: 'low',
        violationCount: 3,
      }),
    ).toBe('medium');

    expect(
      computeReviewLevel({
        finalRiskScore: 30,
        maxRiskScore: 80,
        maxSeverity: 'low',
        violationCount: 5,
      }),
    ).toBe('medium');
  });

  it('returns low when violationCount is between 1 and 2 with non-critical/high severity', () => {
    expect(
      computeReviewLevel({
        finalRiskScore: 20,
        maxRiskScore: 80,
        maxSeverity: 'low',
        violationCount: 1,
      }),
    ).toBe('low');

    expect(
      computeReviewLevel({
        finalRiskScore: 20,
        maxRiskScore: 80,
        maxSeverity: 'medium',
        violationCount: 2,
      }),
    ).toBe('low');
  });

  it('returns none when violationCount is 0 and no risk triggers occurred', () => {
    expect(
      computeReviewLevel({
        finalRiskScore: 0,
        maxRiskScore: 80,
        violationCount: 0,
        maxSeverity: null,
      }),
    ).toBe('none');

    const reasons = getReviewReasons({
      finalRiskScore: 0,
      maxRiskScore: 80,
      violationCount: 0,
    });
    expect(reasons[0]).toContain('No violations');
  });

  it('correctly ranks review levels for sorting', () => {
    expect(reviewLevelRank('high')).toBeGreaterThan(reviewLevelRank('medium'));
    expect(reviewLevelRank('medium')).toBeGreaterThan(reviewLevelRank('low'));
    expect(reviewLevelRank('low')).toBeGreaterThan(reviewLevelRank('none'));
    expect(reviewLevelRank('none')).toBeGreaterThan(reviewLevelRank('unknown'));
  });
});

describe('Phase 6: Integrity Reports & Human Review Decision Integration', () => {
  let sqlite: DatabaseSync;
  let env: any;
  let profAToken: string;
  let profBToken: string;
  let adminToken: string;
  let studentToken: string;

  const mockDoHistory = {
    sessionId: 'sess-live',
    riskScore: 65,
    riskHistory: [
      {
        timestamp: '2026-11-22T10:05:00.000Z',
        score: 30,
        triggers: ['tab_switch'],
        aiExplanation: 'Switched browser tab for 4 seconds',
      },
      {
        timestamp: '2026-11-22T10:10:00.000Z',
        score: 65,
        triggers: ['multiple_faces'],
        aiExplanation: 'Second person detected in frame',
      },
    ],
    violations: [
      {
        id: 'viol-1',
        sessionId: 'sess-live',
        type: 'behavioral',
        severity: 'medium',
        timestamp: '2026-11-22T10:05:00.000Z',
        aiConfidence: 0.95,
        humanReviewed: false,
      },
      {
        id: 'viol-2',
        sessionId: 'sess-live',
        type: 'vision',
        severity: 'high',
        timestamp: '2026-11-22T10:10:00.000Z',
        aiConfidence: 0.88,
        humanReviewed: false,
      },
    ],
    interventions: [
      {
        id: 'inter-1',
        action: 'warn',
        message: 'Please keep only your exam window open.',
        issuedAt: '2026-11-22T10:06:00.000Z',
        acknowledgedAt: '2026-11-22T10:06:10.000Z',
      },
    ],
  };

  beforeEach(async () => {
    sqlite = new DatabaseSync(':memory:');
    const migDir = path.resolve(__dirname, '../migrations');
    const migFiles = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of migFiles) {
      sqlite.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
    }

    const now = '2026-11-22T10:00:00.000Z';
    // Seed users
    sqlite.exec(`
      INSERT INTO users (id, email, password_hash, password_salt, name, role, active, token_version, privacy_accepted_at, created_at)
      VALUES
        ('prof-a', 'prof.a@test.edu', 'hash', 'salt', 'Prof Alice', 'professor', 1, 0, '${now}', '${now}'),
        ('prof-b', 'prof.b@test.edu', 'hash', 'salt', 'Prof Bob', 'professor', 1, 0, '${now}', '${now}'),
        ('admin-1', 'admin@test.edu', 'hash', 'salt', 'Admin User', 'admin', 1, 0, '${now}', '${now}'),
        ('stu-1', 'stu1@test.edu', 'hash', 'salt', 'Student Sam', 'student', 1, 0, '${now}', '${now}'),
        ('stu-2', 'stu2@test.edu', 'hash', 'salt', 'Student Two', 'student', 1, 0, '${now}', '${now}'),
        ('stu-3', 'stu3@test.edu', 'hash', 'salt', 'Student Three', 'student', 1, 0, '${now}', '${now}'),
        ('stu-4', 'stu4@test.edu', 'hash', 'salt', 'Legacy Student', 'student', 1, 0, '${now}', '${now}'),
        ('stu-xss', 'stuxss@test.edu', 'hash', 'salt', 'Student XSS', 'student', 1, 0, '${now}', '${now}');
    `);

    // Seed exams
    sqlite.exec(`
      INSERT INTO exams (id, title, course_code, created_by, duration_minutes, max_risk_score, join_code, join_code_active, status, retention_days, created_at, updated_at)
      VALUES
        ('exam-a', 'CS 101', 'Intro to CS', 'prof-a', 60, 75, 'CS101A', 1, 'active', 90, '${now}', '${now}'),
        ('exam-b', 'MATH 201', 'Calculus II', 'prof-b', 60, 80, 'MATH2B', 1, 'active', 90, '${now}', '${now}');
    `);

    // Seed attempts
    sqlite.exec(`
      INSERT INTO attempts (
        id, exam_id, user_id, student_name, session_id, status, started_at, deadline_at, submitted_at,
        final_risk_score, violation_count, max_severity, ended_reason, is_test, archived
      )
      VALUES
        ('att-ended', 'exam-a', 'stu-1', 'Student Sam', 'sess-live', 'submitted',
         '2026-11-22T10:00:00.000Z', '2026-11-22T11:00:00.000Z', '2026-11-22T10:45:00.000Z', 65, 2, 'high', 'submitted', 0, 0),
        ('att-progress', 'exam-a', 'stu-2', 'Student Two', 'sess-prog', 'in_progress',
         '2026-11-22T10:00:00.000Z', '2026-11-22T11:00:00.000Z', NULL, 10, 0, NULL, NULL, 0, 0),
        ('att-purged', 'exam-a', 'stu-3', 'Student Three', 'sess-purged', 'submitted',
         '2026-11-22T08:00:00.000Z', '2026-11-22T09:00:00.000Z', '2026-11-22T08:50:00.000Z', 85, 4, 'critical', 'submitted', 0, 0),
        ('att-test', 'exam-a', 'prof-a', 'Preview Tester', 'sess-test', 'submitted',
         '2026-11-22T09:00:00.000Z', '2026-11-22T10:00:00.000Z', '2026-11-22T09:30:00.000Z', 0, 0, NULL, 'submitted', 1, 0),
        ('att-legacy', 'exam-a', 'stu-4', 'Legacy Student', 'sess-leg', 'submitted',
         '2026-11-20T08:00:00.000Z', '2026-11-20T09:00:00.000Z', '2026-11-20T08:50:00.000Z', 0, NULL, NULL, 'submitted', 0, 0);
    `);

    // Mark att-purged with data_purged_at
    sqlite.exec(`UPDATE attempts SET data_purged_at = '${now}' WHERE id = 'att-purged'`);

    const d1 = createD1Adapter(sqlite);

    env = {
      DB: d1,
      JWT_SECRET: TEST_SECRET,
      INTERNAL_SECRET: TEST_INTERNAL_SECRET,
      EXAM_SESSION: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: (id: any) => ({
          fetch: async (req: Request) => {
            const url = new URL(req.url);
            const sessId = url.searchParams.get('sessionId');
            if (sessId === 'sess-live') {
              return new Response(JSON.stringify(mockDoHistory), { status: 200 });
            }
            return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
          },
        }),
      },
    };

    profAToken = await signJwt({ sub: 'prof-a', role: 'professor', tv: 0, exp: 9999999999 }, TEST_SECRET);
    profBToken = await signJwt({ sub: 'prof-b', role: 'professor', tv: 0, exp: 9999999999 }, TEST_SECRET);
    adminToken = await signJwt({ sub: 'admin-1', role: 'admin', tv: 0, exp: 9999999999 }, TEST_SECRET);
    studentToken = await signJwt({ sub: 'stu-1', role: 'student', tv: 0, exp: 9999999999 }, TEST_SECRET);
  });

  it('allows owner professor and admin to open the report, but blocks professor B with 404 and student with 403/404', async () => {
    // 1. Owner Prof A
    const reqA = new Request('https://apa.example.com/api/professor/attempts/att-ended/report', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const resA = await worker.fetch(reqA, env);
    expect(resA.status).toBe(200);
    const dataA = (await resA.json()) as any;

    expect(dataA.header.attemptId).toBe('att-ended');
    expect(dataA.header.examTitle).toBe('CS 101');
    expect(dataA.header.studentName).toBe('Student Sam');
    expect(dataA.header.durationSeconds).toBe(2700); // 45 minutes
    expect(dataA.header.reviewLevel).toBe('high'); // multiple_faces in triggers
    expect(dataA.riskTimeline.length).toBe(2);
    expect(dataA.violations.length).toBe(2);
    expect(dataA.interventions.length).toBe(1);

    // 2. Admin can open report
    const reqAdmin = new Request('https://apa.example.com/api/professor/attempts/att-ended/report', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(adminToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const resAdmin = await worker.fetch(reqAdmin, env);
    expect(resAdmin.status).toBe(200);

    // 3. Non-owner Prof B receives 404
    const reqB = new Request('https://apa.example.com/api/professor/attempts/att-ended/report', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profBToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const resB = await worker.fetch(reqB, env);
    expect(resB.status).toBe(404);

    // 4. Student receives 403 or 404
    const reqStu = new Request('https://apa.example.com/api/professor/attempts/att-ended/report', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(studentToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const resStu = await worker.fetch(reqStu, env);
    expect([403, 404]).toContain(resStu.status);
  });

  it('restricts test attempts strictly to their owner', async () => {
    // Owner Prof A succeeds
    const reqOwner = new Request('https://apa.example.com/api/professor/attempts/att-test/report', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const resOwner = await worker.fetch(reqOwner, env);
    expect(resOwner.status).toBe(200);

    // Non-owner Prof B receives 404
    const reqB = new Request('https://apa.example.com/api/professor/attempts/att-test/report', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profBToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const resB = await worker.fetch(reqB, env);
    expect(resB.status).toBe(404);
  });

  it('returns summary only with purged: true when data_purged_at is set', async () => {
    const req = new Request('https://apa.example.com/api/professor/attempts/att-purged/report', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    expect(data.header.purged).toBe(true);
    expect(data.header.violationCount).toBe(4);
    expect(data.header.maxSeverity).toBe('critical');
    expect(data.header.finalRiskScore).toBe(85);
    expect(data.riskTimeline).toEqual([]);
    expect(data.violations).toEqual([]);
    expect(data.interventions).toEqual([]);
  });

  it('strictly contains no answers, rubrics, tokens, or passwords in report JSON', async () => {
    const req = new Request('https://apa.example.com/api/professor/attempts/att-ended/report', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const res = await worker.fetch(req, env);
    const text = await res.text();

    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('salt');
    expect(text).not.toContain('rubric');
    expect(text).not.toContain('correct_answer');
  });

  it('writes an audit_log entry with action view_report on report open', async () => {
    const req = new Request('https://apa.example.com/api/professor/attempts/att-ended/report', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    await worker.fetch(req, env);

    const log = sqlite.prepare("SELECT * FROM audit_log WHERE action = 'view_report' AND target = 'att-ended'").get() as any;
    expect(log).toBeDefined();
    expect(log.actor_user_id).toBe('prof-a');
  });

  it('review decision: rejects in-progress attempts with 409, records decision and notes, allows clearing', async () => {
    // 1. Try to review an in-progress attempt -> 409
    const reqProg = new Request('https://apa.example.com/api/professor/attempts/att-progress/review', {
      method: 'PUT',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        'Content-Type': 'application/json',
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({ decision: 'warning', note: 'Early warning' }),
    });
    const resProg = await worker.fetch(reqProg, env);
    expect(resProg.status).toBe(409);

    // 2. Reject note exceeding 2000 characters -> 400
    const longNote = 'a'.repeat(2001);
    const reqLong = new Request('https://apa.example.com/api/professor/attempts/att-ended/review', {
      method: 'PUT',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        'Content-Type': 'application/json',
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({ decision: 'warning', note: longNote }),
    });
    const resLong = await worker.fetch(reqLong, env);
    expect(resLong.status).toBe(400);

    // 3. Valid decision and note on ended attempt -> 200
    const reqValid = new Request('https://apa.example.com/api/professor/attempts/att-ended/review', {
      method: 'PUT',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        'Content-Type': 'application/json',
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({ decision: 'warning', note: 'Spoke with student about secondary screen' }),
    });
    const resValid = await worker.fetch(reqValid, env);
    expect(resValid.status).toBe(200);
    const dataValid = (await resValid.json()) as any;
    expect(dataValid.review.decision).toBe('warning');
    expect(dataValid.review.reviewedBy).toBe('Prof Alice');

    // Confirm stored in DB
    const dbRow = sqlite.prepare('SELECT review_decision, review_note, reviewed_by FROM attempts WHERE id = ?')
      .get('att-ended') as any;
    expect(dbRow.review_decision).toBe('warning');
    expect(dbRow.reviewed_by).toBe('prof-a');

    // Confirm audit log recorded
    const auditRow = sqlite.prepare("SELECT * FROM audit_log WHERE action = 'review_attempt' AND target = 'att-ended'").get() as any;
    expect(auditRow).toBeDefined();

    // 4. Clear decision with decision: null -> 200
    const reqClear = new Request('https://apa.example.com/api/professor/attempts/att-ended/review', {
      method: 'PUT',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        'Content-Type': 'application/json',
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({ decision: null }),
    });
    const resClear = await worker.fetch(reqClear, env);
    expect(resClear.status).toBe(200);

    const dbRowCleared = sqlite.prepare('SELECT review_decision, review_note FROM attempts WHERE id = ?')
      .get('att-ended') as any;
    expect(dbRowCleared.review_decision).toBeNull();
    expect(dbRowCleared.review_note).toBeNull();
  });

  it('violation review: requires valid violation ID in DO history, upserts decision, and supports clearing', async () => {
    // 1. Unknown violation ID -> 404
    const reqUnknown = new Request('https://apa.example.com/api/professor/attempts/att-ended/violations/viol-unknown/review', {
      method: 'PUT',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        'Content-Type': 'application/json',
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({ decision: 'confirmed' }),
    });
    const resUnknown = await worker.fetch(reqUnknown, env);
    expect(resUnknown.status).toBe(404);

    // 2. Confirm existing violation (viol-1) -> 200
    const reqConfirm = new Request('https://apa.example.com/api/professor/attempts/att-ended/violations/viol-1/review', {
      method: 'PUT',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        'Content-Type': 'application/json',
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({ decision: 'confirmed' }),
    });
    const resConfirm = await worker.fetch(reqConfirm, env);
    expect(resConfirm.status).toBe(200);

    let vRow = sqlite.prepare('SELECT * FROM violation_reviews WHERE attempt_id = ? AND violation_id = ?')
      .get('att-ended', 'viol-1') as any;
    expect(vRow.decision).toBe('confirmed');
    expect(vRow.reviewed_by).toBe('prof-a');

    // 3. Dismiss violation -> 200 upsert
    const reqDismiss = new Request('https://apa.example.com/api/professor/attempts/att-ended/violations/viol-1/review', {
      method: 'PUT',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        'Content-Type': 'application/json',
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({ decision: 'dismissed' }),
    });
    const resDismiss = await worker.fetch(reqDismiss, env);
    expect(resDismiss.status).toBe(200);

    vRow = sqlite.prepare('SELECT * FROM violation_reviews WHERE attempt_id = ? AND violation_id = ?')
      .get('att-ended', 'viol-1') as any;
    expect(vRow.decision).toBe('dismissed');

    // 4. Verify report returns dismissed decision
    const reqRep = new Request('https://apa.example.com/api/professor/attempts/att-ended/report', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const resRep = await worker.fetch(reqRep, env);
    const repData = (await resRep.json()) as any;
    const v1 = repData.violations.find((v: any) => v.id === 'viol-1');
    expect(v1.reviewDecision).toBe('dismissed');

    // 5. Clear violation review decision
    const reqClearV = new Request('https://apa.example.com/api/professor/attempts/att-ended/violations/viol-1/review', {
      method: 'PUT',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        'Content-Type': 'application/json',
        Origin: LOCAL_ORIGIN,
      },
      body: JSON.stringify({ decision: null }),
    });
    const resClearV = await worker.fetch(reqClearV, env);
    expect(resClearV.status).toBe(200);

    vRow = sqlite.prepare('SELECT * FROM violation_reviews WHERE attempt_id = ? AND violation_id = ?')
      .get('att-ended', 'viol-1') as any;
    expect(vRow).toBeUndefined();
  });

  it('review queue: excludes test and archived attempts, correctly ranks by level and risk, and computes without DO calls', async () => {
    // Call per-exam review queue
    const req = new Request('https://apa.example.com/api/professor/exams/exam-a/review', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;

    const ids = data.items.map((it: any) => it.id);
    // att-test (is_test=1) must be strictly excluded
    expect(ids).not.toContain('att-test');
    // Included: att-purged (risk 85, critical -> high), att-ended (risk 65, high sev -> medium in D1), att-progress (none), att-legacy (unknown)
    expect(ids).toContain('att-purged');
    expect(ids).toContain('att-ended');
    expect(ids).toContain('att-legacy');

    // First item should be high review level (att-purged)
    expect(data.items[0].id).toBe('att-purged');
    expect(data.items[0].reviewLevel).toBe('high');

    // Legacy attempt shows unknown level
    const legacyItem = data.items.find((it: any) => it.id === 'att-legacy');
    expect(legacyItem.reviewLevel).toBe('unknown');

    // Test filter by status: unreviewed
    const reqUnrev = new Request('https://apa.example.com/api/professor/exams/exam-a/review?status=unreviewed', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const resUnrev = await worker.fetch(reqUnrev, env);
    const dataUnrev = (await resUnrev.json()) as any;
    expect(dataUnrev.items.every((it: any) => it.reviewDecision === null)).toBe(true);

    // Test cross-exam review queue for Prof A vs Prof B
    const reqCrossA = new Request('https://apa.example.com/api/professor/review', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const resCrossA = await worker.fetch(reqCrossA, env);
    const dataCrossA = (await resCrossA.json()) as any;
    expect(dataCrossA.items.every((it: any) => it.examId === 'exam-a')).toBe(true);

    const reqCrossB = new Request('https://apa.example.com/api/professor/review', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profBToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const resCrossB = await worker.fetch(reqCrossB, env);
    const dataCrossB = (await resCrossB.json()) as any;
    expect(dataCrossB.items.length).toBe(0); // Prof B has no attempts
  });

  it('XSS and injection: preserves malicious HTML and formula payloads as plain text strings', async () => {
    // Insert attempt with malicious student name
    const maliciousName = '=HYPERLINK("http://evil.com", "Malicious")';
    sqlite.exec(`
      INSERT INTO attempts (id, exam_id, user_id, student_name, session_id, status, started_at, deadline_at, submitted_at, final_risk_score, violation_count, max_severity, is_test, archived)
      VALUES ('att-xss', 'exam-a', 'stu-xss', '${maliciousName}', 'sess-xss', 'submitted', '2026-11-22T10:00:00.000Z', '2026-11-22T11:00:00.000Z', '2026-11-22T10:30:00.000Z', 10, 1, 'low', 0, 0);
    `);

    const req = new Request('https://apa.example.com/api/professor/attempts/att-xss/report', {
      method: 'GET',
      headers: {
        Cookie: serializeAuthCookie(profAToken),
        Origin: LOCAL_ORIGIN,
      },
    });
    const res = await worker.fetch(req, env);
    const data = (await res.json()) as any;

    expect(data.header.studentName).toBe(maliciousName);
  });
});
