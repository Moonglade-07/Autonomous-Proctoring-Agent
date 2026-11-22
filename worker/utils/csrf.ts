/**
 * worker/utils/csrf.ts — CSRF & Cross-Site WebSocket Protection
 * ─────────────────────────────────────────────────────────────────────────────
 * For every non-GET request and every WebSocket upgrade, requires the Origin
 * header to match the request host, otherwise returns 403 and writes an audit row.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeAudit } from './audit.js';

export async function verifyOrigin(
  request: Request,
  env: { DB?: D1Database },
): Promise<Response | null> {
  const method = request.method.toUpperCase();
  const isWs = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
  const isMutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

  if (!isMutating && !isWs) {
    return null;
  }

  const origin = request.headers.get('Origin');
  const requestUrl = new URL(request.url);
  const host = request.headers.get('Host') || requestUrl.host;

  if (!origin) {
    const route = requestUrl.pathname;
    await writeAudit(env, {
      action: 'csrf_origin_rejected',
      target: route,
      ip: request.headers.get('cf-connecting-ip') || '127.0.0.1',
      meta: { reason: 'missing_origin', method },
    });
    return new Response(
      JSON.stringify({
        error: { code: 'forbidden', message: 'Forbidden: Origin header required' },
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = '';
  }

  if (!originHost || originHost.toLowerCase() !== host.toLowerCase()) {
    const route = requestUrl.pathname;
    await writeAudit(env, {
      action: 'csrf_origin_rejected',
      target: route,
      ip: request.headers.get('cf-connecting-ip') || '127.0.0.1',
      meta: { originHost, host, method },
    });
    return new Response(
      JSON.stringify({
        error: { code: 'forbidden', message: 'Forbidden: Origin mismatch' },
      }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  return null;
}
