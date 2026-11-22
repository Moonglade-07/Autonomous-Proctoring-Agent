-- ── Phase 5c: Dashboards, Privacy Consent, Exam Archiving ─────────────────────

-- 1. users: privacy consent timestamp and password change tracking
ALTER TABLE users ADD COLUMN privacy_accepted_at TEXT;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;

-- 2. exams: archiving support
ALTER TABLE exams ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exams ADD COLUMN archived_at TEXT;

-- 3. Index for filtering active vs archived exams by owner
CREATE INDEX IF NOT EXISTS idx_exams_owner_archived ON exams(created_by, archived);
