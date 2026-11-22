/**
 * worker/api/sessions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 4c-2b: Session Lifecycle, Archive, Clear, Delete & Preview Management
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';
import { canAccessExam } from '../utils/auth.js';
import { toStudentQuestion } from './student.js';
import { writeAuditLog } from '../utils/audit.js';
import type { User } from '../auth/types.js';

function json<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(message: string, status = 400, details?: unknown): Response {
  return new Response(JSON.stringify({ error: message, details }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
import type {
  SessionView,
  SessionViewCounts,
  SessionActionResponse,
  SessionActionResultItem,
  ProfessorAttempt,
  StudentQuestion,
} from '../types.js';

function nanoId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface SessionsEnv {
  DB: D1Database;
  EXAM_SESSION?: DurableObjectNamespace;
  EXAM_HUB?: DurableObjectNamespace;
  INTERNAL_SECRET?: string;
}

const BatchActionSchema = z.object({
  attemptIds: z.array(z.string().min(1)).min(1),
  confirmationName: z.string().optional(),
});

const HoldActionSchema = z.object({
  attemptId: z.string().min(1),
  hold: z.boolean(),
});

const UnlinkedDeleteSchema = z.object({
  sessionIds: z.array(z.string().min(1)).optional(),
});

export async function handleSessionsApi(
  request: Request,
  env: SessionsEnv,
  subPath: string,
  method: string,
  examId: string,
  user: User,
): Promise<Response> {
  const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?')
    .bind(examId)
    .first<Record<string, unknown>>();
  if (!exam || !canAccessExam(exam, user)) {
    return err('Exam not found', 404);
  }

  const url = new URL(request.url);

  // ── 1. GET /api/professor/exams/:id/sessions ──────────────────────────────
  if (subPath === `/exams/${examId}/sessions` && method === 'GET') {
    const view = (url.searchParams.get('view') || 'live') as SessionView;

    // A. Query D1 for all attempts in this exam
    const rows = await env.DB.prepare(
      `SELECT a.*,
              e.title as exam_title
       FROM attempts a
       JOIN exams e ON a.exam_id = e.id
       WHERE a.exam_id = ?
       ORDER BY a.started_at DESC`,
    )
      .bind(examId)
      .all<Record<string, unknown>>();

    const allAttempts = rows.results;

    // B. Query ExamHubDO for current active hub sessions
    let hubSessions: Record<string, any> = {};
    if (env.EXAM_HUB) {
      try {
        const hubId = env.EXAM_HUB.idFromName(examId);
        const stub = env.EXAM_HUB.get(hubId);
        const res = await stub.fetch('http://internal/internal/sessions', {
          headers: {
            'X-Internal-Auth': env.INTERNAL_SECRET || '',
          },
        });
        if (res.ok) {
          const data = (await res.json()) as { sessions: Record<string, any> };
          hubSessions = data.sessions || {};
        }
      } catch (e) {
        console.warn('[SessionsApi] Failed to fetch hub sessions:', e);
      }
    }

    // Identify unlinked sessions in the hub (hub session_id not present in attempts)
    const knownSessionIds = new Set(allAttempts.map((a) => a.session_id as string).filter(Boolean));
    const unlinkedList = Object.values(hubSessions).filter((s) => !knownSessionIds.has(s.sessionId));

    // Counts
    const liveAttempts = allAttempts.filter(
      (a) => a.status === 'in_progress' && (a.archived as number) === 0 && (a.is_test as number) === 0,
    );
    const endedAttempts = allAttempts.filter(
      (a) =>
        ['submitted', 'auto_submitted', 'terminated'].includes(a.status as string) &&
        (a.archived as number) === 0 &&
        (a.is_test as number) === 0,
    );
    const archivedAttempts = allAttempts.filter(
      (a) => (a.archived as number) === 1 && (a.is_test as number) === 0,
    );
    const testAttempts = allAttempts.filter((a) => (a.is_test as number) === 1);

    const counts: SessionViewCounts = {
      live: liveAttempts.length,
      ended: endedAttempts.length,
      archived: archivedAttempts.length,
      test: testAttempts.length,
      unlinked: unlinkedList.length,
    };

    let targetRows: Record<string, unknown>[] = [];
    if (view === 'live') targetRows = liveAttempts;
    else if (view === 'ended') targetRows = endedAttempts;
    else if (view === 'archived') targetRows = archivedAttempts;
    else if (view === 'test') targetRows = testAttempts;

    const sessions: ProfessorAttempt[] = targetRows.map((r) => {
      let durationSeconds: number | undefined;
      if (r.started_at && r.submitted_at) {
        durationSeconds = Math.max(
          0,
          Math.floor(
            (new Date(r.submitted_at as string).getTime() - new Date(r.started_at as string).getTime()) / 1000,
          ),
        );
      }

      return {
        id: r.id as string,
        exam_id: r.exam_id as string,
        student_name: r.student_name as string,
        session_id: r.session_id as string,
        status: r.status as any,
        started_at: r.started_at as string,
        deadline_at: r.deadline_at as string,
        submitted_at: (r.submitted_at as string) || null,
        paused_seconds: (r.paused_seconds as number) || 0,
        paused_at: (r.paused_at as string) || null,
        score: (r.score as number) ?? null,
        max_score: (r.max_score as number) || 0,
        grading_status: r.grading_status as any,
        fully_graded: (r.fully_graded as number) || 0,
        graded_at: (r.graded_at as string) || null,
        is_test: (r.is_test as number) || 0,
        archived: (r.archived as number) || 0,
        archived_at: (r.archived_at as string) || null,
        evidence_hold: (r.evidence_hold as number) || 0,
        violation_count: (r.violation_count as number) ?? null,
        max_severity: (r.max_severity as string) || null,
        final_risk_score: (r.final_risk_score as number) ?? null,
        last_violation_at: (r.last_violation_at as string) || null,
        ended_reason: (r.ended_reason as any) || (r.status as any),
        data_purged_at: (r.data_purged_at as string) || null,
        duration_seconds: durationSeconds,
        is_purged: !!r.data_purged_at,
      };
    });

    return json({
      view,
      counts,
      sessions,
      unlinked: view === 'unlinked' ? unlinkedList : undefined,
    });
  }

  // ── 2. POST /api/professor/exams/:id/sessions/archive ─────────────────────
  if (subPath === `/exams/${examId}/sessions/archive` && method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON body', 400);
    }

    const parsed = BatchActionSchema.safeParse(body);
    if (!parsed.success) return err(parsed.error.message, 400);

    const { attemptIds } = parsed.data;
    const results: SessionActionResultItem[] = [];
    let succeededCount = 0;
    let refusedCount = 0;
    const nowIso = new Date().toISOString();

    for (const id of attemptIds) {
      const att = await env.DB.prepare('SELECT * FROM attempts WHERE id = ? AND exam_id = ?')
        .bind(id, examId)
        .first<Record<string, unknown>>();

      if (!att) {
        results.push({ id, success: false, reason: 'Attempt not found' });
        refusedCount++;
        continue;
      }

      // Rule: Only ended attempts can be archived, except test attempts
      if (att.status === 'in_progress' && (att.is_test as number) !== 1) {
        results.push({ id, success: false, reason: 'Cannot archive in-progress attempt' });
        refusedCount++;
        continue;
      }

      await env.DB.prepare('UPDATE attempts SET archived = 1, archived_at = ? WHERE id = ?')
        .bind(nowIso, id)
        .run();

      await writeAuditLog(env.DB, {
        action: 'archive_session',
        target: id,
        ip: request.headers.get('cf-connecting-ip') || '127.0.0.1',
        meta: { examId, studentName: att.student_name },
      });

      results.push({ id, success: true });
      succeededCount++;
    }

    return json<SessionActionResponse>({
      ok: true,
      action: 'archive',
      results,
      succeededCount,
      refusedCount,
    });
  }

  // ── 3. POST /api/professor/exams/:id/sessions/unarchive ───────────────────
  if (subPath === `/exams/${examId}/sessions/unarchive` && method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON body', 400);
    }

    const parsed = BatchActionSchema.safeParse(body);
    if (!parsed.success) return err(parsed.error.message, 400);

    const { attemptIds } = parsed.data;
    const results: SessionActionResultItem[] = [];
    let succeededCount = 0;
    let refusedCount = 0;

    for (const id of attemptIds) {
      const att = await env.DB.prepare('SELECT * FROM attempts WHERE id = ? AND exam_id = ?')
        .bind(id, examId)
        .first<Record<string, unknown>>();

      if (!att) {
        results.push({ id, success: false, reason: 'Attempt not found' });
        refusedCount++;
        continue;
      }

      await env.DB.prepare('UPDATE attempts SET archived = 0, archived_at = NULL WHERE id = ?')
        .bind(id)
        .run();

      await writeAuditLog(env.DB, {
        action: 'unarchive_session',
        target: id,
        ip: request.headers.get('cf-connecting-ip') || '127.0.0.1',
        meta: { examId, studentName: att.student_name },
      });

      results.push({ id, success: true });
      succeededCount++;
    }

    return json<SessionActionResponse>({
      ok: true,
      action: 'unarchive',
      results,
      succeededCount,
      refusedCount,
    });
  }

  // ── 4. POST /api/professor/exams/:id/sessions/hold ────────────────────────
  if (subPath === `/exams/${examId}/sessions/hold` && method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON body', 400);
    }

    const parsed = HoldActionSchema.safeParse(body);
    if (!parsed.success) return err(parsed.error.message, 400);

    const { attemptId, hold } = parsed.data;
    const att = await env.DB.prepare('SELECT * FROM attempts WHERE id = ? AND exam_id = ?')
      .bind(attemptId, examId)
      .first<Record<string, unknown>>();

    if (!att) return err('Attempt not found', 404);

    await env.DB.prepare('UPDATE attempts SET evidence_hold = ? WHERE id = ?')
      .bind(hold ? 1 : 0, attemptId)
      .run();

    await writeAuditLog(env.DB, {
      action: hold ? 'set_evidence_hold' : 'release_evidence_hold',
      target: attemptId,
      ip: request.headers.get('cf-connecting-ip') || '127.0.0.1',
      meta: { examId, hold },
    });

    return json({ ok: true, evidence_hold: hold ? 1 : 0 });
  }

  // ── 5. POST /api/professor/exams/:id/sessions/clear ───────────────────────
  if (subPath === `/exams/${examId}/sessions/clear` && method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON body', 400);
    }

    const parsed = BatchActionSchema.safeParse(body);
    if (!parsed.success) return err(parsed.error.message, 400);

    const { attemptIds } = parsed.data;
    const results: SessionActionResultItem[] = [];
    let succeededCount = 0;
    let refusedCount = 0;
    const nowIso = new Date().toISOString();

    for (const id of attemptIds) {
      const att = await env.DB.prepare('SELECT * FROM attempts WHERE id = ? AND exam_id = ?')
        .bind(id, examId)
        .first<Record<string, unknown>>();

      if (!att) {
        results.push({ id, success: false, reason: 'Attempt not found' });
        refusedCount++;
        continue;
      }

      if (att.status === 'in_progress') {
        results.push({ id, success: false, reason: 'Cannot clear in-progress attempt' });
        refusedCount++;
        continue;
      }

      if ((att.evidence_hold as number) === 1) {
        results.push({ id, success: false, reason: 'Attempt has evidence hold active' });
        refusedCount++;
        continue;
      }

      // Rule: Clear is allowed ONLY when violation_count = 0 exactly!
      // NULL must be treated as unknown violations
      const vCount = att.violation_count;
      if (vCount === null || vCount === undefined) {
        results.push({ id, success: false, reason: 'Violation count unknown, archive instead' });
        refusedCount++;
        continue;
      }
      if (Number(vCount) > 0) {
        results.push({
          id,
          success: false,
          reason: `Has violations (${vCount}), archive instead`,
        });
        refusedCount++;
        continue;
      }

      // Step 1: Remove from Hub
      if (env.EXAM_HUB && att.session_id) {
        try {
          const hubId = env.EXAM_HUB.idFromName(examId);
          const stub = env.EXAM_HUB.get(hubId);
          await stub.fetch('http://internal/internal/remove-session', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Auth': env.INTERNAL_SECRET || '',
            },
            body: JSON.stringify({ sessionId: att.session_id }),
          });
        } catch (e) {
          console.warn('[SessionsApi] Failed to remove session from hub:', e);
        }
      }

      // Step 2: Purge session DO (best effort)
      if (env.EXAM_SESSION && att.session_id) {
        try {
          const doId = env.EXAM_SESSION.idFromName(att.session_id as string);
          const stub = env.EXAM_SESSION.get(doId);
          await stub.fetch('http://internal/purge', {
            method: 'POST',
            headers: {
              'X-Internal-Auth': env.INTERNAL_SECRET || '',
            },
          });
        } catch (e) {
          console.warn('[SessionsApi] Failed to purge session DO:', e);
        }
      }

      // Step 3: Record data_purged_at in D1 (keeps attempt, answers and score!)
      await env.DB.prepare('UPDATE attempts SET data_purged_at = ? WHERE id = ?')
        .bind(nowIso, id)
        .run();

      await writeAuditLog(env.DB, {
        action: 'clear_session_data',
        target: id,
        ip: request.headers.get('cf-connecting-ip') || '127.0.0.1',
        meta: { examId, studentName: att.student_name },
      });

      results.push({ id, success: true });
      succeededCount++;
    }

    return json<SessionActionResponse>({
      ok: true,
      action: 'clear',
      results,
      succeededCount,
      refusedCount,
    });
  }

  // ── 6. POST /api/professor/exams/:id/sessions/delete ──────────────────────
  if (subPath === `/exams/${examId}/sessions/delete` && method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('Invalid JSON body', 400);
    }

    const parsed = BatchActionSchema.safeParse(body);
    if (!parsed.success) return err(parsed.error.message, 400);

    const { attemptIds, confirmationName } = parsed.data;
    const results: SessionActionResultItem[] = [];
    let succeededCount = 0;
    let refusedCount = 0;

    for (const id of attemptIds) {
      const att = await env.DB.prepare('SELECT * FROM attempts WHERE id = ? AND exam_id = ?')
        .bind(id, examId)
        .first<Record<string, unknown>>();

      if (!att) {
        results.push({ id, success: false, reason: 'Attempt not found' });
        refusedCount++;
        continue;
      }

      const isTest = (att.is_test as number) === 1;

      // Test attempts can be deleted at any time with no confirmation
      if (!isTest) {
        if (att.status === 'in_progress') {
          results.push({ id, success: false, reason: 'Cannot delete in-progress attempt' });
          refusedCount++;
          continue;
        }

        if ((att.evidence_hold as number) === 1) {
          results.push({ id, success: false, reason: 'Attempt has evidence hold active' });
          refusedCount++;
          continue;
        }

        const vCount = att.violation_count;
        if (vCount === null || vCount === undefined) {
          results.push({ id, success: false, reason: 'Violation count unknown, archive instead' });
          refusedCount++;
          continue;
        }
        if (Number(vCount) > 0) {
          results.push({ id, success: false, reason: 'Has violations, archive instead' });
          refusedCount++;
          continue;
        }

        // Single delete requires typed confirmation name matching student_name
        if (attemptIds.length === 1 && confirmationName !== undefined) {
          if (
            confirmationName.trim().toLowerCase() !==
            (att.student_name as string).trim().toLowerCase()
          ) {
            results.push({
              id,
              success: false,
              reason: 'Confirmation student name does not match',
            });
            refusedCount++;
            continue;
          }
        }
      }

      // Order of deletion:
      // 1. D1 change first: delete answers cascade + delete attempt
      await env.DB.prepare('DELETE FROM answers WHERE attempt_id = ?').bind(id).run();
      await env.DB.prepare('DELETE FROM attempts WHERE id = ?').bind(id).run();

      // 2. Hub removal
      if (env.EXAM_HUB && att.session_id) {
        try {
          const hubId = env.EXAM_HUB.idFromName(examId);
          const stub = env.EXAM_HUB.get(hubId);
          await stub.fetch('http://internal/internal/remove-session', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Auth': env.INTERNAL_SECRET || '',
            },
            body: JSON.stringify({ sessionId: att.session_id }),
          });
        } catch (e) {
          console.warn('[SessionsApi] Failed to remove session from hub:', e);
        }
      }

      // 3. DO purge (best effort)
      if (env.EXAM_SESSION && att.session_id) {
        try {
          const doId = env.EXAM_SESSION.idFromName(att.session_id as string);
          const stub = env.EXAM_SESSION.get(doId);
          await stub.fetch('http://internal/purge', {
            method: 'POST',
            headers: {
              'X-Internal-Auth': env.INTERNAL_SECRET || '',
            },
          });
        } catch (e) {
          console.warn('[SessionsApi] Failed to purge session DO:', e);
        }
      }

      await writeAuditLog(env.DB, {
        action: isTest ? 'delete_test_attempt' : 'delete_attempt',
        target: id,
        ip: request.headers.get('cf-connecting-ip') || '127.0.0.1',
        meta: { examId, studentName: att.student_name, isTest },
      });

      results.push({ id, success: true });
      succeededCount++;
    }

    return json<SessionActionResponse>({
      ok: true,
      action: 'delete',
      results,
      succeededCount,
      refusedCount,
    });
  }

  // ── 7. DELETE /api/professor/exams/:id/sessions/unlinked ──────────────────
  if (subPath === `/exams/${examId}/sessions/unlinked` && method === 'DELETE') {
    let targetSessionIds: string[] = [];

    try {
      const raw = await request.json().catch(() => ({}));
      const parsed = UnlinkedDeleteSchema.safeParse(raw);
      if (parsed.success && parsed.data.sessionIds && parsed.data.sessionIds.length > 0) {
        targetSessionIds = parsed.data.sessionIds;
      }
    } catch {}

    // If no specific sessionIds provided, clear ALL unlinked sessions in the hub
    if (targetSessionIds.length === 0 && env.EXAM_HUB) {
      try {
        const hubId = env.EXAM_HUB.idFromName(examId);
        const stub = env.EXAM_HUB.get(hubId);
        const res = await stub.fetch('http://internal/internal/sessions', {
          headers: {
            'X-Internal-Auth': env.INTERNAL_SECRET || '',
          },
        });
        if (res.ok) {
          const data = (await res.json()) as { sessions: Record<string, any> };
          const hubSessions = data.sessions || {};
          const rows = await env.DB.prepare('SELECT session_id FROM attempts WHERE exam_id = ?')
            .bind(examId)
            .all<{ session_id: string }>();
          const linkedIds = new Set(rows.results.map((r) => r.session_id));
          targetSessionIds = Object.keys(hubSessions).filter((id) => !linkedIds.has(id));
        }
      } catch (e) {
        console.warn('[SessionsApi] Failed to list unlinked sessions:', e);
      }
    }

    let clearedCount = 0;
    for (const sid of targetSessionIds) {
      if (env.EXAM_HUB) {
        try {
          const hubId = env.EXAM_HUB.idFromName(examId);
          const stub = env.EXAM_HUB.get(hubId);
          await stub.fetch('http://internal/internal/remove-session', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Auth': env.INTERNAL_SECRET || '',
            },
            body: JSON.stringify({ sessionId: sid }),
          });
        } catch {}
      }

      if (env.EXAM_SESSION) {
        try {
          const doId = env.EXAM_SESSION.idFromName(sid);
          const stub = env.EXAM_SESSION.get(doId);
          await stub.fetch('http://internal/purge', {
            method: 'POST',
            headers: {
              'X-Internal-Auth': env.INTERNAL_SECRET || '',
            },
          });
        } catch {}
      }

      await writeAuditLog(env.DB, {
        action: 'clear_unlinked_session',
        target: sid,
        ip: request.headers.get('cf-connecting-ip') || '127.0.0.1',
        meta: { examId },
      });

      clearedCount++;
    }

    return json({ ok: true, clearedCount });
  }

  // ── 8. GET /api/professor/exams/:id/sessions/:sessionId/history ───────────
  const historyMatch = subPath.match(new RegExp(`^/exams/${examId}/sessions/([^/]+)/history$`));
  if (historyMatch && method === 'GET') {
    const targetSessionId = historyMatch[1];

    // Verify session belongs to an attempt in this exam
    const attempt = await env.DB.prepare(
      'SELECT id, student_name, data_purged_at FROM attempts WHERE exam_id = ? AND session_id = ?',
    )
      .bind(examId, targetSessionId)
      .first<Record<string, unknown>>();

    if (!attempt) {
      return err('Session not found in this exam', 404);
    }

    if (attempt.data_purged_at) {
      return json({
        sessionId: targetSessionId,
        purged: true,
        message: 'Evidence removed by retention policy',
        riskScore: 0,
        riskHistory: [],
        violations: [],
        interventions: [],
      });
    }

    if (!env.EXAM_SESSION) {
      return err('Exam session service unavailable', 503);
    }

    try {
      const doId = env.EXAM_SESSION.idFromName(targetSessionId);
      const stub = env.EXAM_SESSION.get(doId);
      const doUrl = new URL(`http://internal/history?sessionId=${encodeURIComponent(targetSessionId)}`);
      const doRes = await stub.fetch(
        new Request(doUrl.toString(), {
          method: 'GET',
          headers: {
            'X-Internal-Auth': env.INTERNAL_SECRET || '',
          },
        }),
      );

      if (!doRes.ok) {
        return err('Failed to retrieve session history from DO', doRes.status);
      }

      const historyData = await doRes.json();
      return json(historyData);
    } catch (e) {
      console.warn('[SessionsApi] Failed to fetch session history:', e);
      return err('Internal error fetching session history', 500);
    }
  }

  // ── 9. POST /api/professor/exams/:id/preview-start ────────────────────────
  if (subPath === `/exams/${examId}/preview-start` && method === 'POST') {
    const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?')
      .bind(examId)
      .first<Record<string, unknown>>();

    if (!exam) return err('Exam not found', 404);

    let questions: StudentQuestion[] = [];

    if (exam.status === 'draft') {
      // Draft exam: load live question rows from questions table
      const qRows = await env.DB.prepare(
        'SELECT * FROM questions WHERE exam_id = ? ORDER BY order_index ASC',
      )
        .bind(examId)
        .all<Record<string, unknown>>();

      questions = qRows.results.map((r) => toStudentQuestion(r));
    } else {
      // Published exam: load from exam_questions snapshot_json
      const snapRows = await env.DB.prepare(
        'SELECT snapshot_json FROM exam_questions WHERE exam_id = ? ORDER BY position ASC',
      )
        .bind(examId)
        .all<{ snapshot_json: string | null }>();

      questions = snapRows.results
        .filter((r) => r.snapshot_json != null)
        .map((r) => {
          const raw = JSON.parse(r.snapshot_json!) as Record<string, unknown>;
          return toStudentQuestion(raw);
        });
    }

    const maxScore = questions.reduce((s, q) => s + (q.points || 0), 0);
    const durationMinutes = (exam.duration_minutes as number) || 60;
    const durationMs = durationMinutes * 60 * 1000;
    const nowMs = Date.now();
    const startedAt = new Date(nowMs).toISOString();
    const deadlineAt = new Date(nowMs + durationMs).toISOString();

    const attemptId = nanoId('at');
    const randomChars = Math.random().toString(36).slice(2, 6).toUpperCase();
    const studentName = `Preview-${randomChars}`;
    const sessionId = `session-${Math.random().toString(36).slice(2, 10)}`;

    await env.DB.prepare(
      `INSERT INTO attempts (
         id, exam_id, student_name, session_id, status,
         started_at, deadline_at, paused_seconds, max_score,
         grading_status, is_test, user_id, violation_count, final_risk_score
       ) VALUES (?, ?, ?, ?, 'in_progress', ?, ?, 0, ?, 'auto_graded', 1, ?, 0, 0)`,
    )
      .bind(attemptId, examId, studentName, sessionId, startedAt, deadlineAt, maxScore, user.id)
      .run();

    await writeAuditLog(env.DB, {
      actor_user_id: user.id,
      action: 'preview_start',
      target: attemptId,
      ip: request.headers.get('cf-connecting-ip') || '127.0.0.1',
      meta: { examId, studentName, isTest: true },
    });

    const attempt = {
      id: attemptId,
      exam_id: examId,
      student_name: studentName,
      session_id: sessionId,
      status: 'in_progress',
      started_at: startedAt,
      deadline_at: deadlineAt,
      submitted_at: null,
      paused_seconds: 0,
      paused_at: null,
      score: null,
      max_score: maxScore,
      grading_status: 'auto_graded',
      is_test: 1,
    };

    return json({
      attempt,
      questions,
      seconds_remaining: durationMinutes * 60,
      resumed: false,
    });
  }

  return err('Not found', 404);
}

/**
 * Daily Retention Sweep:
 * Runs once daily (0 3 * * *).
 * 1. For exams with retention_days > 0: finds ended attempts where exam end_time + retention_days is in the past,
 *    data_purged_at IS NULL, evidence_hold = 0, and is_test = 0.
 *    For each (limit 50 per run): purges DO data and removes from hub, then sets data_purged_at.
 *    Attempts, answers and scores are KEPT.
 * 2. Finds is_test = 1 attempts older than 24 hours (started_at < 24h ago):
 *    Permanently deletes them (answers cascade + attempt deleted, DO purged, hub removed).
 * 3. Writes an audit_log row with the counts.
 */
