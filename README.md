# Autonomous Proctoring Agent (APA)

> **Phase 1 — Live Demo:** https://apa-platform.ala109056aman.workers.dev/

An AI-powered, real-time exam proctoring platform built entirely on Cloudflare's developer platform. Students are monitored through behavioral signals analyzed by a large language model running at the edge — no external servers, no third-party AI APIs, no traditional backend.

---

## What This Is

The Autonomous Proctoring Agent detects and reasons about academic integrity violations during online exams. Phase 1 delivers a working vertical slice:

- A **student exam interface** with live webcam feed
- **Behavioral simulation buttons** to trigger test events (tab switch, face not detected, multiple faces, normal)
- **Real-time AI risk scoring** powered by Llama 3.3-70B running on Cloudflare Workers AI
- **Persistent session memory** stored in a Cloudflare Durable Object — survives reconnects and page refreshes
- **Live event log** streaming AI-generated explanations back to the UI via WebSocket

---

## Architecture

```
Browser (React + TypeScript)
    │
    │  WebSocket (wss://.../api/exam/:sessionId)
    ▼
Cloudflare Worker  ─────── Routes /api/exam/:sessionId ──────►  ExamSessionDO
  (worker/index.ts)                                              (Durable Object)
    │                                                                │
    │  Serves React SPA                                              │  1. Accepts WebSocket
    │  (Cloudflare Static Assets)                                    │  2. Calls Workers AI
    │                                                                │  3. Persists state to DO Storage
    │                                                                │  4. Broadcasts risk_update ◄──┐
    │                                                                │                               │
    │                                                           Workers AI                           │
    │                                                    (Llama 3.3-70B FP8 Fast)                   │
    │                                                                │                               │
    │◄───────────────── WebSocket response ─────────────────────────┘
```

**Data flow per button click:**
1. User clicks "Simulate Tab Switch"
2. React sends `{ eventType: "tab_switch" }` over WebSocket
3. Worker routes the request to the correct `ExamSessionDO` instance (by `sessionId`)
4. DO applies a naive risk delta, then calls Llama 3.3-70B with the event + session history
5. AI returns `{ score, explanation, confidence }` as JSON
6. DO updates `riskScore`, appends to `riskHistory` and `violations`, persists to storage
7. DO broadcasts `risk_update` back over WebSocket
8. React updates the gauge, event log, and violation list in real time

---

## How This Meets the 4 Cloudflare AI-App Requirements

| Requirement | Implementation |
|---|---|
| **LLM / AI inference** | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` called via `env.AI.run()` in the Durable Object for every behavioral event |
| **Coordination / workflow** | `ExamSessionDO` coordinates the full pipeline: receive event → call AI → update state → persist → broadcast |
| **User input** | Four simulation buttons send behavioral events over WebSocket; real webcam feed provides visual monitoring |
| **Memory / persistent state** | Durable Object Storage (`this.state.storage.put('session', …)`) persists `riskScore`, `riskHistory[]`, `violations[]` across evictions and reconnects |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + TypeScript + Tailwind CSS v4 |
| Runtime | Cloudflare Workers (ESM, `compatibility_date: 2026-09-25`) |
| Session state | Cloudflare Durable Objects (SQLite-backed, 1 DO per exam session) |
| AI inference | Cloudflare Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Real-time comms | WebSocket (browser ↔ Durable Object via Worker proxy) |
| Build tool | Vite 8 + `@cloudflare/vite-plugin` |
| Deployment | `wrangler deploy` (Workers + Static Assets) |

---

## Project Structure

```
├── src/                          # React frontend (Vite, served as static assets)
│   ├── pages/
│   │   └── ExamPage.tsx          # Main exam interface
│   ├── components/
│   │   ├── WebcamPreview.tsx     # Live webcam via getUserMedia
│   │   ├── RiskIndicator.tsx     # SVG gauge with animated score
│   │   └── EventLog.tsx          # Scrollable AI event log
│   ├── hooks/
│   │   └── useWebSocket.ts       # WebSocket lifecycle + auto-reconnect
│   ├── types.ts                  # Shared TypeScript interfaces (frontend copy)
│   ├── App.tsx                   # Root component
│   └── index.css                 # Tailwind v4 + global styles
│
├── worker/                       # Cloudflare Worker + Durable Object
│   ├── index.ts                  # Worker entry: routes /api/health, /api/exam/:id
│   ├── ExamSessionDO.ts          # Durable Object: WebSocket + AI + storage
│   └── types.ts                  # Shared TypeScript interfaces (worker copy)
│
├── wrangler.jsonc                # Cloudflare config: AI binding, DO binding, migration
├── vite.config.ts                # Vite + Cloudflare + Tailwind plugins
├── tsconfig.json                 # TypeScript project references
├── tsconfig.app.json             # Frontend tsconfig (targets DOM)
├── tsconfig.worker.json          # Worker tsconfig (targets Workers runtime)
└── package.json
```

---

## Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Start the local dev server (Vite + Wrangler simulate the full stack locally)
npm run dev
```

Open http://localhost:5173 — the full app runs locally including the Durable Object and Workers AI (AI calls go to Cloudflare's API from local).

> **Note:** Workers AI requires a Cloudflare account and wrangler login for local development.
> Run `npx wrangler login` once to authenticate.

---

## Deploying to Cloudflare

```bash
# Build + deploy in one step
npm run deploy

# Or separately:
npm run build
npx wrangler deploy
```

The deploy output will print your live `*.workers.dev` URL.

**First-time deploy checklist:**
- ✅ `wrangler.jsonc` has `"new_sqlite_classes": ["ExamSessionDO"]` in migrations (required for free plan)
- ✅ Workers AI binding declared as `"ai": { "binding": "AI" }`
- ✅ Durable Object namespace binding declared as `"name": "EXAM_SESSION"`

---

## Key Files Explained

### `worker/ExamSessionDO.ts`
The core of the system. Each exam session gets its own DO instance (keyed by `sessionId`). Responsibilities:
- Accepts WebSocket connections via `server.accept()` + `addEventListener`
- Calls Llama 3.3-70B with a structured prompt on every behavioral event
- Applies a 20-second timeout on AI calls — fallback fires on timeout/error
- Persists full session state to DO Storage after every update

### `src/hooks/useWebSocket.ts`
Custom React hook managing the WebSocket lifecycle. Features:
- Auto-reconnects every 3 seconds on disconnect
- Exposes `sendEvent(type)` to trigger behavioral events
- Exposes `status` ('connecting' | 'open' | 'closed' | 'error') for UI indicators

