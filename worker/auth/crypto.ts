/**
 * worker/auth/crypto.ts — Web Crypto PBKDF2-SHA256 password hashing
 * ─────────────────────────────────────────────────────────────────────────────
 * Parameters:
 *   - Algorithm: PBKDF2-SHA256
 *   - Iterations: 100,000 (Cloudflare Workers maximum)
 *   - Salt: 16 cryptographically random bytes (hex encoded)
 *   - Constant-time verification
 *   - Password length constraint: 10 to 128 characters
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { constantTimeCompare } from '../utils/internalAuth.js';

export const PBKDF2_ITERATIONS = 100_000;
export const SALT_BYTES = 16;
export const HASH_KEY_LENGTH = 32; // 256 bits

export function validatePassword(password: unknown): { valid: boolean; error?: string } {
  if (typeof password !== 'string') {
    return { valid: false, error: 'Password must be a string' };
  }
  if (password.length < 10) {
    return { valid: false, error: 'Password must be at least 10 characters long' };
  }
  if (password.length > 128) {
    return { valid: false, error: 'Password must be at most 128 characters long' };
  }
  return { valid: true };
}

function bufToHex(buffer: ArrayBuffer | Uint8Array | ArrayBufferLike): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer as ArrayBuffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export async function hashPassword(
  password: string,
  existingSaltHex?: string,
): Promise<{ hashHex: string; saltHex: string }> {
  const enc = new TextEncoder();
  const salt = existingSaltHex ? hexToBuf(existingSaltHex) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));

  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    HASH_KEY_LENGTH * 8,
  );

  return {
    hashHex: bufToHex(derivedBits),
    saltHex: bufToHex(salt),
  };
}

export async function verifyPassword(
  password: string,
  storedHashHex: string,
  storedSaltHex: string,
): Promise<boolean> {
  if (!password || !storedHashHex || !storedSaltHex) return false;
  try {
    const { hashHex } = await hashPassword(password, storedSaltHex);
    return constantTimeCompare(hashHex, storedHashHex);
  } catch {
    return false;
  }
}

/**
 * Runs a dummy 100,000-iteration PBKDF2 calculation to equalize timing
 * when a login request targets a non-existent email.
 */
export async function dummyHash(): Promise<void> {
  const dummySalt = new Uint8Array(SALT_BYTES);
  const enc = new TextEncoder();
  try {
    const baseKey = await crypto.subtle.importKey(
      'raw',
      enc.encode('__dummy_constant_timing_password__'),
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );
    await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: dummySalt,
        iterations: PBKDF2_ITERATIONS,
        hash: 'SHA-256',
      },
      baseKey,
      HASH_KEY_LENGTH * 8,
    );
  } catch {}
}
