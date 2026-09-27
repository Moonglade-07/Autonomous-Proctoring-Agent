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

## Phase 2 (Planned)

- Professor dashboard with session overview and violation review
- Real computer vision (face detection via WebAssembly or Workers AI vision model)
- Audio monitoring (microphone access + speech detection)
- Role-based access (student vs. proctor views)
- Exam management (create/schedule exams, enroll students)

---