### `wrangler.jsonc`
```jsonc
{
  "ai": { "binding": "AI" },
  "durable_objects": {
    "bindings": [{ "name": "EXAM_SESSION", "class_name": "ExamSessionDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ExamSessionDO"] }]
}
```

---

## Phase 3: Professor Live Monitor & Interventions

### Phase 3a — Live Monitor (Read-Only)
- **ExamHubDO**: One Durable Object instance per `examId` (keyed via `env.EXAM_HUB.idFromName(examId)`).
- **Live Grid**: All students active in an exam are displayed live with thumbnails, risk score gauge, and active statuses.
- **Alert Stream**: Live violation feed with real-time push over WebSockets.

### Phase 3b — Real-Time Interventions
Professors can actively intervene in student sessions directly from the monitor:
1. **Send Warning (`warn`)**:
   - Sends custom or quick-pick templates ("Please look at your screen", "Remove other people from view", "Return to the exam tab").
   - Student page displays a blocking warning modal.
   - Student clicks **"I Understand"**, sending an acknowledgement (`command_ack`) back to the professor dashboard.
2. **Pause / Resume (`pause` / `resume`)**:
   - Pausing freezes the student's exam timer and overlays a full-screen pause banner.
   - While paused, behavioral events are still logged in history but risk scoring and AI calls are frozen.
   - Resuming clears the overlay and resumes normal tracking.
