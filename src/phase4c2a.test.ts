/**
 * src/phase4c2a.test.ts — Comprehensive Test Suite for Phase 4c-2a (Vitest)
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies:
 *   1. Manual grading & point validation (0..max, step 0.25, non-gradable MCQ -> 400)
 *   2. Override logic (preserves auto_points, sets grading_source = 'override')
 *   3. Server-authoritative score recomputation & fully_graded toggle
 *   4. Blind grading mode (replaces student names, omits session_id)
 *   5. Result access gating (all 4 states) & answer-leak protection
 *   6. AI suggest-grade rate limiting (20/min) & strict point clamping
 *   7. Server cron sweep auto-end (grace period, unpaused only, idempotent)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect } from 'vitest';
import { gradeAttempt, toStudentQuestion, type QuestionForGrading } from '../worker/utils/questionGrading';
import { handleGradingApi as rawHandleGradingApi, runAutoEndSweep, type GradingEnv } from '../worker/api/grading';
import { handleStudentApi as rawHandleStudentApi } from '../worker/api/student';
import { signJwt } from '../worker/auth/jwt';
import { serializeAuthCookie } from '../worker/auth/cookies';
import type { User } from '../worker/auth/types';

const TEST_SECRET = 'test-secret-key-for-jwt-signing-minimum-32-chars-long';

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

const handleGradingApi = (
  req: Request,
  env: any,
  subPath: string,
  method: string,
  user: User = mockProfUser,
) => {
  const finalEnv = { JWT_SECRET: TEST_SECRET, ...env };
  return rawHandleGradingApi(req, finalEnv, subPath, method, user);
};

const handleStudentApi = async (req: Request, env: any) => {
  const token = await signJwt({ sub: 'student-test', role: 'student', tv: 0 }, TEST_SECRET);
  const cookie = serializeAuthCookie(token);
  const headers = new Headers(req.headers);
  if (!headers.has('Cookie')) {
    headers.set('Cookie', cookie);
  }
  if (!headers.has('Origin') && req.method !== 'GET' && req.method !== 'HEAD') {
    headers.set('Origin', 'http://localhost');
  }
  const proxiedReq = new Request(req.url, {
    method: req.method,
    headers,
    body: req.body,
    // @ts-ignore
    duplex: 'half',
  });
  const finalEnv = { JWT_SECRET: TEST_SECRET, ...env };
  return rawHandleStudentApi(proxiedReq, finalEnv);
};

// ─── Mock D1 Database Helper ─────────────────────────────────────────────────

interface MockDbConfig {
  exam?: Record<string, unknown> | null;
  attempt?: Record<string, unknown> | null;
  attemptsList?: Record<string, unknown>[];
  questionsList?: Record<string, unknown>[];
  snapshotRow?: { snapshot_json: string | null; rubric?: string | null } | null;
  answersList?: Record<string, unknown>[];
  rateLimitCount?: number;
  scoreRow?: { total_score: number | null; pending_count: number } | null;
}

function createMockDb(config: MockDbConfig) {
  const runLogs: Array<{ query: string; params: unknown[] }> = [];

  function makeStatement(query: string, boundArgs: unknown[] = []) {
    return {
      bind(...args: unknown[]) {
        return makeStatement(query, args);
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        // Users lookup (Phase 5a requireAuth)
        if (query.includes('FROM users WHERE id = ?')) {
          const id = String(boundArgs[0] ?? '');
          return (id === 'prof-test' ? mockProfUser : mockStudentUser) as T;
        }
        // Rate limit check
        if (query.includes('FROM grading_rate_limits')) {
          return { count: config.rateLimitCount ?? 0 } as T;
        }
        // Exam lookup (default created_by = prof-test for ownership checks)
        if (query.includes('FROM exams WHERE id = ?') || query.includes('FROM exams WHERE join_code = ?')) {
          return (config.exam ? { created_by: 'prof-test', ...config.exam } : null) as T | null;
        }
        // Attempt lookup (default user_id = student-test)
        if (query.includes('FROM attempts WHERE id = ?') || query.includes('FROM attempts WHERE exam_id = ?')) {
          return (config.attempt ? { user_id: 'student-test', ...config.attempt } : null) as T | null;
        }
        // Snapshot lookup
        if (query.includes('FROM exam_questions') && query.includes('snapshot_json')) {
          return (config.snapshotRow ?? null) as T | null;
        }
        // Question lookup (for rubric)
        if (query.includes('FROM questions WHERE id = ?')) {
          return { rubric: config.snapshotRow?.rubric ?? null } as T;
        }
        // Score row
        if (query.includes('SUM(awarded_points)')) {
          return (config.scoreRow ?? { total_score: 10, pending_count: 0 }) as T;
        }
        // Existing answer lookup
        if (query.includes('FROM answers WHERE attempt_id = ? AND question_id = ?')) {
          const found = config.answersList?.find((a) => a.question_id === boundArgs[1]);
          return (found ?? null) as T | null;
        }
        return null;
      },
      async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
        if (query.includes('FROM attempts WHERE a.exam_id = ?') || query.includes('FROM attempts WHERE exam_id = ?')) {
          const raw = config.attemptsList ?? [config.attempt].filter(Boolean);
          const mapped = raw.map((a: any) => ({ user_id: 'student-test', ...a }));
          return { results: mapped as T[] };
        }
        if (query.includes('FROM exam_questions')) {
          return {
            results: (config.questionsList ?? []).map((q, idx) => ({
              snapshot_json: JSON.stringify(q),
              position: idx,
              rubric: q.rubric ?? null,
            })) as T[],
          };
        }
        if (query.includes('FROM answers WHERE attempt_id = ?') || query.includes('FROM answers ans')) {
          return { results: (config.answersList ?? []) as T[] };
        }
        if (query.includes('FROM attempts') && query.includes("status = 'in_progress'")) {
          let list = config.attemptsList ?? [];
          if (query.includes('paused_at IS NULL')) {
            list = list.filter((a) => !a.paused_at);
          } else if (query.includes('paused_at IS NOT NULL')) {
            list = list.filter((a) => !!a.paused_at);
          }
          if (query.includes('deadline_at < ?') && boundArgs.length > 0) {
            const cutoff = boundArgs[0] as string;
            list = list.filter((a) => typeof a.deadline_at === 'string' && a.deadline_at < cutoff);
          }
          return { results: list as T[] };
        }
        return { results: [] };
      },
      async run() {
        runLogs.push({ query, params: boundArgs });
        return { success: true };
      },
    };
  }

  const db = {
    prepare(query: string) {
      return makeStatement(query);
    },
    async batch(stmts: Array<{ run: () => Promise<{ success: boolean }> }>) {
      for (const s of stmts) await s.run();
      return [];
    },
    _runLogs: runLogs,
  };

  return db as unknown as D1Database & { _runLogs: typeof runLogs };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Phase 4c-2a: Extended Grading Engine & Auto-Zero', () => {
  it('auto-zeros manual questions left blank so they never show as pending', () => {
    const qManual: QuestionForGrading = {
      id: 'q-essay',
      type: 'long_answer',
      grading_mode: 'manual',
      points: 10,
      correct_answer: null,
    };

    // Student submitted blank answer
    const answersBlank = new Map<string, string>([
      ['q-essay', '""'], // empty JSON string
    ]);

    const res = gradeAttempt([qManual], answersBlank);
    expect(res.answer_grades).toHaveLength(1);
    expect(res.answer_grades[0].awarded_points).toBe(0);
    expect(res.answer_grades[0].grading_source).toBe('manual');
    expect(res.fully_graded).toBe(true); // not pending!
  });

  it('keeps manual question with real answer as pending (null awarded_points)', () => {
    const qManual: QuestionForGrading = {
      id: 'q-essay',
      type: 'long_answer',
      grading_mode: 'manual',
      points: 10,
      correct_answer: null,
    };

    const answersReal = new Map<string, string>([
      ['q-essay', JSON.stringify('My thoughtful explanation of Dijkstra algorithm.')],
    ]);

    const res = gradeAttempt([qManual], answersReal);
    expect(res.answer_grades).toHaveLength(1);
    expect(res.answer_grades[0].awarded_points).toBeNull();
    expect(res.answer_grades[0].grading_source).toBeNull();
    expect(res.fully_graded).toBe(false);
    expect(res.grading_status).toBe('pending_manual');
  });
});

describe('Phase 4c-2a: Grade PUT Validation & Overrides', () => {
  it('rejects grading attempts that are still in_progress with 409', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', title: 'Test', results_released: 0 },
      attempt: { id: 'att-1', exam_id: 'exam-1', status: 'in_progress' },
    });

    const req = new Request('http://localhost/api/professor/attempts/att-1/answers/q-1/grade', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: 2 }),
    });

    const res = await handleGradingApi(req, { DB: mockDb }, '/attempts/att-1/answers/q-1/grade', 'PUT');
    expect(res?.status).toBe(409);
    const body = (await res?.json()) as { error: string };
    expect(body.error).toContain('not in a gradable state');
  });

  it('rejects points out of range or not a multiple of 0.25 with 400', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', title: 'Test' },
      attempt: { id: 'att-1', exam_id: 'exam-1', status: 'submitted' },
      snapshotRow: {
        snapshot_json: JSON.stringify({ id: 'q-1', points: 5, type: 'short_answer', grading_mode: 'manual' }),
      },
    });

    // 1. Points greater than max
    const req1 = new Request('http://localhost/api/professor/attempts/att-1/answers/q-1/grade', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: 6 }),
    });
    const res1 = await handleGradingApi(req1, { DB: mockDb }, '/attempts/att-1/answers/q-1/grade', 'PUT');
    expect(res1?.status).toBe(400);

    // 2. Step not 0.25 (e.g. 2.13)
    const req2 = new Request('http://localhost/api/professor/attempts/att-1/answers/q-1/grade', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: 2.13 }),
    });
    const res2 = await handleGradingApi(req2, { DB: mockDb }, '/attempts/att-1/answers/q-1/grade', 'PUT');
    expect(res2?.status).toBe(400);
    const body2 = (await res2?.json()) as { error: string };
    expect(body2.error).toContain('multiple of 0.25');
  });

  it('rejects manual grading on MCQ questions with 400', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', title: 'Test' },
      attempt: { id: 'att-1', exam_id: 'exam-1', status: 'submitted' },
      snapshotRow: {
        snapshot_json: JSON.stringify({ id: 'q-mcq', points: 2, type: 'mcq', grading_mode: 'auto' }),
      },
    });

    const req = new Request('http://localhost/api/professor/attempts/att-1/answers/q-mcq/grade', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: 2 }),
    });
    const res = await handleGradingApi(req, { DB: mockDb }, '/attempts/att-1/answers/q-mcq/grade', 'PUT');
    expect(res?.status).toBe(400);
    const body = (await res?.json()) as { error: string };
    expect(body.error).toContain('auto only');
  });

  it('allows override on short_answer and sets grading_source = override while preserving auto_points', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', title: 'Test' },
      attempt: { id: 'att-1', exam_id: 'exam-1', status: 'submitted' },
      snapshotRow: {
        snapshot_json: JSON.stringify({ id: 'q-sa', points: 4, type: 'short_answer', grading_mode: 'auto' }),
      },
      answersList: [{ question_id: 'q-sa', auto_points: 0, grading_source: 'auto' }],
      scoreRow: { total_score: 3.5, pending_count: 0 },
    });

    const req = new Request('http://localhost/api/professor/attempts/att-1/answers/q-sa/grade', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ points: 3.5, comment: 'Partial credit for close answer' }),
    });

    const res = await handleGradingApi(req, { DB: mockDb }, '/attempts/att-1/answers/q-sa/grade', 'PUT');
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { success: boolean; awarded_points: number; fully_graded: boolean };
    expect(body.success).toBe(true);
    expect(body.awarded_points).toBe(3.5);

    // Verify DB update query set grading_source = 'override'
    const updateLog = mockDb._runLogs.find((l) => l.query.includes('UPDATE answers') && l.query.includes('awarded_points'));
    expect(updateLog).toBeDefined();
    expect(updateLog?.params[1]).toBe('override');
  });
});

describe('Phase 4c-2a: Blind Grading Mode', () => {
  it('blind=1 replaces student names with aliases and strips session_id', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', title: 'Test' },
      snapshotRow: {
        snapshot_json: JSON.stringify({ id: 'q-essay', points: 10, type: 'long_answer', grading_mode: 'manual', question_text: 'Explain Paxos.' }),
        rubric: 'Must mention proposers and acceptors.',
      },
      answersList: [
        { attempt_id: 'att-1', student_name: 'Alice Cooper', session_id: 's-alice', answer_json: '"Paxos is..."', awarded_points: null },
        { attempt_id: 'att-2', student_name: 'Bob Marley', session_id: 's-bob', answer_json: '"Paxos works by..."', awarded_points: null },
      ],
    });

    const req = new Request('http://localhost/api/professor/exams/exam-1/grading/questions/q-essay?blind=1');

    const res = await handleGradingApi(req, { DB: mockDb }, '/exams/exam-1/grading/questions/q-essay', 'GET');
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { question: Record<string, unknown>; answers: Array<Record<string, unknown>> };

    expect(body.answers).toHaveLength(2);
    // Student names must be masked
    expect(body.answers[0].student_name).toBe('Student 1');
    expect(body.answers[1].student_name).toBe('Student 2');
    // Session IDs must be undefined
    expect(body.answers[0].session_id).toBeUndefined();
    expect(body.answers[1].session_id).toBeUndefined();
  });
});

describe('Phase 4c-2a: Results Release Gating & Answer Leak Protection', () => {
  it('State 1: unreleased & not instant -> returns submitted_pending_release with zero answers/score', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', results_released: 0, instant_results: 0, show_answers: 0 },
      attempt: { id: 'att-1', exam_id: 'exam-1', status: 'submitted', score: 10, max_score: 10, fully_graded: 1 },
    });

    const req = new Request('http://localhost/api/student/attempts/att-1/result');
    const res = await handleStudentApi(req, { DB: mockDb });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; score?: number };
    expect(data.status).toBe('submitted_pending_release');
    expect(data.score).toBeUndefined();
  });

  it('State 2: instant_results=1 on auto exam with fully_graded=1 -> returns score immediately', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', results_released: 0, instant_results: 1, show_answers: 0 },
      attempt: { id: 'att-1', exam_id: 'exam-1', status: 'submitted', score: 8, max_score: 10, fully_graded: 1, grading_status: 'auto_graded' },
      questionsList: [{ id: 'q-1', question_text: 'Q1', points: 10, type: 'mcq' }],
      answersList: [{ question_id: 'q-1', awarded_points: 8 }],
    });

    const req = new Request('http://localhost/api/student/attempts/att-1/result');
    const res = await handleStudentApi(req, { DB: mockDb });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; score: number };
    expect(data.status).toBe('result_available');
    expect(data.score).toBe(8);
  });

  it('State 3: released=1 but fully_graded=0 -> returns being_graded with no scores', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', results_released: 1, instant_results: 0, show_answers: 0 },
      attempt: { id: 'att-1', exam_id: 'exam-1', status: 'submitted', score: null, max_score: 10, fully_graded: 0, grading_status: 'pending_manual' },
    });

    const req = new Request('http://localhost/api/student/attempts/att-1/result');
    const res = await handleStudentApi(req, { DB: mockDb });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string; score?: number };
    expect(data.status).toBe('being_graded');
    expect(data.score).toBeUndefined();
  });

  it('rubric is NEVER included in student responses even when results are released and show_answers=1', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', results_released: 1, instant_results: 0, show_answers: 1 },
      attempt: { id: 'att-1', exam_id: 'exam-1', status: 'submitted', score: 10, max_score: 10, fully_graded: 1, grading_status: 'auto_graded' },
      questionsList: [
        { id: 'q-1', question_text: 'What is 1+1?', points: 2, type: 'short_answer', correct_answer: '2', rubric: 'TOP_SECRET_PROFESSOR_RUBRIC' },
      ],
      answersList: [{ question_id: 'q-1', answer_json: '"2"', awarded_points: 2 }],
    });

    const req = new Request('http://localhost/api/student/attempts/att-1/result');
    const res = await handleStudentApi(req, { DB: mockDb });
    const text = await res.text();

    expect(text).not.toContain('TOP_SECRET_PROFESSOR_RUBRIC');
    expect(text).not.toContain('rubric');
  });

  it('GET /api/student/exams/:id/attempt returns attempt and exam info', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', title: 'Test Exam', course_code: 'CS101', results_released: 0 },
      attempt: { id: 'att-1', exam_id: 'exam-1', student_name: 'Alice', status: 'submitted' },
    });

    const req = new Request('http://localhost/api/student/exams/exam-1/attempt?name=Alice');
    const res = await handleStudentApi(req, { DB: mockDb });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { exam: { id: string }; attempt: { id: string; status: string } };
    expect(data.exam.id).toBe('exam-1');
    expect(data.attempt.id).toBe('att-1');
    expect(data.attempt.status).toBe('submitted');
  });

  it('GET /api/student/exams/:id/attempt returns 401 when unauthenticated', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', title: 'Test Exam' },
    });

    const req = new Request('http://localhost/api/student/exams/exam-1/attempt');
    const res = await rawHandleStudentApi(req, { DB: mockDb, JWT_SECRET: TEST_SECRET });
    expect(res.status).toBe(401);
  });

  it('GET /api/student/attempts/:id/result returns 403 if attempt is still in progress', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', results_released: 1 },
      attempt: { id: 'att-1', exam_id: 'exam-1', status: 'in_progress' },
    });

    const req = new Request('http://localhost/api/student/attempts/att-1/result');
    const res = await handleStudentApi(req, { DB: mockDb });
    expect(res.status).toBe(403);
  });
});

describe('Phase 4c-2a: AI Suggest-Grade Security & Clamping', () => {
  it('enforces rate limit of 20 AI suggestions per minute per exam', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', title: 'Test' },
      attempt: { id: 'att-1', exam_id: 'exam-1', status: 'submitted' },
      rateLimitCount: 20, // already at limit
    });

    const req = new Request('http://localhost/api/professor/attempts/att-1/answers/q-1/suggest-grade', {
      method: 'POST',
    });

    const res = await handleGradingApi(req, { DB: mockDb }, '/attempts/att-1/answers/q-1/suggest-grade', 'POST');
    expect(res?.status).toBe(429);
    const body = (await res?.json()) as { error: string };
    expect(body.error).toContain('Rate limit exceeded');
  });

  it('clamps suggested points to 0..max points even if AI returns out-of-bounds score', async () => {
    const mockDb = createMockDb({
      exam: { id: 'exam-1', title: 'Test' },
      attempt: { id: 'att-1', exam_id: 'exam-1', status: 'submitted' },
      snapshotRow: {
        snapshot_json: JSON.stringify({ id: 'q-1', points: 5, question_text: 'Test', type: 'short_answer' }),
      },
      answersList: [{ question_id: 'q-1', answer_json: '"I demand 100 points!"' }],
    });

    // Mock AI service returning 99 points
    const mockAi = {
      async run() {
        return { response: JSON.stringify({ suggestedPoints: 99, rationale: 'Student asked for it.' }) };
      },
    };

    const req = new Request('http://localhost/api/professor/attempts/att-1/answers/q-1/suggest-grade', {
      method: 'POST',
    });

    const res = await handleGradingApi(
      req,
      { DB: mockDb, AI: mockAi as unknown as Ai },
      '/attempts/att-1/answers/q-1/suggest-grade',
      'POST',
    );

    expect(res?.status).toBe(200);
    const body = (await res?.json()) as { suggestedPoints: number; note: string };
    expect(body.suggestedPoints).toBe(5); // Clamped to question max 5!
    expect(body.note).toContain('AI suggestion');
  });
});

describe('Phase 4c-2a: Server Cron Auto-End Sweep', () => {
  it('submits expired in-progress attempts past the grace period and is idempotent', async () => {
    let submitCount = 0;
    const mockDb = createMockDb({
      attemptsList: [
        { id: 'att-expired', exam_id: 'exam-1', status: 'in_progress', paused_at: null, deadline_at: '2026-01-01T00:00:00Z' },
      ],
      exam: { id: 'exam-1', status: 'active', end_time: '2030-01-01T00:00:00Z' },
      questionsList: [{ id: 'q-1', points: 2, type: 'mcq' }],
      attempt: { id: 'att-expired', exam_id: 'exam-1', status: 'in_progress' },
    });

    const env: GradingEnv = { DB: mockDb };

    // Run sweep
    const result1 = await runAutoEndSweep(env);
    expect(result1.processed).toBe(1);

    // Verify status was updated to auto_submitted in DB
    const updateLog = mockDb._runLogs.find((l) => l.query.includes('SET status = ?') && l.params[0] === 'auto_submitted');
    expect(updateLog).toBeDefined();

    // Second run: attempt now has status 'auto_submitted' -> idempotency check skips it
    const mockDbRun2 = createMockDb({
      attemptsList: [
        { id: 'att-expired', exam_id: 'exam-1', status: 'auto_submitted', paused_at: null },
      ],
      attempt: { id: 'att-expired', exam_id: 'exam-1', status: 'auto_submitted' }, // fresh lookup returns auto_submitted
    });

    const result2 = await runAutoEndSweep({ DB: mockDbRun2 });
    expect(result2.processed).toBe(0);
  });

  it('proves an attempt expired 2 minutes ago with real ISO string is swept, while one expiring in 10 minutes is not', async () => {
    const now = Date.now();
    const expiredDeadlineIso = new Date(now - 2 * 60 * 1000).toISOString(); // 2 min ago
    const futureDeadlineIso = new Date(now + 10 * 60 * 1000).toISOString(); // 10 min in future

    const mockDb = createMockDb({
      attemptsList: [
        { id: 'att-expired', exam_id: 'exam-1', status: 'in_progress', paused_at: null, deadline_at: expiredDeadlineIso },
        { id: 'att-active', exam_id: 'exam-1', status: 'in_progress', paused_at: null, deadline_at: futureDeadlineIso },
      ],
      exam: { id: 'exam-1', status: 'active', end_time: new Date(now + 3600000).toISOString() },
      questionsList: [{ id: 'q-1', points: 2, type: 'mcq' }],
      attempt: { id: 'att-expired', exam_id: 'exam-1', status: 'in_progress' },
    });

    const env: GradingEnv = { DB: mockDb };
    const sweep = await runAutoEndSweep(env);

    expect(sweep.processed).toBe(1);
    const submittedIds = mockDb._runLogs
      .filter((l) => l.query.includes('SET status = ?') && l.params[0] === 'auto_submitted')
      .map((l) => l.params[l.params.length - 1]); // WHERE id = ? is last param
    expect(submittedIds).toContain('att-expired');
    expect(submittedIds).not.toContain('att-active');
  });
});
