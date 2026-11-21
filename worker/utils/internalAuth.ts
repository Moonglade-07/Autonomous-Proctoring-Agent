/**
 * worker/utils/internalAuth.ts
 *
 * Defense-in-depth authentication for internal Durable Object handlers.
 * Ensures only Worker code with the matching INTERNAL_SECRET can invoke internal endpoints.
 */

/**
 * Constant-time comparison of two strings to prevent timing attacks.
 * Never logs or reveals the secret.
 */
export function constantTimeCompare(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) {
    return false;
  }
  const aLen = a.length;
  const bLen = b.length;
  let diff = aLen ^ bLen;
  const maxLen = Math.max(aLen, bLen);
  for (let i = 0; i < maxLen; i++) {
    const charA = i < aLen ? a.charCodeAt(i) : 0;
    const charB = i < bLen ? b.charCodeAt(i) : 0;
    diff |= charA ^ charB;
  }
  return diff === 0;
}

/**
 * Verifies that the incoming request carries the X-Internal-Auth header matching INTERNAL_SECRET.
 * If INTERNAL_SECRET is missing or the header doesn't match, returns false.
 */
export function verifyInternalAuth(request: Request, env: { INTERNAL_SECRET?: string }): boolean {
  const secret = env?.INTERNAL_SECRET;
  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    return false;
  }
  const authHeader = request.headers.get('X-Internal-Auth');
  return constantTimeCompare(authHeader, secret);
}

/**
 * Standard 403 Forbidden response for unauthorized internal calls.
 */
export function forbiddenResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'forbidden',
        message: 'Forbidden',
      },
    }),
    {
      status: 403,
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );
}

/**
 * Standard 404 Not Found response in required JSON format.
 */
export function jsonNotFound(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'not_found',
        message: 'Not found',
      },
    }),
    {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    },
  );
}

