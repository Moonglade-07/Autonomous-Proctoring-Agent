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

## Setting Up `PROFESSOR_KEY` (Security Guard)

The professor dashboard and hub endpoints are protected by a shared secret key until Phase 5 authentication is introduced:

### For Cloudflare Production Deployments:
```bash
npx wrangler secret put PROFESSOR_KEY
# Enter your secret key (e.g., "my-secret-prof-key")
```

### For Local Development:
Create or edit a `.dev.vars` file in the project root:
```env
PROFESSOR_KEY=my-secret-prof-key
```

When navigating to `/professor`, the dashboard prompts for the key once, saves it in `sessionStorage`, and connects to the hub WebSocket with `?key=...`. Mismatches are rejected with HTTP 401 Unauthorized.

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
PROFESSOR_KEY=my-secret-prof-key
INTERNAL_SECRET=my-long-random-internal-secret-token-32bytes-hex
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

All routes require X-Professor-Key header matching PROFESSOR_KEY secret.

## Phase 4c-1: Exam-Centric Architecture, Join Codes, & Student Lobby

Phase 4c-1 restructures the platform around the **exam as the container**:
- No global question bank — every question is owned directly by a specific exam (`exam_id`).
- No global exam listing for students — students discover exams exclusively via 8-character join codes (`XXXX-XXXX`).
- Automated student pre-flight lobby (`/student/lobby/:examId`) with camera, fullscreen, and browser readiness checks.
- 5 comprehensive question types: `mcq`, `multi_select`, `fill_in_blank` (with partial credit per blank), `short_answer` (auto or manual), and `long_answer` (manual).

---

### Professor API Routes (`/api/professor/*`)

Requires `X-Professor-Key` header. Centralized access check via `canAccessExam`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/professor/exams` | List exams with question counts, points, student counts, and derived status |
| POST | `/api/professor/exams` | Create exam (short form, auto-generates join code) |
| GET | `/api/professor/exams/:id` | Get exam details with questions and counts |
| PUT | `/api/professor/exams/:id` | Update exam metadata/settings (duration, schedule, proctoring) |
| DELETE | `/api/professor/exams/:id` | Delete exam (drafts only) |
| POST | `/api/professor/exams/:id/duplicate` | Duplicate exam (copies questions with fresh IDs + generates new join code) |
| POST | `/api/professor/exams/:id/publish` | Publish exam (freezes questions into snapshot) |
| POST | `/api/professor/exams/:id/regenerate-code` | Regenerate join code (draft only) |
| PUT | `/api/professor/exams/:id/toggle-code` | Toggle join code active/inactive |
| GET | `/api/professor/exams/:id/attempts` | List student submissions/attempts for this exam |
| GET | `/api/professor/exams/:id/questions` | List questions owned by this exam |
| POST | `/api/professor/exams/:id/questions` | Create question in this exam |
| PUT | `/api/professor/exams/:id/questions/:qid` | Update question (draft only) |
| DELETE | `/api/professor/exams/:id/questions/:qid` | Delete question (draft only) |
| PUT | `/api/professor/exams/:id/questions/reorder` | Reorder questions in this exam |
| POST | `/api/professor/exams/:id/questions/import` | Copy questions from another exam (fresh IDs, non-shared) |

---

### Student API Routes (`/api/student/*`)

No professor key required. Anti-probing and rate-limited.

| Method | Path | Description |
|---|---|---|
| POST | `/api/student/join` | Join exam with code + student name (anti-probing generic error; 10 failed joins/10 min rate limit) |
| GET | `/api/student/my-exams?name=` | List exams student has enrolled in with status and score |
| GET | `/api/student/exams/:id` | Get exam metadata and questions (strictly safe `StudentQuestion`) |
| POST | `/api/student/exams/:id/start` | Start or resume attempt (requires prior enrollment in `exam_enrollments`, otherwise 403) |
| PUT | `/api/student/attempts/:id/answers` | Autosave answers (batch; rejected if deadline passed) |
| GET | `/api/student/attempts/:id/time` | Re-sync server-authoritative timer (countdown seconds, paused status) |
| POST | `/api/student/attempts/:id/submit` | Finalize and grade attempt server-side (idempotent) |
| GET | `/api/student/attempts/:id/result` | Retrieve attempt score, status, and optional answer review (if `show_answers = 1`) |

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

### Pre-Authentication Limitations (Until Phase 5)

Phase 4c-1 operates with `PROFESSOR_KEY` and unauthenticated student identifiers (`?name=`):

1. **Unauthenticated Name Collisions**:
   - Enrollment and attempts are keyed on `(exam_id, student_name)` in D1 SQLite.
   - Anyone typing an existing student's exact name will resume that student's attempt and inherit their saved answers.
   - Names are case-sensitive (`"alice"` and `"Alice"` are treated as two distinct students).
2. **Incognito Pause State**:
   - Professor interventions (`pause` / `resume`) are tracked per `sessionId` in Durable Object memory.
   - If an incognito window opens the exam with the same student name and generates a new `sessionId`, the new session will not inherit the previous WebSocket pause state until refreshed.

> **Resolution:** Both limitations will be eliminated in **Phase 5 (Authentication & RBAC)**, where attempts, sessions, and proctoring interventions will be bound to authenticated student accounts and JWT tokens.

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

All routes require `X-Professor-Key` header and execute `canAccessExam`.

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
- **Audit Log Table (`audit_log`)**: All lifecycle mutations (`archive_session`, `unarchive_session`, `hold_session`, `clear_session_data`, `delete_attempt`, `delete_test_attempt`, `clear_unlinked_sessions`, `retention_sweep`) append immutable records with timestamp, actor label (`professor_key`), target attempt ID, client IP, and metadata JSON.
- **DO Purge Protection**: `ExamSessionDO`'s `POST /purge` route is strictly internal to Cloudflare's edge network and is completely unreachable from public worker routing.


