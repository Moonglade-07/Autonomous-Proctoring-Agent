-- ─────────────────────────────────────────────────────────────────────────────
-- 0004_grading.sql  —  Phase 4c-2a: Manual Grading, Results Release, Auto-End
-- ─────────────────────────────────────────────────────────────────────────────
-- ALTER TABLE only — no DROP/REBUILD. D1 can cascade-delete child rows on DROP.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. answers: grading columns ──────────────────────────────────────────────
ALTER TABLE answers ADD COLUMN awarded_points REAL;
ALTER TABLE answers ADD COLUMN auto_points REAL;
ALTER TABLE answers ADD COLUMN grading_source TEXT CHECK (grading_source IN ('auto', 'manual', 'override'));
ALTER TABLE answers ADD COLUMN grader_comment TEXT;
ALTER TABLE answers ADD COLUMN graded_at TEXT;

-- ── 2. attempts: grading columns ─────────────────────────────────────────────
ALTER TABLE attempts ADD COLUMN fully_graded INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN graded_at TEXT;

-- ── 3. exams: results release + instant_results ──────────────────────────────
ALTER TABLE exams ADD COLUMN results_released INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exams ADD COLUMN results_released_at TEXT;
ALTER TABLE exams ADD COLUMN instant_results INTEGER NOT NULL DEFAULT 0;

-- ── 4. questions: rubric for professor grading notes ─────────────────────────
ALTER TABLE questions ADD COLUMN rubric TEXT;

-- ── 5. grading_rate_limits table for AI suggest-grade rate limiting ───────────
CREATE TABLE IF NOT EXISTS grading_rate_limits (
  id          TEXT PRIMARY KEY,
  exam_id     TEXT NOT NULL,
  called_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_grl_exam_time ON grading_rate_limits(exam_id, called_at);

-- ── 6. Backfill: fully_graded = 1 for auto_graded submitted attempts ──────────
UPDATE attempts
SET fully_graded = 1
WHERE status IN ('submitted', 'auto_submitted', 'terminated')
  AND grading_status = 'auto_graded';

