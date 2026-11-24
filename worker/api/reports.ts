/**
 * worker/api/reports.ts — Integrity Reports & Review Queue API (Phase 6)
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides:
 *   • GET  /api/professor/attempts/:attemptId/report
 *   • PUT  /api/professor/attempts/:attemptId/review
 *   • PUT  /api/professor/attempts/:attemptId/violations/:violationId/review
 *   • GET  /api/professor/exams/:id/review
 *   • GET  /api/professor/review
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';
import type { User } from '../auth/types.js';
import { canAccessExam } from '../utils/auth.js';
import { writeAudit } from '../utils/audit.js';
import {
  computeReviewLevel,
  getReviewReasons,
  reviewLevelRank,
} from '../utils/reviewLevel.js';

export interface ReportsEnv {
  DB: D1Database;
  EXAM_SESSION?: DurableObjectNamespace;
  INTERNAL_SECRET?: string;
}

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

const ReviewDecisionSchema = z.object({
  decision: z.enum(['no_action', 'warning', 'escalate']).nullable(),
  note: z.string().max(2000, 'Note must not exceed 2000 characters').optional().nullable(),
});

const ViolationReviewSchema = z.object({
  decision: z.enum(['confirmed', 'dismissed']).nullable(),
});

/**
 * Dispatches requests starting with /api/professor to Phase 6 report endpoints.
 * Returns null if the path does not match any report route.
 */
