# Autonomous Proctoring Agent — Prompt History

This document contains the chronological prompt history used to build this project with AI-assisted coding.

### 1. Initial Scaffold
**Prompt given:**
> "npm create cloudflare@latest" with React + TypeScript template, scaffolded into existing repo, minimal /api/health test route added.

**What was built in response:**
- Created base `apa-platform` directory using `npm create cloudflare`
- Selected React + TypeScript (Framework Starter)
- Set up initial `wrangler.jsonc` and `vite.config.ts`
- Added a basic `/api/health` test route to the Worker entry point

### 2. Phase 1 Build
**Prompt given:**
> Note: The Cloudflare Workers + React scaffold already exists in this repo (Moonglade-07/Autonomous-Proctoring-Agent), with a working /api/health test route. Build Phase 1 on top of this existing structure — do not re-scaffold.
> 
> Build Phase 1 of an "Autonomous Proctoring Agent" — an AI-powered exam monitoring app, deployed entirely on Cloudflare. This is a scoped MVP slice of a larger platform.
> 
> TECH STACK (Cloudflare only):
> - Frontend: React + TypeScript + Tailwind CSS, deployed via Cloudflare Pages
> - Backend: Cloudflare Workers
> - LLM: Workers AI, model "@cf/meta/llama-3.3-70b-instruct-fp8-fast" for reasoning/risk analysis
> - State/Memory: Durable Objects (one Durable Object instance per exam session)
> - Realtime: WebSocket connection between frontend and the Durable Object
> 
> SCOPE FOR THIS PHASE:
> Build a single working vertical slice: a student exam interface where simulated behavioral events are sent from the frontend to a backend agent that reasons about risk in real time and maintains session memory.
> 
> 1. FRONTEND (React + TS + Tailwind, in Cloudflare Pages project):
>    - One page: `/exam` — simple Exam Interface
>    - UI elements:
>      - A mock webcam preview box (just a placeholder div, no real camera needed yet)
>      - A "Risk Score" indicator (color-coded: green <30, yellow 30-70, red >70)
>      - A live event log panel showing recent AI-generated warnings/messages
>      - Buttons to SIMULATE behavioral events for testing: "Simulate Tab Switch", "Simulate Face Not Detected", "Simulate Multiple Faces", "Simulate Normal Behavior"
>    - On button click, send event via WebSocket to backend Durable Object
>    - Display incoming AI responses (warnings/risk score updates) in the event log in real time
> 
> 2. BACKEND — Durable Object (session state + memory):
>    - One Durable Object class `ExamSessionDO`
>    - Holds in-memory + persisted state:
>      - `riskScore: number` (0-100)
>      - `riskHistory: {timestamp, score, trigger, aiExplanation}[]`
>      - `violations: {type, severity, timestamp, aiExplanation}[]`
>    - Exposes a WebSocket handler: accepts connection from frontend, receives event messages like `{type: "tab_switch"}`, `{type: "face_not_detected"}`, `{type: "multiple_faces"}`, `{type: "normal"}`
>    - On receiving an event:
>      a. Update internal state
>      b. Call Workers AI (Llama 3.3) with a prompt describing the event + recent history, asking it to: assess risk severity, output a new risk score (0-100), and produce a short natural-language explanation/warning
>      c. Persist updated state (riskScore, riskHistory, violations) using Durable Object storage (`this.state.storage`)
>      d. Send the AI's response (new risk score + explanation) back to frontend over WebSocket
> 
> 3. WORKER (entry point):
>    - Cloudflare Worker routes:
>      - `/api/exam/:sessionId` → routes WebSocket upgrade requests to the correct `ExamSessionDO` instance (using sessionId to get the Durable Object ID)
>    - Bind Workers AI in `wrangler.toml`
>    - Bind Durable Object namespace in `wrangler.toml`
> 
> 4. DATA MODELS (TypeScript interfaces, use these exactly):
> ```typescript
> interface RiskEvent {
>   timestamp: string;
>   score: number;
>   triggers: string[];
>   aiExplanation: string;
> }
> 
> interface Violation {
>   id: string;
>   sessionId: string;
>   type: 'vision' | 'behavioral' | 'audio' | 'system';
>   severity: 'low' | 'medium' | 'high' | 'critical';
>   timestamp: string;
>   aiConfidence: number;
>   humanReviewed: boolean;
> }
> 
> interface ExamSessionState {
>   sessionId: string;
>   riskScore: number;
>   riskHistory: RiskEvent[];
>   violations: Violation[];
> }
> ```
> 
> 5. FOLDER STRUCTURE:
> 
> apa-platform/
> ├── frontend/
> │ ├── src/
> │ │ ├── pages/ExamPage.tsx
> │ │ ├── components/RiskIndicator.tsx
> │ │ ├── components/EventLog.tsx
> │ │ ├── components/WebcamPreview.tsx
> │ │ ├── hooks/useWebSocket.ts
> │ │ └── App.tsx
> ├── worker/
> │ ├── src/
> │ │ ├── index.ts (Worker entry, routes to DO)
> │ │ └── ExamSessionDO.ts (Durable Object class)
> ├── wrangler.toml
> ├── package.json
> 
> 
> 6. wrangler.toml MUST include:
>    - Durable Object binding for `ExamSessionDO`
>    - Workers AI binding
>    - Migration block for the Durable Object class
> 
> DELIVERABLE:
> Generate the full folder structure and all files above, fully working and ready to run locally with `wrangler dev`, and deployable with `wrangler deploy`. Include clear comments explaining the WebSocket flow and where Llama 3.3 is called. Do not add authentication, professor dashboard, or admin dashboard yet — this is Phase 1 only.

