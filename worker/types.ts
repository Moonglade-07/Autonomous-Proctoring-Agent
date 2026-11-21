/**
 * types.ts — Shared TypeScript interfaces used by both Worker and (via imports) the frontend.
 */

// ─── Behavioral event types ──────────────────────────────────────────────────

/** All event types the proctoring system can detect and process. */
export type BehavioralEventType =
  | 'tab_switch'
  | 'clipboard_activity'
  | 'fullscreen_exit'
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
  sessionStatus?: 'active' | 'paused' | 'submitted' | 'terminated';
}

// ─── Phase 3b: Intervention types ────────────────────────────────────────────

/** Action a professor can issue against a student session. */
export type InterventionAction = 'warn' | 'pause' | 'resume' | 'force_submit';

/** Persisted record of a professor intervention in ExamSessionDO. */
export interface Intervention {
  id: string;
  action: InterventionAction;
  message?: string;
  issuedAt: string;
  acknowledgedAt?: string;
}

/**
 * Message sent FROM professor WebSocket to ExamHubDO.
 * The hub validates the key and routes it to the right ExamSessionDO.
 */
export interface CommandMsg {
  type: 'command';
  sessionId: string;
  action: InterventionAction;
  message?: string;
}

/**
 * Message sent FROM ExamSessionDO to student WebSocket (via broadcast).
 * Also sent back through ExamHubDO to professor WebSocket when acknowledged.
 */
export interface CommandAck {
  type: 'command_ack';
  interventionId: string;
  sessionId: string;
  action: InterventionAction;
  acknowledgedAt: string;
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
  }
  | {
    /** Phase 3b: professor command pushed down to the student */
    type: 'command';
    intervention: Intervention;
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
  /** Current cumulative risk score (0-100) */
  riskScore: number;
  /** Whether the student is active, disconnected, submitted, paused, or terminated */
  status: 'active' | 'disconnected' | 'submitted' | 'paused' | 'terminated';
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
  /** Phase 3b: recent intervention history for the detail drawer */
  interventions?: Intervention[];
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
  /** Phase 3b: set to 'intervention' for professor-issued actions */
  kind?: 'violation' | 'intervention';
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
  }
  | {
    /** Phase 3b: command delivery result (queued / delivered / noop / error) */
    type: 'command_result';
    sessionId: string;
    action: InterventionAction;
    status: 'delivered' | 'queued' | 'error' | 'noop';
    message: string;
  }
  | {
    /** Phase 3b: forwarded acknowledgement from student back to professor */
    type: 'command_ack';
    interventionId: string;
    sessionId: string;
    action: InterventionAction;
    acknowledgedAt: string;
  };
// ─── Phase 4a & 4c-1: D1 data models ────────────────────────────────────────

export type ExamStatus = 'draft' | 'scheduled' | 'active' | 'completed' | 'closed';
export type DerivedExamStatus = 'draft' | 'scheduled' | 'live' | 'ended';
export type QuestionType =
  | 'mcq'
  | 'multi_select'
  | 'fill_in_blank'
  | 'short_answer'
  | 'long_answer';
export type GradingMode = 'auto' | 'manual';

