/**
 * types.ts — Shared TypeScript interfaces used by both Worker and (via imports) the frontend.
 */

// ─── Behavioral event types ──────────────────────────────────────────────────

/** All event types the proctoring system can detect and process. */
export type BehavioralEventType =
  | 'tab_switch'
  | 'face_not_detected'
  | 'multiple_faces'
  | 'normal'
  | 'clipboard_activity'
  | 'fullscreen_exit'
  | 'right_click_attempt';

/** Payload sent alongside clipboard_activity events. */
export interface ClipboardPayload {
  action: 'copy' | 'paste';
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
  payload?: ClipboardPayload;
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
