/**
 * types.ts — Shared TypeScript interfaces used by both Worker and (via imports) the frontend.
 */

// ─── Behavioral event types ──────────────────────────────────────────────────

/** All event types the proctoring system can detect and process. */
export type BehavioralEventType =
  | 'tab_switch'
  | 'clipboard_activity'
  | 'fullscreen_exit'
  | 'right_click_attempt'
  | 'no_face'
  | 'multiple_faces'
  | 'orientation_away'
  | 'identity_mismatch'
  | 'normal'
  | 'thumbnail'
  | 'submit';

/** Payload sent alongside clipboard_activity events. */
export interface ClipboardPayload {
  action: 'copy' | 'paste';
}

export interface VisionEventPayload {
  durationSeconds: number;
  frameBase64?: string;
  clientDetection: string; // what the client-side model flagged
}

// ─── Data Models ─────────────────────────────────────────────────────────────

export interface RiskEvent {
  timestamp: string;
  score: number;
  triggers: string[];
  aiExplanation: string;
}

export interface Violation {
  id: string;
  sessionId: string;
  type: 'vision' | 'behavioral' | 'audio' | 'system';
  severity: 'low' | 'medium' | 'high' | 'critical';
  timestamp: string;
  aiConfidence: number;
  humanReviewed: boolean;
}

export interface ExamSessionState {
  sessionId: string;
  riskScore: number;
  riskHistory: RiskEvent[];
  violations: Violation[];
}

// ─── WebSocket message shapes ────────────────────────────────────────────────

/** Messages sent FROM frontend TO backend DO */
export interface BehavioralEventMsg {
  eventType: BehavioralEventType;
  payload?: ClipboardPayload | VisionEventPayload | ThumbnailPayload;
}

/** Messages sent FROM backend DO TO frontend */
export type WSOutboundMsg =
  | {
      type: 'risk_update';
      riskScore: number;
      riskEvent: RiskEvent;
      violations: Violation[];
    }
  | {
      type: 'session_snapshot';
      session: ExamSessionState;
    }
  | {
      type: 'error';
      message: string;
    };

// ─── Phase 3a: Hub types ─────────────────────────────────────────────────────

/**
 * Lightweight per-student summary stored and broadcast by ExamHubDO.
 * Omits full riskHistory to keep WebSocket messages small.
 */
export interface SessionSummary {
  /** The student's unique session ID */
  sessionId: string;
  /** Human-readable name from the ?name= query param */
  studentName: string;
  /** Current cumulative risk score (0–100) */
  riskScore: number;
  /** Whether the student is still connected, has disconnected, or submitted */
  status: 'active' | 'disconnected' | 'submitted';
  /** Total number of violations recorded so far */
  violationCount: number;
  /** The most recent event type (e.g. 'tab_switch', 'no_face') */
  lastEventType: string;
  /** ISO timestamp of the last event */
  lastEventAt: string;
  /** Timestamp when session started, for time active calculation */
  startedAt?: string;
  /** Latest webcam thumbnail (tiny JPEG, base64, optional) */
  thumbnailBase64?: string;
  /** The examId this session belongs to */
  examId: string;
  /** Recent violations for the detail drawer */
  recentViolations?: Violation[];
}

/**
 * A single proctoring alert pushed from a student session to the hub,
 * then broadcast to all connected professors.
 */
export interface HubAlert {
  sessionId: string;
  studentName: string;
  eventType: string;
  severity: Violation['severity'];
  durationSeconds?: number;
  aiExplanation: string;
  timestamp: string;
}

/** Thumbnail payload sent from student to DO, forwarded to hub only. */
export interface ThumbnailPayload {
  thumbnailBase64: string;
}

/** Body of POST /session-event sent from ExamSessionDO to ExamHubDO. */
export interface HubInternalUpdate {
  summary: SessionSummary;
  alert?: HubAlert;
}

/** Messages sent FROM ExamHubDO TO professor WebSocket clients. */
export type HubOutboundMsg =
  | {
      type: 'snapshot';
      sessions: Record<string, SessionSummary>;
      alerts: HubAlert[];
    }
  | {
      type: 'session_updated' | 'session_update';
      summary: SessionSummary;
    }
  | {
      type: 'session_removed';
      sessionId: string;
    }
  | {
      type: 'alert';
      alert: HubAlert;
    };
