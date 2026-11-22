/**
 * worker/auth/cookies.ts — HTTP Cookie management for JWT session tokens
 * ─────────────────────────────────────────────────────────────────────────────
 * Cookie:
 *   - Name: auth_token
 *   - HttpOnly: true
 *   - SameSite: Lax
 *   - Path: /
 *   - Secure: true when request is HTTPS
 *   - Max-Age: 28800 (8 hours)
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const AUTH_COOKIE_NAME = 'auth_token';
export const AUTH_COOKIE_MAX_AGE = 28800; // 8 hours in seconds

export function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    if (key) {
      cookies[key] = decodeURIComponent(val);
    }
  }
  return cookies;
}

export function getAuthTokenFromRequest(request: Request): string | null {
  const cookies = parseCookies(request);
  return cookies[AUTH_COOKIE_NAME] || null;
}

export function serializeAuthCookie(token: string, isSecure = false): string {
  const securePart = isSecure ? ' Secure;' : '';
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${AUTH_COOKIE_MAX_AGE};${securePart}`;
}

export function clearAuthCookie(isSecure = false): string {
  const securePart = isSecure ? ' Secure;' : '';
  return `${AUTH_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT;${securePart}`;
}
