/**
 * worker/utils/reviewLevel.ts — Pure Review Level Evaluation
 * ─────────────────────────────────────────────────────────────────────────────
 * Computes an objective integrity review level based on session telemetry.
 *
 * Rules:
 *   • violationCount NULL / undefined -> 'unknown' (legacy sessions / not recorded)
 *   • 'high'   if finalRiskScore >= maxRiskScore, or maxSeverity is 'critical',
 *                 or identity mismatch or multiple faces occurred.
 *   • 'medium' if maxSeverity is 'high', or violationCount >= 3.
 *   • 'low'    if violationCount >= 1.
 *   • 'none'   otherwise.
 *
 * NOTE: The review level is a prompt for human review, never an automated verdict.
 * Evaluators must never use words like "cheating" or "guilty".
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type ReviewLevel = 'unknown' | 'none' | 'low' | 'medium' | 'high';

export interface ReviewLevelInput {
  finalRiskScore?: number | null;
  maxSeverity?: string | null;
  violationCount?: number | null;
  maxRiskScore: number;
  hasIdentityMismatch?: boolean | null;
  hasMultipleFaces?: boolean | null;
}

/**
 * Computes the review level according to strict Phase 6 rules.
 *
 * @param input - Telemetry metrics and threshold parameters.
 * @returns 'unknown' | 'none' | 'low' | 'medium' | 'high'
 */
export function computeReviewLevel(input: ReviewLevelInput): ReviewLevel {
  const {
    finalRiskScore,
    maxSeverity,
    violationCount,
    maxRiskScore,
    hasIdentityMismatch,
    hasMultipleFaces,
  } = input;

  // 1. Legacy or missing telemetry
  if (violationCount === null || violationCount === undefined) {
    return 'unknown';
  }

  // 2. High severity triggers
  const scoreHigh = finalRiskScore !== null && finalRiskScore !== undefined && finalRiskScore >= maxRiskScore;
  const severityCritical = maxSeverity === 'critical';
  const mismatch = hasIdentityMismatch === true;
  const multiFaces = hasMultipleFaces === true;

  if (scoreHigh || severityCritical || mismatch || multiFaces) {
    return 'high';
  }

  // 3. Medium severity triggers
  const severityHigh = maxSeverity === 'high';
  const countMedium = (violationCount ?? 0) >= 3;

  if (severityHigh || countMedium) {
    return 'medium';
  }

  // 4. Low severity triggers
  if ((violationCount ?? 0) >= 1) {
    return 'low';
  }

  // 5. Clean attempt
  return 'none';
}

/**
 * Explains why an attempt received its assigned review level in human-readable terms.
 * Used in the UI as the "Why flagged" breakdown.
 *
 * @param input - The same telemetry metrics passed to computeReviewLevel.
 * @returns Array of readable reason strings.
 */
export function getReviewReasons(input: ReviewLevelInput): string[] {
  const {
    finalRiskScore,
    maxSeverity,
    violationCount,
    maxRiskScore,
    hasIdentityMismatch,
    hasMultipleFaces,
  } = input;

  if (violationCount === null || violationCount === undefined) {
    return ['Violation count not recorded (legacy session data).'];
  }

  const reasons: string[] = [];

  if (finalRiskScore !== null && finalRiskScore !== undefined && finalRiskScore >= maxRiskScore) {
    reasons.push(`Final risk score (${finalRiskScore}) reached or exceeded threshold (${maxRiskScore}).`);
  }
  if (maxSeverity === 'critical') {
    reasons.push('Critical severity violation detected.');
  }
  if (hasIdentityMismatch === true) {
    reasons.push('Identity mismatch flagged during session.');
  }
  if (hasMultipleFaces === true) {
    reasons.push('Multiple faces detected during session.');
  }

  if (reasons.length > 0) {
    return reasons;
  }

  if (maxSeverity === 'high') {
    reasons.push('High severity violation detected.');
  }
  if ((violationCount ?? 0) >= 3) {
    reasons.push(`Violation count (${violationCount}) reached threshold (>= 3).`);
  }

  if (reasons.length > 0) {
    return reasons;
  }

  if ((violationCount ?? 0) >= 1) {
    reasons.push(`${violationCount} minor violation(s) recorded.`);
    return reasons;
  }

  return ['No violations or risk threshold breaches recorded.'];
}

/**
 * Numeric priority ranking for sorting review queue attempts (highest urgency first).
 */
export function reviewLevelRank(level: ReviewLevel): number {
  switch (level) {
    case 'high':
      return 4;
    case 'medium':
      return 3;
    case 'low':
      return 2;
    case 'none':
      return 1;
    case 'unknown':
      return 0;
  }
}

/**
 * Human-readable label for a review level.
 */
export function reviewLevelLabel(level: ReviewLevel): string {
  switch (level) {
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    case 'low':
      return 'Low';
    case 'none':
      return 'None';
    case 'unknown':
      return 'Not recorded';
  }
}
