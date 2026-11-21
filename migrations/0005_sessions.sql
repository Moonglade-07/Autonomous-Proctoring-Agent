-- ─────────────────────────────────────────────────────────────────────────────
-- 0005_sessions.sql  —  Phase 4c-2b: Session Lifecycle, Retention & Audit Log
-- ─────────────────────────────────────────────────────────────────────────────
-- ADD COLUMN only — no DROP or REBUILD.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. attempts: lifecycle, telemetry sync, hold & purge columns ─────────────
ALTER TABLE attempts ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN archived_at TEXT;
ALTER TABLE attempts ADD COLUMN evidence_hold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN violation_count INTEGER;
ALTER TABLE attempts ADD COLUMN max_severity TEXT;
ALTER TABLE attempts ADD COLUMN final_risk_score REAL;
ALTER TABLE attempts ADD COLUMN last_violation_at TEXT;
ALTER TABLE attempts ADD COLUMN ended_reason TEXT CHECK (ended_reason IN ('submitted', 'auto_submitted', 'terminated'));
ALTER TABLE attempts ADD COLUMN data_purged_at TEXT;

-- ── 2. exams: retention policy in days (0 = keep forever) ───────────────────
ALTER TABLE exams ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 90;

-- ── 3. audit_log: persistent audit trail ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  actor_user_id  TEXT,
  action         TEXT NOT NULL,
  target         TEXT NOT NULL,
  ip             TEXT,
  meta_json      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);

-- ── 4. Performance Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_attempts_exam_archived_test ON attempts(exam_id, archived, is_test);
CREATE INDEX IF NOT EXISTS idx_attempts_status_submitted ON attempts(status, submitted_at);

-- ── 5. Backfill: ended_reason from status for existing finished attempts ─────
UPDATE attempts
SET ended_reason = status
WHERE status IN ('submitted', 'auto_submitted', 'terminated');