export async function handleReportsApi(
  request: Request,
  env: ReportsEnv,
  path: string,
  method: string,
  user: User,
): Promise<Response | null> {
  const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';

  // ── 1. GET /api/professor/review (cross-exam queue) ────────────────────────
  if (path === '/review' && method === 'GET') {
    const url = new URL(request.url);
    const filterLevel = url.searchParams.get('level');
    const filterStatus = url.searchParams.get('status') || 'all';

    let sql = `
      SELECT
        a.id,
        a.exam_id,
        a.student_name,
        u_stu.email AS student_email,
        a.status,
        a.started_at,
        a.submitted_at,
        a.final_risk_score,
        a.violation_count,
        a.max_severity,
        a.review_decision,
        a.review_note,
        a.reviewed_at,
        a.reviewed_by,
        u.name AS reviewer_name,
        e.title AS exam_title,
        e.course_code AS exam_course,
        e.max_risk_score
      FROM attempts a
      JOIN exams e ON a.exam_id = e.id
      LEFT JOIN users u ON a.reviewed_by = u.id
      LEFT JOIN users u_stu ON a.user_id = u_stu.id
      WHERE a.is_test = 0
        AND a.archived = 0
        AND e.archived = 0
    `;

    const binds: any[] = [];
    if (user.role !== 'admin') {
      sql += ' AND e.created_by = ?';
      binds.push(user.id);
    }

    const { results } = await env.DB.prepare(sql).bind(...binds).all<Record<string, unknown>>();

    let items = (results || []).map((row) => {
      const level = computeReviewLevel({
        finalRiskScore: (row.final_risk_score as number) ?? null,
        maxSeverity: (row.max_severity as string) ?? null,
        violationCount: (row.violation_count as number) ?? null,
        maxRiskScore: (row.max_risk_score as number) ?? 80,
        hasIdentityMismatch: false,
        hasMultipleFaces: false,
      });

      return {
        id: row.id as string,
        examId: row.exam_id as string,
        exam: {
          id: row.exam_id as string,
          title: (row.exam_title as string) || 'Untitled Exam',
          course: (row.exam_course as string) || '',
        },
        studentName: (row.student_name as string) || 'Anonymous Student',
        studentEmail: (row.student_email as string) || '',
        status: row.status as string,
        finalRiskScore: (row.final_risk_score as number) ?? null,
        violationCount: (row.violation_count as number) ?? null,
        maxSeverity: (row.max_severity as string) ?? null,
        reviewLevel: level,
        reviewDecision: (row.review_decision as string) ?? null,
        reviewNote: (row.review_note as string) ?? null,
        reviewedAt: (row.reviewed_at as string) ?? null,
        reviewedByName: (row.reviewer_name as string) ?? null,
        endedAt: (row.submitted_at as string) ?? null,
      };
    });

    // Filter by status
    if (filterStatus === 'unreviewed') {
      items = items.filter((it) => it.reviewDecision === null);
    } else if (filterStatus === 'reviewed') {
      items = items.filter((it) => it.reviewDecision !== null);
    }

    // Filter by level
    if (filterLevel && filterLevel !== 'all') {
      items = items.filter((it) => it.reviewLevel === filterLevel);
    }

    // Sort by level rank DESC, then finalRiskScore DESC, then endedAt DESC
    items.sort((a, b) => {
      const rankDiff = reviewLevelRank(b.reviewLevel) - reviewLevelRank(a.reviewLevel);
      if (rankDiff !== 0) return rankDiff;

      const scoreA = a.finalRiskScore ?? -1;
      const scoreB = b.finalRiskScore ?? -1;
      if (scoreB !== scoreA) return scoreB - scoreA;

      const timeA = a.endedAt ? new Date(a.endedAt).getTime() : 0;
      const timeB = b.endedAt ? new Date(b.endedAt).getTime() : 0;
      return timeB - timeA;
    });

    return json({ items });
  }

  // ── 2. GET /api/professor/exams/:id/review (per-exam queue) ────────────────
  const examReviewMatch = path.match(/^\/exams\/([^/]+)\/review$/);
  if (examReviewMatch && method === 'GET') {
    const examId = examReviewMatch[1];
    const exam = await env.DB.prepare('SELECT * FROM exams WHERE id = ?')
      .bind(examId)
      .first<Record<string, unknown>>();

    if (!exam || !canAccessExam(exam, user)) {
      return err('Exam not found', 404);
    }

    const url = new URL(request.url);
    const filterLevel = url.searchParams.get('level');
    const filterStatus = url.searchParams.get('status') || 'all';

    const sql = `
      SELECT
        a.id,
        a.exam_id,
        a.student_name,
        u_stu.email AS student_email,
        a.status,
        a.started_at,
        a.submitted_at,
        a.final_risk_score,
        a.violation_count,
        a.max_severity,
        a.review_decision,
        a.review_note,
        a.reviewed_at,
        a.reviewed_by,
        u.name AS reviewer_name,
        e.max_risk_score
      FROM attempts a
      JOIN exams e ON a.exam_id = e.id
      LEFT JOIN users u ON a.reviewed_by = u.id
      LEFT JOIN users u_stu ON a.user_id = u_stu.id
      WHERE a.exam_id = ?
        AND a.is_test = 0
        AND a.archived = 0
    `;

    const { results } = await env.DB.prepare(sql).bind(examId).all<Record<string, unknown>>();

    let items = (results || []).map((row) => {
      const level = computeReviewLevel({
        finalRiskScore: (row.final_risk_score as number) ?? null,
        maxSeverity: (row.max_severity as string) ?? null,
        violationCount: (row.violation_count as number) ?? null,
        maxRiskScore: (row.max_risk_score as number) ?? (exam.max_risk_score as number) ?? 80,
        hasIdentityMismatch: false,
        hasMultipleFaces: false,
      });

      return {
        id: row.id as string,
        examId: row.exam_id as string,
        studentName: (row.student_name as string) || 'Anonymous Student',
        studentEmail: (row.student_email as string) || '',
        status: row.status as string,
        finalRiskScore: (row.final_risk_score as number) ?? null,
        violationCount: (row.violation_count as number) ?? null,
        maxSeverity: (row.max_severity as string) ?? null,
        reviewLevel: level,
        reviewDecision: (row.review_decision as string) ?? null,
        reviewNote: (row.review_note as string) ?? null,
        reviewedAt: (row.reviewed_at as string) ?? null,
        reviewedByName: (row.reviewer_name as string) ?? null,
        endedAt: (row.submitted_at as string) ?? null,
      };
    });

    if (filterStatus === 'unreviewed') {
      items = items.filter((it) => it.reviewDecision === null);
    } else if (filterStatus === 'reviewed') {
      items = items.filter((it) => it.reviewDecision !== null);
    }

    if (filterLevel && filterLevel !== 'all') {
      items = items.filter((it) => it.reviewLevel === filterLevel);
    }

    items.sort((a, b) => {
      const rankDiff = reviewLevelRank(b.reviewLevel) - reviewLevelRank(a.reviewLevel);
      if (rankDiff !== 0) return rankDiff;

      const scoreA = a.finalRiskScore ?? -1;
      const scoreB = b.finalRiskScore ?? -1;
      if (scoreB !== scoreA) return scoreB - scoreA;

      const timeA = a.endedAt ? new Date(a.endedAt).getTime() : 0;
      const timeB = b.endedAt ? new Date(b.endedAt).getTime() : 0;
      return timeB - timeA;
    });

    return json({ items });
  }

  // ── 3. GET /api/professor/attempts/:attemptId/report ────────────────────────
  const reportMatch = path.match(/^\/attempts\/([^/]+)\/report$/);
  if (reportMatch && method === 'GET') {
    const attemptId = reportMatch[1];

    const attempt = await env.DB.prepare(`
      SELECT
        a.*,
        u_stu.email AS student_email,
        e.id AS exam_id,
        e.title AS exam_title,
        e.course_code AS exam_course,
        e.created_by AS exam_created_by,
        e.max_risk_score,
        e.retention_days,
        u.name AS reviewer_name
      FROM attempts a
      JOIN exams e ON a.exam_id = e.id
      LEFT JOIN users u ON a.reviewed_by = u.id
      LEFT JOIN users u_stu ON a.user_id = u_stu.id
      WHERE a.id = ?
    `)
      .bind(attemptId)
      .first<Record<string, unknown>>();

    if (!attempt) {
      return err('Attempt not found', 404);
    }

    const exam = { id: attempt.exam_id, created_by: attempt.exam_created_by };
    if (!canAccessExam(exam, user)) {
      return err('Not found', 404);
    }

    // Test attempts are strictly restricted to their owner
    if (attempt.is_test === 1 && attempt.exam_created_by !== user.id) {
      return err('Not found', 404);
    }

    // Write audit log entry for viewing the report
    await writeAudit(env, {
      actor_user_id: user.id,
      action: 'view_report',
      target: attemptId,
      ip,
    });

    // Query violation reviews recorded for this attempt
    const { results: vReviews } = await env.DB.prepare(`
      SELECT violation_id, decision, reviewed_by, reviewed_at
      FROM violation_reviews
      WHERE attempt_id = ?
    `)
      .bind(attemptId)
      .all<Record<string, unknown>>();

    const reviewMap = new Map<string, { decision: string; reviewed_by: string; reviewed_at: string }>();
    for (const r of vReviews || []) {
      reviewMap.set(r.violation_id as string, {
        decision: r.decision as string,
        reviewed_by: r.reviewed_by as string,
        reviewed_at: r.reviewed_at as string,
      });
    }

    // Determine DO proctoring history or purged status
    let purged = Boolean(attempt.data_purged_at);
    let riskTimeline: Array<{ timestamp: string; score: number; triggers: string[]; aiExplanation: string }> = [];
    let violations: Array<{
      id: string;
      type: string;
      severity: string;
      timestamp: string;
      duration?: number;
      aiConfidence: number;
      aiExplanation?: string;
      reviewDecision: string | null;
      reviewedBy?: string | null;
      reviewedAt?: string | null;
    }> = [];
    let interventions: Array<{
      id: string;
      action: string;
      message: string;
      issuedAt: string;
      acknowledgedAt?: string | null;
    }> = [];

    let hasIdentityMismatch = false;
    let hasMultipleFaces = false;

    if (!purged && env.EXAM_SESSION && attempt.session_id) {
      try {
        const doId = env.EXAM_SESSION.idFromName(attempt.session_id as string);
        const stub = env.EXAM_SESSION.get(doId);
        const doUrl = new URL(`http://internal/history?sessionId=${encodeURIComponent(attempt.session_id as string)}`);
        const doRes = await stub.fetch(
          new Request(doUrl.toString(), {
            method: 'GET',
            headers: {
              'X-Internal-Auth': env.INTERNAL_SECRET || '',
            },
          }),
        );

        if (doRes.ok) {
          const doData = (await doRes.json()) as any;
          if (doData.purged) {
            purged = true;
          } else {
            const rawRiskHistory: any[] = Array.isArray(doData.riskHistory) ? doData.riskHistory : [];
            const rawViolations: any[] = Array.isArray(doData.violations) ? doData.violations : [];
            const rawInterventions: any[] = Array.isArray(doData.interventions) ? doData.interventions : [];

            riskTimeline = rawRiskHistory.map((rh) => ({
              timestamp: rh.timestamp,
              score: rh.score,
              triggers: Array.isArray(rh.triggers) ? rh.triggers : [],
              aiExplanation: rh.aiExplanation || '',
            }));

            // Check triggers for identity mismatch or multiple faces
            for (const rh of riskTimeline) {
              if (rh.triggers.includes('identity_mismatch')) hasIdentityMismatch = true;
              if (rh.triggers.includes('multiple_faces')) hasMultipleFaces = true;
            }

            // Map violations
            violations = rawViolations.map((v) => {
              if (v.type === 'vision' && String(v.triggers || '').includes('identity_mismatch')) {
                hasIdentityMismatch = true;
              }
              const matchingRisk = riskTimeline.find((r) => r.timestamp === v.timestamp);
              const vRev = reviewMap.get(v.id);
              return {
                id: v.id,
                type: v.type,
                severity: v.severity,
                timestamp: v.timestamp,
                // Note: duration is not stored in the Violation data model, so it is omitted
                duration: typeof v.duration === 'number' ? v.duration : undefined,
                aiConfidence: typeof v.aiConfidence === 'number' ? v.aiConfidence : 1.0,
                aiExplanation: v.aiExplanation || matchingRisk?.aiExplanation || '',
                reviewDecision: vRev ? vRev.decision : null,
                reviewedBy: vRev ? vRev.reviewed_by : null,
                reviewedAt: vRev ? vRev.reviewed_at : null,
              };
            });

            interventions = rawInterventions.map((iv) => ({
              id: iv.id,
              action: iv.action,
              message: iv.message,
              issuedAt: iv.issuedAt,
              acknowledgedAt: iv.acknowledgedAt || null,
            }));
          }
        } else {
          purged = true;
        }
      } catch (err) {
        console.warn('[handleReportsApi] Error fetching DO history, treating as purged:', err);
        purged = true;
      }
    } else {
      purged = true;
    }

    const maxRiskScore = (attempt.max_risk_score as number) ?? 80;
    const reviewLevel = computeReviewLevel({
      finalRiskScore: (attempt.final_risk_score as number) ?? null,
      maxSeverity: (attempt.max_severity as string) ?? null,
      violationCount: (attempt.violation_count as number) ?? null,
      maxRiskScore,
      hasIdentityMismatch,
      hasMultipleFaces,
    });

    const reviewReasons = getReviewReasons({
      finalRiskScore: (attempt.final_risk_score as number) ?? null,
      maxSeverity: (attempt.max_severity as string) ?? null,
      violationCount: (attempt.violation_count as number) ?? null,
      maxRiskScore,
      hasIdentityMismatch,
      hasMultipleFaces,
    });

    let durationSeconds: number | null = null;
    if (attempt.started_at) {
      const endIso = attempt.submitted_at as string | null;
      if (endIso) {
        const startMs = new Date(attempt.started_at as string).getTime();
        const endMs = new Date(endIso).getTime();
        if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
          durationSeconds = Math.round((endMs - startMs) / 1000);
        }
      }
    }

    return json({
      header: {
        attemptId: attempt.id,
        examId: attempt.exam_id,
        examTitle: attempt.exam_title || 'Untitled Exam',
        examCourse: attempt.exam_course || '',
        studentName: attempt.student_name || 'Anonymous Student',
        studentEmail: attempt.student_email || '',
        status: attempt.status,
        startedAt: attempt.started_at || null,
        endedAt: attempt.submitted_at || null,
        durationSeconds,
        endedReason: attempt.ended_reason || attempt.status,
        finalRiskScore: (attempt.final_risk_score as number) ?? 0,
        maxRiskScore,
        violationCount: (attempt.violation_count as number) ?? null,
        maxSeverity: (attempt.max_severity as string) ?? null,
        reviewLevel,
        reviewReasons,
        purged,
      },
      riskTimeline: purged ? [] : riskTimeline,
      violations: purged ? [] : violations,
      interventions: purged ? [] : interventions,
      review: {
        decision: (attempt.review_decision as string) ?? null,
        note: (attempt.review_note as string) ?? null,
        reviewedAt: (attempt.reviewed_at as string) ?? null,
        reviewedBy: (attempt.reviewer_name as string) || (attempt.reviewed_by as string) || null,
      },
    });
  }

  // ── 4. PUT /api/professor/attempts/:attemptId/review ───────────────────────
  const attemptReviewMatch = path.match(/^\/attempts\/([^/]+)\/review$/);
  if (attemptReviewMatch && method === 'PUT') {
    const attemptId = attemptReviewMatch[1];

    const attempt = await env.DB.prepare(`
      SELECT a.*, e.created_by AS exam_created_by
      FROM attempts a
      JOIN exams e ON a.exam_id = e.id
      WHERE a.id = ?
    `)
      .bind(attemptId)
      .first<Record<string, unknown>>();

    if (!attempt) {
      return err('Attempt not found', 404);
    }

    const exam = { id: attempt.exam_id, created_by: attempt.exam_created_by };
    if (!canAccessExam(exam, user)) {
      return err('Not found', 404);
    }

    if (attempt.is_test === 1 && attempt.exam_created_by !== user.id) {
      return err('Not found', 404);
    }

    // Allowed only for ended attempts (409 for in_progress)
    if (attempt.status === 'in_progress') {
      return err('Cannot review an in-progress attempt', 409);
    }

    let body: z.infer<typeof ReviewDecisionSchema>;
    try {
      const raw = await request.json();
      body = ReviewDecisionSchema.parse(raw);
    } catch (e: any) {
      return err(e?.errors?.[0]?.message || 'Invalid review payload', 400);
    }

    const now = new Date().toISOString();
    if (body.decision === null) {
      // Clear decision
      await env.DB.prepare(`
        UPDATE attempts
        SET review_decision = NULL, review_note = NULL, reviewed_at = NULL, reviewed_by = NULL
        WHERE id = ?
      `)
        .bind(attemptId)
        .run();

      await writeAudit(env, {
        actor_user_id: user.id,
        action: 'review_attempt',
        target: attemptId,
        ip,
        meta: { decision: null },
      });

      return json({
        ok: true,
        review: {
          decision: null,
          note: null,
          reviewedAt: null,
          reviewedBy: null,
        },
      });
    }

    // Set decision
    await env.DB.prepare(`
      UPDATE attempts
      SET review_decision = ?, review_note = ?, reviewed_at = ?, reviewed_by = ?
      WHERE id = ?
    `)
      .bind(body.decision, body.note ?? null, now, user.id, attemptId)
      .run();

    await writeAudit(env, {
      actor_user_id: user.id,
      action: 'review_attempt',
      target: attemptId,
      ip,
      meta: { decision: body.decision, noteLength: body.note?.length ?? 0 },
    });

    return json({
      ok: true,
      review: {
        decision: body.decision,
        note: body.note ?? null,
        reviewedAt: now,
        reviewedBy: user.name,
      },
    });
  }

  // ── 5. PUT /api/professor/attempts/:attemptId/violations/:violationId/review ─
  const violationReviewMatch = path.match(/^\/attempts\/([^/]+)\/violations\/([^/]+)\/review$/);
  if (violationReviewMatch && method === 'PUT') {
    const attemptId = violationReviewMatch[1];
    const violationId = violationReviewMatch[2];

    const attempt = await env.DB.prepare(`
      SELECT a.*, e.created_by AS exam_created_by
      FROM attempts a
      JOIN exams e ON a.exam_id = e.id
      WHERE a.id = ?
    `)
      .bind(attemptId)
      .first<Record<string, unknown>>();

    if (!attempt) {
      return err('Attempt not found', 404);
    }

    const exam = { id: attempt.exam_id, created_by: attempt.exam_created_by };
    if (!canAccessExam(exam, user)) {
      return err('Not found', 404);
    }

    if (attempt.is_test === 1 && attempt.exam_created_by !== user.id) {
      return err('Not found', 404);
    }

    let body: z.infer<typeof ViolationReviewSchema>;
    try {
      const raw = await request.json();
      body = ViolationReviewSchema.parse(raw);
    } catch (e: any) {
      return err(e?.errors?.[0]?.message || 'Invalid violation review payload', 400);
    }

    // The violation id must exist in that attempt's history, otherwise 404
    if (!env.EXAM_SESSION || !attempt.session_id) {
      return err('Violation not found in attempt history', 404);
    }

    try {
      const doId = env.EXAM_SESSION.idFromName(attempt.session_id as string);
      const stub = env.EXAM_SESSION.get(doId);
      const doUrl = new URL(`http://internal/history?sessionId=${encodeURIComponent(attempt.session_id as string)}`);
      const doRes = await stub.fetch(
        new Request(doUrl.toString(), {
          method: 'GET',
          headers: {
            'X-Internal-Auth': env.INTERNAL_SECRET || '',
          },
        }),
      );

      if (!doRes.ok) {
        return err('Violation not found in attempt history', 404);
      }

      const doData = (await doRes.json()) as any;
      const rawViolations: any[] = Array.isArray(doData?.violations) ? doData.violations : [];
      const found = rawViolations.some((v) => v.id === violationId);
      if (!found) {
        return err('Violation not found in attempt history', 404);
      }
    } catch (err: any) {
      console.warn('[handleReportsApi] Failed to verify violation in DO:', err);
      return err('Violation not found in attempt history', 404);
    }

    const now = new Date().toISOString();

    if (body.decision === null) {
      await env.DB.prepare(`
        DELETE FROM violation_reviews
        WHERE attempt_id = ? AND violation_id = ?
      `)
        .bind(attemptId, violationId)
        .run();

      await writeAudit(env, {
        actor_user_id: user.id,
        action: 'review_violation',
        target: `${attemptId}:${violationId}`,
        ip,
        meta: { decision: null },
      });

      return json({ ok: true, decision: null });
    }

    await env.DB.prepare(`
      INSERT INTO violation_reviews (attempt_id, violation_id, decision, reviewed_by, reviewed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (attempt_id, violation_id) DO UPDATE SET
        decision = excluded.decision,
        reviewed_by = excluded.reviewed_by,
        reviewed_at = excluded.reviewed_at
    `)
      .bind(attemptId, violationId, body.decision, user.id, now)
      .run();

    await writeAudit(env, {
      actor_user_id: user.id,
      action: 'review_violation',
      target: `${attemptId}:${violationId}`,
      ip,
      meta: { decision: body.decision },
    });

    return json({ ok: true, decision: body.decision });
  }

  return null;
}
