/**
 * Shared TypeScript interfaces for the frontend.
 * Mirrors worker/types.ts — kept separate to avoid bundling Worker code into the React app.
 */

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

export type BehavioralEventType = 'tab_switch' | 'face_not_detected' | 'multiple_faces' | 'normal';
