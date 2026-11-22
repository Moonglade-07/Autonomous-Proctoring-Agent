/**
 * worker/utils/auth.ts — Centralized exam ownership and access helper
 * ─────────────────────────────────────────────────────────────────────────────
 * Allowed if:
 *   - user.role === 'admin', OR
 *   - exam.created_by === user.id
 *
 * Legacy exams with created_by NULL are accessible to admins ONLY until claimed.
 * If access is denied, professor routes must return 404 (not 403) to prevent
 * exam enumeration.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { User } from '../auth/types.js';

export function canAccessExam(
  exam: Record<string, unknown> | null | undefined,
  user: User | { id: string; role: string } | null | undefined,
): boolean {
  if (!exam || !user) return false;

  // Admins can access all exams (including legacy unclaimed exams)
  if (user.role === 'admin') {
    return true;
  }

  // Non-admins can only access exams they created
  const createdBy = exam.created_by as string | null | undefined;
  if (!createdBy) {
    // Legacy exams with created_by = NULL are visible to admins ONLY until claimed
    return false;
  }

  return createdBy === user.id;
}
