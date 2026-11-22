-- ─────────────────────────────────────────────────────────────────────────────
-- 0006_auth.sql  —  Phase 5a: Authentication, Roles & Exam Ownership
-- ─────────────────────────────────────────────────────────────────────────────
-- Apply locally:  npm run db:migrate:local
-- Apply remotely: npm run db:migrate:remote
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. users: Accounts for students, professors, and admins ───────────────────
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,       -- stored lowercase
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('student', 'professor', 'admin')),
  password_hash   TEXT NOT NULL,
  password_salt   TEXT NOT NULL,
  student_id      TEXT,                       -- optional student ID number
  department      TEXT,                       -- optional department for professors/admins
  active          INTEGER NOT NULL DEFAULT 1, -- 1 = active, 0 = deactivated
  token_version   INTEGER NOT NULL DEFAULT 0, -- incremented on password change / deactivation
  created_at      TEXT NOT NULL,              -- ISO-8601 UTC
  last_login_at   TEXT                        -- ISO-8601 UTC
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ── 2. login_attempts: Rate limiting & brute force lockout ───────────────────
CREATE TABLE IF NOT EXISTS login_attempts (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL,              -- stored lowercase
  ip              TEXT NOT NULL,
  attempted_at    TEXT NOT NULL,              -- ISO-8601 UTC
  success         INTEGER NOT NULL DEFAULT 0  -- 1 = success, 0 = failure
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time ON login_attempts(email, attempted_at);

-- ── 3. audit_log: Ensure table exists (Phase 4c-2b schema) ─────────────────────
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

-- ── 4. exams: Ownership column (created_by) ──────────────────────────────────
-- NULL = legacy exams (visible to admins only until claimed)
ALTER TABLE exams ADD COLUMN created_by TEXT;
CREATE INDEX IF NOT EXISTS idx_exams_created_by ON exams(created_by);

-- ── 5. attempts: User binding & partial unique index ─────────────────────────
ALTER TABLE attempts ADD COLUMN user_id TEXT;

-- Drop legacy unique index on (exam_id, student_name) to allow same-named students
DROP INDEX IF EXISTS idx_attempts_exam_student;

-- Partial unique index: one non-test attempt per student account per exam
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_exam_user
  ON attempts(exam_id, user_id)
  WHERE is_test = 0 AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attempts_user_id ON attempts(user_id);

-- ── 6. exam_enrollments: Rebuild leaf table for user_id support ───────────────
CREATE TABLE IF NOT EXISTS exam_enrollments_v2 (
  id                  TEXT PRIMARY KEY,
  exam_id             TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  user_id             TEXT,
  legacy_student_name TEXT,
  joined_at           TEXT NOT NULL
);

-- Copy existing legacy enrollments
INSERT INTO exam_enrollments_v2 (id, exam_id, user_id, legacy_student_name, joined_at)
SELECT
  ('enr-legacy-' || hex(randomblob(8))),
  exam_id,
  NULL,
  student_name,
  joined_at
FROM exam_enrollments;

-- Drop old table and rename
DROP TABLE exam_enrollments;
ALTER TABLE exam_enrollments_v2 RENAME TO exam_enrollments;

-- Indexes for rebuilt enrollments table
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollments_exam_user
  ON exam_enrollments(exam_id, user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_enrollments_exam ON exam_enrollments(exam_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_user ON exam_enrollments(user_id);