**What was built in response:**
- Configured Cloudflare bindings (`env.AI`, `env.EXAM_SESSION`) and DO migration in `wrangler.jsonc`
- Created `worker/types.ts` defining shared data models (`RiskEvent`, `Violation`, `ExamSessionState`)
- Created `worker/ExamSessionDO.ts` implementing a Durable Object that handles WebSockets, AI calls, and state persistence
- Created `worker/index.ts` to route HTTP requests and WebSocket upgrades to the DO
- Created `src/hooks/useWebSocket.ts` for frontend WebSocket management
- Created `src/components/RiskIndicator.tsx`, `EventLog.tsx`, and `WebcamPreview.tsx` (with placeholder camera)
- Created `src/pages/ExamPage.tsx` integrating UI components and simulation controls
- Configured Tailwind CSS v4 in `vite.config.ts` and `src/index.css`

### 3. Phase 1 Polish
**Prompt given:**
> Polish Phase 1 of the Autonomous Proctoring Agent before final submission. Do not change the architecture (Workers + Durable Object + Workers AI + WebSocket) — only improve and refine what already exists.
> 
> 1. REAL WEBCAM ACCESS
>    - Replace the placeholder "[Camera access simulated in Phase 1]" box with actual browser webcam access using `navigator.mediaDevices.getUserMedia({ video: true })`
>    - Show the real live video feed in the WebcamPreview component
>    - Handle permission denial gracefully (show a fallback message if user denies camera access)
>    - Keep the REC indicator overlay
> 
> 2. UI/UX IMPROVEMENTS
>    - Add subtle animations when risk score changes (smooth transition, not instant jump)
>    - Add a timestamp next to each event in the Event Log
>    - Add a "Clear Log" button to reset the event log view (does not need to reset backend state)
>    - Improve color contrast and spacing for readability — this should look professional and demo-ready, not like a prototype
>    - Add a short header/description explaining what this page demonstrates (e.g., "This interface simulates real-time AI-powered exam proctoring using Cloudflare Workers AI, Durable Objects, and WebSockets")
> 
> 3. ERROR HANDLING
>    - If WebSocket disconnects, show a clear "Reconnecting..." indicator instead of silently failing
>    - If Workers AI call fails or times out, show a fallback message in the event log instead of breaking the UI
>    - Add basic loading states (e.g., while waiting for AI response after clicking simulate button, disable that button briefly and show a spinner/pulse)
> 
> 4. CODE QUALITY
>    - Add JSDoc/TSDoc comments to ExamSessionDO.ts explaining what each method does, especially the Workers AI call and state persistence logic
>    - Ensure consistent naming and formatting across all files
>    - Remove any unused imports or dead code
>    - Confirm TypeScript strict mode passes with 0 errors
> 
> 5. README
>    - Write a clear README.md at the project root explaining:
>      - What this project is (Autonomous Proctoring Agent, Phase 1)
>      - Architecture diagram (text-based is fine): Frontend (Pages) → WebSocket → Worker → Durable Object → Workers AI (Llama 3.3)
>      - How the 4 Cloudflare AI-app requirements are met (LLM, Workflow/coordination, user input, memory/state)
>      - How to run locally (`npm install`, `npm run dev`)
>      - How to deploy (`npx wrangler deploy`)
>      - Live demo link: https://apa-platform.ala109056aman.workers.dev/
> 
> Do not add new pages, new roles, authentication, or professor dashboard features in this pass — that's Phase 2. This pass is purely refinement of the existing Phase 1 scope.

