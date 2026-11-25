/**
 * worker/api/admin.ts — Admin Management REST API (Phase 7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoints (all require role: 'admin'):
 *   GET    /api/admin/users                 → List users with search, role/status filter, keyset pagination
 *   POST   /api/admin/users                 → Create staff (professor or admin) accounts
 *   POST   /api/admin/users/:id/deactivate  → Deactivate user with self & last-admin protection
 *   POST   /api/admin/users/:id/reactivate  → Reactivate user and bump token_version
 *   GET    /api/admin/exams                 → All exams with owner, counts, filters, and pagination
 *   POST   /api/admin/exams/:id/reassign    → Reassign exam to active professor/admin (409 if in-progress)
 *   GET    /api/admin/overview              → Platform overview metrics, pending items, and cron health
 *   GET    /api/admin/audit                 → Searchable, keyset-paginated audit log viewer
 *   GET    /api/admin/security/failed-logins→ Failed logins grouped by email and IP + locked accounts
 *   POST   /api/admin/claim-legacy-exams    → Claim exams with NULL created_by (Phase 5a)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';
import { requireAuth, isAuthResponse } from '../auth/requireAuth.js';
import { hashPassword } from '../auth/crypto.js';
import { writeAudit } from '../utils/audit.js';
import type { SafeUser } from '../auth/types.js';

function json<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(code: string, message: string, status = 400): Response {
  return new Response(
    JSON.stringify({ error: { code, message } }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

export interface AdminEnv {
  DB: D1Database;
  JWT_SECRET?: string;
}

/** Escapes SQL LIKE special wildcard characters (%, _, \) */
export function escapeLike(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// ── Zod Schemas ───────────────────────────────────────────────────────────────

const CreateStaffSchema = z.object({
  email: z.string().trim().email('Invalid email address').max(255),
  name: z.string().trim().min(1, 'Name is required').max(100),
  password: z.string().min(10, 'Password must be at least 10 characters').max(128),
  role: z.enum(['professor', 'admin']),
  department: z.string().trim().max(100).optional().nullable(),
});

const ReassignExamSchema = z.object({
  newOwnerId: z.string().trim().min(1, 'New owner ID is required'),
});

// ── Main Route Handler ────────────────────────────────────────────────────────

export async function handleAdminApi(request: Request, env: AdminEnv): Promise<Response> {
  const auth = await requireAuth(request, env, ['admin']);
  if (isAuthResponse(auth)) {
    return auth;
  }
  const admin = auth.user;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';

  // ── 1. GET /api/admin/users ────────────────────────────────────────────────
  if (path === '/api/admin/users' && method === 'GET') {
    const search = url.searchParams.get('search')?.trim() || '';
    const role = url.searchParams.get('role')?.trim() || '';
    const status = url.searchParams.get('status')?.trim() || '';
    const cursor = url.searchParams.get('cursor')?.trim() || null;
    const limitParam = parseInt(url.searchParams.get('limit') || '20', 10);
    const limit = Math.max(1, Math.min(50, isNaN(limitParam) ? 20 : limitParam));

    let query = `
      SELECT id, email, name, role, active, student_id, department, created_at, last_login_at
      FROM users
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (search) {
      const escaped = escapeLike(search);
      query += ` AND (email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')`;
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    if (role && role !== 'all') {
      query += ` AND role = ?`;
      params.push(role);
    }

    if (status && status !== 'all') {
      if (status === 'active') {
        query += ` AND active = 1`;
      } else if (status === 'inactive') {
        query += ` AND active = 0`;
      }
    }

    // Keyset pagination cursor format: created_at___id
    if (cursor) {
      const parts = cursor.split('___');
      if (parts.length === 2) {
        query += ` AND (created_at < ? OR (created_at = ? AND id < ?))`;
        params.push(parts[0], parts[0], parts[1]);
      }
    }

    query += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = await env.DB.prepare(query)
      .bind(...params)
      .all<Record<string, unknown>>();

    const items = rows.results || [];
    let next_cursor: string | null = null;
    if (items.length > limit) {
      const lastItem = items[limit - 1];
      next_cursor = `${lastItem.created_at}___${lastItem.id}`;
      items.splice(limit);
    }

    // Explicit sanitize: never return password_hash, password_salt, or token_version
    const users = items.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      active: Number(u.active) === 1,
      student_id: u.student_id || null,
      department: u.department || null,
      created_at: u.created_at,
      last_login_at: u.last_login_at || null,
    }));

    return json({ users, next_cursor });
  }

  // ── 2. POST /api/admin/users (Create Professor or Admin) ───────────────────
  if (path === '/api/admin/users' && method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('invalid_json', 'Invalid JSON body', 400);
    }

    const parsed = CreateStaffSchema.safeParse(body);
    if (!parsed.success) {
      return err('validation_error', parsed.error.issues[0]?.message || 'Validation failed', 400);
    }

    const email = parsed.data.email.toLowerCase();
    const existing = await env.DB
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: string }>();

    if (existing) {
      return err('email_in_use', 'An account with this email already exists', 400);
    }

    const { hashHex, saltHex } = await hashPassword(parsed.data.password);
    const userId = `usr-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const department = parsed.data.department ? parsed.data.department.trim() : null;

    await env.DB
      .prepare(
        `INSERT INTO users (id, email, name, role, password_hash, password_salt, student_id, department, active, token_version, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 1, 0, ?, NULL)`,
      )
      .bind(
        userId,
        email,
        parsed.data.name,
        parsed.data.role,
        hashHex,
        saltHex,
        department,
        now,
      )
      .run();

    await writeAudit(env, {
      actor_user_id: admin.id,
      action: 'create_user',
      target: userId,
      ip,
      meta: { email, role: parsed.data.role, name: parsed.data.name },
    });

    const safeUser: SafeUser = {
      id: userId,
      email,
      name: parsed.data.name,
      role: parsed.data.role,
      student_id: null,
      department,
    };

    return json({ user: safeUser }, 201);
  }

  // ── 3. POST /api/admin/users/:id/deactivate ────────────────────────────────
  const deactivateMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/deactivate$/);
  if (deactivateMatch && method === 'POST') {
    const targetUserId = deactivateMatch[1];

    const targetUser = await env.DB
      .prepare('SELECT id, email, role, active FROM users WHERE id = ?')
      .bind(targetUserId)
      .first<{ id: string; email: string; role: string; active: number }>();

    if (!targetUser) {
      return err('not_found', 'User not found', 404);
    }

    // Protection 1: refuse to deactivate the last active admin on the platform
    if (targetUser.role === 'admin' && Number(targetUser.active) === 1) {
      const adminCountRow = await env.DB
        .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1")
        .first<{ count: number }>();
      if ((adminCountRow?.count ?? 0) <= 1) {
        return err('last_admin', 'Cannot deactivate the last active administrator on the platform', 409);
      }
    }

    // Protection 2: refuse when target is the calling admin
    if (targetUserId === admin.id) {
      return err('cannot_deactivate_self', 'You cannot deactivate your own administrator account', 409);
    }

    // Increment token_version so active sessions are immediately revoked
    await env.DB
      .prepare('UPDATE users SET active = 0, token_version = token_version + 1 WHERE id = ?')
      .bind(targetUserId)
      .run();

    await writeAudit(env, {
      actor_user_id: admin.id,
      action: 'deactivate_user',
      target: targetUserId,
      ip,
      meta: { email: targetUser.email },
    });

    return json({ ok: true, active: 0 });
  }

  // ── 4. POST /api/admin/users/:id/reactivate ────────────────────────────────
  const reactivateMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/reactivate$/);
  if (reactivateMatch && method === 'POST') {
    const targetUserId = reactivateMatch[1];

    const targetUser = await env.DB
      .prepare('SELECT id, email FROM users WHERE id = ?')
      .bind(targetUserId)
      .first<{ id: string; email: string }>();

    if (!targetUser) {
      return err('not_found', 'User not found', 404);
    }

    // Increment token_version so any pre-existing tokens remain revoked
    await env.DB
      .prepare('UPDATE users SET active = 1, token_version = token_version + 1 WHERE id = ?')
      .bind(targetUserId)
      .run();

    await writeAudit(env, {
      actor_user_id: admin.id,
      action: 'reactivate_user',
      target: targetUserId,
      ip,
      meta: { email: targetUser.email },
    });

    return json({ ok: true, active: 1 });
  }

  // ── 5. GET /api/admin/exams ────────────────────────────────────────────────
  if (path === '/api/admin/exams' && method === 'GET') {
    const search = url.searchParams.get('search')?.trim() || '';
    const status = url.searchParams.get('status')?.trim() || '';
    const owner = url.searchParams.get('owner')?.trim() || '';
    const cursor = url.searchParams.get('cursor')?.trim() || null;
    const limitParam = parseInt(url.searchParams.get('limit') || '20', 10);
    const limit = Math.max(1, Math.min(50, isNaN(limitParam) ? 20 : limitParam));

    let query = `
      SELECT 
        e.id, e.title, e.course_code, e.status, e.join_code, e.join_code_active,
        e.duration_minutes, e.start_time, e.end_time, e.created_at, e.created_by,
        e.archived, e.archived_at,
        u.name AS owner_name, u.email AS owner_email,
        (SELECT COUNT(*) FROM exam_enrollments en WHERE en.exam_id = e.id) AS enrolled_count,
        (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND (a.is_test IS NULL OR a.is_test = 0) AND a.status IN ('submitted', 'auto_submitted', 'terminated')) AS submitted_count,
        (SELECT COUNT(*) FROM attempts a WHERE a.exam_id = e.id AND (a.is_test IS NULL OR a.is_test = 0) AND a.status = 'in_progress') AS in_progress_count
      FROM exams e
      LEFT JOIN users u ON e.created_by = u.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (search) {
      const escaped = escapeLike(search);
      query += ` AND (e.title LIKE ? ESCAPE '\\' OR e.course_code LIKE ? ESCAPE '\\')`;
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    if (status && status !== 'all') {
      if (status === 'archived') {
        query += ` AND e.archived = 1`;
      } else {
        query += ` AND e.status = ? AND (e.archived IS NULL OR e.archived = 0)`;
        params.push(status);
      }
    }

    if (owner) {
      query += ` AND (e.created_by = ? OR u.email = ?)`;
      params.push(owner, owner);
    }

    if (cursor) {
      const parts = cursor.split('___');
      if (parts.length === 2) {
        query += ` AND (e.created_at < ? OR (e.created_at = ? AND e.id < ?))`;
        params.push(parts[0], parts[0], parts[1]);
      }
    }

    query += ` ORDER BY e.created_at DESC, e.id DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = await env.DB.prepare(query)
      .bind(...params)
      .all<Record<string, unknown>>();

    const items = rows.results || [];
    let next_cursor: string | null = null;
    if (items.length > limit) {
      const lastItem = items[limit - 1];
      next_cursor = `${lastItem.created_at}___${lastItem.id}`;
      items.splice(limit);
    }

    return json({ exams: items, next_cursor });
  }

  // ── 6. POST /api/admin/exams/:id/reassign ──────────────────────────────────
  const reassignMatch = path.match(/^\/api\/admin\/exams\/([^/]+)\/reassign$/);
  if (reassignMatch && method === 'POST') {
    const examId = reassignMatch[1];

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('invalid_json', 'Invalid JSON body', 400);
    }

    const parsed = ReassignExamSchema.safeParse(body);
    if (!parsed.success) {
      return err('validation_error', parsed.error.issues[0]?.message || 'Validation failed', 400);
    }
    const { newOwnerId } = parsed.data;

    // 1. Verify exam exists
    const exam = await env.DB
      .prepare('SELECT id, title, created_by, status FROM exams WHERE id = ?')
      .bind(examId)
      .first<{ id: string; title: string; created_by: string; status: string }>();

    if (!exam) {
      return err('not_found', 'Exam not found', 404);
    }

    // 2. Verify new owner exists, is active, and is professor or admin
    const newOwner = await env.DB
      .prepare('SELECT id, name, email, role, active FROM users WHERE id = ?')
      .bind(newOwnerId)
      .first<{ id: string; name: string; email: string; role: string; active: number }>();

    if (!newOwner || Number(newOwner.active) !== 1 || !['professor', 'admin'].includes(newOwner.role)) {
      return err('invalid_owner', 'New owner must be an active professor or administrator', 400);
    }

    // 3. Refuse with 409 if exam has in-progress student attempts
    const inProgressRow = await env.DB
      .prepare(
        "SELECT COUNT(*) AS count FROM attempts WHERE exam_id = ? AND status = 'in_progress' AND (is_test IS NULL OR is_test = 0)",
      )
      .bind(examId)
      .first<{ count: number }>();

    if ((inProgressRow?.count ?? 0) > 0) {
      return err(
        'exam_in_progress',
        'Cannot reassign an exam with student attempts currently in progress',
        409,
      );
    }

    // 4. Update exams.created_by only (attempts, answers, reviews untouched)
    await env.DB
      .prepare('UPDATE exams SET created_by = ? WHERE id = ?')
      .bind(newOwnerId, examId)
      .run();

    await writeAudit(env, {
      actor_user_id: admin.id,
      action: 'reassign_exam',
      target: examId,
      ip,
      meta: {
        examTitle: exam.title,
        oldOwnerId: exam.created_by,
        newOwnerId,
        newOwnerEmail: newOwner.email,
      },
    });

    return json({ ok: true, examId, oldOwnerId: exam.created_by, newOwnerId });
  }

  // ── 7. GET /api/admin/overview ─────────────────────────────────────────────
  if (path === '/api/admin/overview' && method === 'GET') {
    const now = Date.now();
    const cutoff24h = new Date(now - 24 * 3600 * 1000).toISOString();
    const cutoff7d = new Date(now - 7 * 24 * 3600 * 1000).toISOString();

    // 1. Users by role and active status
    const userStats = await env.DB
      .prepare('SELECT role, active, COUNT(*) as count FROM users GROUP BY role, active')
      .all<{ role: string; active: number; count: number }>();

    const usersSummary = {
      total: 0,
      students: { active: 0, inactive: 0 },
      professors: { active: 0, inactive: 0 },
      admins: { active: 0, inactive: 0 },
    };

    for (const r of userStats.results || []) {
      const cnt = Number(r.count) || 0;
      usersSummary.total += cnt;
      const isActive = Number(r.active) === 1;
      if (r.role === 'student') {
        if (isActive) usersSummary.students.active += cnt;
        else usersSummary.students.inactive += cnt;
      } else if (r.role === 'professor') {
        if (isActive) usersSummary.professors.active += cnt;
        else usersSummary.professors.inactive += cnt;
      } else if (r.role === 'admin') {
        if (isActive) usersSummary.admins.active += cnt;
        else usersSummary.admins.inactive += cnt;
      }
    }

    // 2. Exams by status & archived
    const examStats = await env.DB
      .prepare('SELECT status, COUNT(*) as count FROM exams WHERE (archived IS NULL OR archived = 0) GROUP BY status')
      .all<{ status: string; count: number }>();

    const archivedExams = await env.DB
      .prepare('SELECT COUNT(*) as count FROM exams WHERE archived = 1')
      .first<{ count: number }>();

    const examsSummary: Record<string, number> = {
      draft: 0,
      scheduled: 0,
      active: 0,
      completed: 0,
      closed: 0,
      archived: archivedExams?.count || 0,
      total: archivedExams?.count || 0,
    };

    for (const r of examStats.results || []) {
      const cnt = Number(r.count) || 0;
      examsSummary[r.status] = cnt;
      examsSummary.total += cnt;
    }

    // 3. Attempts started in 24h & 7d (exclude is_test)
    const attempts24h = await env.DB
      .prepare("SELECT COUNT(*) as count FROM attempts WHERE (is_test IS NULL OR is_test = 0) AND started_at >= ?")
      .bind(cutoff24h)
      .first<{ count: number }>();

    const attempts7d = await env.DB
      .prepare("SELECT COUNT(*) as count FROM attempts WHERE (is_test IS NULL OR is_test = 0) AND started_at >= ?")
      .bind(cutoff7d)
      .first<{ count: number }>();

    const inProgressAttempts = await env.DB
      .prepare("SELECT COUNT(*) as count FROM attempts WHERE (is_test IS NULL OR is_test = 0) AND status = 'in_progress'")
      .first<{ count: number }>();

    // 4. Submissions waiting for manual grading
    const needsGradingAttempts = await env.DB
      .prepare(
        "SELECT COUNT(*) as count FROM attempts WHERE (is_test IS NULL OR is_test = 0) AND status IN ('submitted', 'auto_submitted', 'terminated') AND (fully_graded IS NULL OR fully_graded = 0)",
      )
      .first<{ count: number }>();

    // 5. Flagged attempts without a review decision
    const unreviewedFlags = await env.DB
      .prepare(
        "SELECT COUNT(*) as count FROM attempts WHERE (is_test IS NULL OR is_test = 0) AND violation_count > 0 AND review_decision IS NULL",
      )
      .first<{ count: number }>();

    // 6. Cron runs health and age
    let cronRows: Array<{ job: string; last_run_at: string | null; last_ok: number; last_count: number; last_error: string | null; age_seconds: number | null }> = [];
    try {
      const cronDb = await env.DB
        .prepare('SELECT job, last_run_at, last_ok, last_count, last_error FROM cron_runs')
        .all<{ job: string; last_run_at: string | null; last_ok: number; last_count: number; last_error: string | null }>();

      cronRows = (cronDb.results || []).map((cr) => {
        const age_seconds = cr.last_run_at ? Math.max(0, Math.floor((now - new Date(cr.last_run_at).getTime()) / 1000)) : null;
        return {
          job: cr.job,
          last_run_at: cr.last_run_at,
          last_ok: cr.last_ok,
          last_count: cr.last_count,
          last_error: cr.last_error,
          age_seconds,
        };
      });
    } catch {
      // If table empty or migration in progress
      cronRows = [];
    }

    return json({
      users: usersSummary,
      exams: examsSummary,
      attempts: {
        started_last_24h: attempts24h?.count || 0,
        started_last_7d: attempts7d?.count || 0,
        in_progress_now: inProgressAttempts?.count || 0,
        needs_grading: needsGradingAttempts?.count || 0,
        unreviewed_flagged: unreviewedFlags?.count || 0,
      },
      cron_runs: cronRows,
    });
  }

  // ── 8. GET /api/admin/audit ────────────────────────────────────────────────
  if (path === '/api/admin/audit' && method === 'GET') {
    const action = url.searchParams.get('action')?.trim() || '';
    const actor = url.searchParams.get('actor')?.trim() || '';
    const target = url.searchParams.get('target')?.trim() || '';
    const from = url.searchParams.get('from')?.trim() || '';
    const to = url.searchParams.get('to')?.trim() || '';
    const cursor = url.searchParams.get('cursor')?.trim() || null;
    const limitParam = parseInt(url.searchParams.get('limit') || '50', 10);
    const limit = Math.max(1, Math.min(100, isNaN(limitParam) ? 50 : limitParam));

    let query = `
      SELECT 
        a.id, a.ts, a.actor_user_id, a.action, a.target, a.ip, a.meta_json,
        u.name AS actor_name, u.email AS actor_email
      FROM audit_log a
      LEFT JOIN users u ON a.actor_user_id = u.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    if (action) {
      query += ` AND a.action = ?`;
      params.push(action);
    }

    if (actor) {
      query += ` AND (a.actor_user_id = ? OR u.email = ? OR u.name LIKE ? ESCAPE '\\')`;
      params.push(actor, actor, `%${escapeLike(actor)}%`);
    }

    if (target) {
      query += ` AND a.target LIKE ? ESCAPE '\\'`;
      params.push(`%${escapeLike(target)}%`);
    }

    if (from) {
      query += ` AND a.ts >= ?`;
      params.push(from);
    }

    if (to) {
      query += ` AND a.ts <= ?`;
      params.push(to);
    }

    if (cursor) {
      const parts = cursor.split('___');
      if (parts.length === 2) {
        query += ` AND (a.ts < ? OR (a.ts = ? AND a.id < ?))`;
        params.push(parts[0], parts[0], parts[1]);
      }
    }

    query += ` ORDER BY a.ts DESC, a.id DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = await env.DB.prepare(query)
      .bind(...params)
      .all<Record<string, unknown>>();

    const items = rows.results || [];
    let next_cursor: string | null = null;
    if (items.length > limit) {
      const lastItem = items[limit - 1];
      next_cursor = `${lastItem.ts}___${lastItem.id}`;
      items.splice(limit);
    }

    // Never interpret meta_json; return as plain string
    const audit_logs = items.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor_user_id: r.actor_user_id || null,
      actor_name: r.actor_name || null,
      actor_email: r.actor_email || null,
      action: r.action,
      target: r.target,
      ip: r.ip || null,
      meta_json: typeof r.meta_json === 'string' ? r.meta_json : JSON.stringify(r.meta_json || null),
    }));

    return json({ audit_logs, next_cursor });
  }

  // ── 9. GET /api/admin/security/failed-logins ────────────────────────────────
  if (path === '/api/admin/security/failed-logins' && method === 'GET') {
    const hoursParam = parseInt(url.searchParams.get('hours') || '24', 10);
    const hours = Math.max(1, Math.min(168, isNaN(hoursParam) ? 24 : hoursParam));

    const now = Date.now();
    const windowCutoff = new Date(now - hours * 3600 * 1000).toISOString();
    const lockoutCutoff = new Date(now - 15 * 60 * 1000).toISOString();

    // Accounts currently locked out (>= 5 failures in last 15 min, excluding pwd: rows)
    const lockedRows = await env.DB.prepare(`
      SELECT email, COUNT(*) AS failure_count, MAX(attempted_at) AS last_attempt_at
      FROM login_attempts
      WHERE success = 0 AND attempted_at >= ? AND email NOT LIKE 'pwd:%'
      GROUP BY email
      HAVING COUNT(*) >= 5
      ORDER BY failure_count DESC, last_attempt_at DESC
    `)
      .bind(lockoutCutoff)
      .all<{ email: string; failure_count: number; last_attempt_at: string }>();

    // Failures by email in time window (excluding pwd: rows)
    const byEmailRows = await env.DB.prepare(`
      SELECT email, COUNT(*) AS failure_count, MAX(attempted_at) AS last_attempt_at, MAX(ip) AS last_ip
      FROM login_attempts
      WHERE success = 0 AND attempted_at >= ? AND email NOT LIKE 'pwd:%'
      GROUP BY email
      ORDER BY failure_count DESC, last_attempt_at DESC
      LIMIT 50
    `)
      .bind(windowCutoff)
      .all<{ email: string; failure_count: number; last_attempt_at: string; last_ip: string }>();

    // Failures by IP in time window (excluding pwd: rows)
    const byIpRows = await env.DB.prepare(`
      SELECT ip, COUNT(*) AS failure_count, MAX(attempted_at) AS last_attempt_at, COUNT(DISTINCT email) AS targeted_emails_count
      FROM login_attempts
      WHERE success = 0 AND attempted_at >= ? AND email NOT LIKE 'pwd:%'
      GROUP BY ip
      ORDER BY failure_count DESC, last_attempt_at DESC
      LIMIT 50
    `)
      .bind(windowCutoff)
      .all<{ ip: string; failure_count: number; last_attempt_at: string; targeted_emails_count: number }>();

    return json({
      hours,
      locked_accounts: lockedRows.results || [],
      by_email: byEmailRows.results || [],
      by_ip: byIpRows.results || [],
    });
  }

  // ── 10. POST /api/admin/claim-legacy-exams (Phase 5a) ──────────────────────
  if (path === '/api/admin/claim-legacy-exams' && method === 'POST') {
    const legacyExams = await env.DB
      .prepare('SELECT id FROM exams WHERE created_by IS NULL')
      .all<{ id: string }>();

    const count = legacyExams.results.length;

    if (count > 0) {
      await env.DB
        .prepare('UPDATE exams SET created_by = ? WHERE created_by IS NULL')
        .bind(admin.id)
        .run();
    }

    await writeAudit(env, {
      actor_user_id: admin.id,
      action: 'admin_claim_legacy_exams',
      target: admin.id,
      ip,
      meta: { claimedCount: count },
    });

    return json({ ok: true, claimedCount: count });
  }

  return err('not_found', 'Not found', 404);
}
