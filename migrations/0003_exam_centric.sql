-- ─────────────────────────────────────────────────────────────────────────────
-- 0003_exam_centric.sql  —  Phase 4c-1: Exam-Centric Architecture & Student Lobby
-- ─────────────────────────────────────────────────────────────────────────────
-- Applies to EXISTING local and remote D1 databases without requiring re-seeding.
-- Rebuilds questions table to update CHECK constraints and add exam_id ownership.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Rebuild questions table with exam_id and updated types ────────────────

CREATE TABLE IF NOT EXISTS questions_new (
  id             TEXT    PRIMARY KEY,
  exam_id        TEXT    NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  question_text  TEXT    NOT NULL,
  type           TEXT    NOT NULL
    CHECK (type IN ('mcq', 'multi_select', 'fill_in_blank', 'short_answer', 'long_answer')),
  options        TEXT,                                -- JSON array of strings (for mcq/multi_select)
  correct_answer TEXT,                                -- correct answer string or JSON
  points         REAL    NOT NULL DEFAULT 1,
  topic          TEXT    NOT NULL DEFAULT '',
  difficulty     TEXT    NOT NULL DEFAULT 'medium'
    CHECK (difficulty IN ('easy', 'medium', 'hard')),
  grading_mode   TEXT    NOT NULL DEFAULT 'auto'
    CHECK (grading_mode IN ('auto', 'manual')),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Copy existing questions linked via exam_questions
-- If a question is shared across multiple exams, each gets its own row with unique ID
INSERT INTO questions_new (
  id, exam_id, question_text, type, options, correct_answer, points, topic, difficulty, grading_mode, created_at, updated_at
)
SELECT 
  CASE 
    WHEN (SELECT COUNT(*) FROM exam_questions eq2 WHERE eq2.question_id = q.id AND eq2.exam_id < eq.exam_id) = 0 THEN q.id
    ELSE q.id || '-' || eq.exam_id
  END AS id,
  eq.exam_id,
  q.question_text,
  CASE 
    WHEN q.type IN ('essay', 'code') THEN 'long_answer'
    WHEN q.type = 'true_false' THEN 'mcq'
    ELSE q.type 
  END AS type,
  q.options,
  q.correct_answer,
  q.points,
  q.topic,
  q.difficulty,
  CASE
    WHEN q.type IN ('essay', 'code') THEN 'manual'
    WHEN q.type IN ('mcq', 'multi_select', 'true_false') THEN 'auto'
    WHEN q.type = 'short_answer' AND (q.correct_answer IS NOT NULL AND TRIM(q.correct_answer) != '') THEN 'auto'
    ELSE 'manual'
  END AS grading_mode,
  q.created_at,
  q.updated_at
FROM questions q
JOIN exam_questions eq ON q.id = eq.question_id;

-- Copy any unattached questions to the earliest exam if one exists
INSERT OR IGNORE INTO questions_new (
  id, exam_id, question_text, type, options, correct_answer, points, topic, difficulty, grading_mode, created_at, updated_at
)
SELECT
  q.id,
  (SELECT id FROM exams ORDER BY created_at ASC LIMIT 1),
  q.question_text,
  CASE 
    WHEN q.type IN ('essay', 'code') THEN 'long_answer'
    WHEN q.type = 'true_false' THEN 'mcq'
    ELSE q.type 
  END,
  q.options,
  q.correct_answer,
  q.points,
  q.topic,
  q.difficulty,
  CASE
    WHEN q.type IN ('essay', 'code') THEN 'manual'
    WHEN q.type IN ('mcq', 'multi_select', 'true_false') THEN 'auto'
    WHEN q.type = 'short_answer' AND (q.correct_answer IS NOT NULL AND TRIM(q.correct_answer) != '') THEN 'auto'
    ELSE 'manual'
  END,
  q.created_at,
  q.updated_at
FROM questions q
WHERE q.id NOT IN (SELECT id FROM questions_new)
  AND (SELECT id FROM exams ORDER BY created_at ASC LIMIT 1) IS NOT NULL;

-- Drop old questions table and rename questions_new to questions
DROP TABLE questions;
ALTER TABLE questions_new RENAME TO questions;

CREATE INDEX IF NOT EXISTS idx_questions_exam_id   ON questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_questions_topic     ON questions(topic);
CREATE INDEX IF NOT EXISTS idx_questions_type      ON questions(type);

-- ── 2. Add join_code and join_code_active to exams ───────────────────────────

ALTER TABLE exams ADD COLUMN join_code TEXT;
ALTER TABLE exams ADD COLUMN join_code_active INTEGER NOT NULL DEFAULT 1;

-- Backfill join code for exam-1 (matches prompt requirement HKP47QWM)
UPDATE exams
SET join_code = 'HKP47QWM',
    join_code_active = 1
WHERE id = 'exam-1';

-- Backfill unique join code for any other existing exams
UPDATE exams
SET join_code = UPPER(SUBSTR(REPLACE(HEX(RANDOMBLOB(4)), '0', 'X'), 1, 8)),
    join_code_active = 1
WHERE join_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_exams_join_code ON exams(join_code);

-- ── 3. Create exam_enrollments table ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS exam_enrollments (
  exam_id      TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_name TEXT NOT NULL,
  joined_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (exam_id, student_name)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_student ON exam_enrollments(student_name);
CREATE INDEX IF NOT EXISTS idx_enrollments_exam    ON exam_enrollments(exam_id);

-- Backfill enrollments for existing student attempts so past attempts remain valid
INSERT OR IGNORE INTO exam_enrollments (exam_id, student_name, joined_at)
SELECT DISTINCT exam_id, student_name, started_at
FROM attempts;

-- ── 4. Create join_attempts table (for join rate limiting) ───────────────────

CREATE TABLE IF NOT EXISTS join_attempts (
  id           TEXT PRIMARY KEY,
  ip           TEXT NOT NULL,
  student_name TEXT,
  attempted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  success      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_join_attempts_ip_time ON join_attempts(ip, attempted_at);

-- ── 5. Update existing snapshot_json in exam_questions ───────────────────────

UPDATE exam_questions
SET snapshot_json = json_set(
  snapshot_json,
  '$.grading_mode',
  CASE
    WHEN json_extract(snapshot_json, '$.type') IN ('essay', 'code', 'long_answer') THEN 'manual'
    ELSE 'auto'
  END,
  '$.type',
  CASE
    WHEN json_extract(snapshot_json, '$.type') IN ('essay', 'code') THEN 'long_answer'
    WHEN json_extract(snapshot_json, '$.type') = 'true_false' THEN 'mcq'
    ELSE json_extract(snapshot_json, '$.type')
  END
)
WHERE snapshot_json IS NOT NULL;