3. **Force Submit (`force_submit`)**:
   - Protected behind a safety dialog (requires typing the student's name to confirm).
   - Terminates the session, halts all webcam tracks and detection loops, exits fullscreen, and permanently locks the session.
4. **Refresh & Reconnect Resilience**:
   - Session status (`paused` / `terminated`) is persisted in Durable Object Storage and `sessionStorage`.
   - Refreshing or reconnecting while paused or terminated immediately restores the locked/frozen screen.

---

## Setting Up Authentication & Secrets (Phase 5a)

The platform uses signed HS256 JWT cookies for role-based authentication and a shared internal secret for Durable Object communication:

### For Cloudflare Production Deployments:
```bash
# 1. JWT secret for user authentication cookies:
npx wrangler secret put JWT_SECRET

# 2. Internal defense-in-depth secret for Durable Object routing:
npx wrangler secret put INTERNAL_SECRET
```

### For Local Development:
Create or edit a `.dev.vars` file in the project root:
```env
INTERNAL_SECRET=my-long-random-internal-secret-token-32bytes-hex
JWT_SECRET=my-long-random-jwt-signing-secret-token-32bytes-hex
```

---

## Setting Up `INTERNAL_SECRET` (Durable Object Internal Defense-in-Depth)

All internal, non-WebSocket HTTP handlers across `ExamSessionDO` and `ExamHubDO` (`/history`, `/command`, `/purge`, `/end`, `/session-event`, `/command-ack`, `/internal/sessions`, `/internal/remove-session`) are strictly protected against unauthorized access. They reject any incoming request with HTTP 403 unless it provides a matching `X-Internal-Auth` header verified via constant-time string comparison.

### For Cloudflare Production Deployments:
Generate a long, cryptographically secure random value (e.g. 64 hexadecimal characters via `openssl rand -hex 32` or Node's `crypto.randomBytes(32).toString('hex')`):
```bash
npx wrangler secret put INTERNAL_SECRET
# Enter your long random secret (e.g., 64-char hex token)
```

### For Local Development:
Add `INTERNAL_SECRET` to your `.dev.vars` file:
```env
INTERNAL_SECRET=my-long-random-internal-secret-token-32bytes-hex
JWT_SECRET=my-long-random-jwt-signing-secret-token-32bytes-hex
```

> **Security Note:** `INTERNAL_SECRET` is used exclusively for internal DO-to-DO, Worker-to-DO, and cron worker communications. It is never logged and never exposed in client responses or public API endpoints.

---

## Phase 4a: D1 Database — Exam Management

Professors can now create, schedule, and manage exams with a shared question bank. All data is stored in Cloudflare D1 (SQLite at the edge).

### Initial Setup (One-Time)

`ash
# 1. Create the D1 database on Cloudflare
npx wrangler d1 create apa-db
# Copy the database_id and paste it into wrangler.jsonc d1_databases[0].database_id

# 2. Apply schema migrations (MUST run before first deploy with D1)
npm run db:migrate:remote

# 3. (Optional) Load sample data locally
npm run db:seed:local
`

### Database Commands

| Command | Description |
|---|---|
| `npm run db:migrate:local` | Apply migrations to local D1 |
| `npm run db:migrate:remote` | Apply migrations to production D1 (run before deploy) |
| `npm run db:seed:local` | Insert sample exam-1 + 5 questions into local D1 |

### API Routes (/api/professor/*)

All routes require authenticated session cookie (`auth_token`) and execute `canAccessExam`.

## Phase 4c-1: Exam-Centric Architecture, Join Codes, & Student Lobby

Phase 4c-1 restructures the platform around the **exam as the container**:
- No global question bank — every question is owned directly by a specific exam (`exam_id`).
- No global exam listing for students — students discover exams exclusively via 8-character join codes (`XXXX-XXXX`).
- Automated student pre-flight lobby (`/student/lobby/:examId`) with camera, fullscreen, and browser readiness checks.
- 5 comprehensive question types: `mcq`, `multi_select`, `fill_in_blank` (with partial credit per blank), `short_answer` (auto or manual), and `long_answer` (manual).

---

### Professor API Routes (`/api/professor/*`)

Requires authenticated session cookie (`auth_token`) with `professor` or `admin` role. Centralized access check via `canAccessExam`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/professor/exams` | List exams owned by the professor with question counts, points, student counts, and derived status |
| POST | `/api/professor/exams` | Create exam (short form, auto-generates join code) |
| GET | `/api/professor/exams/:id` | Get exam details with questions and counts |
| PUT | `/api/professor/exams/:id` | Update exam metadata/settings (duration, schedule, proctoring) |
| DELETE | `/api/professor/exams/:id` | Delete exam (drafts only) |
| POST | `/api/professor/exams/:id/duplicate` | Duplicate exam (copies questions with fresh IDs + generates new join code) |
| POST | `/api/professor/exams/:id/publish` | Publish exam (freezes questions into snapshot) |
| POST | `/api/professor/exams/:id/close` | Close exam (sets `status = 'closed'`, `join_code_active = 0`) |
| POST | `/api/professor/exams/:id/reset` | Reset exam to draft. Supports `{ dryRun: true }` preview. Requires `{ force: true, confirmTitle }` if attempts submitted/graded or results released. Blocks if violations or evidence hold exist. |
| POST | `/api/professor/exams/:id/regenerate-code` | Regenerate join code (draft only) |
| PUT | `/api/professor/exams/:id/toggle-code` | Toggle join code active/inactive |
| GET | `/api/professor/exams/:id/attempts` | List student submissions/attempts for this exam |
| GET | `/api/professor/exams/:id/questions` | List questions owned by this exam |
| POST | `/api/professor/exams/:id/questions` | Create question in this exam |
| PUT | `/api/professor/exams/:id/questions/:qid` | Update question (draft only) |
| DELETE | `/api/professor/exams/:id/questions/:qid` | Delete question (draft only) |
| PUT | `/api/professor/exams/:id/questions/reorder` | Reorder questions in this exam |
| POST | `/api/professor/exams/:id/questions/import` | Copy questions from another exam (fresh IDs, non-shared; requires access to both exams) |

---

### Student API Routes (`/api/student/*`)

Requires authenticated session cookie (`auth_token`) with `student` role (or admin). Enforces enrollment and anti-probing guarantees.

| Method | Path | Description |
|---|---|---|
| POST | `/api/student/join` | Join exam with code (enforces active account, creates `exam_enrollments` record, rate limited) |
| GET | `/api/student/my-exams` | List exams student is enrolled in with status and score |
| GET | `/api/student/exams/:id` | Get exam metadata only (duration, window, title, course). Requires enrollment row (otherwise 404); NEVER returns questions. |
| POST | `/api/student/exams/:id/start` | Start or resume attempt (requires prior enrollment). Returns safe student questions (`toStudentQuestion()`). |
| PUT | `/api/student/attempts/:id/answers` | Autosave answers (batch; rejected if deadline passed or attempt not owned) |
| GET | `/api/student/attempts/:id/time` | Re-sync server-authoritative timer (countdown seconds, paused status; requires attempt ownership) |
| POST | `/api/student/attempts/:id/submit` | Finalize and grade attempt server-side (idempotent; requires attempt ownership) |
| GET | `/api/student/attempts/:id/result` | Retrieve attempt score, status, and optional answer review (if `show_answers = 1`; requires attempt ownership) |

---

### Admin API Routes (`/api/admin/*`)

Requires authenticated session cookie (`auth_token`) with `admin` role.

| Method | Path | Description |
|---|---|---|
| POST | `/api/admin/users` | Create user with explicit role (`student`, `professor`, `admin`) |
| POST | `/api/admin/users/:id/deactivate` | Deactivate user (`active = 0`) and invalidate all active sessions (`token_version + 1`) |
| POST | `/api/admin/claim-legacy-exams` | Assign legacy exams (`created_by IS NULL`) to an admin or designated professor |

---

### UI Routes & Navigation

| Path | Area | Description |
|---|---|---|
| `/student` | Student | Portal: name input, 8-character join code entry, "My Exams" list |
| `/student/lobby/:examId` | Student | Pre-flight lobby: webcam check, fullscreen check, browser check, countdown timer, "Begin Exam" |
| `/exam?exam=:id&name=:name` | Student | Active exam interface: webcam, face AI, tab monitoring, questions, debounced autosave, submit modal, results |
| `/student/exam/:examId` | Student | Direct alias to the unified proctoring & exam taking page |
| `/professor` | Professor | Redirects to `/professor/exams` |
| `/professor/exams` | Professor | Dashboard: derived status badges, join code badges, question/student counts, short "Create Exam" modal, Duplicate, Delete |
| `/professor/exams/:id` | Professor | Container workspace: **Overview** (large join code, copy, regenerate, toggle), **Questions** (reorder, drawer, import modal), **Live Monitor** (scoped live hub), **Submissions** (attempts table), **Settings** (proctoring & timing) |
| `/professor/exams/:id/live` | Professor | Direct link to the scoped Live Monitor |

---

### Answer-Leak Protection Rule

1. **Explicit Allowlist (`toStudentQuestion`)**: Student question responses strictly permit only `id`, `type`, `question_text`, `options`, `points`, `topic`, `difficulty`, `blank_count`, and `word_limit`. The `correct_answer`, accepted answer lists, and blanks arrays are **never** copied, spread, or returned to student endpoints.
2. **Snapshot Immutability**: Active exams load questions strictly from `exam_questions.snapshot_json` frozen at publish time, never from live draft questions.
3. **Automated Unit Tests**: Vitest suite (`npm test`) verifies that no student-facing API payload contains answer fields or leakage in any form across all 5 question types.
4. **Server-Side Grading & Timing**: Scoring is executed purely on Cloudflare Workers edge using server timestamps and 5-second grace handling. Client timers and timestamps are never trusted.

---

### Legacy Authentication History (Pre-Phase 5a)

Prior to Phase 5a, the platform operated with temporary development secrets and unauthenticated student identifiers (`?name=`):

1. **Unauthenticated Name Collisions**:
   - Enrollment and attempts were keyed on `(exam_id, student_name)` in D1 SQLite.
   - Anyone typing an existing student's exact name resumed that student's attempt.
2. **Incognito Pause State**:
   - Professor interventions (`pause` / `resume`) were tracked per `sessionId` in Durable Object memory.

> **Resolution:** Both limitations were eliminated in **Phase 5a (Authentication & RBAC)**, where attempts, sessions, and proctoring interventions are bound to authenticated student accounts and JWT tokens.

---

## Phase 4c-2a: Manual Grading, Results Release, & Server-Side Auto-End

Phase 4c-2a delivers full post-exam lifecycle management:

1. **Manual Grading Workflows**:
   - **"By Student" mode**: Grade all questions for one student with submission metadata, previous comments, and real-time score total updates.
   - **"By Question" mode**: Grade one question across all students sequentially to maintain consistent grading standards.
   - **Blind Grading toggle**: Masks student names with randomized identifiers (`Student A`, `Student B`) and hides session IDs to prevent bias.
   - **Auto-Zero Rule**: Manual questions left blank or unanswered by the student automatically receive 0 points and `grading_source = 'manual'` upon submission, preventing false "pending" backlogs.
   - **Grade Overrides**: Auto-graded `short_answer` and `fill_in_blank` questions allow professor overrides (`grading_source = 'override'`), preserving the original `auto_points`. `mcq` and `multi_select` cannot be manually overridden.
   - **Point Validation**: Points must be within `[0, question.points]` and must be multiples of 0.25.

2. **AI-Assisted Suggest-Grade**:
   - Professors can click **"Suggest Grade"** on manual answers (`short_answer`, `long_answer`).
   - Powered by Cloudflare Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`).
   - Grounded strictly on the question text, max points, student answer, and the optional professor **rubric**.
   - **Security**: Prompt-injection defensive system framing, zero-shot structured JSON parsing, strict clamping of output points to `[0, question.points]`, and a server-side rate limit of **20 AI suggestions per minute per exam** (`429 Too Many Requests`).

3. **Results Release Gating (4 States)**:
   - Results are held by default (`results_released = 0`).
   - **State 1 (`submitted_pending_release`)**: Results unreleased, exam not configured for instant results. Student sees confirmation that submission was received.
   - **State 2 (`being_graded`)**: Results either released or instant results enabled, but manual questions remain ungraded (`fully_graded = 0`). Student sees that grading is actively in progress.
   - **State 3 (Instant Results)**: `instant_results = 1` on fully auto-graded exams (`fully_graded = 1`). Score is immediately available upon submission without professor action.
   - **State 4 (Released)**: Professor clicks **"Release Results"** (`results_released = 1`). Full score is revealed. If `show_answers = 1`, question review is included. Rubrics and internal model answers are **never** leaked.

4. **Server-Side Auto-End (Scheduled Cron)**:
   - A Cloudflare Worker scheduled cron (`triggers.crons = ["* * * * *"]`) executes `runAutoEndSweep` every 60 seconds.
   - **Unpaused expired attempts**: Finds attempts where `status = 'in_progress'`, `paused_at IS NULL`, and `deadline_at < datetime('now', '-30 seconds')` (grace period), and submits them as `auto_submitted`.
   - **Abandoned paused attempts**: Paused attempts past `exam.end_time + 24 hours` are safely swept.
   - **Local Testing**:
     ```bash
     npx wrangler dev --test-scheduled
     # Trigger cron manually in another terminal:
     curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
     ```

---

### Professor Grading API Routes (`/api/professor/*`)

All routes require authenticated session cookie (`auth_token`) and execute `canAccessExam`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/professor/exams/:id/submissions` | List exam attempts with `needs_grading_count`, `fully_graded`, scores, and submission timestamps |
| GET | `/api/professor/attempts/:attemptId/grading` | Full attempt in grading view: questions, rubrics, student answers, awarded points, auto points, grader comments |
| GET | `/api/professor/exams/:id/grading/questions/:qid?blind=1` | All student answers for one question with optional blind grading alias masking |
| PUT | `/api/professor/attempts/:attemptId/answers/:qid/grade` | Grade or override an answer: validates points (0..max, step 0.25) and recomputes total score |
| POST | `/api/professor/attempts/:attemptId/answers/:qid/suggest-grade` | AI-assisted score and feedback suggestion (rate limited to 20/min/exam) |
| POST | `/api/professor/exams/:id/release-results` | Publish scores to students (`results_released = 1`) |
| POST | `/api/professor/exams/:id/unrelease-results` | Revert score release back to pending |

---

## Phase 4c-2b: Session Lifecycle, Retention & Test Previews

Phase 4c-2b introduces comprehensive session lifecycle management, enterprise data retention sweeps, preview testing, and multi-state delete/archive rules.

### 1. Session Views & Live Isolation
The Live Monitor tab now isolates truly active sessions from past history using a segmented control:
- **Live**: In-progress student attempts only (`active`, `paused`, `disconnected`). Ended sessions are automatically removed upon submission, termination, or auto-end.
- **Ended**: Finished non-test, non-archived attempts (`submitted`, `auto_submitted`, `terminated`). Shows student, ended reason, final risk score, violation count, duration, and completion timestamp.
- **Archived**: Hidden past attempts. Supports one-click **Unarchive** and **Evidence Hold** toggles.
- **Test**: Test attempts created via "Preview Exam". Displays a `TEST` badge and features dedicated single/bulk deletion.
- **Unlinked**: Legacy hub sessions without a matching D1 attempt record. Supports individual and bulk "Clear All Unlinked".

### 2. Archive vs. Clear vs. Delete Rules

| Action | Allowed When | What It Does | Answers & Scores | Telemetry (Webcam / Violations) |
|---|---|---|---|---|
| **Archive** | Any ended attempt (or test attempt) | Hides from Ended view and default counts. Reversible via Unarchive. | Preserved intact | Preserved intact |
| **Clear Telemetry** | `violation_count = 0` strictly | Removes webcam snapshots, violation history, and Durable Object storage. Sets `data_purged_at`. | Preserved intact | Purged |
| **Permanent Delete** | `violation_count = 0` AND `evidence_hold = 0` (or test attempt) | Permanently deletes attempt and cascades deletion to all answer records. Purges DO storage and hub. Requires typing student name to confirm. | Deleted | Purged |

> **Academic Integrity Guard**: Attempts with recorded violations (`violation_count > 0` or `NULL` unknown) **cannot** be cleared or permanently deleted by professors. They can only be archived. Permanent deletion for violation-flagged sessions is restricted to enterprise retention sweeps or the Phase 5 admin panel.

### 3. Student Preview Mode (Test Attempts)
Professors can test their exam before or after publishing without corrupting student statistics:
- **Button in Header**: "Preview Exam" available for both `draft` and `published` exams.
- **Options**:
  - **Questions only (no webcam)**: Skips camera permissions, face recognition, and fullscreen enforcement for quick testing of question layout, inputs, and auto-grading.
  - **Full proctoring test**: Runs camera setup, facial AI, behavioral tracking, and streams live telemetry to the **Test** tab in the Live Monitor.
- **Isolation Guarantees**:
  - Flagged in database with `is_test = 1` and unique generated name `Preview-XXXX`.
  - Excluded from submissions table by default (revealed with `[ ] Show test attempts` checkbox).
  - Excluded from student score averages, "needs grading" counts, grade releases, and student-facing portals.
  - Test attempts can be deleted anytime without student name confirmation.

### 4. Enterprise Data Retention & Nightly Sweep
- **Exam Retention Setting**: `retention_days` configured in Exam Settings (default 90 days; `0` keeps forever).
- **Scheduled Daily Cron (`0 3 * * *`)**:
  - Evaluates completed attempts where `ended_at < now - retention_days`.
  - Skips attempts with `evidence_hold = 1` or exams with `retention_days = 0`.
  - Purges proctoring telemetry from Durable Object storage and Hub memory, setting `data_purged_at`.
  - Automatically deletes orphaned test attempts older than 24 hours.
  - Logs a summary entry to `audit_log`.
- **Local Retention Cron Testing**:
  ```bash
  npx wrangler dev --test-scheduled
  # Trigger minute cron (auto-end sweep):
  curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
  # Trigger daily cron (retention sweep):
  curl "http://localhost:8787/__scheduled?cron=0+3+*+*+*"
  ```

### 5. Audit Logging & Security
- **Audit Log Table (`audit_log`)**: All lifecycle mutations (`archive_session`, `unarchive_session`, `hold_session`, `clear_session_data`, `delete_attempt`, `delete_test_attempt`, `clear_unlinked_sessions`, `retention_sweep`, `reset_exam`) append immutable records with timestamp, actor user ID (`actor_user_id`), target identifier, client IP, and metadata JSON (`meta_json`).
- **DO Purge Protection**: `ExamSessionDO`'s `POST /purge` route is strictly internal to Cloudflare's edge network and is completely unreachable from public worker routing.

---

## Phase 5a: Authentication, Roles, Exam Ownership & Session Binding

Phase 5a replaces shared pre-shared keys and client-supplied student names with a hardened, edge-native authentication and role-based access control system.

### 1. Security & Authentication Layer
- **Roles**: `student`, `professor`, `admin`.
- **Password Hashing**: Web Crypto PBKDF2 with SHA-256, 100,000 iterations, and a 16-byte cryptographically secure random salt. Uses constant-time comparison to prevent timing side-channels.
- **Timing Parity on Unknown Emails**: Failed login attempts on non-existent emails compute a dummy 100k-iteration PBKDF2 hash before returning to ensure uniform execution timing.
- **Brute-Force & Lockout Protection**: 5 failed login attempts targeting an email address within 15 minutes triggers an immediate `429 Too Many Requests` lockout. A separate loose IP throttle (50 failed logins per 15 minutes per IP) prevents distributed brute-forcing without locking out shared campus networks.
- **Sessions & Tokens**:
  - Signed HS256 JWTs using `JWT_SECRET`.
  - 8-hour expiration (`exp`), subject bound to `users.id`, role claim, and `token_version` (`tv`).
  - Delivered via an `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=28800` cookie named `auth_token` (`Secure` flag added in production/HTTPS).
  - Instant session revocation via `token_version` incrementing on password changes or administrative deactivations (`POST /api/admin/users/:id/deactivate`).
- **CSRF & Cross-Site WebSocket Protection**:
  - `verifyOrigin` enforces that the `Origin` header matches the request host on all mutating requests (`POST`, `PUT`, `DELETE`) and all WebSocket upgrade requests (`Upgrade: websocket`). Violations return `403 Forbidden` and append to `audit_log`.
- **WebSocket Upgrade Defense**:
  - Forwarded internal URLs (`http://session.internal/` and `http://hub.internal/ws`) are reconstructed exclusively with verified JWT claims (`userId`, `role`, `tokenVersion`), stripping any client-supplied spoofed parameters.
- **Exam Reset & Lifecycle Guarantees**:
  - `POST /api/professor/exams/:id/reset` provides dry-run preview (`dryRun: true`), requires confirmation with exact exam title and `force: true` when attempts exist or results are released, and strictly refuses reset if violation or evidence-hold records exist.

### 2. Multi-Tenant Professor Isolation (`canAccessExam`)
- Every exam-scoped route verifies ownership:
  - Accessible if `user.role === 'admin'` OR `exam.created_by === user.id`.
  - Non-owners receive a strict **`404 Not Found`** (never `403`) to completely prevent exam enumeration.
  - Legacy exams with `created_by = NULL` are visible exclusively to admins until explicitly claimed via `POST /api/admin/claim-legacy-exams`.

### 3. Student Session Binding & Single Active Connection
- **Zero Client Name Trust**: Student names and IDs are loaded server-side from the authenticated user record. Client-supplied student names are ignored.
- **Server-Generated Session IDs**: Session IDs are generated as `sess-${crypto.randomUUID()}` upon attempt creation.
- **One Live Connection per Session**:
  - `ExamSessionDO` terminates prior WebSocket connections with close code `4001` (`"session_replaced"`) when a new window or tab connects to the same session.
  - The client displays a non-dismissible `DuplicateWindowOverlay` explaining that the exam is active in another window.

### 4. In-Exam 401 Re-Authentication & Clean Logout
- **Graceful Token Expiration Handling**:
  - If a student's session expires mid-exam during autosave or navigation, a `SessionExpiredModal` appears.
  - Autosave queues and in-memory answers are preserved intact without data loss.
  - The student can re-authenticate with their password directly within the modal; upon success, pending answer buffers are immediately flushed.
- **Mid-Exam Logout**:
  - Exits fullscreen mode and stops all webcam hardware media tracks.
  - Cancels behavioral polling intervals.
  - Leaves the attempt in its current `in_progress` state so it can be resumed later.
  - Calls `POST /api/auth/logout` and redirects to `/login`.

### 5. CLI Tool for Account Bootstrapping
Initial administrator and staff accounts can be created securely via the CLI script:
```bash
# Interactive hidden password prompt (never logged to history or console):
npm run user:create -- --role admin --email admin@university.edu --name "System Administrator"

# For remote production D1:
npm run user:create -- --role admin --email admin@university.edu --name "System Administrator" --remote
```

---

## Phase 5c: Landing Page, Student & Professor Dashboards, Privacy Notice & Results Analytics

Phase 5c introduces dedicated, role-specific portals, streamlined navigation without manual URL typing, an enforceable student privacy consent model, account management with password changes, exam archiving, and exportable analytics.

### 1. D1 Migration (`0007_dashboards.sql`)
- **`users` table**:
  - `privacy_accepted_at TEXT` (nullable ISO-8601 UTC timestamp).
  - `password_changed_at TEXT` (nullable ISO-8601 UTC timestamp).
- **`exams` table**:
  - `archived INTEGER NOT NULL DEFAULT 0` (0 = active, 1 = archived).
  - `archived_at TEXT` (nullable ISO-8601 UTC timestamp).
- **Performance index**:
  - `idx_exams_created_by_archived ON exams(created_by, archived)`.

### 2. Change Password Flow (`POST /api/auth/change-password`)
- Authenticated endpoint available to all roles (`student`, `professor`, `admin`).
- Verifies `currentPassword` against stored PBKDF2 hash using constant-time comparison.
- Enforces 10 to 128 character password length.
- Generates a fresh 16-byte cryptographically random salt and 100,000-iteration PBKDF2 SHA-256 hash.
- **Session Revocation**: Increments `token_version` in D1, invalidating all other active JWT sessions across devices immediately.
- Re-issues a fresh `auth_token` cookie for the current session.
- **Rate Limiting**: 5 incorrect password attempts within 15 minutes returns `429 Too Many Requests`.
- Appends an audit log record with `action: 'change_password'`. Passwords are never logged or returned.

### 3. Student Privacy Notice & Consent Gate
- **Enforcement**:
  - `POST /api/student/join` and `POST /api/student/exams/:id/start` verify `privacy_accepted_at` on the student account.
  - Returns `403 Forbidden` with `{ code: 'privacy_required' }` if unaccepted.
  - Professor preview attempts (`is_test = 1`) are strictly exempt.
- **Consent Modal & Page (`/student/privacy`)**:
  - Plain-language explanation of monitored signals (webcam frames, face detection, tab switches, fullscreen status, copy/paste).
  - Clear statement of data storage (edge-only Cloudflare D1/DO, automated retention purges, no third-party selling or ad profiling).
  - Explicit explanation of Cloudflare Workers AI model inference.
  - One-click consent button (`POST /api/student/accept-privacy`) logging acceptance timestamp.

### 4. Role-Specific Portals & Navigation
- **Landing Page (`/`)**:
  - Clean overview of features for students and professors.
  - Automatically redirects authenticated users to their respective home dashboard (`/student` or `/professor`).
- **Student Portal (`/student`)**:
  - Top navigation bar (`StudentNav`) with links to Home, System Check, FAQ Help, Profile, and Sign Out (no professor links).
  - **Join Card**: Input field for 8-character exam code; clears error messages as soon as the student edits the code.
  - **In-Progress Section**: Direct "Resume Exam" cards with elapsed time indicators.
  - **Upcoming & Joined Section**: Enrolled exams with live countdown timers, start/end windows, and durations.
  - **Past Exams Section**: Complete exam history showing submission status, final score, percentage, and direct links to view released results.
  - **System Readiness Check (`/student/system-check`)**: Self-service diagnostics for camera hardware, fullscreen permission, modern browser compatibility, and edge network latency to `/api/health`. Results persist in `localStorage`.
  - **Student Profile (`/student/profile`)**: Update display name, student ID number, change account password, and view privacy policy.
  - **Help & FAQ (`/student/help`)**: Common questions regarding proctoring, system requirements, interruptions, and academic integrity.
- **Professor Dashboard (`/professor`)**:
  - Top navigation bar (`ProfessorNav`) linking to Dashboard, Exam Management, Profile, and Sign Out.
  - **Summary Cards**: Real-time metrics for *Live Now*, *Upcoming*, *Needs Manual Grading*, and *Flagged for Violations*.
  - **Needs Attention Queue**: Prioritized list of exams requiring grading or review with direct jump links.
  - **Exam Management Cards**: Organized under tabs (*All*, *Draft*, *Scheduled*, *Live*, *Ended*, *Archived*) with live search, sorting (creation date, start date, title), and direct navigation to Exam Editor, Live Monitor, or Submissions.
  - **Archiving Lifecycle**:
    - `POST /api/professor/exams/:id/archive`: Archives past or draft exams, deactivating the join code. Refuses with `409 Conflict` if the exam is currently live.
    - `POST /api/professor/exams/:id/unarchive`: Restores archived exams.
- **Custom 404 Page (`NotFoundPage`)**: Role-aware fallback preventing unintended route leaking.

### 5. Results Analytics & Secure CSV Export
- **Results Tab Analytics**:
  - Score distribution bar chart visualizing score ranges across student submissions.
  - Question-by-question auto-graded accuracy rates (% of students answering correctly) with difficulty indicators.
- **CSV Results Export (`GET /api/professor/exams/:id/results.csv`)**:
  - Generates download of student grades: Student Name, Student ID, Email, Score, Max Score, Percentage, Status, Violations, Submitted At.
  - **Spreadsheet Formula Injection Defense**: Prepend single quote (`'`) to any text field starting with `=`, `+`, `-`, or `@` to prevent remote code or formula execution in Excel/Google Sheets.
  - Test attempts (`is_test = 1`) are excluded.
  - Proctored telemetry snapshots, answer contents, and AI internal reasoning are omitted.
  - Appends an audit log entry for the export event.

### 6. Known Scope Limitations
- Password reset via email and email verification are intentionally not implemented (requires email delivery integration).
- Proctoring time extensions, broadcast messaging, and pre-uploaded student rosters are scheduled for future milestones.

## Phase 6: Integrity Reports, Review Queue, Human Decisions & Print/PDF Views

Phase 6 provides professors and academic integrity administrators with formal, auditable review tooling. After or during an exam, professors can open an in-depth integrity report for any attempt, inspect timeline risk score progression, review AI-flagged violations, confirm or dismiss individual events, record a binding human decision with notes, and print or export a clean PDF record.

### 1. D1 Migration (`0008_reports.sql`)
- **`attempts` table**:
  - `review_decision TEXT CHECK (review_decision IS NULL OR review_decision IN ('no_action', 'warning', 'escalate'))`: Recorded decision by human reviewer.
  - `review_note TEXT`: Contextual notes and justification (up to 2,000 characters).
  - `reviewed_at TEXT`: ISO-8601 UTC timestamp of the review decision.
  - `reviewed_by TEXT`: User ID of the reviewer.
  - Index: `CREATE INDEX IF NOT EXISTS idx_attempts_review_decision ON attempts(review_decision)`.
- **`violation_reviews` table**:
  - `attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE`.
  - `violation_id TEXT NOT NULL`.
  - `decision TEXT NOT NULL CHECK (decision IN ('confirmed', 'dismissed'))`.
  - `reviewed_by TEXT NOT NULL`, `reviewed_at TEXT NOT NULL`.
  - Composite primary key on `(attempt_id, violation_id)` enabling idempotent upserts.
  - Index: `idx_violation_reviews_attempt`.

### 2. Review Level Pure Function & Reasoning Rules
Review levels are determined objectively by `computeReviewLevel(...)` and explained via `getReviewReasons(...)` in `worker/utils/reviewLevel.ts`:
- **`unknown`**: When `violationCount` is `NULL` or `undefined` (legacy attempt or incomplete write). Labeled as *"Not recorded"*.
- **`high`**:
  - `finalRiskScore >= maxRiskScore` (boundary at exam threshold, e.g. 80).
  - `maxSeverity === 'critical'`.
  - Identity mismatch (`identity_mismatch`) or multiple faces (`multiple_faces`) detected during the attempt.
- **`medium`**:
  - `maxSeverity === 'high'`.
  - `violationCount >= 3`.
- **`low`**:
  - `violationCount >= 1` (minor violations with low/medium severity).
- **`none`**:
  - Clean attempt with 0 violations and risk score below threshold.

> **Academic Integrity Standard**: The review level is strictly a prompt for human review, never an automated verdict. The system never uses defamatory terms such as "cheating" or "guilty". All automated signals are treated as evidence to be reviewed by authorized instructors.

### 3. Report & Review Queue API Endpoints
- **`GET /api/professor/attempts/:attemptId/report`**:
  - Access restricted to exam owner (`canAccessExam`) or administrators. Non-owners receive `404 Not Found`. Test attempts (`is_test = 1`) are restricted solely to their creator.
  - Retrieves proctoring history from `ExamSessionDO` via internal authenticated channel (`X-Internal-Auth`).
  - Merges human review decisions from `violation_reviews`.
  - Appends an audit log record with `action: 'view_report'`.
  - **Information Protection**: Strictly omits student answers, correct answer rubrics, passwords, and tokens.
- **`PUT /api/professor/attempts/:attemptId/review`**:
  - Restricts review decision submissions to **ended attempts only**; returns `409 Conflict` if the attempt is still in progress.
  - Validates payload with Zod (`decision: 'no_action' | 'warning' | 'escalate' | null`, `note`: max 2,000 characters).
  - Allows clearing a decision with `decision: null`.
  - Appends an audit log record with `action: 'review_attempt'`.
- **`PUT /api/professor/attempts/:attemptId/violations/:violationId/review`**:
  - Requires the `violationId` to exist in the attempt's proctoring history (returns `404` if not found).
  - Upserts into `violation_reviews` with `decision: 'confirmed' | 'dismissed' | null`.
  - Dismissing or confirming an item does not rewrite DO telemetry or scores; it only annotates the report. Struck-through styling indicates dismissed events in the UI without hiding them.
  - Appends an audit log record with `action: 'review_violation'`.
- **`GET /api/professor/exams/:id/review`**:
  - Fetches review queue for an exam filtered by `level` and `status` (`unreviewed`, `reviewed`, `all`).
  - Computed purely from D1 columns (no DO calls) and sorted by urgency level rank, then final risk score descending.
  - Excludes test attempts (`is_test = 0`) and archived attempts (`archived = 0`) by default.
- **`GET /api/professor/review`**:
  - Cross-exam review queue for all accessible exams with exam metadata columns.

### 4. Report UI & Print/PDF View (`/professor/attempts/:attemptId/report`)
- **Header**: Exam details, student identification, duration, final risk score badge, and review level chip with expandable "Why flagged" explanation.
- **Risk Timeline SVG Chart**: Inline vector line chart showing risk score evolution over time with red triangle markers for violations, blue diamond markers for interventions, and a dashed line at the exam's risk threshold.
- **Accessible Table Fallback**: One-click toggle displaying raw timeline timestamps, scores, and triggers in an accessible HTML table.
- **Flagged Violations Table**: Lists time, type, severity, duration, AI confidence, plain-text explanations, and immediate Confirm/Dismiss toggle buttons.
- **Intervention History**: Complete log of warnings, pauses, resumes, and force-submits with student acknowledgment timestamps.
- **Decision Panel**: Clean interface to select No Action, Warning, or Escalate with justification notes.
- **Retention Interaction**: If detailed evidence was purged under the retention policy (`data_purged_at` is set), displays a prominent banner (*"Detailed evidence was removed by the retention policy. Only the summary below is available."*) while preserving the D1 score and violation count summary.
- **Print / Save as PDF**:
  - Pure client-side `window.print()` trigger styled via `@media print`.
  - Automatically hides navigation, toolbars, and buttons; renders black text on clean white backgrounds; avoids page breaks inside table rows.
  - Includes authoritative decision-aid footer:
    > *"This report is a decision aid. Flags are generated automatically and require human review."*

### 5. Known Scope Boundaries (Phase 6)
- The Admin Panel (Phase 7), audio monitoring, screenshot storage, ID photo matching, and student-facing integrity reports were handled separately or remain out of scope. Students never receive integrity reports, risk scores, or violation records.

---

## Phase 7: Admin Panel, Governance, Audit Logging & Cron Health

Phase 7 delivers a centralized administration and governance suite for the Autonomous Proctoring Agent platform. Administrators can manage user accounts, oversee all exams across professors, inspect append-only audit trails, analyze authentication security metrics and account lockouts, and monitor background cron sweeps without manual database queries.

### 1. D1 Migration (`0009_admin.sql`)
- **`cron_runs` table**:
  - `job TEXT PRIMARY KEY`: Identifier for scheduled sweep (`auto_end_sweep`, `retention_sweep`).
  - `last_run_at TEXT`: ISO-8601 UTC timestamp of the most recent execution.
  - `last_ok INTEGER`: Boolean flag (1 = success, 0 = failed).
  - `last_count INTEGER`: Number of records processed or purged.
  - `last_error TEXT`: Error message if run failed, or `NULL`.
- **Performance Indexes**:
  - `idx_users_role_active ON users(role, active)`: Accelerates user filtering and active administrator counts.
  - `idx_audit_log_action_ts ON audit_log(action, ts)`: Fast lookup and filtering by audit action and time.
  - `idx_audit_log_actor_ts ON audit_log(actor_user_id, ts)`: Fast lookup by acting user and timestamp.
- **Append-Only Audit Log Triggers**:
  - `audit_log_no_update`: `BEFORE UPDATE ON audit_log` raises `ABORT('audit_log is append-only')`.
  - `audit_log_no_delete`: `BEFORE DELETE ON audit_log` raises `ABORT('audit_log is append-only')`.
  - Protects audit trail integrity directly at the SQLite storage layer; entries can only be inserted, never modified or erased.
- **Timestamps**:
  - All timestamps are ISO-8601 UTC strings generated in the Cloudflare Worker application code (e.g. `new Date().toISOString()`), avoiding local timezone drift or SQLite `datetime()` discrepancies.

### 2. Admin API Endpoints (`/api/admin/*`)
All admin endpoints strictly require `requireAuth(['admin'])`. Unauthenticated requests return `401 Unauthorized`; authenticated requests by professors or students return `403 Forbidden`.

| Method | Path | Description & Guarantees |
|---|---|---|
| `GET` | `/api/admin/overview` | Platform-wide metrics: user counts by role/status, exams by status and archived state, attempts started in last 24h & 7d, current in-progress count, submissions waiting for manual grading, unreviewed flagged attempts, and `cron_runs` entries with `age_seconds`. D1 only, excludes test attempts (`is_test = 0`). |
| `GET` | `/api/admin/users` | Keyset-paginated directory of users (max 50/page). Supports search by email or name with SQL wildcard escaping (`%`, `_`, `\`), and filtering by role (`student`, `professor`, `admin`) and status (`active`, `inactive`). Never returns `password_hash`, `password_salt`, or `token_version`. |
| `POST` | `/api/admin/users` | Creates staff accounts (`professor` or `admin` only). Hashes password with PBKDF2-SHA256 (100,000 iterations, 16-byte random salt). Appends `create_user` audit entry. |
| `POST` | `/api/admin/users/:id/deactivate` | Deactivates a user (`active = 0`) and increments `token_version` by 1 to immediately revoke all existing JWTs. Refuses self-deactivation with `409` (`cannot_deactivate_self`). Refuses deactivating the last active administrator with `409` (`last_admin`). Returns `404` for unknown user. Appends `deactivate_user` audit entry. |
| `POST` | `/api/admin/users/:id/reactivate` | Reactivates a user (`active = 1`) and increments `token_version` by 1. Returns `404` for unknown user. Appends `reactivate_user` audit entry. |
| `GET` | `/api/admin/exams` | Global exam list with owner name/email, join code status, archived status, and counts of enrolled, submitted, and in-progress attempts (excluding test attempts). Supports search, status filtering, and keyset pagination. |
| `POST` | `/api/admin/exams/:id/reassign` | Reassigns `exams.created_by` to an active professor or administrator. Refuses with `409` (`exam_in_progress`) if student attempts are currently in progress. Submissions, answers, and integrity reviews remain untouched. Appends `reassign_exam` audit entry recording old and new owner. |
| `GET` | `/api/admin/audit` | Keyset-paginated audit entries (max 100/page). Filterable by `action`, `actor`, `target`, `from`, and `to`. Resolves actor name and email. Returns `meta_json` as a raw string without server interpretation. Viewing the audit log is not self-logged to avoid log inflation. |
| `GET` | `/api/admin/security/failed-logins` | Failed login metrics grouped by target email and client IP over a window of 1 to 168 hours. Excludes change-password attempts (`email LIKE 'pwd:%'`). Lists currently locked accounts (>= 5 failures in the last 15 minutes). |

### 3. Admin UI & Navigation
- **Navigation & Role Guarding**:
  - Upon login, users with the `admin` role land directly on `/admin`.
  - The navigation header displays the **Admin Navigation Bar** (`AdminNav`) with links to **Overview**, **Users**, **Exams**, **Audit**, and **Security**, plus a quick link to the Professor Portal (`/professor`).
  - Professors and students accessing `/admin/*` receive the platform's standard `403 Forbidden` page with no administrative UI or links exposed.
- **Admin Pages**:
  - **Overview (`/admin`)**: Summary metric cards (Users, Exams, In-Progress Attempts, Attention Items) and the **Background Cron Sweeps** status board. Shows health status, execution age, and processed counts for `auto_end_sweep` and `retention_sweep`. Emits a red warning alert if the auto-end sweep is older than 5 minutes or the retention sweep is older than 26 hours.
  - **User Directory (`/admin/users`)**: Search bar, role filter dropdown, active/inactive status filter, and keyset pagination. Includes a **"Create staff account"** modal with role selection (`professor` or `admin`), 10+ character password strength indicator, and an explicit advisory reminding the admin to share credentials securely. Includes **Deactivate** and **Reactivate** confirmation dialogs with buttons automatically disabled if the action would violate self-deactivation or last-admin rules.
  - **Exam Management (`/admin/exams`)**: Searchable, paginated directory of all platform exams. Features a **"Reassign Owner"** modal allowing selection of any active professor or administrator, with the submit button disabled and an explanatory warning if the exam has live student attempts.
  - **Audit Log Viewer (`/admin/audit`)**: Action filter, actor filter, target filter, and date range filters with keyset pagination. Rows expand to display formatted, plain-text `meta_json` details.
  - **Security & Failed Logins (`/admin/security`)**: Time window selector (1h, 6h, 24h, 7d). Displays locked accounts requiring attention, top targeted email addresses, and top offending IP addresses.
- **Plain-Text XSS Defense**:
  - All dynamic data across the Admin UI (user names, emails, exam titles, IDs, error messages, and audit metadata) is rendered strictly as plain text (no `dangerouslySetInnerHTML`), ensuring that injection strings like `<script>` or `=cmd` are displayed safely as raw text.

### 4. Governance & Self-Protection Rules
1. **Self-Deactivation Protection**: An administrator cannot deactivate their own account (`cannot_deactivate_self`).
2. **Last Administrator Protection**: An administrator cannot deactivate the last active administrator on the platform (`last_admin`), preventing administrative lockout.
3. **Live Exam Reassignment Protection**: Exams cannot be reassigned while student attempts are actively in progress (`exam_in_progress`), preventing race conditions and split ownership during active testing.
4. **Token Revocation Guarantee**: Deactivating or reactivating a user increments their `token_version` in D1, immediately invalidating any active JWT cookies and forcing re-authentication.
5. **Append-Only Immutability**: SQLite triggers reject any `UPDATE` or `DELETE` against the `audit_log` table. Entries are permanent records of administrative and security events. Passwords, secrets, and authorization tokens are strictly excluded from audit entries.

### 5. Creating the Initial Administrator Account
Because the platform does not allow self-registration for administrative accounts, the initial administrator must be provisioned via the secure CLI bootstrapping script:

```bash
# Create initial admin account locally:
node scripts/create-user.mjs --role admin --email admin@example.com --name "System Administrator"

# Create initial admin account remotely (production):
node scripts/create-user.mjs --role admin --email admin@example.com --name "System Administrator" --remote
```

The script will securely prompt for a password with input masking:
- Enforces 10 to 128 character password length.
- Requires confirmation to prevent typos.
- Generates a cryptographically random 16-byte salt (`crypto.randomBytes(16)`).
- Derives a PBKDF2-SHA256 hash using 100,000 iterations.
- Inserts the user record into Cloudflare D1 with `role = 'admin'`, `active = 1`, and `token_version = 0`.





