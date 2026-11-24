-- ─────────────────────────────────────────────────────────────────────────────
-- 0008_reports.sql  —  Phase 6: Integrity Reports & Human Review Decisions
-- ─────────────────────────────────────────────────────────────────────────────
-- ADD COLUMN and new tables only — no DROP or REBUILD.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. attempts: professor review decisions, notes, and reviewer tracking ───
ALTER TABLE attempts ADD COLUMN review_decision TEXT CHECK (review_decision IS NULL OR review_decision IN ('no_action', 'warning', 'escalate'));
ALTER TABLE attempts ADD COLUMN review_note TEXT;
ALTER TABLE attempts ADD COLUMN reviewed_at TEXT;
ALTER TABLE attempts ADD COLUMN reviewed_by TEXT;

-- ── 2. Index for filtering review queue by decision ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_attempts_review_decision ON attempts(review_decision);

-- ── 3. violation_reviews: annotations/decisions per violation ────────────────
CREATE TABLE IF NOT EXISTS violation_reviews (
  attempt_id    TEXT NOT NULL,
  violation_id  TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('confirmed', 'dismissed')),
  reviewed_by   TEXT NOT NULL,
  reviewed_at   TEXT NOT NULL,
  PRIMARY KEY (attempt_id, violation_id),
  FOREIGN KEY (attempt_id) REFERENCES attempts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_violation_reviews_attempt ON violation_reviews(attempt_id);
