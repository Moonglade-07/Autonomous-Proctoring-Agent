-- ─────────────────────────────────────────────────────────────────────────────
-- 0009_admin.sql  —  Phase 7: Admin Panel, Cron Tracking & Append-Only Audit Log
-- ─────────────────────────────────────────────────────────────────────────────
-- ADD COLUMN, new tables, indexes and triggers only — no DROP or REBUILD.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. cron_runs: track health and status of scheduled jobs ─────────────────
CREATE TABLE IF NOT EXISTS cron_runs (
  job         TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_ok     INTEGER,
  last_count  INTEGER,
  last_error  TEXT
);

-- ── 2. Indexes for fast user filtering and audit log searching ───────────────
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role, active);
CREATE INDEX IF NOT EXISTS idx_audit_log_action_ts ON audit_log(action, ts);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor_ts ON audit_log(actor_user_id, ts);

-- ── 3. Append-only enforcement for audit_log ─────────────────────────────────
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
