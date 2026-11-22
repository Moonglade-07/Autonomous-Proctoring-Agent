/**
 * worker/api/admin.ts — Admin Management REST API (Phase 5a)
 * ─────────────────────────────────────────────────────────────────────────────
 * Routes (admin only):
 *   POST /api/admin/users                → Create professor or admin accounts
 *   POST /api/admin/users/:id/deactivate → Deactivate account & increment token_version
 *   POST /api/admin/claim-legacy-exams   → Claim all legacy exams with created_by NULL
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

const CreateStaffSchema = z.object({
  email: z.string().trim().email('Invalid email address').max(255),
  name: z.string().trim().min(1, 'Name is required').max(100),
  password: z.string().min(10, 'Password must be at least 10 characters').max(128),
  role: z.enum(['professor', 'admin']),
  department: z.string().trim().max(100).optional().nullable(),
});

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

  // ── 1. POST /api/admin/users (Create Professor or Admin) ───────────────────
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
      action: 'admin_create_user',
      target: userId,
      ip,
      meta: { email, role: parsed.data.role },
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

  // ── 2. POST /api/admin/users/:id/deactivate ────────────────────────
  const deactivateMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/deactivate$/);
  if (deactivateMatch && method === 'POST') {
    const targetUserId = deactivateMatch[1];

    const targetUser = await env.DB
      .prepare('SELECT id, email FROM users WHERE id = ?')
      .bind(targetUserId)
      .first<{ id: string; email: string }>();

    if (!targetUser) {
      return err('not_found', 'User not found', 404);
    }

    // Deactivate and immediately invalidate all existing tokens by incrementing token_version
    await env.DB
      .prepare('UPDATE users SET active = 0, token_version = token_version + 1 WHERE id = ?')
      .bind(targetUserId)
      .run();

    await writeAudit(env, {
      actor_user_id: admin.id,
      action: 'admin_deactivate_user',
      target: targetUserId,
      ip,
      meta: { email: targetUser.email },
    });

    return json({ ok: true, active: 0 });
  }

  // ── 3. POST /api/admin/claim-legacy-exams (Idempotent) ─────────────────────
  if (path === '/api/admin/claim-legacy-exams' && method === 'POST') {
    // Find all legacy exams where created_by IS NULL
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
