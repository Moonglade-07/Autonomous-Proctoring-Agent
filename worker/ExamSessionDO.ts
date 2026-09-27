/**
 * ExamSessionDO.ts
 * ─────────────────────────────────────────────────────────────────
 * Cloudflare Durable Object: one instance per exam session.
 *
 * Responsibilities:
 *   1. Accept WebSocket connections from the React frontend.
 *   2. Receive behavioral-event messages (tab_switch, face_not_detected, etc.).
 *   3. Call Workers AI (Llama 3.3-70B) to assess risk and produce an explanation.
 *   4. Persist state to Durable Object Storage so it survives evictions.
 *   5. Broadcast the AI response back over the WebSocket.
 * ─────────────────────────────────────────────────────────────────
 */

import type { RiskEvent, Violation, ExamSessionState, BehavioralEventMsg, WSOutboundMsg } from './types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate a short unique ID for violations */
function uid(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Map event type → initial risk delta before AI refines it */
const RISK_DELTAS: Record<string, number> = {
  tab_switch: 15,
  face_not_detected: 20,
  multiple_faces: 25,
  normal: -5,
};

/** Map event type → violation type */
const VIOLATION_TYPE_MAP: Record<string, Violation['type']> = {
  tab_switch: 'behavioral',
  face_not_detected: 'vision',
  multiple_faces: 'vision',
  normal: 'system',
};

/** Map risk score range → severity */
function scoreSeverity(score: number): Violation['severity'] {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

// ─── Durable Object Class ───────────────────────────────────────────────────

export class ExamSessionDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  // In-memory cache of persisted session state
  private session: ExamSessionState = {
    sessionId: '',
    riskScore: 0,
    riskHistory: [],
    violations: [],
  };

  // Active WebSocket connections for this DO instance
  private sockets: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // ─── Lifecycle: restore state from storage on wake-up ─────────────────────
  async initialize(sessionId: string) {
    const stored = await this.state.storage.get<ExamSessionState>('session');
    if (stored) {
      this.session = stored;
    } else {
      this.session = {
        sessionId,
        riskScore: 0,
        riskHistory: [],
        violations: [],
      };
    }
  }

  // ─── Cloudflare DO fetch handler ──────────────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId') ?? 'unknown';

    // Restore persisted state (idempotent — safe to call multiple times)
    await this.initialize(sessionId);

    // ── WebSocket upgrade ────────────────────────────────────────────────────
    if (request.headers.get('Upgrade') === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair();

      // Accept the server side of the WebSocket inside the Durable Object
      this.state.acceptWebSocket(server);
      this.sockets.add(server);

      server.addEventListener('message', (evt) => this.handleMessage(server, evt));
      server.addEventListener('close', () => this.sockets.delete(server));
      server.addEventListener('error', () => this.sockets.delete(server));

      // Send current state snapshot to the newly connected client
      this.send(server, {
        type: 'session_snapshot',
        session: this.session,
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  // ─── Handle incoming WebSocket messages ───────────────────────────────────
  private async handleMessage(socket: WebSocket, evt: MessageEvent) {
    let msg: BehavioralEventMsg;

    try {
      msg = JSON.parse(evt.data as string) as BehavioralEventMsg;
    } catch {
      this.send(socket, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    const { eventType } = msg;

    // 1. Apply a naive delta to risk score (AI will refine it below)
    const delta = RISK_DELTAS[eventType] ?? 0;
    const rawNewScore = Math.min(100, Math.max(0, this.session.riskScore + delta));

    // 2. ── Call Workers AI (Llama 3.3-70B) for risk analysis ──────────────
    //    The AI receives recent history + the new event and returns:
    //      • A refined risk score (0-100)
    //      • A short natural-language explanation / warning
    const aiResult = await this.callWorkersAI(eventType, rawNewScore);

    // 3. Update session state
    const now = new Date().toISOString();

    const riskEvent: RiskEvent = {
      timestamp: now,
      score: aiResult.score,
      triggers: [eventType],
      aiExplanation: aiResult.explanation,
    };

    this.session.riskScore = aiResult.score;
    this.session.riskHistory = [...this.session.riskHistory, riskEvent].slice(-50);

    if (eventType !== 'normal') {
      const violation: Violation = {
        id: uid(),
        sessionId: this.session.sessionId,
        type: VIOLATION_TYPE_MAP[eventType] ?? 'system',
        severity: scoreSeverity(aiResult.score),
        timestamp: now,
        aiConfidence: aiResult.confidence,
        humanReviewed: false,
      };
      this.session.violations = [...this.session.violations, violation].slice(-100);
    }

    // 4. Persist to Durable Object storage (survives evictions)
    await this.state.storage.put('session', this.session);

    // 5. Send AI response back to frontend over WebSocket
    const outbound: WSOutboundMsg = {
      type: 'risk_update',
      riskScore: this.session.riskScore,
      riskEvent,
      violations: this.session.violations,
    };

    this.broadcast(outbound);
  }

  // ─── Workers AI call ──────────────────────────────────────────────────────
  /**
   * Calls @cf/meta/llama-3.3-70b-instruct-fp8-fast with a structured prompt.
   * Returns { score: number, explanation: string, confidence: number }.
   */
  private async callWorkersAI(
    eventType: string,
    rawScore: number
  ): Promise<{ score: number; explanation: string; confidence: number }> {
    const recentHistory = this.session.riskHistory
      .slice(-5)
      .map((h: RiskEvent) => `  • [${h.timestamp}] score=${h.score} trigger=${h.triggers.join(',')}`)
      .join('\n');

    const systemPrompt = `You are an AI proctoring risk analysis engine.
Your job is to assess academic integrity violations in real-time.
You MUST respond with valid JSON only — no markdown, no explanation outside JSON.
JSON schema: { "score": <integer 0-100>, "explanation": "<one sentence>", "confidence": <float 0-1> }`;

    const userPrompt = `Current exam session risk score: ${rawScore}/100
New behavioral event detected: "${eventType}"

Recent history (last 5 events):
${recentHistory || '  (none yet)'}

Assess the risk. Return an updated score (0-100), a brief warning or reassurance for the student/proctor, and your confidence (0-1).
Only respond with the JSON object.`;

    try {
      // Workers AI binding — "AI" is declared in wrangler.jsonc
      const response = await this.env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 150,
      });

      const text = (response as { response: string }).response?.trim() ?? '';
      const jsonStr = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(jsonStr) as { score: number; explanation: string; confidence: number };

      return {
        score: Math.min(100, Math.max(0, Math.round(parsed.score))),
        explanation: parsed.explanation ?? 'Risk assessed.',
        confidence: Math.min(1, Math.max(0, parsed.confidence ?? 0.8)),
      };
    } catch (err) {
      console.error('[ExamSessionDO] Workers AI error:', err);
      return {
        score: rawScore,
        explanation: this.fallbackExplanation(eventType),
        confidence: 0.5,
      };
    }
  }

  private fallbackExplanation(eventType: string): string {
    const map: Record<string, string> = {
      tab_switch: 'Tab switch detected — this may indicate accessing external resources.',
      face_not_detected: 'Face not detected in camera — please ensure you are visible.',
      multiple_faces: 'Multiple faces detected — only the exam taker should be present.',
      normal: 'Behavior appears normal. No violations detected.',
    };
    return map[eventType] ?? 'Behavioral event recorded.';
  }

  // ─── WebSocket helpers ────────────────────────────────────────────────────
  private send(socket: WebSocket, data: unknown) {
    if (socket.readyState === WebSocket.READY_STATE_OPEN) {
      socket.send(JSON.stringify(data));
    }
  }

  private broadcast(data: unknown) {
    for (const socket of this.sockets) {
      this.send(socket, data);
    }
  }
}
