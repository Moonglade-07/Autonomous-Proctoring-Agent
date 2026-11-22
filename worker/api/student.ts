/**
 * worker/api/student.ts — Student exam-taking REST API (Phase 4c-1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Student interface with Join Code & Lobby support.
 * Global exam listing is removed. Students discover exams by joining with a code.
 *
 * Routes (all under /api/student):
 *   POST /api/student/join                   → join exam with join code + student name (rate-limited)
 *   GET  /api/student/my-exams?name=         → list exams student has enrolled in
 *   GET  /api/student/exams/:id              → get exam metadata + questions (answer-safe StudentQuestion)
 *   POST /api/student/exams/:id/start        → start/resume attempt (requires enrollment!)
 *   PUT  /api/student/attempts/:id/answers   → autosave answers (batch)
 *   GET  /api/student/attempts/:id/time      → server-authoritative timer sync
 *   POST /api/student/attempts/:id/submit    → finalize and grade attempt (idempotent)
 *   GET  /api/student/attempts/:id/result    → get result + optional answer review
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';
import { normalizeJoinCode } from '../utils/joinCode.js';
import {
  toStudentQuestion,
  gradeAttempt,
  type QuestionForGrading,
} from '../utils/questionGrading.js';
import type { StudentQuestion, DerivedExamStatus, ResultStatus } from '../types.js';
import { requireAuth, isAuthResponse } from '../auth/requireAuth.js';

export { gradeAttempt, toStudentQuestion };

interface StudentEnv {
  DB: D1Database;
  JWT_SECRET?: string;
  EXAM_SESSION?: DurableObjectNamespace;
  INTERNAL_SECRET?: string;
}

function nanoId(prefix = 'at'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cors(res: Response): Response {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  return new Response(res.body, { status: res.status, headers: h });
}

function json(data: unknown, status = 200): Response {
  return cors(Response.json(data, { status }));
}

function err(msg: string, status: number): Response {
  return cors(Response.json({ error: msg }, { status }));
}

function computeDerivedStatus(
  status: string,
  startTime: string | null,
  endTime: string | null,
): DerivedExamStatus {
  if (status === 'draft') return 'draft';
  if (status === 'completed' || status === 'closed') return 'ended';

  const nowMs = Date.now();
  if (endTime && new Date(endTime).getTime() < nowMs) return 'ended';
  if (startTime && new Date(startTime).getTime() > nowMs) return 'scheduled';
  return 'live';
}

async function getExam(db: D1Database, id: string) {
  return db
    .prepare('SELECT * FROM exams WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
}

async function getAttempt(db: D1Database, id: string) {
  return db
    .prepare('SELECT * FROM attempts WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
}

function computeSecondsRemaining(attempt: Record<string, unknown>): number {
  const deadline = new Date(attempt.deadline_at as string).getTime();
  const now = Date.now();
  if (attempt.paused_at) {
    const pausedAt = new Date(attempt.paused_at as string).getTime();
    return Math.max(0, Math.floor((deadline - pausedAt) / 1000));
  }
  return Math.max(0, Math.floor((deadline - now) / 1000));
}

async function getStudentQuestions(db: D1Database, examId: string): Promise<StudentQuestion[]> {
  const rows = await db
    .prepare(
      `SELECT eq.id AS eq_id, eq.snapshot_json, eq.position
       FROM exam_questions eq
       WHERE eq.exam_id = ?
       ORDER BY eq.position ASC`,
    )
    .bind(examId)
    .all<{ eq_id: string; snapshot_json: string | null; position: number }>();

  return rows.results.map((row) => {
    if (!row.snapshot_json) {
      throw new Error(
        `snapshot_json is null for exam_question ${row.eq_id} — was this exam published correctly?`,
      );
    }
    const parsed = JSON.parse(row.snapshot_json) as Record<string, unknown>;
    return toStudentQuestion(parsed);
  });
}

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const JoinSchema = z.object({
  code: z.string().min(1, 'Join code is required'),
  studentName: z.string().optional(),
});

const AnswerEntrySchema = z.object({
  question_id: z.string().min(1).optional(),
  questionId: z.string().min(1).optional(),
  answer_json: z.string().optional(),
  answer: z.unknown().optional(),
  marked_for_review: z.boolean().optional(),
  markedForReview: z.boolean().optional(),
});

// ─── Router ───────────────────────────────────────────────────────────────────

export async function handleStudentApi(request: Request, env: StudentEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/student/, '');
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return cors(new Response(null, { status: 204 }));
  }

  const auth = await requireAuth(request, env as any, ['student']);
  if (isAuthResponse(auth)) {
    return auth;
  }
  const user = auth.user;

  // ── POST /join ─────────────────────────────────────────────────────────────
  if (path === '/join' && method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON body', 400);
    }

    const parsed = JoinSchema.safeParse(body);
    if (!parsed.success) {
      return err('Invalid join request', 400);
    }

    const rawCode = parsed.data.code;
    const normalizedCode = normalizeJoinCode(rawCode);

    // Rate limit check: max 10 failed joins per IP in 10 minutes
    const ip =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      '127.0.0.1';

    const failCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const failRow = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM join_attempts
       WHERE ip = ? AND success = 0 AND attempted_at > ?`,
    )
      .bind(ip, failCutoff)
      .first<{ count: number }>();

    if ((failRow?.count ?? 0) >= 10) {
      return err('Too many failed join attempts. Please try again later.', 429);
    }

    // Look up exam by normalized join code
    const exam = await env.DB.prepare(
      'SELECT * FROM exams WHERE join_code = ?',
    )
      .bind(normalizedCode)
      .first<Record<string, unknown>>();

    const attemptId = `ja-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const attemptTime = new Date().toISOString();

    // Generic error to prevent code and draft probing
    const isInvalid = !exam || exam.join_code_active !== 1 || exam.status === 'draft';
    if (isInvalid) {
      await env.DB.prepare(
        'INSERT INTO join_attempts (id, ip, student_name, attempted_at, success) VALUES (?, ?, ?, ?, 0)',
      )
        .bind(attemptId, ip, user.name, attemptTime)
        .run();

      return err('Invalid or inactive code', 400);
    }

    // Record success
    await env.DB.prepare(
      'INSERT INTO join_attempts (id, ip, student_name, attempted_at, success) VALUES (?, ?, ?, ?, 1)',
    )
      .bind(attemptId, ip, user.name, attemptTime)
      .run();

    // Enroll student (idempotent, by user_id)
    const existingEnrollment = await env.DB.prepare(
      'SELECT id FROM exam_enrollments WHERE exam_id = ? AND user_id = ?',
    )
      .bind(exam.id, user.id)
      .first<{ id: string }>();

    if (!existingEnrollment) {
      const enrollId = `en-${crypto.randomUUID()}`;
      try {
        await env.DB.prepare(
          `INSERT INTO exam_enrollments (id, exam_id, user_id, joined_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(exam_id, user_id) WHERE user_id IS NOT NULL DO NOTHING`,
        )
          .bind(enrollId, exam.id, user.id, attemptTime)
          .run();
      } catch (insertErr) {
        const check = await env.DB.prepare(
          'SELECT id FROM exam_enrollments WHERE exam_id = ? AND user_id = ?',
        )
          .bind(exam.id, user.id)
          .first<{ id: string }>();
        if (!check) {
          throw insertErr;
        }
      }
    }

    return json({
      id: exam.id,
      title: exam.title,
      course: exam.course_code,
      course_code: exam.course_code,
      duration: exam.duration_minutes,
      duration_minutes: exam.duration_minutes,
      start_time: exam.start_time,
      end_time: exam.end_time,
      status: exam.status,
    });
  }

  // ── GET /my-exams ──────────────────────────────────────────────────────────
  if (path === '/my-exams' && method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT e.id, e.title, e.course_code, e.duration_minutes, e.start_time, e.end_time, e.status, en.joined_at,
              e.results_released, e.instant_results,
              a.id as attempt_id, a.status as attempt_status, a.score, a.max_score, a.fully_graded, a.grading_status
       FROM exam_enrollments en
       JOIN exams e ON en.exam_id = e.id
       LEFT JOIN attempts a ON a.exam_id = e.id AND a.user_id = en.user_id AND (a.is_test = 0 OR a.is_test IS NULL)
       WHERE en.user_id = ?
       ORDER BY en.joined_at DESC`,
    )
      .bind(user.id)
      .all<Record<string, unknown>>();

    const exams = rows.results.map((r) => {
      const derived = computeDerivedStatus(
        r.status as string,
        r.start_time as string | null,
        r.end_time as string | null,
      );

      const attStatus = r.attempt_status as string | null;
      const isCompleted = attStatus && attStatus !== 'in_progress';
      const resultsReleased = r.results_released === 1;
      const instantResults = r.instant_results === 1;
      const fullyGraded = r.fully_graded === 1;
      const isAutoOnly = r.grading_status === 'auto_graded';

      let resultStatus: ResultStatus | 'in_progress' | null = null;
      let canViewScore = false;

      if (attStatus === 'in_progress') {
        resultStatus = 'in_progress';
      } else if (isCompleted) {
        if (resultsReleased && fullyGraded) {
          resultStatus = 'result_available';
          canViewScore = true;
        } else if (instantResults && isAutoOnly && fullyGraded) {
          resultStatus = 'result_available';
          canViewScore = true;
        } else if (resultsReleased && !fullyGraded) {
          resultStatus = 'being_graded';
        } else if (instantResults && (!isAutoOnly || !fullyGraded)) {
          resultStatus = 'being_graded';
        } else {
          resultStatus = 'submitted_pending_release';
        }
      }

      return {
        id: r.id,
        title: r.title,
        course_code: r.course_code,
        duration_minutes: r.duration_minutes,
        start_time: r.start_time,
        end_time: r.end_time,
        status: r.status,
        derived_status: derived,
        joined_at: r.joined_at,
        attempt_id: (r.attempt_id as string) || null,
        attempt_status: r.attempt_status || null,
        result_status: resultStatus,
        score: canViewScore && r.score !== null ? r.score : null,
        max_score: canViewScore && r.max_score !== null ? r.max_score : null,
      };
    });

    return json({ exams });
  }

  // ── GET /exams/:id ──────────────────────────────────────────────────────────
  // Metadata ONLY — requires active enrollment, returns 404 without enrollment.
  // Questions are NEVER returned here; they are only provided via POST /start for active attempts.
  const examDetailMatch = path.match(/^\/exams\/([^/]+)$/);
  if (method === 'GET' && examDetailMatch) {
    const examId = examDetailMatch[1];

    // Enrollment check: student must have joined/enrolled in this exam
    const enrollment = await env.DB.prepare(
      'SELECT 1 FROM exam_enrollments WHERE exam_id = ? AND user_id = ?',
    )
      .bind(examId, user.id)
      .first();

    if (!enrollment) {
      return err('Exam not found', 404);
    }

    const exam = await getExam(env.DB, examId);
    if (!exam || exam.status === 'draft') return err('Exam not found', 404);

    return json({
      exam: {
        id: exam.id,
        title: exam.title,
        description: exam.description,
        course: exam.course_code,
        course_code: exam.course_code,
        duration: exam.duration_minutes,
        duration_minutes: exam.duration_minutes,
        start_time: exam.start_time,
        end_time: exam.end_time,
        status: exam.status,
        show_answers: exam.show_answers,
      },
    });
  }

  // ── GET /exams/:id/attempt ─────────────────────────────────────────────────
  const examAttemptMatch = path.match(/^\/exams\/([^/]+)\/attempt$/);
  if (method === 'GET' && examAttemptMatch) {
    const examId = examAttemptMatch[1];

    const exam = await getExam(env.DB, examId);
    if (!exam) return err('Exam not found', 404);

    const attempt = await env.DB.prepare(
      `SELECT * FROM attempts WHERE exam_id = ? AND user_id = ? AND (is_test = 0 OR is_test IS NULL)`,
    )
      .bind(examId, user.id)
      .first<Record<string, unknown>>();

    return json({
      exam: {
        id: exam.id,
        title: exam.title,
        course_code: exam.course_code,
        duration_minutes: exam.duration_minutes,
        start_time: exam.start_time,
        end_time: exam.end_time,
        status: exam.status,
        results_released: exam.results_released,
        instant_results: exam.instant_results,
        show_answers: exam.show_answers,
      },
      attempt: attempt ?? null,
    });
  }

  // ── POST /exams/:id/start ───────────────────────────────────────────────────
  const startMatch = path.match(/^\/exams\/([^/]+)\/start$/);
  if (method === 'POST' && startMatch) {
    const examId = startMatch[1];

    // Enrollment check: student must have joined the exam
    const enrollment = await env.DB.prepare(
      'SELECT 1 FROM exam_enrollments WHERE exam_id = ? AND user_id = ?',
    )
      .bind(examId, user.id)
      .first();

    if (!enrollment) {
      return err('Student is not enrolled in this exam. Please join using an exam code.', 403);
    }

    const exam = await getExam(env.DB, examId);
    if (!exam) return err('Exam not found', 404);
    if (exam.status !== 'active' && exam.status !== 'scheduled') {
      return err(`Exam is ${exam.status as string} — not accepting submissions`, 403);
    }

    // Validate exam window
    const nowMs = Date.now();
    if (exam.end_time && new Date(exam.end_time as string).getTime() < nowMs) {
      return err('Exam window has closed', 403);
    }
    if (exam.status === 'scheduled' && exam.start_time && new Date(exam.start_time as string).getTime() > nowMs) {
      return err('Exam has not started yet', 403);
    }

    // Check for existing attempt
    const existing = await env.DB.prepare(
      'SELECT * FROM attempts WHERE exam_id = ? AND user_id = ? AND (is_test = 0 OR is_test IS NULL)',
    )
      .bind(examId, user.id)
      .first<Record<string, unknown>>();

    if (existing) {
      if (
        existing.status === 'in_progress' &&
        !existing.paused_at &&
        new Date(existing.deadline_at as string).getTime() < Date.now()
      ) {
        await autoSubmit(env.DB, existing);
        const refreshed = await getAttempt(env.DB, existing.id as string);
        const questions = await getStudentQuestions(env.DB, examId);
        const savedAnswers = await env.DB.prepare(
          'SELECT question_id, answer_json, marked_for_review FROM answers WHERE attempt_id = ?',
        )
          .bind(existing.id)
          .all<{ question_id: string; answer_json: string; marked_for_review: number }>();

        return json({
          attempt: refreshed,
          questions,
          answers: savedAnswers.results,
          seconds_remaining: 0,
          resumed: true,
        });
      }

      const questions = await getStudentQuestions(env.DB, examId);
      const secondsRemaining = computeSecondsRemaining(existing);
      const savedAnswers = await env.DB.prepare(
        'SELECT question_id, answer_json, marked_for_review FROM answers WHERE attempt_id = ?',
      )
        .bind(existing.id)
        .all<{ question_id: string; answer_json: string; marked_for_review: number }>();

      return json({
        attempt: existing,
        questions,
        answers: savedAnswers.results,
        seconds_remaining: secondsRemaining,
        resumed: true,
      });
    }

    // New attempt
    const questions = await getStudentQuestions(env.DB, examId);
    const maxScore = questions.reduce((s, q) => s + q.points, 0);
    const durationMs = (exam.duration_minutes as number) * 60 * 1000;
    const examEndMs = exam.end_time ? new Date(exam.end_time as string).getTime() : Infinity;
    const deadlineMs = Math.min(nowMs + durationMs, isNaN(examEndMs) ? nowMs + durationMs : examEndMs);
    const startedAt = new Date(nowMs).toISOString();
    const deadlineAt = new Date(deadlineMs).toISOString();
    const attemptId = nanoId('at');
    const sessionId = `sess-${crypto.randomUUID()}`;

    await env.DB.prepare(
      `INSERT INTO attempts (id, exam_id, user_id, student_name, session_id, status,
                             started_at, deadline_at, paused_seconds, max_score, grading_status,
                             is_test, violation_count, final_risk_score)
       VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, 0, ?, 'pending_manual', 0, 0, 0)`,
    )
      .bind(attemptId, examId, user.id, user.name, sessionId, startedAt, deadlineAt, maxScore)
      .run();

    const attempt = await getAttempt(env.DB, attemptId);
    const initialSeconds = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));
    return json({
      attempt: attempt!,
      questions,
      answers: [],
      seconds_remaining: initialSeconds,
      resumed: false,
    });
  }

  // ── PUT /attempts/:id/answers ───────────────────────────────────────────────
  const saveMatch = path.match(/^\/attempts\/([^/]+)\/answers$/);
  if (method === 'PUT' && saveMatch) {
    const attemptId = saveMatch[1];

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return err('Invalid JSON body', 400);
    }

    const attempt = await getAttempt(env.DB, attemptId);
    if (!attempt || attempt.user_id !== user.id) return err('Attempt not found', 404);
    if (attempt.status !== 'in_progress') {
      return err(`Attempt is ${attempt.status as string} — cannot accept answers`, 409);
    }
    if (attempt.paused_at) {
      return err('Exam is paused by the proctor — cannot accept answers', 409);
    }

    // Reject if deadline passed
    const nowMs = Date.now();
    const deadlineMs = new Date(attempt.deadline_at as string).getTime();
    if (nowMs > deadlineMs + 5000 && !attempt.paused_at) {
      await autoSubmit(env.DB, attempt, env);
      return err('Exam deadline has passed. Attempt has been submitted.', 410);
    }

    let entries: z.infer<typeof AnswerEntrySchema>[] = [];
    if (Array.isArray(body.answers)) {
      entries = body.answers as z.infer<typeof AnswerEntrySchema>[];
    } else {
      entries = [body as z.infer<typeof AnswerEntrySchema>];
    }

    const stmts: D1PreparedStatement[] = [];
    const updatedAt = new Date().toISOString();

    for (const raw of entries) {
      const qId = raw.question_id ?? raw.questionId;
      if (!qId) continue;

      let aJson = raw.answer_json;
      if (aJson === undefined && raw.answer !== undefined) {
        aJson = JSON.stringify(raw.answer);
      }
      if (aJson === undefined) continue;

      // Validate 10,000 char length limit
      if (aJson.length > 10000) {
        return err('Answer exceeds maximum allowed length of 10,000 characters', 400);
      }

      const mfr = (raw.marked_for_review ?? raw.markedForReview) ? 1 : 0;

      stmts.push(
        env.DB.prepare(
          `INSERT INTO answers (attempt_id, question_id, answer_json, marked_for_review, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(attempt_id, question_id) DO UPDATE SET
             answer_json = excluded.answer_json,
             marked_for_review = excluded.marked_for_review,
             updated_at = excluded.updated_at`,
        ).bind(attemptId, qId, aJson, mfr, updatedAt),
      );
    }

    if (stmts.length > 0) {
      await env.DB.batch(stmts);
    }

    return json({
      saved: stmts.length,
      seconds_remaining: computeSecondsRemaining(attempt),
      timestamp: updatedAt,
    });
  }

  // ── GET /attempts/:id/time ─────────────────────────────────────────────────
  const timeMatch = path.match(/^\/attempts\/([^/]+)\/time$/);
  if (method === 'GET' && timeMatch) {
    const attemptId = timeMatch[1];
    const attempt = await getAttempt(env.DB, attemptId);
    if (!attempt || attempt.user_id !== user.id) return err('Attempt not found', 404);

    if (
      attempt.status === 'in_progress' &&
      !attempt.paused_at &&
      new Date(attempt.deadline_at as string).getTime() < Date.now()
    ) {
      await autoSubmit(env.DB, attempt);
      const refreshed = await getAttempt(env.DB, attemptId);
      return json({
        seconds_remaining: 0,
        is_paused: false,
        status: refreshed?.status ?? 'auto_submitted',
      });
    }

    return json({
      seconds_remaining: computeSecondsRemaining(attempt),
      is_paused: !!attempt.paused_at,
      status: attempt.status,
    });
  }

  // ── POST /attempts/:id/submit ──────────────────────────────────────────────
  const submitMatch = path.match(/^\/attempts\/([^/]+)\/submit$/);
  if (method === 'POST' && submitMatch) {
    const attemptId = submitMatch[1];
    const attempt = await getAttempt(env.DB, attemptId);
    if (!attempt || attempt.user_id !== user.id) return err('Attempt not found', 404);

    if (attempt.status !== 'in_progress') {
      return json({ attempt, submitted: true, idempotent: true });
    }

    await doSubmit(env.DB, attempt, 'submitted');
    if (env.EXAM_SESSION && attempt.session_id) {
      try {
        const doId = env.EXAM_SESSION.idFromName(attempt.session_id as string);
        const stub = env.EXAM_SESSION.get(doId);
        await stub.fetch(
          new Request(`http://internal/end?sessionId=${encodeURIComponent(attempt.session_id as string)}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Auth': env.INTERNAL_SECRET || '',
            },
            body: JSON.stringify({ endedReason: 'submitted' }),
          }),
        );
      } catch (e) {
        console.warn('[student/submit] Failed to notify ExamSessionDO:', e);
      }
    }
    const updated = await getAttempt(env.DB, attemptId);
    return json({ attempt: updated, submitted: true });
  }

  // ── GET /attempts/:id/result ───────────────────────────────────────────────
  const resultMatch = path.match(/^\/attempts\/([^/]+)\/result$/);
  if (method === 'GET' && resultMatch) {
    const attemptId = resultMatch[1];
    const attempt = await getAttempt(env.DB, attemptId);
    if (!attempt || attempt.user_id !== user.id) return err('Attempt not found', 404);

    if (attempt.status === 'in_progress') {
      return err('Exam is still in progress', 403);
    }

    const exam = await getExam(env.DB, attempt.exam_id as string);
    if (!exam) return err('Exam not found', 404);

    const resultsReleased = exam.results_released === 1;
    const instantResults = exam.instant_results === 1;
    const fullyGraded = attempt.fully_graded === 1;
    const isAutoOnly = attempt.grading_status === 'auto_graded';

    // State 1: Instant results for auto-graded exams with no manual questions
    const canShowInstant = instantResults && isAutoOnly && fullyGraded;

    // State 2: Released and fully graded
    const canShowReleased = resultsReleased && fullyGraded;

    if (!resultsReleased && !instantResults) {
      return json({
        status: 'submitted_pending_release',
        message: 'Your submission has been received. Results will be released by your instructor.',
      });
    }

    if (instantResults && !resultsReleased) {
      if (!isAutoOnly || !fullyGraded) {
        return json({
          status: 'being_graded',
          message: 'Your submission has been received and is being graded.',
        });
      }
    }

    if (resultsReleased && !fullyGraded) {
      return json({
        status: 'being_graded',
        message: 'Your submission is being graded.',
      });
    }

    if (!canShowInstant && !canShowReleased) {
      return json({
        status: 'submitted_pending_release',
        message: 'Your submission has been received. Results will be released by your instructor.',
      });
    }

    // Results are available
    const answerRows = await env.DB.prepare(
      `SELECT question_id, answer_json, marked_for_review, awarded_points, auto_points, grader_comment
       FROM answers WHERE attempt_id = ?`,
    )
      .bind(attemptId)
      .all<{
        question_id: string;
        answer_json: string;
        marked_for_review: number;
        awarded_points: number | null;
        auto_points: number | null;
        grader_comment: string | null;
      }>();

    const showAnswers = exam.show_answers === 1;
    const answerMap = new Map(answerRows.results.map((a) => [a.question_id, a]));

    const snapRows = await env.DB.prepare(
      `SELECT snapshot_json FROM exam_questions WHERE exam_id = ? ORDER BY position ASC`,
    )
      .bind(attempt.exam_id)
      .all<{ snapshot_json: string | null }>();

    const questionsWithAnswers = snapRows.results
      .filter((r) => r.snapshot_json != null)
      .map((r) => {
        const raw = JSON.parse(r.snapshot_json!) as Record<string, unknown>;
        const sq = toStudentQuestion(raw);
        const ans = answerMap.get(sq.id);
        return {
          ...sq,
          awarded_points: ans?.awarded_points ?? null,
          grader_comment: ans?.grader_comment ?? null,
          ...(showAnswers ? { correct_answer: (raw.correct_answer as string) ?? null } : {}),
        };
      });

    const percentage =
      attempt.max_score && Number(attempt.max_score) > 0
        ? Math.round(((Number(attempt.score) || 0) / Number(attempt.max_score)) * 1000) / 10
        : 0;

    return json({
      status: 'result_available',
      attempt,
      score: attempt.score,
      max_score: attempt.max_score,
      percentage,
      answers: answerRows.results,
      questions_with_answers: questionsWithAnswers,
    });
  }

  return err('Not found', 404);
}

// ─── Internal Submit Helper ──────────────────────────────────────────────────

export async function doSubmit(
  db: D1Database,
  attempt: Record<string, unknown>,
  status: 'submitted' | 'auto_submitted' | 'terminated',
): Promise<void> {
  const examId = attempt.exam_id as string;

  const snapRows = await db
    .prepare(`SELECT snapshot_json FROM exam_questions WHERE exam_id = ? ORDER BY position ASC`)
    .bind(examId)
    .all<{ snapshot_json: string | null }>();

  const gradingQuestions: QuestionForGrading[] = snapRows.results
    .filter((r) => r.snapshot_json != null)
    .map((r) => {
      const raw = JSON.parse(r.snapshot_json!) as Record<string, unknown>;
      return {
        id: raw.id as string,
        type: raw.type as string,
        grading_mode: raw.grading_mode as string | undefined,
        correct_answer: (raw.correct_answer as string) ?? null,
        points: Number(raw.points) || 1,
        question_text: (raw.question_text as string) || '',
        options: Array.isArray(raw.options)
          ? (raw.options as string[])
          : typeof raw.options === 'string'
            ? (() => {
                try {
                  const parsed = JSON.parse(raw.options as string);
                  return Array.isArray(parsed) ? parsed : null;
                } catch {
                  return null;
                }
              })()
            : null,
      };
    });

  const answerRows = await db
    .prepare('SELECT question_id, answer_json FROM answers WHERE attempt_id = ?')
    .bind(attempt.id)
    .all<{ question_id: string; answer_json: string }>();

  const answerMap = new Map(answerRows.results.map((a) => [a.question_id, a.answer_json]));
  const { score, max_score, grading_status, fully_graded, answer_grades } = gradeAttempt(gradingQuestions, answerMap);

  const submittedAt = new Date().toISOString();

  // Write per-answer grades to answers table (upserting to ensure rows exist for all questions)
  const gradeStmts: D1PreparedStatement[] = answer_grades.map((ag) =>
    db
      .prepare(
        `INSERT INTO answers (attempt_id, question_id, answer_json, marked_for_review, awarded_points, auto_points, grading_source, graded_at, updated_at)
         VALUES (?, ?, '""', 0, ?, ?, ?, ?, ?)
         ON CONFLICT(attempt_id, question_id) DO UPDATE SET
           awarded_points = excluded.awarded_points,
           auto_points = excluded.auto_points,
           grading_source = excluded.grading_source,
           graded_at = excluded.graded_at`,
      )
      .bind(
        attempt.id,
        ag.question_id,
        ag.awarded_points,
        ag.auto_points,
        ag.grading_source,
        submittedAt,
        submittedAt,
      ),
  );

  if (gradeStmts.length > 0) {
    await db.batch(gradeStmts);
  }

  await db
    .prepare(
      `UPDATE attempts
       SET status = ?, submitted_at = ?, score = ?, max_score = ?, grading_status = ?, fully_graded = ?, ended_reason = ?
       WHERE id = ?`,
    )
    .bind(status, submittedAt, score, max_score, grading_status, fully_graded ? 1 : 0, status, attempt.id)
    .run();
}

async function autoSubmit(db: D1Database, attempt: Record<string, unknown>, env?: StudentEnv): Promise<void> {
  await doSubmit(db, attempt, 'auto_submitted');
  if (env?.EXAM_SESSION && attempt.session_id) {
    try {
      const doId = env.EXAM_SESSION.idFromName(attempt.session_id as string);
      const stub = env.EXAM_SESSION.get(doId);
      await stub.fetch(
        new Request(`http://internal/end?sessionId=${encodeURIComponent(attempt.session_id as string)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Auth': env?.INTERNAL_SECRET || '',
          },
          body: JSON.stringify({ endedReason: 'auto_submitted' }),
        }),
      );
    } catch (e) {
      console.warn('[student/autoSubmit] Failed to notify ExamSessionDO:', e);
    }
  }
}
