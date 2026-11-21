/**
 * worker/utils/joinCode.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 4c-1: Join Code Generator & Normalizer
 *
 * Requirements:
 *   - Alphabet: ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (32 chars; excludes I, O, 0, 1)
 *   - No modulo bias: 256 % 32 == 0
 *   - Length: 8 characters
 *   - Normalization: uppercase, strip spaces and dashes
 *   - Display format: XXXX-XXXX
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const JOIN_CODE_LENGTH = 8;

export function generateJoinCode(): string {
  const bytes = new Uint8Array(JOIN_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    // 32 characters in alphabet -> mask with 31 (0x1f), perfectly uniform
    code += JOIN_CODE_ALPHABET[bytes[i] & 31];
  }
  return code;
}

export function normalizeJoinCode(code?: string | null): string {
  if (!code) return '';
  return code.toUpperCase().replace(/[\s-]/g, '');
}

export function formatJoinCode(code?: string | null): string {
  if (!code) return '—';
  const norm = normalizeJoinCode(code);
  if (!norm) return '—';
  if (norm.length <= 4) return norm;
  return `${norm.slice(0, 4)}-${norm.slice(4, 8)}`;
}