export async function runRetentionSweep(
  env: SessionsEnv,
): Promise<{ purgedCount: number; testDeletedCount: number }> {
  let purgedCount = 0;
  let testDeletedCount = 0;

  // 1. Purge expired evidence from non-test ended attempts
  try {
    const expiredRows = await env.DB.prepare(
      `SELECT a.id, a.session_id, a.exam_id, a.ended_at, a.submitted_at, e.end_time, e.retention_days
       FROM attempts a
       JOIN exams e ON a.exam_id = e.id
       WHERE e.retention_days > 0
         AND a.status IN ('submitted', 'auto_submitted', 'terminated')
         AND a.data_purged_at IS NULL
         AND a.evidence_hold = 0
         AND a.is_test = 0
       LIMIT 50`,
    ).all<Record<string, unknown>>();

    const now = Date.now();
    for (const r of expiredRows.results) {
      try {
        const retentionDays = Number(r.retention_days);
        const refTimeStr = (r.ended_at || r.submitted_at || r.end_time) as string;
        if (!refTimeStr) continue;
        const refTime = new Date(refTimeStr).getTime();
        const expirationTime = refTime + retentionDays * 86400000;

        if (now >= expirationTime) {
          const attemptId = r.id as string;
          const sessionId = r.session_id as string;
          const examId = r.exam_id as string;

          // DO purge
          if (env.EXAM_SESSION && sessionId) {
            try {
              const doId = env.EXAM_SESSION.idFromName(sessionId);
              const stub = env.EXAM_SESSION.get(doId);
              await stub.fetch('http://internal/purge', {
                method: 'POST',
                headers: {
                  'X-Internal-Auth': env.INTERNAL_SECRET || '',
                },
              });
            } catch {}
          }

          // Hub remove
          if (env.EXAM_HUB && sessionId) {
            try {
              const hubId = env.EXAM_HUB.idFromName(examId);
              const stub = env.EXAM_HUB.get(hubId);
              await stub.fetch('http://internal/internal/remove-session', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Internal-Auth': env.INTERNAL_SECRET || '',
                },
                body: JSON.stringify({ sessionId }),
              });
            } catch {}
          }

          // Set data_purged_at in D1 (keeps attempts, answers, and scores)
          await env.DB.prepare('UPDATE attempts SET data_purged_at = ? WHERE id = ?')
            .bind(new Date().toISOString(), attemptId)
            .run();

          purgedCount++;
        }
      } catch (itemErr) {
        console.warn(`[RetentionSweep] Failed to purge attempt ${r.id}:`, itemErr);
      }
    }
  } catch (err) {
    console.warn('[RetentionSweep] Error querying expired attempts:', err);
  }

  // 2. Delete test attempts older than 24 hours
  try {
    const testCutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const oldTests = await env.DB.prepare(
      `SELECT id, session_id, exam_id FROM attempts
       WHERE is_test = 1 AND started_at < ?
       LIMIT 50`,
    )
      .bind(testCutoff)
      .all<{ id: string; session_id: string; exam_id: string }>();

    for (const t of oldTests.results) {
      try {
        await env.DB.prepare('DELETE FROM answers WHERE attempt_id = ?').bind(t.id).run();
        await env.DB.prepare('DELETE FROM attempts WHERE id = ?').bind(t.id).run();

        if (env.EXAM_SESSION && t.session_id) {
          try {
            const doId = env.EXAM_SESSION.idFromName(t.session_id);
            const stub = env.EXAM_SESSION.get(doId);
            await stub.fetch('http://internal/purge', {
              method: 'POST',
              headers: {
                'X-Internal-Auth': env.INTERNAL_SECRET || '',
              },
            });
          } catch {}
        }

        if (env.EXAM_HUB && t.session_id) {
          try {
            const hubId = env.EXAM_HUB.idFromName(t.exam_id);
            const stub = env.EXAM_HUB.get(hubId);
            await stub.fetch('http://internal/internal/remove-session', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Internal-Auth': env.INTERNAL_SECRET || '',
              },
              body: JSON.stringify({ sessionId: t.session_id }),
            });
          } catch {}
        }

        testDeletedCount++;
      } catch (testErr) {
        console.warn(`[RetentionSweep] Failed to delete test attempt ${t.id}:`, testErr);
      }
    }
  } catch (err) {
    console.warn('[RetentionSweep] Error querying old test attempts:', err);
  }

  // Write one audit_log row for the run
  await writeAuditLog(env.DB, {
    actor_user_id: 'system_retention_cron',
    action: 'retention_sweep',
    target: 'system',
    meta: { purgedCount, testDeletedCount },
  });

  return { purgedCount, testDeletedCount };
}

