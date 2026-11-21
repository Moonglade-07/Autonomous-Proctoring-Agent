-- ─────────────────────────────────────────────────────────────────────────────
-- 0002_attempts.sql  —  Phase 4b: student attempts & answers
-- ─────────────────────────────────────────────────────────────────────────────
-- Apply locally:  npm run db:migrate:local
-- Apply remotely: npm run db:migrate:remote   (run BEFORE npm run deploy)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Add show_answers column to exams ─────────────────────────────────────────
-- Controls whether students see correct answers after grading.
ALTER TABLE exams ADD COLUMN show_answers INTEGER NOT NULL DEFAULT 0;

-- ── Student attempt records ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS attempts (
  id              TEXT    PRIMARY KEY,
  exam_id         TEXT    NOT NULL REFERENCES exams(id) ON DELETE RESTRICT,
  student_name    TEXT    NOT NULL,
  session_id      TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress','submitted','auto_submitted','terminated')),
  started_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- Server-authoritative deadline: started_at + duration_minutes (plus any pause extensions)
  deadline_at     TEXT    NOT NULL,
  submitted_at    TEXT,
  -- Cumulative seconds the exam has been paused (adds to deadline)
  paused_seconds  INTEGER NOT NULL DEFAULT 0,
  paused_at       TEXT,                       -- ISO timestamp when last pause started; NULL if not paused
  score           REAL,                       -- null until graded
  max_score       REAL    NOT NULL DEFAULT 0,
  grading_status  TEXT    NOT NULL DEFAULT 'pending_manual'
    CHECK (grading_status IN ('auto_graded','pending_manual'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_exam_student
  ON attempts(exam_id, student_name);          -- one attempt per student per exam
CREATE INDEX IF NOT EXISTS idx_attempts_exam_id     ON attempts(exam_id);
CREATE INDEX IF NOT EXISTS idx_attempts_student     ON attempts(student_name);
CREATE INDEX IF NOT EXISTS idx_attempts_status      ON attempts(status);
CREATE INDEX IF NOT EXISTS idx_attempts_session     ON attempts(session_id);

-- ── Per-question student answers ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS answers (
  attempt_id        TEXT    NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id       TEXT    NOT NULL,
  answer_json       TEXT    NOT NULL DEFAULT '""',  -- JSON-encoded answer value
  marked_for_review INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (attempt_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_answers_attempt ON answers(attempt_id);