**What was built in response:**
- Rewrote `WebcamPreview.tsx` to use `navigator.mediaDevices.getUserMedia()` with fallback UI states
- Enhanced `EventLog.tsx` with a "Clear view" button, trigger labels, timestamp tooltips, and improved contrast
- Enhanced `ExamPage.tsx` with an AI stack hero banner, a prominent WebSocket reconnect banner, and server error handling
- Added a 20-second timeout wrapper around Workers AI calls in `ExamSessionDO.ts` with a deterministic fallback to prevent hangs
- Added comprehensive JSDoc/TSDoc comments to all methods in `ExamSessionDO.ts`
- Fixed a StrictMode double-rendering bug and changed `state.acceptWebSocket()` to `server.accept()` to resolve a silent message drop issue
- Generated a comprehensive `README.md` containing architecture, flow explanation, and deployment instructions
- Resolved all TypeScript strict mode errors

### 4. Phase 4a: D1 Database Setup and Professor Exam Management
**Prompt given:**
> Build Phase 4a of the Autonomous Proctoring Agent: D1 database setup and professor exam management. Keep Phases 1 to 3b working exactly as is. Auth is still Phase 5, so professor endpoints reuse the PROFESSOR_KEY guard from Phase 3b. Do NOT build the student exam-taking flow in this pass; that is Phase 4b.
> 
> GOAL: A professor can create, edit, schedule and delete exams with questions, and reuse questions from a question bank. All of it is stored in Cloudflare D1.
> 
> 1. D1 SETUP
>    - Create a D1 database "apa-db" and add the binding `DB` in wrangler.jsonc
>    - Add a /migrations folder with numbered SQL files (0001_init.sql). Add npm scripts: "db:migrate:local" and "db:migrate:remote" using wrangler d1 migrations apply
>    - Document both commands in the README, including that the remote one must run before npm run deploy
>    - Do not touch the existing Durable Object bindings or migrations v1 to v3
> 
> 2. SCHEMA (0001_init.sql)
>    - exams: id (text pk), title, description, course_code, duration_minutes, start_time, end_time, status ('draft' | 'scheduled' | 'active' | 'completed'), strictness ('low' | 'medium' | 'high' | 'custom'), enable_vision (0/1), enable_identity (0/1), max_risk_score, created_at, updated_at
>    - questions: id (text pk), type ('mcq' | 'multi_select' | 'short_answer' | 'code' | 'essay'), text, options_json, correct_answer_json, points, topic, difficulty ('easy' | 'medium' | 'hard'), created_at
>    - exam_questions: exam_id, question_id, position (composite pk on exam_id + question_id; foreign keys with ON DELETE CASCADE)
>    - Add indexes on exams.status, exams.start_time, questions.topic and questions.difficulty
>    - Questions are shared between the bank and exams through exam_questions, so editing a bank question updates every draft exam that uses it. Published (non-draft) exams must snapshot their questions instead: when an exam moves from draft to scheduled, copy the question content into exam_questions as a frozen snapshot column (snapshot_json) so later bank edits cannot change a live exam.
> 
> 3. WORKER API (new file worker/api/exams.ts, routed from worker/index.ts under /api/professor/*)
>    - All routes require the PROFESSOR_KEY (header `X-Professor-Key`, not a query param), return 401 on mismatch, and use the same constant-time comparison already used by the hub
>    - Routes:
>      - GET /api/professor/exams: list with filters (status, search)
>      - POST /api/professor/exams: create
>      - GET /api/professor/exams/:id: exam with its questions
>      - PUT /api/professor/exams/:id: update; reject edits to question content or timing on non-draft exams with a clear 409 message
>      - DELETE /api/professor/exams/:id: only drafts; others return 409
>      - POST /api/professor/exams/:id/publish: validates (at least 1 question, duration > 0, end_time after start_time, total points > 0), snapshots questions, sets status to 'scheduled'
>      - GET/POST/PUT/DELETE /api/professor/questions: question bank CRUD with filters (topic, difficulty, type, search); block deleting a question that is used by a non-draft exam
>    - Validate every request body with a schema library (zod) and return structured 400 errors with field names
>    - Use parameterized queries only (D1 .prepare().bind()). No string concatenation in SQL.
>    - Generate ids with crypto.randomUUID()
>    - Return JSON with consistent shapes: { data } or { error: { code, message, fields? } }
> 
> 4. FRONTEND: ROUTES AND LAYOUT
>    - Add routes under /professor/exams (list), /professor/exams/new (wizard), /professor/exams/:id (edit) and /professor/questions (bank)
>    - Keep /professor as the Live Monitor. Add a top navigation bar to the professor area: Live Monitor | Exams | Question Bank
>    - Reuse the existing professor key gate and send the key as X-Professor-Key through one small api.ts helper
> 
> 5. FRONTEND: EXAM LIST (/professor/exams)
>    - Table with title, course, schedule, duration, status badge, question count, total points
>    - Filter by status, search by title, "Create Exam" button
>    - Row actions: Edit, Duplicate (copies to a new draft), Delete (drafts only, with confirm)
> 
> 6. FRONTEND: CREATE EXAM WIZARD (/professor/exams/new and edit)
>    - Step 1, Basic info: title, description, course code, duration
>    - Step 2, Questions: build questions inline (MCQ, multi-select, short answer, code, essay) OR "Add from Question Bank" with a searchable picker. Reorder with up/down buttons and remove. Show a running total of points.
>    - Step 3, Proctoring settings: strictness (low/medium/high/custom), toggles for vision and identity verification, max risk score before auto-flag (slider). Show a short description of what each strictness level means.
>    - Step 4, Schedule: start and end datetime pickers (show times in the user's local timezone, store ISO UTC), then a review summary
>    - Actions: "Save Draft" at any step, and "Publish" only on the last step (calls the publish endpoint). Show validation errors per field.
>    - Autosave nothing silently; show a clear "Unsaved changes" warning if the user navigates away
> 
> 7. FRONTEND: QUESTION BANK (/professor/questions)
>    - Table with filters (topic, difficulty, type) and search
>    - Create/edit question in a side drawer with a type-specific form: MCQ and multi-select need 2 to 6 options and at least one correct; short answer needs an accepted answers list (case-insensitive match option); code and essay are manually graded, so correct answer is optional
>    - Delete with confirm; show a clear error if it is used by a published exam
> 
> 8. DATA MODELS
>    - Add shared types for Exam, Question, ExamQuestion, ProctoringSettings and API response shapes in both types.ts copies
>    - The correctAnswer fields must exist only in professor-facing types. Create a separate StudentQuestion type that omits them now, so 4b cannot leak answers by accident.
> 
> 9. SEED DATA
>    - Add a seed SQL file (seed.sql) with one sample exam "exam-1" (matching the existing default exam id) with 5 mixed questions, status 'active', so the existing Live Monitor demo keeps working. Add a "db:seed:local" script.
> 
> 10. DO NOT build in this pass: the student question-taking UI, answer submission or scoring, auth, reports, or admin pages. Keep all new code TSDoc-commented, with TypeScript strict at 0 errors. Update the README with a "Database" section (schema overview, migration commands) and the new API routes.
> 
> DELIVERABLE: Run the db migration locally, open /professor/exams, create an exam through the wizard with questions from both inline creation and the question bank, save it as a draft, publish it, and see it listed as Scheduled. Edits to a published exam's questions are rejected. Deleting a bank question used by a published exam is rejected. The existing Live Monitor and student proctoring still work unchanged.

**What was built in response:**
- Configured Cloudflare D1 binding `env.DB` (`apa-db`, ID `fa52197c-1a66-4deb-b2e0-5bddd234a351`) in `wrangler.jsonc`
- Created `migrations/0001_init.sql` for `exams`, `questions`, and `exam_questions` with snapshot columns and indexes
- Created root `seed.sql` with default `exam-1` and 5 sample questions
- Created `worker/api/exams.ts` providing 13 REST endpoints with Zod schema validation, strict `X-Professor-Key` auth, zero-question publish guards, time range validation, question deletion protection against published exams, and snapshot freezing logic
- Created typed frontend API client in `src/hooks/useProfessorApi.ts`
- Created shared `src/components/QuestionModal.tsx` and `ProfessorNav.tsx`
- Implemented `/professor/exams` (ExamListPage), `/professor/exams/new` & `/:id` (ExamEditorPage), and `/professor/questions` (QuestionBankPage)
- Created answer-safe `StudentQuestion` type (omitting `correct_answer`) in both `worker/types.ts` and `src/types.ts` to prevent answer leakage in Phase 4b
- Verified local and remote D1 migrations, seeding, UI workflows, and student proctoring regression tests

### 6. Phase 4b Build
**Prompt given:**
> Build Phase 4b of the Autonomous Proctoring Agent: the student exam-taking flow with server-side timing and auto-grading. Keep Phases 1 to 4a working exactly as is. Auth is still Phase 5, so students are identified by ?name= as before. Do NOT build auth, reports, admin pages, or manual grading UI in this pass.
> 
> GOAL: A student opens an exam, answers the questions while the existing proctoring runs, submits (or gets auto-submitted at the deadline), and sees their result. Correct answers must never reach the student's browser before grading.
> 
> 1. D1 MIGRATION (migrations/0002_attempts.sql, do not edit 0001)
>    - attempts: id (text pk), exam_id, student_name, session_id, status ('in_progress' | 'submitted' | 'auto_submitted' | 'terminated'), started_at, deadline_at, submitted_at, paused_seconds (default 0), paused_at (nullable), score (nullable), max_score, grading_status ('auto_graded' | 'pending_manual')
>    - answers: attempt_id, question_id, answer_json, marked_for_review (0/1), updated_at (composite pk on attempt_id + question_id; ON DELETE CASCADE)
>    - Unique index on (exam_id, student_name) so one attempt per student per exam until Phase 5 adds accounts
>    - Index on attempts.exam_id and attempts.status
>    - Update seed.sql so exam-1's exam_questions rows have snapshot_json populated
> 
> 2. STUDENT API (new file worker/api/student.ts, routed under /api/student/*, no professor key required)
>    - GET /api/student/exams: exams that are 'scheduled' or 'active' and whose window includes now; return only id, title, course, duration, start/end
>    - POST /api/student/exams/:id/start { studentName, sessionId }: validates the exam window, creates the attempt (or returns the existing in-progress one so refresh resumes), sets deadline_at = min(now + duration, exam end_time), and returns questions as StudentQuestion with NO correct answers, plus saved answers and the server's remaining seconds
>    - PUT /api/student/attempts/:id/answers { questionId, answer, markedForReview }: autosave one answer. Reject if the attempt is not in_progress or the deadline has passed.
>    - POST /api/student/attempts/:id/submit: finalizes and grades. Idempotent: a second call returns the stored result.
>    - GET /api/student/attempts/:id/result: only after submission; returns score, max score, and per-question correctness for auto-graded questions. Show correct answers only if the exam has a show_answers setting. Add a show_answers column to exams in this migration, default 0, and keep it off.
>    - All timing is enforced on the server using its own clock. Never trust client timestamps or the client timer. Allow a 5 second grace on submit, and answers arriving after the deadline are ignored.
>    - Questions come from exam_questions.snapshot_json for published exams, never the live bank. If snapshot_json is null for a non-draft exam, return a 500 with a clear error instead of silently falling back.
> 
> 3. ANSWER-LEAK PROTECTION (critical)
>    - Build student questions through one function toStudentQuestion() that uses an explicit allowlist of fields (id, type, text, options, points, topic, difficulty). Never spread or copy the full question object.
>    - Never SELECT correct_answer_json in any /api/student route except inside the grading function, and never return it from there.
>    - Add a unit test (vitest) asserting that no student-facing response contains correct_answer, correctAnswer or correct_answer_json, including nested snapshots. Add the vitest dev dependency and a "test" script.
> 
> 4. GRADING (server-side only, in one function)
>    - mcq: exact match of the chosen option
>    - multi_select: exact set match (order-insensitive), no partial credit
>    - short_answer: trimmed, case-insensitive match against the accepted answers list
>    - code and essay: not auto-graded; grading_status becomes 'pending_manual' and the score covers auto-graded questions only
>    - Treat missing answers as 0. Validate each submitted answer against the question type (option indexes in range, string length limit of 10,000 chars) and reject bad payloads with 400.
> 
> 5. PROCTORING INTEGRATION
>    - Pass the examId and the attempt's sessionId to the existing ExamSessionDO connection so the Live Monitor shows the same student
>    - On professor force_submit, the ExamSessionDO marks the attempt 'terminated' and grades whatever answers were already saved (use env.DB from the DO)
>    - On pause and resume, the DO records paused_at and adds the elapsed time to paused_seconds, and deadline is extended by that amount, so paused time does not count against the student. The client timer must read the server's remaining seconds, which the autosave and a /api/student/attempts/:id/time endpoint return.
>    - If the student's browser disconnects, the attempt keeps running. Reconnecting with the same sessionId resumes it.
> 
> 6. STUDENT UI (extend ExamPage.tsx; keep the identity verification, proctoring panel, warnings, pause and terminate screens exactly as they are)
>    - New route /student: simple list of available exams with a name field and a "Start" button, which goes to /exam?exam=<id>&name=<name>
>    - Question panel: renders MCQ (radio), multi-select (checkboxes), short answer (input), code (monospace textarea with tab handling), essay (textarea with a character counter)
>    - Question palette: numbered buttons showing answered, unanswered, marked for review, and current
>    - "Mark for review" toggle, Previous and Next buttons
>    - Autosave: debounce 800ms on change, with a visible "Saved" or "Saving..." or "Retry" indicator. Queue and retry on network failure, and warn before leaving the page with unsaved changes.
>    - Timer: starts from the server's remaining seconds, ticks locally, and re-syncs from the server every 30 seconds. At zero, call submit automatically.
>    - Submit: a confirmation dialog showing the count of unanswered and marked-for-review questions
>    - After submission: stop monitoring cleanly (reuse the force_submit cleanup path: stop webcam, exit fullscreen, stop loops), then show a result screen with score and percentage, or "Pending manual grading" for the parts that need it
>    - Refresh resilience: store the attemptId in sessionStorage beside the sessionId. A refresh resumes with saved answers and the correct remaining time. A submitted attempt always shows its result screen, never the questions again.
> 
> 7. PROFESSOR SIDE (minimal, read-only)
>    - GET /api/professor/exams/:id/attempts (key guarded): student name, status, score, max score, grading status, submitted time
>    - Add an "Attempts" tab on /professor/exams/:id showing that table. No grading UI yet.
> 
> 8. DATA MODELS: add Attempt, StudentAnswer, SubmitResult and the student API shapes to both types.ts copies. Keep StudentQuestion from 4a as the only question type used in student responses.
> 
> 9. Keep all new code TSDoc-commented, TypeScript strict at 0 errors, SQL fully parameterized, and the README updated with the student API routes and the leak-protection rule.
> 
> DELIVERABLE: Open /student, start exam-1, answer all question types, refresh mid-exam and resume with answers and the right remaining time, submit, and see the score. Check the Network tab: no response ever contains a correct answer. Start the same exam under the same name again and get the existing attempt, not a new one. The Live Monitor still shows the student, and a professor force submit ends the attempt with a graded score.

**What was built in response:**
- Created D1 schema migration `migrations/0002_attempts.sql` for student attempts, answers, and `show_answers` column on `exams`
- Updated `seed.sql` with full frozen question `snapshot_json` for exam-1
- Created `worker/api/student.ts` with complete `/api/student/*` endpoints: list exams, get exam questions, start/resume attempt, batch/single autosave answers, time sync, server-side auto-grading submit, and submission results
- Implemented strict answer-leak protection via `toStudentQuestion()` allowlist and added 10-test Vitest suite in `src/answer-leak.test.ts`
- Connected `ExamSessionDO.ts` with D1 database: synced force_submit auto-grading termination, pause timestamp recording, and resume deadline extensions
- Extended unified `ExamPage.tsx` at `/exam?exam=<id>&name=<name>` with full interactive exam interface (question palette, server-synced timer, 800ms debounced autosave, question types, submission modal, and result screen) with all multimodal proctoring attached (webcam feed, identity capture reference, face detection, orientation, fullscreen enforcement, tab focus, and clipboard monitoring)
- Created `/student` exam list portal (`StudentExamListPage.tsx`) routing directly into the unified `ExamPage.tsx`
- Added read-only "Attempts" tab to professor exam editor (`ExamEditorPage.tsx`) and `GET /api/professor/exams/:id/attempts` endpoint
- Updated data models in `src/types.ts` and `worker/types.ts`
- Documented Phase 5 limitations (unauthenticated name collisions and incognito pause bypass) in `README.md`
- Updated `README.md` with Phase 4b endpoints, UI paths, and answer-leak protection policies

### 7. Phase 4c-1 Build
**Prompt given:**
> Build Phase 4c-1 of the Autonomous Proctoring Agent: restructure the professor side around the exam, add the new question types, and add the exam join code with a student lobby. Keep Phases 1 to 4b working exactly as is, except where this prompt says to replace something. Auth is still Phase 5 (PROFESSOR_KEY and ?name= stay for now). Do NOT build manual grading UI, results release, auto-end at exam close, session delete/archive, preview-as-student, shuffling or reports in this pass. Those are 4c-2.
> 
> GOAL: The exam is the container. A professor creates an exam, gets a join code, builds its questions inside it, and watches it live from inside it. A student enters the code to join. There is no global question bank and no global exam list for students.
> 
> 1. D1 MIGRATION (0003_exam_centric.sql)
>    - questions table rebuilt with exam_id foreign key (ON DELETE CASCADE) and updated type CHECK constraint ('mcq', 'multi_select', 'fill_in_blank', 'short_answer', 'long_answer') and grading_mode ('auto', 'manual').
>    - exams: add join_code (text, unique index), join_code_active (default 1).
>    - exam_enrollments: exam_id, student_name, joined_at, composite pk.
>    - join_attempts: id, ip, student_name, attempted_at, success; index on (ip, attempted_at).
> 
> 2. QUESTION TYPES AND GRADING
>    - mcq: 2 to 6 options, 1 correct, auto
>    - multi_select: 2 to 6 options, >=1 correct, auto
>    - fill_in_blank: question text contains '___' markers, accepted answers per blank, case-insensitivity flag, partial credit split equally across blanks
>    - short_answer: auto with accepted answers list or manual
>    - long_answer: manual only with optional word-limit hint
>    - toStudentQuestion() allowlist leak-protection for all types
> 
> 3. EXAM-CENTRIC PROFESSOR UI
>    - Top nav: Exams only (/professor redirects to /professor/exams)
>    - /professor/exams: table with derived status, join code badges, question/student counts, short Create Exam modal, Duplicate, Delete
>    - /professor/exams/:id: Overview, Questions, Live Monitor, Submissions, Settings
>    - QuestionDrawer on the right with type-specific editors and auto/manual toggle
>    - Import from previous exams modal
>    - Scoped Live Monitor embedding ProfessorDashboard fixedExamId
> 
> 4. STUDENT JOIN FLOW & LOBBY
>    - POST /api/student/join { code, studentName } with rate limiting (>10 failed joins / 10 mins -> 429) and anti-probing constant generic error ("Invalid or inactive code")
>    - GET /api/student/my-exams?name=
>    - POST /api/student/exams/:id/start requires enrollment row (403 if unenrolled)
>    - Student lobby (/student/lobby/:examId) with camera, fullscreen, and browser readiness checks before Begin Exam unlocks
> 
> 5. VITEST TEST SUITE
>    - Join code generation, alphabet, length, normalization, formatting
>    - Anti-probing error consistency
>    - Rate limiting
>    - Enrollment requirement
>    - Grading per type (fill_in_blank partial credit & casing, manual pending status)
>    - Answer-leak protection across all types

**What was built in response:**
- Created and executed D1 migration `migrations/0003_exam_centric.sql` locally and on the live remote database `apa-db` without data loss
- Generated backup dump `backup.sql` before schema migration
- Implemented uniform join code generator from 32-character alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`) with zero modulo bias
- Implemented `worker/api/student.ts` join code endpoint with 10-attempt/10-minute rate limiting and anti-probing constant generic error
- Implemented `GET /api/student/my-exams` and enrollment requirement check in `POST /api/student/exams/:id/start`
- Implemented Zod validation schemas and grading engine in `worker/utils/questionGrading.ts` supporting `fill_in_blank` partial credit per blank, case insensitivity, `short_answer` auto/manual modes, and `long_answer` manual grading status
- Replaced global Question Bank with exam-scoped questions in `worker/api/exams.ts`, adding duplicate exam, join code regeneration, toggle code, and question import
- Built `src/pages/StudentLobbyPage.tsx` with automated camera permission, fullscreen, and browser readiness checks and window countdown
- Built `src/pages/StudentExamListPage.tsx` join-by-code student portal and "My Exams" list
- Restructured `src/pages/ExamListPage.tsx` with derived status badges, join code badges, and short form "Create Exam" modal
- Restructured `src/pages/ExamEditorPage.tsx` into 5-tab workspace (Overview, Questions, Live Monitor, Submissions, Settings) with `QuestionDrawer` and `ImportQuestionsModal`
- Scoped `src/pages/ProfessorDashboard.tsx` with `fixedExamId` to embed seamlessly into the exam editor Live Monitor tab
- Extended `src/pages/ExamPage.tsx` to render interactive inputs for `fill_in_blank` and `long_answer` while preserving all multimodal proctoring
- Wrote 13 new Vitest tests in `src/phase4c1.test.ts` (33/33 tests passing project-wide)
- Built project bundle (`npm run build`) and deployed live to Cloudflare Workers (`https://apa-platform.ala109056aman.workers.dev`)

### 8. Phase 4c-2a Build
**Prompt given:**
> Build Phase 4c-2a of the Autonomous Proctoring Agent: manual grading, results release, and server-side auto-end of expired attempts. Keep Phases 1 to 4c-1 working exactly as is, except where this prompt says to replace something. Auth is still Phase 5 (PROFESSOR_KEY and student names stay, and canAccessExam must be called on every professor route). Do NOT build session delete/archive, past sessions, preview-as-student, shuffling, reports, CSV/PDF export or retention in this pass.
> 
> GOAL: A professor can grade the manual questions of every submission, release results to students when ready, and no attempt can stay open after its deadline even if the student closes the browser.
> 
> 1. D1 MIGRATION (0004_grading.sql)
>    - DO NOT rebuild or drop the attempts, answers, questions or exams tables. Add columns only, with ALTER TABLE ... ADD COLUMN.
>    - answers: awarded_points, auto_points, grading_source ('auto' | 'manual' | 'override'), grader_comment, graded_at.
>    - attempts: fully_graded (INTEGER default 0), graded_at. Keep grading_status as it is.
>    - exams: results_released (default 0), results_released_at, instant_results (default 0).
>    - questions: rubric (TEXT, nullable).
>    - Backfill fully_graded = 1 for auto_graded attempts.
> 
> 2. SUBMIT-TIME GRADING
>    - Write awarded_points and auto_points for auto questions.
>    - Manual questions left blank auto-zero to awarded_points = 0 and grading_source = 'manual'.
>    - Manual questions answered stay awarded_points = NULL until graded.
>    - attempts.score = SUM(awarded_points); fully_graded = 1 when all are graded.
> 
> 3. GRADING API (professor routes, key guarded, canAccessExam on every one)
>    - GET /api/professor/exams/:id/submissions: attempts list with needs_grading_count and fully_graded
>    - GET /api/professor/attempts/:attemptId/grading: full attempt in professor view with questions, rubric, student answer, auto_points, awarded_points, comments
>    - GET /api/professor/exams/:id/grading/questions/:questionId?blind=1: all answers to one question with optional blind grading
>    - PUT /api/professor/attempts/:attemptId/answers/:questionId/grade: set points and comment, validate 0..max points, step 0.25, preserve auto_points on override
>    - POST /api/professor/attempts/:attemptId/answers/:questionId/suggest-grade: Workers AI suggestion with rubric, strict rate limiting (20/min), prompt injection protection, clamped points
>    - POST /api/professor/exams/:id/release-results & POST /api/professor/exams/:id/unrelease-results
> 
> 4. RESULTS RELEASE & STUDENT ACCESS
>    - 4 distinct states: submitted_pending_release, being_graded, instant results (auto exams only), and fully released
>    - rubric and correct answers NEVER leak
> 
> 5. SERVER CRON AUTO-END
>    - Worker scheduled handler + 1-minute cron (* * * * *)
>    - Finds in-progress unpaused attempts with deadline_at < now - 30s
>    - Abandoned paused attempts past exam end_time + 24 hours
>    - Idempotent auto-submit
> 
> 6. PROFESSOR GRADING UI
>    - Submissions tab with metrics banner (Total, Graded, Pending, Avg Score)
>    - Release/Unrelease results buttons with confirmation
>    - Instant results toggle in Settings
>    - Dual-mode grading view ("By Student" and "By Question" with blind grading toggle and AI suggest grade)
>    - Rubric field in QuestionDrawer for manual questions
> 
> 7. STUDENT RESULTS UI
>    - Status badges in My Exams
>    - Result screens reflecting pending, being graded, or released results
> 
> 8. VITEST TEST SUITE
>    - Auto-zero on blank answers, pending for answered manual questions
>    - Grade PUT validation (0..max, step 0.25, rejection of non-gradable MCQ)
>    - Override logic (preserves auto_points, sets grading_source = 'override')
>    - Blind grading mode (alias replacement, session_id omitted)
>    - Results release 4-state gating & rubric protection
>    - AI suggest-grade rate limit & clamping
>    - Server cron sweep grace period, unpaused only, idempotent

**What was built in response:**
- Created non-destructive D1 migration `migrations/0004_grading.sql` (ALTER TABLE only, no DROP/rebuild) and applied to both local and live remote databases
- Generated remote backup dump `backup_pre_0004.sql` before applying remote migration
- Updated grading engine in `worker/utils/questionGrading.ts` with auto-zeroing for blank manual questions, per-answer grade tracking, and server score recalculation
- Implemented professor grading REST API in `worker/api/grading.ts`:
  - `GET /api/professor/exams/:id/submissions`
  - `GET /api/professor/attempts/:attemptId/grading`
  - `GET /api/professor/exams/:id/grading/questions/:questionId?blind=1`
  - `PUT /api/professor/attempts/:attemptId/answers/:questionId/grade`
  - `POST /api/professor/attempts/:attemptId/answers/:questionId/suggest-grade` with Workers AI, anti-injection framing, and 20/min rate limiting
  - `POST /api/professor/exams/:id/release-results` & `POST /api/professor/exams/:id/unrelease-results`
- Implemented `runAutoEndSweep` server cron in `worker/api/grading.ts` triggered every minute by `worker/index.ts` `scheduled` handler and configured in `wrangler.jsonc` (`* * * * *`)
- Extended `worker/api/student.ts` with 4-state result gating (`submitted_pending_release`, `being_graded`, instant results, and released) and zero answer leakage
- Created `src/components/GradingView.tsx` supporting "By Student" and "By Question" grading workflows, blind grading mode, rubric reference, and AI score suggestions
- Added `rubric` editor to `src/components/QuestionDrawer.tsx` for manual questions
- Upgraded `src/pages/ExamEditorPage.tsx` with rich Submissions tab, grading progress bar, release confirmation modal, and Instant Results setting
- Updated `src/pages/StudentExamListPage.tsx` and `src/pages/ExamPage.tsx` to display pending release, being graded, and released score cards
- Created 14 comprehensive Vitest tests in `src/phase4c2a.test.ts` (47/47 tests passing across the entire project)
- Built project bundle (`npm run build`) and deployed live to Cloudflare Workers (`https://apa-platform.ala109056aman.workers.dev`)




