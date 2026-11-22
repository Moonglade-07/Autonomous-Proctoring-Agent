/**
 * worker/auth/requireAuth.ts — Authentication and Role Authorization Guard
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates JWT from HttpOnly cookie.
 * On every request, loads user from D1 and validates active = 1 and token_version.
 * All route protection goes through requireAuth.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getAuthTokenFromRequest } from './cookies.js';
import { verifyJwt } from './jwt.js';
import type { User, UserRole } from './types.js';
import { writeAudit } from '../utils/audit.js';

export function jsonAuthError(code: 'unauthorized' | 'forbidden', message: string, status: 401 | 403): Response {
  return new Response(
    JSON.stringify({
      error: { code, message },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

export type AuthResult = { user: User } | Response;

export function isAuthResponse(result: AuthResult): result is Response {
  return result instanceof Response;
}

export async function requireAuth(
  request: Request,
  env: { DB?: D1Database; JWT_SECRET?: string },
  allowedRoles?: UserRole[],
): Promise<AuthResult> {
  const token = getAuthTokenFromRequest(request);
  if (!token) {
    return jsonAuthError('unauthorized', 'Authentication required', 401);
  }

  const payload = await verifyJwt(token, env.JWT_SECRET);
  if (!payload) {
    return jsonAuthError('unauthorized', 'Invalid or expired session', 401);
  }

  if (!env.DB) {
    return jsonAuthError('unauthorized', 'Authentication service unavailable', 401);
  }

  // Load user from D1 on every authenticated request to guarantee immediate deactivation / revocation
  const user = await env.DB
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(payload.sub)
    .first<User>();

  if (!user || user.active !== 1 || user.token_version !== payload.tv) {
    return jsonAuthError('unauthorized', 'Session invalid or revoked', 401);
  }

  // Role authorization check
  if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
    const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';
    const route = new URL(request.url).pathname;
    await writeAudit(env, {
      actor_user_id: user.id,
      action: 'role_forbidden',
      target: route,
      ip,
      meta: { requiredRoles: allowedRoles, actualRole: user.role },
    });
    return jsonAuthError('forbidden', 'Forbidden: insufficient permissions', 403);
  }

  return { user };
}
