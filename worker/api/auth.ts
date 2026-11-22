/**
 * worker/api/auth.ts — Authentication REST API (Phase 5a)
 * ─────────────────────────────────────────────────────────────────────────────
 * Routes:
 *   POST /api/auth/signup  → Student self-registration (email, name, password, student_id)
 *   POST /api/auth/login   → Login with lockout (5 failures / 15m) & dummy hash timing parity
 *   POST /api/auth/logout  → Clears auth_token cookie
 *   GET  /api/auth/me      → Current session user profile
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from 'zod';
import { hashPassword, verifyPassword, dummyHash } from '../auth/crypto.js';
import { signJwt } from '../auth/jwt.js';
import { serializeAuthCookie, clearAuthCookie } from '../auth/cookies.js';
import { requireAuth, isAuthResponse } from '../auth/requireAuth.js';
import { writeAudit } from '../utils/audit.js';
import type { User, SafeUser } from '../auth/types.js';

function json<T>(data: T, status = 200, headers?: HeadersInit): Response {
  const mergedHeaders = new Headers(headers);
  mergedHeaders.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), {
    status,
    headers: mergedHeaders,
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

export interface AuthEnv {
  DB: D1Database;
  JWT_SECRET?: string;
  ALLOW_STUDENT_SIGNUP?: string | boolean;
}

const SignupSchema = z.object({
  email: z.string().trim().email('Invalid email address').max(255),
  name: z.string().trim().min(1, 'Name is required').max(100),
  password: z.string().min(10, 'Password must be at least 10 characters').max(128),
  student_id: z.string().trim().max(50).optional().nullable(),
});

const LoginSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
  password: z.string().min(1, 'Password is required').max(128),
});

export async function handleAuthApi(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';
  const isSecure = url.protocol === 'https:';

  // ── 1. POST /api/auth/signup (Students Only) ──────────────────────────────
  if (path === '/api/auth/signup' && method === 'POST') {
    // Check if student signup is allowed
    const allowSignup = env.ALLOW_STUDENT_SIGNUP !== 'false' && env.ALLOW_STUDENT_SIGNUP !== false;
    if (!allowSignup) {
      await writeAudit(env, {
        action: 'signup_disabled_rejected',
        target: path,
        ip,
      });
      return err('signup_disabled', 'Student registration is currently disabled', 403);
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('invalid_json', 'Invalid JSON body', 400);
    }

    const parsed = SignupSchema.safeParse(body);
    if (!parsed.success) {
      return err('validation_error', parsed.error.issues[0]?.message || 'Validation failed', 400);
    }

    // Role cannot be supplied by the user (always student)
    const email = parsed.data.email.toLowerCase();
    const name = parsed.data.name;
    const password = parsed.data.password;
    const studentId = parsed.data.student_id ? parsed.data.student_id.trim() : null;

    // Check if email already exists
    const existing = await env.DB
      .prepare('SELECT id FROM users WHERE email = ?')
      .bind(email)
      .first<{ id: string }>();

    if (existing) {
      return err('email_in_use', 'An account with this email already exists', 400);
    }

    const { hashHex, saltHex } = await hashPassword(password);
    const userId = `usr-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    await env.DB
      .prepare(
        `INSERT INTO users (id, email, name, role, password_hash, password_salt, student_id, department, active, token_version, created_at, last_login_at)
         VALUES (?, ?, ?, 'student', ?, ?, ?, NULL, 1, 0, ?, ?)`,
      )
      .bind(userId, email, name, hashHex, saltHex, studentId, now, now)
      .run();

    // Sign session token
    const token = await signJwt({ sub: userId, role: 'student', tv: 0 }, env.JWT_SECRET);
    if (!token) {
      return err('server_misconfigured', 'Authentication token generation failed', 500);
    }

    await writeAudit(env, {
      actor_user_id: userId,
      action: 'signup',
      target: email,
      ip,
    });

    const safeUser: SafeUser = {
      id: userId,
      email,
      name,
      role: 'student',
      student_id: studentId,
      department: null,
      privacy_accepted: false,
      privacy_accepted_at: null,
    };

    const cookieHeader = serializeAuthCookie(token, isSecure);
    return json({ user: safeUser }, 201, { 'Set-Cookie': cookieHeader });
  }

  // ── 2. POST /api/auth/login ───────────────────────────────────────────────
  if (path === '/api/auth/login' && method === 'POST') {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('invalid_json', 'Invalid JSON body', 400);
    }

    const parsed = LoginSchema.safeParse(body);
    if (!parsed.success) {
      return err('validation_error', 'Invalid email or password format', 400);
    }

    const email = parsed.data.email.toLowerCase();
    const password = parsed.data.password;

    // 1. Loose IP throttle: 50 failed logins per 15 minutes per IP (prevents network-wide brute-forcing)
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const ipFailStats = await env.DB
      .prepare(
        `SELECT COUNT(*) as fail_count
         FROM login_attempts
         WHERE ip = ? AND success = 0 AND attempted_at > ? AND email NOT LIKE 'pwd:%'`,
      )
      .bind(ip, fifteenMinAgo)
      .first<{ fail_count: number }>();

    if ((ipFailStats?.fail_count ?? 0) >= 50) {
      await writeAudit(env, {
        action: 'ip_throttle',
        target: ip,
        ip,
        meta: { reason: 'ip_rate_limit_exceeded', count: ipFailStats?.fail_count },
      });
      return err(
        'too_many_requests',
        'Too many failed login attempts from this network. Please try again later.',
        429,
      );
    }

    // 2. Strict per-account lockout: 5 failed attempts per EMAIL in 15 minutes (per-account protection)
    const failStats = await env.DB
      .prepare(
        `SELECT COUNT(*) as fail_count
         FROM login_attempts
         WHERE email = ? AND success = 0 AND attempted_at > ? AND email NOT LIKE 'pwd:%'`,
      )
      .bind(email, fifteenMinAgo)
      .first<{ fail_count: number }>();

    if ((failStats?.fail_count ?? 0) >= 5) {
      await writeAudit(env, {
        action: 'lockout',
        target: email,
        ip,
        meta: { reason: 'account_locked_out', count: failStats?.fail_count },
      });
      return err(
        'too_many_requests',
        'Too many failed login attempts for this account. Please try again later.',
        429,
      );
    }

    const user = await env.DB
      .prepare('SELECT * FROM users WHERE email = ?')
      .bind(email)
      .first<User>();

    const attemptId = `la-${crypto.randomUUID()}`;
    const attemptTime = new Date().toISOString();

    if (!user) {
      // Run dummy PBKDF2 hash to match timing of existing user verification
      await dummyHash();

      await env.DB
        .prepare('INSERT INTO login_attempts (id, email, ip, attempted_at, success) VALUES (?, ?, ?, ?, 0)')
        .bind(attemptId, email, ip, attemptTime)
        .run();

      await writeAudit(env, {
        action: 'login_failure',
        target: email,
        ip,
        meta: { reason: 'user_not_found' },
      });

      return err('unauthorized', 'Invalid email or password', 401);
    }

    if (user.active !== 1) {
      await env.DB
        .prepare('INSERT INTO login_attempts (id, email, ip, attempted_at, success) VALUES (?, ?, ?, ?, 0)')
        .bind(attemptId, email, ip, attemptTime)
        .run();

      await writeAudit(env, {
        actor_user_id: user.id,
        action: 'login_failure',
        target: email,
        ip,
        meta: { reason: 'account_inactive' },
      });

      return err('unauthorized', 'Invalid email or password', 401);
    }

    const passwordMatches = await verifyPassword(password, user.password_hash, user.password_salt);
    if (!passwordMatches) {
      await env.DB
        .prepare('INSERT INTO login_attempts (id, email, ip, attempted_at, success) VALUES (?, ?, ?, ?, 0)')
        .bind(attemptId, email, ip, attemptTime)
        .run();

      await writeAudit(env, {
        actor_user_id: user.id,
        action: 'login_failure',
        target: email,
        ip,
        meta: { reason: 'wrong_password' },
      });

      return err('unauthorized', 'Invalid email or password', 401);
    }

    // Success
    await env.DB
      .prepare('INSERT INTO login_attempts (id, email, ip, attempted_at, success) VALUES (?, ?, ?, ?, 1)')
      .bind(attemptId, email, ip, attemptTime)
      .run();

    await env.DB
      .prepare('UPDATE users SET last_login_at = ? WHERE id = ?')
      .bind(attemptTime, user.id)
      .run();

    const token = await signJwt(
      { sub: user.id, role: user.role, tv: user.token_version },
      env.JWT_SECRET,
    );

    if (!token) {
      return err('server_misconfigured', 'Authentication token generation failed', 500);
    }

    await writeAudit(env, {
      actor_user_id: user.id,
      action: 'login_success',
      target: email,
      ip,
    });

    const safeUser: SafeUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      student_id: user.student_id,
      department: user.department,
      privacy_accepted: !!user.privacy_accepted_at,
      privacy_accepted_at: user.privacy_accepted_at ?? null,
    };

    const cookieHeader = serializeAuthCookie(token, isSecure);
    return json({ user: safeUser }, 200, { 'Set-Cookie': cookieHeader });
  }

  // ── 3. POST /api/auth/logout ──────────────────────────────────────────────
  if (path === '/api/auth/logout' && method === 'POST') {
    const auth = await requireAuth(request, env);
    const actorId = !isAuthResponse(auth) ? auth.user.id : null;
    const actorEmail = !isAuthResponse(auth) ? auth.user.email : '-';

    await writeAudit(env, {
      actor_user_id: actorId,
      action: 'logout',
      target: actorEmail,
      ip,
    });

    const cookieHeader = clearAuthCookie(isSecure);
    return json({ ok: true }, 200, { 'Set-Cookie': cookieHeader });
  }

  // ── 4. GET /api/auth/me ───────────────────────────────────────────────────
  if (path === '/api/auth/me' && method === 'GET') {
    const auth = await requireAuth(request, env);
    if (isAuthResponse(auth)) {
      return auth;
    }

    const { user } = auth;
    const userRow = await env.DB
      .prepare('SELECT privacy_accepted_at FROM users WHERE id = ?')
      .bind(user.id)
      .first<{ privacy_accepted_at: string | null }>();

    const safeUser: SafeUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      student_id: user.student_id,
      department: user.department,
      privacy_accepted: !!userRow?.privacy_accepted_at,
      privacy_accepted_at: userRow?.privacy_accepted_at ?? null,
    };

    return json({ user: safeUser });
  }

  // ── 5. POST /api/auth/change-password ─────────────────────────────────────
  if (path === '/api/auth/change-password' && method === 'POST') {
    const auth = await requireAuth(request, env);
    if (isAuthResponse(auth)) {
      return auth;
    }
    const user = auth.user;

    // Rate limit: 5 wrong currentPassword attempts in 15 minutes per user returns 429
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const failStats = await env.DB
      .prepare(
        `SELECT COUNT(*) as fail_count
         FROM login_attempts
         WHERE email = ? AND success = 0 AND attempted_at > ?`,
      )
      .bind(`pwd:${user.id}`, fifteenMinAgo)
      .first<{ fail_count: number }>();

    if ((failStats?.fail_count ?? 0) >= 5) {
      await writeAudit(env, {
        actor_user_id: user.id,
        action: 'change_password_rate_limit',
        target: user.id,
        ip,
        meta: { reason: 'too_many_password_change_failures' },
      });
      return err(
        'too_many_requests',
        'Too many failed attempts. Please try again later.',
        429,
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return err('invalid_request', 'Invalid current password or new password does not meet requirements', 400);
    }

    const { currentPassword, newPassword } = (body as Record<string, unknown>) || {};

    const userRow = await env.DB
      .prepare('SELECT * FROM users WHERE id = ?')
      .bind(user.id)
      .first<User>();

    if (!userRow) {
      return err('unauthorized', 'User not found', 401);
    }

    // Verify current password with constant-time PBKDF2 check
    const currentMatches =
      typeof currentPassword === 'string' &&
      (await verifyPassword(currentPassword, userRow.password_hash, userRow.password_salt));

    if (!currentMatches) {
      const attemptId = `la-${crypto.randomUUID()}`;
      await env.DB
        .prepare('INSERT INTO login_attempts (id, email, ip, attempted_at, success) VALUES (?, ?, ?, ?, 0)')
        .bind(attemptId, `pwd:${user.id}`, '-', new Date().toISOString())
        .run();

      await writeAudit(env, {
        actor_user_id: user.id,
        action: 'change_password_failure',
        target: user.id,
        ip,
        meta: { reason: 'wrong_current_password' },
      });

      return err('invalid_request', 'Invalid current password or new password does not meet requirements', 400);
    }

    // Validate newPassword: 10 to 128 characters
    if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) {
      return err('invalid_request', 'Invalid current password or new password does not meet requirements', 400);
    }

    // Fresh salt and hash with PBKDF2
    const { hashHex, saltHex } = await hashPassword(newPassword);
    const newTokenVersion = (userRow.token_version ?? 0) + 1;
    const nowIso = new Date().toISOString();

    await env.DB
      .prepare(
        `UPDATE users
         SET password_hash = ?, password_salt = ?, token_version = ?, password_changed_at = ?
         WHERE id = ?`,
      )
      .bind(hashHex, saltHex, newTokenVersion, nowIso, user.id)
      .run();

    // Re-issue auth cookie for current session with new token_version
    const newToken = await signJwt(
      { sub: user.id, role: user.role, tv: newTokenVersion },
      env.JWT_SECRET,
    );
    const cookieHeader = serializeAuthCookie(newToken!, isSecure);

    // Record success in rate limit table
    await env.DB
      .prepare('INSERT INTO login_attempts (id, email, ip, attempted_at, success) VALUES (?, ?, ?, ?, 1)')
      .bind(`la-${crypto.randomUUID()}`, `pwchange:${user.id}`, ip, nowIso)
      .run();

    await writeAudit(env, {
      actor_user_id: user.id,
      action: 'change_password',
      target: user.id,
      ip,
    });

    return json({ ok: true, message: 'Password changed successfully' }, 200, { 'Set-Cookie': cookieHeader });
  }

  return err('not_found', 'Not found', 404);
}
