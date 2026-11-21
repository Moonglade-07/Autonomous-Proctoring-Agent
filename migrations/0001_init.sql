-- ─────────────────────────────────────────────────────────────────────────────
-- 0001_init.sql  —  Autonomous Proctoring Agent · Phase 4a initial schema
-- ─────────────────────────────────────────────────────────────────────────────
-- Apply locally:  npm run db:migrate:local
-- Apply remotely: npm run db:migrate:remote   (run BEFORE npm run deploy)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Exams ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS exams (
  id               TEXT    PRIMARY KEY,
  title            TEXT    NOT NULL,
  description      TEXT    NOT NULL DEFAULT '',
  course_code      TEXT    NOT NULL DEFAULT '',
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  start_time       TEXT,                              -- ISO-8601, nullable
  end_time         TEXT,                              -- ISO-8601, nullable
  status           TEXT    NOT NULL DEFAULT 'draft'  -- draft | scheduled | active | completed | closed
    CHECK (status IN ('draft','scheduled','active','completed','closed')),
  strictness       TEXT    NOT NULL DEFAULT 'medium'  -- low | medium | high | custom
    CHECK (strictness IN ('low','medium','high','custom')),
  enable_vision    INTEGER NOT NULL DEFAULT 1,
  enable_identity  INTEGER NOT NULL DEFAULT 1,
  max_risk_score   INTEGER NOT NULL DEFAULT 80,
  scheduled_at     TEXT,                              -- ISO-8601, nullable (backwards-compat)
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_exams_status     ON exams(status);
CREATE INDEX IF NOT EXISTS idx_exams_start_time ON exams(start_time);

-- ── Question bank ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS questions (
  id             TEXT    PRIMARY KEY,
  question_text  TEXT    NOT NULL,
  type           TEXT    NOT NULL DEFAULT 'mcq'  -- mcq | multi_select | short_answer | code | essay | true_false
    CHECK (type IN ('mcq','multi_select','short_answer','code','essay','true_false')),
  options        TEXT,                            -- JSON array of strings
  correct_answer TEXT,                            -- correct option string or JSON
  points         INTEGER NOT NULL DEFAULT 1,
  topic          TEXT    NOT NULL DEFAULT '',
  difficulty     TEXT    NOT NULL DEFAULT 'medium'
    CHECK (difficulty IN ('easy','medium','hard')),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_questions_topic      ON questions(topic);
CREATE INDEX IF NOT EXISTS idx_questions_difficulty ON questions(difficulty);

-- ── Exam–Question join (with snapshot for published exams) ────────────────────

CREATE TABLE IF NOT EXISTS exam_questions (
  id            TEXT    PRIMARY KEY,
  exam_id       TEXT    NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_id   TEXT    NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT,                             -- Frozen snapshot when exam leaves 'draft'
  UNIQUE (exam_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_eq_exam_id     ON exam_questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_eq_question_id ON exam_questions(question_id);
CREATE INDEX IF NOT EXISTS idx_eq_position    ON exam_questions(exam_id, position);
