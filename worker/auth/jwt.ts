/**
 * worker/auth/jwt.ts — HS256 JWT sign & verify using Web Crypto
 * ─────────────────────────────────────────────────────────────────────────────
 * Fails closed if JWT_SECRET is unset, empty, or whitespace-only.
 * Strictly verifies alg = HS256. Rejects "none", bad signatures, and expired tokens.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { JwtPayload, UserRole } from './types.js';

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array | null {
  try {
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function strToBase64Url(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str));
}

function base64UrlToStr(str: string): string | null {
  const bytes = base64UrlDecode(str);
  if (!bytes) return null;
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function getHmacKey(secret: string): Promise<CryptoKey | null> {
  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    return null;
  }
  try {
    return await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  } catch {
    return null;
  }
}

export async function signJwt(
  claims: { sub: string; role: UserRole; tv: number },
  secret: string | undefined | null,
  expiresInSeconds = 28800, // 8 hours
): Promise<string | null> {
  if (!secret) return null;
  const key = await getHmacKey(secret);
  if (!key) return null;

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: JwtPayload = {
    sub: claims.sub,
    role: claims.role,
    tv: claims.tv,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = strToBase64Url(JSON.stringify(header));
  const encodedPayload = strToBase64Url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const sigBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput),
  );
  const encodedSig = base64UrlEncode(new Uint8Array(sigBuffer));

  return `${signingInput}.${encodedSig}`;
}

export async function verifyJwt(
  token: string | null | undefined,
  secret: string | undefined | null,
): Promise<JwtPayload | null> {
  // Fail closed if secret is missing/empty
  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    return null;
  }
  if (!token || typeof token !== 'string') {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, encodedSig] = parts;

  // 1. Validate header
  const headerStr = base64UrlToStr(encodedHeader);
  if (!headerStr) return null;
  try {
    const header = JSON.parse(headerStr);
    // Explicitly reject "none" and any other non-HS256 algorithm
    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      return null;
    }
  } catch {
    return null;
  }

  // 2. Validate signature via HMAC
  const key = await getHmacKey(secret);
  if (!key) return null;

  const sigBytes = base64UrlDecode(encodedSig);
  if (!sigBytes) return null;

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes as BufferSource,
    new TextEncoder().encode(signingInput),
  );
  if (!valid) {
    return null;
  }

  // 3. Parse and validate payload
  const payloadStr = base64UrlToStr(encodedPayload);
  if (!payloadStr) return null;
  try {
    const payload = JSON.parse(payloadStr) as JwtPayload;
    if (!payload.sub || !payload.role || typeof payload.tv !== 'number' || typeof payload.exp !== 'number') {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}
