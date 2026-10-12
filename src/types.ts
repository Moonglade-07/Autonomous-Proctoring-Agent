/**
 * Shared TypeScript interfaces for the frontend.
 * Mirrors worker/types.ts — kept separate to avoid bundling Worker code into the React app.
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

/** Thumbnail payload sent from student to DO, forwarded to hub only. */
export interface ThumbnailPayload {
  thumbnailBase64: string;
}

// ─── Data models ─────────────────────────────────────────────────────────────

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
 */
export interface SessionSummary {
  sessionId: string;
  studentName: string;
  riskScore: number;
  status: 'active' | 'disconnected' | 'submitted';
  violationCount: number;
  lastEventType: string;
  lastEventAt: string;
  startedAt?: string;
  thumbnailBase64?: string;
  examId: string;
  recentViolations?: Violation[];
}

/**
 * A single proctoring alert pushed from a student session to the hub.
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
