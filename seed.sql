-- ─────────────────────────────────────────────────────────────────────────────
-- seed.sql  —  Sample data for local & remote initialization
-- Matches Phase 4c-1 schema with join code HKP47QWM and exam-owned questions
-- Apply locally:  npm run db:seed:local
-- Apply remotely: npx wrangler d1 execute apa-db --remote --file=seed.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- Sample exam (matches the default exam-1 used throughout Phase 1-4)
-- Window covers 2026 to 2030 so the active window is always valid for tests.
INSERT OR IGNORE INTO exams (
  id, title, description, course_code, duration_minutes,
  start_time, end_time, status, strictness, enable_vision, enable_identity,
  max_risk_score, scheduled_at, show_answers, join_code, join_code_active
)
VALUES (
  'exam-1',
  'CS101 Midterm Examination',
  'Covers data structures, algorithms, and complexity analysis from weeks 1–8.',
  'CS101',
  90,
  '2026-01-01T00:00:00Z',
  '2030-12-31T23:59:59Z',
  'active',
  'medium',
  1,
  1,
  80,
  '2026-01-01T00:00:00Z',
  1,
  'HKP47QWM',
  1
);

-- Ensure existing exam-1 in DB gets the updated window, status, and join code
UPDATE exams
SET start_time = '2026-01-01T00:00:00Z',
    end_time = '2030-12-31T23:59:59Z',
    status = 'active',
    duration_minutes = 90,
    show_answers = 1,
    join_code = 'HKP47QWM',
    join_code_active = 1
WHERE id = 'exam-1';

-- Questions owned directly by exam-1 (Phase 4c-1 exam-centric architecture)
INSERT OR IGNORE INTO questions (id, exam_id, question_text, type, options, correct_answer, points, topic, difficulty, grading_mode)
VALUES
  (
    'q-001',
    'exam-1',
    'What is the time complexity of binary search on a sorted array?',
    'mcq',
    '["O(n)","O(log n)","O(n log n)","O(1)"]',
    'O(log n)',
    2,
    'Algorithms',
    'easy',
    'auto'
  ),
  (
    'q-002',
    'exam-1',
    'Which data structure uses LIFO ordering?',
    'mcq',
    '["Queue","Heap","Stack","Linked List"]',
    'Stack',
    1,
    'Data Structures',
    'easy',
    'auto'
  ),
  (
    'q-003',
    'exam-1',
    'A hash table provides O(1) average-case lookup.',
    'mcq',
    '["True","False"]',
    'True',
    1,
    'Data Structures',
    'easy',
    'auto'
  ),
  (
    'q-004',
    'exam-1',
    'Briefly explain the difference between BFS and DFS graph traversal.',
    'short_answer',
    NULL,
    'BFS explores neighbors layer by layer using a queue; DFS explores as deep as possible along each branch using recursion or a stack.',
    3,
    'Algorithms',
    'medium',
    'auto'
  ),
  (
    'q-005',
    'exam-1',
    'Which sorting algorithm has the best worst-case time complexity?',
    'mcq',
    '["Bubble Sort","Quick Sort","Merge Sort","Insertion Sort"]',
    'Merge Sort',
    2,
    'Algorithms',
    'medium',
    'auto'
  );

-- Link questions to the exam with frozen snapshot including type & grading_mode
INSERT OR REPLACE INTO exam_questions (id, exam_id, question_id, position, snapshot_json)
VALUES
  ('eq-001', 'exam-1', 'q-001', 0, '{"id":"q-001","question_text":"What is the time complexity of binary search on a sorted array?","type":"mcq","options":["O(n)","O(log n)","O(n log n)","O(1)"],"correct_answer":"O(log n)","points":2,"topic":"Algorithms","difficulty":"easy","grading_mode":"auto"}'),
  ('eq-002', 'exam-1', 'q-002', 1, '{"id":"q-002","question_text":"Which data structure uses LIFO ordering?","type":"mcq","options":["Queue","Heap","Stack","Linked List"],"correct_answer":"Stack","points":1,"topic":"Data Structures","difficulty":"easy","grading_mode":"auto"}'),
  ('eq-003', 'exam-1', 'q-003', 2, '{"id":"q-003","question_text":"A hash table provides O(1) average-case lookup.","type":"mcq","options":["True","False"],"correct_answer":"True","points":1,"topic":"Data Structures","difficulty":"easy","grading_mode":"auto"}'),
  ('eq-004', 'exam-1', 'q-004', 3, '{"id":"q-004","question_text":"Briefly explain the difference between BFS and DFS graph traversal.","type":"short_answer","options":null,"correct_answer":"BFS explores neighbors layer by layer using a queue; DFS explores as deep as possible along each branch using recursion or a stack.","points":3,"topic":"Algorithms","difficulty":"medium","grading_mode":"auto"}'),
  ('eq-005', 'exam-1', 'q-005', 4, '{"id":"q-005","question_text":"Which sorting algorithm has the best worst-case time complexity?","type":"mcq","options":["Bubble Sort","Quick Sort","Merge Sort","Insertion Sort"],"correct_answer":"Merge Sort","points":2,"topic":"Algorithms","difficulty":"medium","grading_mode":"auto"}');