/** Full question row including correct answer — professor-facing only. */
export interface Question {
  id: string;
  exam_id: string;
  question_text: string;
  type: QuestionType;
  /** Parsed array for MCQ/multi_select; null for short/long answer. */
  options: string[] | null;
  /** Correct answer string — NEVER send to students. */
  correct_answer: string | null;
  points: number;
  topic?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  grading_mode: GradingMode;
  rubric?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Student-safe version of Question — correct_answer is intentionally absent.
 * Use this type everywhere student-facing code touches questions (Phase 4b+).
 */
export interface StudentQuestion {
  id: string;
  exam_id?: string;
  question_text: string;
  type: QuestionType;
  options: string[] | null;
  points: number;
  topic?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  grading_mode?: GradingMode;
  blank_count?: number;
  word_limit?: number | null;
}

/** Configuration for fill_in_blank accepted answers */
export interface FillInBlankConfig {
  blanks: string[][];
  case_insensitive: boolean;
}

/** A question attached to an exam, with optional frozen snapshot. */
export interface ExamQuestion {
  exam_question_id: string;
  position: number;
  /** true when the question was frozen at publish time */
  is_snapshot: boolean;
  id: string;
  exam_id?: string;
  question_text: string;
  type: QuestionType;
  options: string[] | null;
  correct_answer: string | null;
  points: number;
  topic?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  grading_mode?: GradingMode;
  rubric?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Full exam row with hydrated questions. */
export interface Exam {
  id: string;
  title: string;
  description: string;
  course_code: string;
  duration_minutes: number;
  start_time: string | null;
  end_time: string | null;
  status: ExamStatus;
  strictness?: 'low' | 'medium' | 'high' | 'custom';
  enable_vision?: number | boolean;
  enable_identity?: number | boolean;
  max_risk_score?: number;
  /** Phase 4b: whether students see correct answers after grading */
  show_answers?: number | boolean;
  /** Phase 4c-1: join code */
  join_code?: string | null;
  join_code_active?: number | boolean;
  /** Phase 4c-2a: Results release and instant results */
  results_released?: number | boolean;
  results_released_at?: string | null;
  instant_results?: number | boolean;
  /** Phase 4c-2b: Data retention policy in days (0 = keep forever) */
  retention_days?: number;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
  /** Questions are included when fetched via GET /exams/:id */
  questions?: ExamQuestion[];
  question_count?: number;
  total_points?: number;
  student_count?: number;
  derived_status?: DerivedExamStatus;
}

// ─── Phase 4c-1: Enrollment & Join models ────────────────────────────────────

export interface ExamEnrollment {
  exam_id: string;
  student_name: string;
  joined_at: string;
}

export interface JoinExamResponse {
  id: string;
  title: string;
  course: string;
  course_code: string;
  duration: number;
  duration_minutes: number;
  start_time: string | null;
  end_time: string | null;
  status: string;
}

export interface MyExamEntry {
  id: string;
  title: string;
  course_code: string;
  duration_minutes: number;
  start_time: string | null;
  end_time: string | null;
  status: string;
  derived_status: DerivedExamStatus;
  joined_at: string;
  attempt_id?: string | null;
  attempt_status?: AttemptStatus | null;
  result_status?: ResultStatus | 'in_progress' | null;
  score?: number | null;
  max_score?: number | null;
}

// ─── Phase 4b: Attempt types ──────────────────────────────────────────

export type AttemptStatus = 'in_progress' | 'submitted' | 'auto_submitted' | 'terminated';
export type GradingStatus = 'auto_graded' | 'pending_manual';

/** A student's attempt at an exam. */
export interface Attempt {
  id: string;
  exam_id: string;
  student_name: string;
  session_id: string;
  status: AttemptStatus;
  started_at: string;
  deadline_at: string;
  submitted_at: string | null;
  paused_seconds: number;
  paused_at: string | null;
  score: number | null;
  max_score: number;
  grading_status: GradingStatus;
  /** Phase 4c-2a: 1 if all manual questions have been graded */
  fully_graded?: number;
  graded_at?: string | null;
  /** Phase 4c-2b: Session lifecycle & retention fields */
  is_test?: number;
  archived?: number;
  archived_at?: string | null;
  evidence_hold?: number;
  ended_reason?: 'submitted' | 'auto_submitted' | 'terminated' | null;
  data_purged_at?: string | null;
}

/** A single student answer row. */
export interface StudentAnswer {
  attempt_id: string;
  question_id: string;
  answer_json: string;
  marked_for_review: number; // 0 | 1
  awarded_points?: number | null;
  auto_points?: number | null;
  grading_source?: GradingSource | null;
  grader_comment?: string | null;
  graded_at?: string | null;
  updated_at: string;
}

/** Result returned after exam submission. */
export interface SubmitResult {
  attempt: Attempt;
  submitted: boolean;
  idempotent?: boolean;
}

/** Student exam summary for the exam picker list. */
export interface StudentExamSummary {
  id: string;
  title: string;
  description: string;
  course: string;
  course_code: string;
  duration: number;
  duration_minutes: number;
  start_time: string | null;
  end_time: string | null;
  status: ExamStatus;
  show_answers?: number;
}

/** Response from POST /api/student/exams/:id/start */
export interface StartExamResponse {
  attempt: Attempt;
  questions: StudentQuestion[];
  answers: StudentAnswer[];
  seconds_remaining: number;
  resumed: boolean;
}

// ─── Phase 4c-2a: Grading types ──────────────────────────────────────────────

/** Source of grading for an answer. */
export type GradingSource = 'auto' | 'manual' | 'override';

/** Professor-facing grading view for one question in one attempt. */
export interface GradingItem {
  question_id: string;
  question_text: string;
  type: QuestionType;
  grading_mode: GradingMode;
  points: number;
  options: string[] | null;
  /** Correct answer — professor-only, never sent to students. */
  correct_answer: string | null;
  /** Professor's grading notes — professor-only. */
  rubric: string | null;
  position: number;
  answer_json: string | null;
  marked_for_review: number;
  awarded_points: number | null;
  auto_points: number | null;
  grading_source: GradingSource | null;
  grader_comment: string | null;
  graded_at: string | null;
}

/** Request body for PUT .../grade */
export interface GradeRequest {
  /** Points to award (0..max, multiple of 0.25). */
  points: number;
  comment?: string;
}

/** Response from POST .../suggest-grade */
export interface SuggestGradeResponse {
  suggestedPoints: number;
  rationale: string;
  note: string;
}

/** Status labels for the student result endpoint. */
export type ResultStatus = 'submitted_pending_release' | 'being_graded' | 'result_available';

/** Extended attempt with Phase 4c-2a grading fields. */
export interface GradedAttempt extends Attempt {
  fully_graded: number;
  graded_at: string | null;
}

/** Extended exam with Phase 4c-2a results release fields. */
export interface GradedExam extends Exam {
  results_released: number;
  results_released_at: string | null;
  instant_results: number;
}

// ─── Phase 4c-2b: Session Lifecycle, Retention & Audit ────────────────────────

export type SessionView = 'live' | 'ended' | 'archived' | 'test' | 'unlinked';

export interface SessionViewCounts {
  live: number;
  ended: number;
  archived: number;
  test: number;
  unlinked: number;
}

export interface SessionActionResultItem {
  id: string;
  success: boolean;
  reason?: string;
}

export interface SessionActionResponse {
  ok: boolean;
  action: 'archive' | 'unarchive' | 'clear' | 'delete' | 'hold' | 'clear_unlinked';
  results: SessionActionResultItem[];
  succeededCount: number;
  refusedCount: number;
}

export interface RetentionSettings {
  retention_days: number;
}

export interface UnlinkedSessionItem {
  sessionId: string;
  studentName?: string;
  examId?: string;
  startedAt?: string;
  lastActiveAt?: string;
  riskScore?: number;
  violationCount?: number;
  status?: string;
}

/** Extended attempt with Phase 4c-2b professor-only telemetry fields. */
export interface ProfessorAttempt extends GradedAttempt {
  violation_count?: number | null;
  max_severity?: string | null;
  final_risk_score?: number | null;
  last_violation_at?: string | null;
  ended_reason?: 'submitted' | 'auto_submitted' | 'terminated' | null;
  data_purged_at?: string | null;
  duration_seconds?: number;
  is_purged?: boolean;
}

export interface AuditLogEntry {
  id: string;
  ts: string;
  actor_user_id: string | null;
  action: string;
  target: string;
  ip: string | null;
  meta_json: string | null;
}



