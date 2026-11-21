/**
 * worker/utils/auth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralized authorization access helper for exams.
 * In Phase 4c-1, returns true if exam exists.
 * Phase 5 will add user identity and ownership checks in this single function.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export function canAccessExam(
  exam: Record<string, unknown> | null | undefined,
  _professorKey?: string | null,
): boolean {
  if (!exam) return false;
  // In Phase 5, this will check: exam.professor_id === professor.id
  return true;
}

