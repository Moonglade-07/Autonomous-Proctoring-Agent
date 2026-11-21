/**
 * worker/api/exams.ts — Professor exam management REST API (Phase 4c-1)
 * ─────────────────────────────────────────────────────────────────────────────
 * Restructured around the exam as the container.
 * No global question bank. Questions are owned by specific exams.
 *
 * Routes (all under /api/professor):
 *   GET    /api/professor/exams                       → list exams (search, filter, sort, with counts)
 *   POST   /api/professor/exams                       → create exam (short form, auto-generates join code)
 *   GET    /api/professor/exams/:id                   → get exam with questions & counts
 *   PUT    /api/professor/exams/:id                   → update exam metadata/settings
 *   DELETE /api/professor/exams/:id                   → delete exam (drafts only)
 *   POST   /api/professor/exams/:id/duplicate         → duplicate exam + copy questions + new code
 *   POST   /api/professor/exams/:id/publish           → publish exam (snapshots questions)
 *   POST   /api/professor/exams/:id/regenerate-code   → regenerate join code
 *   PUT    /api/professor/exams/:id/toggle-code       → enable/disable join code
 *   GET    /api/professor/exams/:id/attempts          → list student submissions/attempts
 *
 *   GET    /api/professor/exams/:id/questions         → list questions for this exam
 *   POST   /api/professor/exams/:id/questions         → create question in this exam
 *   PUT    /api/professor/exams/:id/questions/:qid    → update question (draft only)
 *   DELETE /api/professor/exams/:id/questions/:qid    → delete question (draft only)
 *   PUT    /api/professor/exams/:id/questions/reorder → reorder questions in this exam
 *   POST   /api/professor/exams/:id/questions/import  → copy questions from another exam
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';
import { generateJoinCode } from '../utils/joinCode.js';
import { canAccessExam } from '../utils/auth.js';
export { canAccessExam } from '../utils/auth.js';
import { handleGradingApi } from './grading.js';
import { handleSessionsApi } from './sessions.js';
import {
  QuestionCreateSchema,
} from '../utils/questionGrading.js';
import type { DerivedExamStatus } from '../types.js';

interface DbEnv {
  DB: D1Database;
  PROFESSOR_KEY?: string;
  AI?: Ai;
  EXAM_SESSION?: DurableObjectNamespace;
  EXAM_HUB?: DurableObjectNamespace;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nanoid(prefix = 'q'): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  for (const b of buf) {
    id += chars[b % chars.length];
  }
  return `${prefix}-${id}`;
}

function normalizeCorrectAnswer(
  type: string,
  options: string[] | null | undefined,
  correctStr: string | null | undefined,
): string | null {
  if (!correctStr) return null;
  if (!options || !Array.isArray(options) || options.length === 0) return correctStr;

  if (type === 'mcq') {
    const idx = parseInt(correctStr, 10);
    if (!isNaN(idx) && idx >= 0 && idx < options.length && !options.includes(correctStr)) {
      return options[idx];
    }
  } else if (type === 'multi_select') {
    try {
      const parsed = JSON.parse(correctStr);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const normalized = parsed.map((item) => {
          if (typeof item === 'string' && options.includes(item)) return item;
          const idx = typeof item === 'number' ? item : parseInt(String(item), 10);
          if (!isNaN(idx) && idx >= 0 && idx < options.length) {
            return options[idx];
          }
          return String(item);
        });
        return JSON.stringify(normalized);
      }
    } catch {}
  }

  return correctStr;
}

function now(): string {
  return new Date().toISOString();
}

function formatQuestionRow(r: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!r) return null;
  let opts: unknown = null;
  if (r.options) {
    try {
      opts = Array.isArray(r.options) ? r.options : JSON.parse(r.options as string);
    } catch {
      opts = null;
    }
  }
  return {
    ...r,
    options: opts,
    points: Number(r.points) || 1,
  };
}

function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonErr(message: string, status: number, details?: unknown): Response {
  return new Response(JSON.stringify({ error: message, details }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function checkAuth(request: Request, env: DbEnv): Response | null {
  const expectedKey = env.PROFESSOR_KEY;
  const provided = request.headers.get('X-Professor-Key') ?? '';
  if (!provided || (expectedKey && provided !== expectedKey)) {
    return jsonErr('Unauthorized: Invalid or missing X-Professor-Key header', 401);
  }
  return null;
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

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

const CreateExamSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200),
    description: z.string().max(2000).default(''),
    course_code: z.string().max(20).default(''),
    duration_minutes: z.number().int().min(1, 'Duration must be at least 1 minute').max(600).default(60),
    start_time: z.string().datetime({ offset: true }).nullable().optional(),
    end_time: z.string().datetime({ offset: true }).nullable().optional(),
    retention_days: z.number().int().min(0).max(3650).default(90),
  })
  .superRefine((data, ctx) => {
    if (data.start_time && data.end_time) {
      if (new Date(data.end_time).getTime() <= new Date(data.start_time).getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['end_time'],
          message: 'End time must be after start time',
        });
      }
    }
  });

const UpdateExamSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200).optional(),
    description: z.string().max(2000).optional(),
    course_code: z.string().max(20).optional(),
    duration_minutes: z.number().int().min(1).max(600).optional(),
    start_time: z.string().datetime({ offset: true }).nullable().optional(),
    end_time: z.string().datetime({ offset: true }).nullable().optional(),
    strictness: z.enum(['low', 'medium', 'high', 'custom']).optional(),
    enable_vision: z.number().int().min(0).max(1).optional(),
    enable_identity: z.number().int().min(0).max(1).optional(),
    max_risk_score: z.number().int().min(0).max(100).optional(),
    show_answers: z.number().int().min(0).max(1).optional(),
    join_code_active: z.number().int().min(0).max(1).optional(),
    instant_results: z.number().int().min(0).max(1).optional(),
    retention_days: z.number().int().min(0).max(3650).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.start_time && data.end_time) {
      if (new Date(data.end_time).getTime() <= new Date(data.start_time).getTime()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['end_time'],
          message: 'End time must be after start time',
        });
      }
    }
  });

const ReorderSchema = z.object({
  order: z.array(z.string().min(1)).min(1),
});

const ImportQuestionsSchema = z.object({
  sourceExamId: z.string().min(1, 'sourceExamId is required'),
  questionIds: z.array(z.string().min(1)).min(1, 'At least one question must be selected for import'),
});

// ─── Exam Fetch Helper ───────────────────────────────────────────────────────

async function getExamWithQuestions(db: D1Database, examId: string) {
  const exam = await db
    .prepare('SELECT * FROM exams WHERE id = ?')
    .bind(examId)
    .first<Record<string, unknown>>();

  if (!exam) return null;

  // Fetch questions ordered by exam_questions position if present, else questions.created_at
  const rows = await db
    .prepare(
      `SELECT q.*, eq.id AS eq_id, eq.position, eq.snapshot_json
       FROM questions q
       LEFT JOIN exam_questions eq ON q.id = eq.question_id AND eq.exam_id = q.exam_id
       WHERE q.exam_id = ?
       ORDER BY COALESCE(eq.position, 9999) ASC, q.created_at ASC`,
    )
    .bind(examId)
    .all<Record<string, unknown>>();

  const questions = rows.results.map((r) => {
    let opts = null;
    if (r.options) {
      try {
        opts = Array.isArray(r.options) ? r.options : JSON.parse(r.options as string);
      } catch {}
    }
    return {
      id: r.id as string,
      exam_id: r.exam_id as string,
      question_text: r.question_text as string,
      type: r.type as string,
      options: opts,
      correct_answer: r.correct_answer as string | null,
      points: Number(r.points) || 1,
      topic: (r.topic as string) || '',
      difficulty: (r.difficulty as string) || 'medium',
      grading_mode: (r.grading_mode as string) || 'auto',
      rubric: (r.rubric as string) || null,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
      position: typeof r.position === 'number' ? r.position : 0,
      is_snapshot: !!r.snapshot_json,
    };
  });

  const studentCountRow = await db
    .prepare('SELECT COUNT(*) AS count FROM exam_enrollments WHERE exam_id = ?')
    .bind(examId)
    .first<{ count: number }>();

  const derived = computeDerivedStatus(
    exam.status as string,
    exam.start_time as string | null,
    exam.end_time as string | null,
  );

  return {
    ...exam,
    questions,
    question_count: questions.length,
    total_points: questions.reduce((sum, q) => sum + q.points, 0),
    student_count: studentCountRow?.count || 0,
    derived_status: derived,
  };
}

// ─── Snapshot Questions Helper ───────────────────────────────────────────────

async function snapshotExamQuestions(db: D1Database, examId: string): Promise<void> {
  const rows = await db
    .prepare('SELECT * FROM questions WHERE exam_id = ?')
    .bind(examId)
    .all<Record<string, unknown>>();

  for (let i = 0; i < rows.results.length; i++) {
    const q = rows.results[i];
    const snap = JSON.stringify({
      id: q.id,
      exam_id: q.exam_id,
      question_text: q.question_text,
      type: q.type,
      options: q.options ? (typeof q.options === 'string' ? JSON.parse(q.options) : q.options) : null,
      correct_answer: q.correct_answer,
      points: q.points,
      topic: q.topic,
      difficulty: q.difficulty,
      grading_mode: q.grading_mode,
      rubric: q.rubric ?? null,
      created_at: q.created_at,
      updated_at: q.updated_at,
    });

    const eqId = `eq-${examId}-${q.id}`;
    await db
      .prepare(
        `INSERT INTO exam_questions (id, exam_id, question_id, position, snapshot_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json, position = excluded.position`,
      )
      .bind(eqId, examId, q.id, i, snap)
      .run();
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export async function handleProfessorApi(request: Request, env: DbEnv): Promise<Response> {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/professor/, '');
  const method = request.method.toUpperCase();

  // ── Delegate to grading API ────────────────────────────────────────────────
  const gradingRes = await handleGradingApi(request, env as unknown as Parameters<typeof handleGradingApi>[1], path, method);
  if (gradingRes !== null) return gradingRes;

  // ── Delegate to sessions API (Phase 4c-2b) ─────────────────────────────────
  const sessionsMatch = path.match(/^\/exams\/([^/]+)\/(sessions.*|preview-start)$/);
  if (sessionsMatch) {
    const examId = sessionsMatch[1];
    return handleSessionsApi(request, env as unknown as Parameters<typeof handleSessionsApi>[1], path, method, examId);
  }

  // ── GET /exams ─────────────────────────────────────────────────────────────
  if (path === '/exams' && method === 'GET') {
    const search = url.searchParams.get('search')?.trim() || '';
    const status = url.searchParams.get('status')?.trim() || '';

    const rows = await env.DB.prepare(
      `SELECT e.*,
              (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.id) AS question_count,
              (SELECT COALESCE(SUM(q.points), 0) FROM questions q WHERE q.exam_id = e.id) AS total_points,
              (SELECT COUNT(*) FROM exam_enrollments en WHERE en.exam_id = e.id) AS student_count
       FROM exams e
       ORDER BY e.created_at DESC`,
    ).all<Record<string, unknown>>();

    let list: Record<string, unknown>[] = rows.results.map((e) => {
      const derived = computeDerivedStatus(
        e.status as string,
        e.start_time as string | null,
        e.end_time as string | null,
      );
      return {
        ...e,
        question_count: Number(e.question_count) || 0,
        total_points: Number(e.total_points) || 0,
        student_count: Number(e.student_count) || 0,
        derived_status: derived,
      };
    });

    if (status) {
      list = list.filter((e) => e.derived_status === status || e.status === status);
    }

    if (search) {
      const term = search.toLowerCase();
      list = list.filter(
        (e) =>
          String(e.title || '').toLowerCase().includes(term) ||
          String(e.course_code || '').toLowerCase().includes(term) ||
          String(e.join_code || '').toLowerCase().includes(term) ||
          String(e.description || '').toLowerCase().includes(term),
      );
    }

    return jsonOk({ exams: list });
  }

  // ── POST /exams ────────────────────────────────────────────────────────────
  if (path === '/exams' && method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonErr('Invalid JSON body', 400);
    }

    const parsed = CreateExamSchema.safeParse(body);
    if (!parsed.success) {
      return jsonErr('Validation error', 400, parsed.error.flatten().fieldErrors);
    }

    const examId = `exam-${nanoid('ex')}`;
    let joinCode = generateJoinCode();

    // Collision retry up to 5 times
    for (let i = 0; i < 5; i++) {
      const existingCode = await env.DB.prepare('SELECT id FROM exams WHERE join_code = ?')
        .bind(joinCode)
        .first();
      if (!existingCode) break;
      joinCode = generateJoinCode();
    }

    const d = parsed.data;
    const createdAt = now();

    await env.DB.prepare(
      `INSERT INTO exams (
         id, title, description, course_code, duration_minutes,
         start_time, end_time, status, strictness, enable_vision,
         enable_identity, max_risk_score, show_answers, join_code,
         join_code_active, retention_days, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', 'medium', 1, 1, 80, 0, ?, 1, ?, ?, ?)`,
    )
      .bind(
        examId,
        d.title,
        d.description,
        d.course_code,
        d.duration_minutes,
        d.start_time ?? null,
        d.end_time ?? null,
        joinCode,
        d.retention_days ?? 90,
        createdAt,
        createdAt,
      )
      .run();

    const created = await getExamWithQuestions(env.DB, examId);
    return jsonOk({ exam: created }, 201);
  }

  // ── Exam-specific routes ───────────────────────────────────────────────────
  const examRouteMatch = path.match(/^\/exams\/([^/]+)(\/.*)?$/);
  if (!examRouteMatch) {
    return jsonErr('Not found', 404);
  }

  const examId = examRouteMatch[1];
  const subPath = examRouteMatch[2] || '';

  const rawExam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?')
    .bind(examId)
    .first<Record<string, unknown>>();

  if (!rawExam) {
    return jsonErr('Exam not found', 404);
  }

  if (!canAccessExam(rawExam)) {
    return jsonErr('Forbidden', 403);
  }

  // ── GET /exams/:id ─────────────────────────────────────────────────────────
  if (subPath === '' && method === 'GET') {
    const exam = await getExamWithQuestions(env.DB, examId);
    return jsonOk({ exam });
  }

  // ── PUT /exams/:id ─────────────────────────────────────────────────────────
  if (subPath === '' && method === 'PUT') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonErr('Invalid JSON body', 400);
    }

    const parsed = UpdateExamSchema.safeParse(body);
    if (!parsed.success) {
      return jsonErr('Validation error', 400, parsed.error.flatten().fieldErrors);
    }

    const d = parsed.data;
    const isDraft = rawExam.status === 'draft';

    // If published, timing and core fields cannot be edited
    if (!isDraft) {
      if (d.duration_minutes !== undefined || d.start_time !== undefined || d.end_time !== undefined) {
        return jsonErr('Cannot modify schedule or duration of a published exam', 409);
      }
    }

    const updates: string[] = [];
    const values: unknown[] = [];

    const allowedFields = [
      'title',
      'description',
      'course_code',
      'duration_minutes',
      'start_time',
      'end_time',
      'strictness',
      'enable_vision',
      'enable_identity',
      'max_risk_score',
      'show_answers',
      'join_code_active',
      'instant_results',
      'retention_days',
    ] as const;

    for (const f of allowedFields) {
      if (d[f] !== undefined) {
        updates.push(`${f} = ?`);
        values.push(d[f]);
      }
    }

    if (updates.length > 0) {
      updates.push('updated_at = ?');
      values.push(now());
      values.push(examId);

      await env.DB.prepare(`UPDATE exams SET ${updates.join(', ')} WHERE id = ?`)
        .bind(...values)
        .run();
    }

    const updated = await getExamWithQuestions(env.DB, examId);
    return jsonOk({ exam: updated });
  }

  // ── DELETE /exams/:id ──────────────────────────────────────────────────────
  if (subPath === '' && method === 'DELETE') {
    if (rawExam.status !== 'draft') {
      return jsonErr('Only draft exams can be deleted', 409);
    }

    await env.DB.prepare('DELETE FROM exams WHERE id = ?').bind(examId).run();
    return jsonOk({ deleted: true });
  }

  // ── POST /exams/:id/duplicate ──────────────────────────────────────────────
  if (subPath === '/duplicate' && method === 'POST') {
    const newExamId = `exam-${nanoid('ex')}`;
    let joinCode = generateJoinCode();

    for (let i = 0; i < 5; i++) {
      const existing = await env.DB.prepare('SELECT id FROM exams WHERE join_code = ?')
        .bind(joinCode)
        .first();
      if (!existing) break;
      joinCode = generateJoinCode();
    }

    const createdAt = now();
    const newTitle = `${rawExam.title as string} (Copy)`;

    await env.DB.prepare(
      `INSERT INTO exams (
         id, title, description, course_code, duration_minutes,
         start_time, end_time, status, strictness, enable_vision,
         enable_identity, max_risk_score, show_answers, join_code,
         join_code_active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
      .bind(
        newExamId,
        newTitle,
        rawExam.description,
        rawExam.course_code,
        rawExam.duration_minutes,
        rawExam.start_time,
        rawExam.end_time,
        rawExam.strictness,
        rawExam.enable_vision,
        rawExam.enable_identity,
        rawExam.max_risk_score,
        rawExam.show_answers,
        joinCode,
        createdAt,
        createdAt,
      )
      .run();

    // Copy all questions from source exam into new rows
    const srcQuestions = await env.DB.prepare(
      `SELECT q.*, eq.position
       FROM questions q
       LEFT JOIN exam_questions eq ON q.id = eq.question_id AND eq.exam_id = q.exam_id
       WHERE q.exam_id = ?
       ORDER BY COALESCE(eq.position, 9999) ASC, q.created_at ASC`,
    )
      .bind(examId)
      .all<Record<string, unknown>>();

    for (let i = 0; i < srcQuestions.results.length; i++) {
      const q = srcQuestions.results[i];
      const newQId = nanoid('q');
      await env.DB.prepare(
        `INSERT INTO questions (
           id, exam_id, question_text, type, options, correct_answer,
           points, topic, difficulty, grading_mode, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          newQId,
          newExamId,
          q.question_text,
          q.type,
          q.options,
          q.correct_answer,
          q.points,
          q.topic,
          q.difficulty,
          q.grading_mode,
          createdAt,
          createdAt,
        )
        .run();

      await env.DB.prepare(
        `INSERT INTO exam_questions (id, exam_id, question_id, position)
         VALUES (?, ?, ?, ?)`,
      )
        .bind(`eq-${newExamId}-${newQId}`, newExamId, newQId, i)
        .run();
    }

    const duplicated = await getExamWithQuestions(env.DB, newExamId);
    return jsonOk({ exam: duplicated }, 201);
  }

  // ── POST /exams/:id/publish ────────────────────────────────────────────────
  if (subPath === '/publish' && method === 'POST') {
    if (rawExam.status !== 'draft') {
      return jsonErr(`Exam is already ${rawExam.status as string}`, 409);
    }

    const qCountRow = await env.DB.prepare(
      'SELECT COUNT(*) as count, COALESCE(SUM(points), 0) as total_points FROM questions WHERE exam_id = ?',
    )
      .bind(examId)
      .first<{ count: number; total_points: number }>();

    const qCount = qCountRow?.count || 0;
    const totalPoints = qCountRow?.total_points || 0;

    if (qCount === 0) {
      return jsonErr('Cannot publish an exam with 0 questions. Add at least one question first.', 422);
    }

    if (totalPoints <= 0) {
      return jsonErr('Cannot publish an exam with 0 total points.', 422);
    }

    const duration = (rawExam.duration_minutes as number) || 0;
    if (duration <= 0) {
      return jsonErr('Duration must be greater than 0 minutes', 422);
    }

    const startTime = rawExam.start_time as string | null;
    const endTime = rawExam.end_time as string | null;
    if (startTime && endTime && new Date(endTime).getTime() <= new Date(startTime).getTime()) {
      return jsonErr('End time must be after start time', 422);
    }

    // Snapshot questions before updating status
    await snapshotExamQuestions(env.DB, examId);

    const nowMs = Date.now();
    let newStatus = 'active';
    if (startTime && new Date(startTime).getTime() > nowMs) {
      newStatus = 'scheduled';
    }

    await env.DB.prepare('UPDATE exams SET status = ?, updated_at = ? WHERE id = ?')
      .bind(newStatus, now(), examId)
      .run();

    const published = await getExamWithQuestions(env.DB, examId);
    return jsonOk({ exam: published });
  }

  // ── POST /exams/:id/regenerate-code ────────────────────────────────────────
  if (subPath === '/regenerate-code' && method === 'POST') {
    let newCode = generateJoinCode();
    for (let i = 0; i < 5; i++) {
      const existing = await env.DB.prepare('SELECT id FROM exams WHERE join_code = ?')
        .bind(newCode)
        .first();
      if (!existing) break;
      newCode = generateJoinCode();
    }

    await env.DB.prepare('UPDATE exams SET join_code = ?, updated_at = ? WHERE id = ?')
      .bind(newCode, now(), examId)
      .run();

    return jsonOk({ join_code: newCode });
  }

  // ── PUT /exams/:id/toggle-code ─────────────────────────────────────────────
  if (subPath === '/toggle-code' && method === 'PUT') {
    let body: { active?: number | boolean } = {};
    try {
      body = (await request.json()) as { active?: number | boolean };
    } catch {}

    let nextActive: number;
    if (body.active !== undefined) {
      nextActive = body.active ? 1 : 0;
    } else {
      nextActive = rawExam.join_code_active ? 0 : 1;
    }

    await env.DB.prepare('UPDATE exams SET join_code_active = ?, updated_at = ? WHERE id = ?')
      .bind(nextActive, now(), examId)
      .run();

    return jsonOk({ join_code_active: nextActive });
  }

  // ── GET /exams/:id/attempts ────────────────────────────────────────────────
  if (subPath === '/attempts' && method === 'GET') {
    const includeTest = url.searchParams.get('include_test') === '1';
    const rows = await env.DB.prepare(
      `SELECT id, exam_id, student_name, session_id, status, started_at,
              deadline_at, submitted_at, paused_seconds, score, max_score, grading_status, is_test
       FROM attempts
       WHERE exam_id = ?
         ${includeTest ? '' : 'AND (is_test = 0 OR is_test IS NULL)'}
       ORDER BY started_at DESC`,
    )
      .bind(examId)
      .all<Record<string, unknown>>();

    return jsonOk({ attempts: rows.results ?? [] });
  }

  // ── QUESTIONS API: /exams/:id/questions ────────────────────────────────────

  // GET /exams/:id/questions
  if (subPath === '/questions' && method === 'GET') {
    const exam = await getExamWithQuestions(env.DB, examId);
    return jsonOk({ questions: exam?.questions ?? [] });
  }

  // POST /exams/:id/questions
  if (subPath === '/questions' && method === 'POST') {
    if (rawExam.status !== 'draft') {
      return jsonErr('Cannot add questions to a published exam', 409);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonErr('Invalid JSON body', 400);
    }

    const parsed = QuestionCreateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonErr('Validation error', 400, parsed.error.flatten().fieldErrors);
    }

    const qData = parsed.data;
    const qId = nanoid('q');
    const createdAt = now();

    const optionsStr = qData.options ? JSON.stringify(qData.options) : null;
    const correctStr = normalizeCorrectAnswer(qData.type, qData.options, qData.correct_answer);

    await env.DB.prepare(
      `INSERT INTO questions (
         id, exam_id, question_text, type, options, correct_answer,
         points, topic, difficulty, grading_mode, rubric, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        qId,
        examId,
        qData.question_text,
        qData.type,
        optionsStr,
        correctStr,
        qData.points,
        qData.topic || '',
        qData.difficulty || 'medium',
        qData.grading_mode || 'auto',
        qData.rubric ?? null,
        createdAt,
        createdAt,
      )
      .run();

    // Link position in exam_questions
    const maxPosRow = await env.DB.prepare(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM exam_questions WHERE exam_id = ?',
    )
      .bind(examId)
      .first<{ max_pos: number }>();
    const nextPos = (maxPosRow?.max_pos ?? -1) + 1;

    await env.DB.prepare(
      'INSERT INTO exam_questions (id, exam_id, question_id, position) VALUES (?, ?, ?, ?)',
    )
      .bind(`eq-${examId}-${qId}`, examId, qId, nextPos)
      .run();

    const created = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(qId).first<Record<string, unknown>>();
    return jsonOk({ question: formatQuestionRow(created) }, 201);
  }

  // PUT /exams/:id/questions/reorder
  if (subPath === '/questions/reorder' && method === 'PUT') {
    if (rawExam.status !== 'draft') {
      return jsonErr('Cannot reorder questions in a published exam', 409);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonErr('Invalid JSON body', 400);
    }

    const parsed = ReorderSchema.safeParse(body);
    if (!parsed.success) {
      return jsonErr('Validation error', 400, parsed.error.flatten().fieldErrors);
    }

    const stmts = parsed.data.order.map((qId, index) =>
      env.DB.prepare(
        'UPDATE exam_questions SET position = ? WHERE exam_id = ? AND question_id = ?',
      ).bind(index, examId, qId),
    );

    await env.DB.batch(stmts);
    return jsonOk({ reordered: true });
  }

  // POST /exams/:id/questions/import
  if (subPath === '/questions/import' && method === 'POST') {
    if (rawExam.status !== 'draft') {
      return jsonErr('Cannot import questions into a published exam', 409);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonErr('Invalid JSON body', 400);
    }

    const parsed = ImportQuestionsSchema.safeParse(body);
    if (!parsed.success) {
      return jsonErr('Validation error', 400, parsed.error.flatten().fieldErrors);
    }

    const { sourceExamId, questionIds } = parsed.data;

    const sourceExam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?')
      .bind(sourceExamId)
      .first<Record<string, unknown>>();

    if (!sourceExam) {
      return jsonErr('Source exam not found', 404);
    }

    if (!canAccessExam(sourceExam)) {
      return jsonErr('Forbidden: cannot access source exam', 403);
    }

    const maxPosRow = await env.DB.prepare(
      'SELECT COALESCE(MAX(position), -1) AS max_pos FROM exam_questions WHERE exam_id = ?',
    )
      .bind(examId)
      .first<{ max_pos: number }>();
    let currentPos = (maxPosRow?.max_pos ?? -1) + 1;

    const placeholders = questionIds.map(() => '?').join(',');
    const srcQuestions = await env.DB.prepare(
      `SELECT * FROM questions WHERE exam_id = ? AND id IN (${placeholders})`,
    )
      .bind(sourceExamId, ...questionIds)
      .all<Record<string, unknown>>();

    const importedQuestions: Record<string, unknown>[] = [];
    const createdAt = now();

    for (const q of srcQuestions.results) {
      const newQId = nanoid('q');
      await env.DB.prepare(
        `INSERT INTO questions (
           id, exam_id, question_text, type, options, correct_answer,
           points, topic, difficulty, grading_mode, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          newQId,
          examId,
          q.question_text,
          q.type,
          q.options,
          q.correct_answer,
          q.points,
          q.topic,
          q.difficulty,
          q.grading_mode,
          createdAt,
          createdAt,
        )
        .run();

      await env.DB.prepare(
        'INSERT INTO exam_questions (id, exam_id, question_id, position) VALUES (?, ?, ?, ?)',
      )
        .bind(`eq-${examId}-${newQId}`, examId, newQId, currentPos++)
        .run();

      importedQuestions.push({
        id: newQId,
        exam_id: examId,
        question_text: q.question_text,
        type: q.type,
        options: q.options ? (typeof q.options === 'string' ? JSON.parse(q.options) : q.options) : null,
        correct_answer: q.correct_answer,
        points: q.points,
        topic: q.topic,
        difficulty: q.difficulty,
        grading_mode: q.grading_mode,
        position: currentPos - 1,
      });
    }

    return jsonOk({ imported_count: importedQuestions.length, questions: importedQuestions });
  }

  // ── Single question: PUT /exams/:id/questions/:qId & DELETE ────────────────
  const qItemMatch = subPath.match(/^\/questions\/([^/]+)$/);
  if (qItemMatch) {
    const qId = qItemMatch[1];

    if (method === 'PUT') {
      if (rawExam.status !== 'draft') {
        return jsonErr('Cannot modify questions in a published exam', 409);
      }

      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonErr('Invalid JSON body', 400);
      }

      const parsed = QuestionCreateSchema.safeParse(body);
      if (!parsed.success) {
        return jsonErr('Validation error', 400, parsed.error.flatten().fieldErrors);
      }

      const qData = parsed.data;
      const optionsStr = qData.options ? JSON.stringify(qData.options) : null;
      const correctStr = normalizeCorrectAnswer(qData.type, qData.options, qData.correct_answer);

      await env.DB.prepare(
        `UPDATE questions
         SET question_text = ?, type = ?, options = ?, correct_answer = ?,
             points = ?, topic = ?, difficulty = ?, grading_mode = ?, rubric = ?, updated_at = ?
         WHERE id = ? AND exam_id = ?`,
      )
        .bind(
          qData.question_text,
          qData.type,
          optionsStr,
          correctStr,
          qData.points,
          qData.topic || '',
          qData.difficulty || 'medium',
          qData.grading_mode || 'auto',
          qData.rubric ?? null,
          now(),
          qId,
          examId,
        )
        .run();

      const updated = await env.DB.prepare('SELECT * FROM questions WHERE id = ? AND exam_id = ?')
        .bind(qId, examId)
        .first<Record<string, unknown>>();
      return jsonOk({ question: formatQuestionRow(updated) });
    }

    if (method === 'DELETE') {
      if (rawExam.status !== 'draft') {
        return jsonErr('Cannot delete questions from a published exam', 409);
      }

      await env.DB.prepare('DELETE FROM exam_questions WHERE exam_id = ? AND question_id = ?')
        .bind(examId, qId)
        .run();
      await env.DB.prepare('DELETE FROM questions WHERE id = ? AND exam_id = ?')
        .bind(qId, examId)
        .run();

      return jsonOk({ deleted: true });
    }
  }

  return jsonErr('Not found', 404);
}
