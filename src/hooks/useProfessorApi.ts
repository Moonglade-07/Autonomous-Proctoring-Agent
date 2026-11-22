/**
 * src/hooks/useProfessorApi.ts — typed fetch wrapper for /api/professor/* (Phase 4a & 5a)
 *
 * Uses authenticated session cookie (auth_token).
 * All methods throw on HTTP error ≥ 400.
 */

import type {
  Exam,
  Question,
  SessionView,
  SessionViewCounts,
  SessionActionResponse,
  ProfessorAttempt,
  Attempt,
  StudentQuestion,
} from '../types';

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/professor${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as {
      error?: string;
      details?: unknown;
    };
    throw new ApiError(res.status, body.error ?? res.statusText, body.details);
  }

  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

// ─── Exams ───────────────────────────────────────────────────────────────────

export interface ListExamsParams {
  status?: string;
  search?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}

export async function listExams(params: ListExamsParams = {}): Promise<Exam[]> {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.search) q.set('search', params.search);
  if (params.sort) q.set('sort', params.sort);
  if (params.order) q.set('order', params.order);
  const qs = q.toString() ? `?${q}` : '';
  const data = await apiFetch<{ exams: Exam[] }>(`/exams${qs}`);
  return data.exams;
}

export async function getExam(id: string): Promise<Exam> {
  const data = await apiFetch<{ exam: Exam }>(`/exams/${id}`);
  return data.exam;
}

export async function createExam(body: Partial<Exam> & { title: string }): Promise<Exam> {
  const data = await apiFetch<{ exam: Exam }>('/exams', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.exam;
}

export async function updateExam(id: string, body: Partial<Exam>): Promise<Exam> {
  const data = await apiFetch<{ exam: Exam }>(`/exams/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return data.exam;
}

export async function deleteExam(id: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(`/exams/${id}`, { method: 'DELETE' });
}

export async function duplicateExam(id: string): Promise<Exam> {
  const data = await apiFetch<{ exam: Exam }>(`/exams/${id}/duplicate`, {
    method: 'POST',
  });
  return data.exam;
}

export async function publishExam(
  id: string,
  body: {
    status?: 'scheduled' | 'active' | 'completed' | 'closed';
    start_time?: string | null;
    end_time?: string | null;
    scheduled_at?: string | null;
  } = {},
): Promise<Exam> {
  const data = await apiFetch<{ exam: Exam }>(`/exams/${id}/publish`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.exam;
}

export async function regenerateJoinCode(id: string): Promise<string> {
  const data = await apiFetch<{ join_code: string }>(`/exams/${id}/regenerate-code`, {
    method: 'POST',
  });
  return data.join_code;
}

export async function toggleJoinCode(id: string, active: boolean): Promise<boolean> {
  const data = await apiFetch<{ join_code_active: number }>(`/exams/${id}/toggle-code`, {
    method: 'PUT',
    body: JSON.stringify({ active }),
  });
  return Boolean(data.join_code_active);
}

// ─── Exam Questions (Phase 4c-1: Exam-owned questions) ─────────────────────────

export async function listExamQuestions(examId: string): Promise<Question[]> {
  const data = await apiFetch<{ questions: Question[] }>(`/exams/${examId}/questions`);
  return data.questions;
}

export async function createExamQuestion(
  examId: string,
  body: Partial<Question> & { question_text: string },
): Promise<Question> {
  const data = await apiFetch<{ question: Question }>(`/exams/${examId}/questions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return data.question;
}

export async function updateExamQuestion(
  examId: string,
  qid: string,
  body: Partial<Question>,
): Promise<Question> {
  const data = await apiFetch<{ question: Question }>(`/exams/${examId}/questions/${qid}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return data.question;
}

export async function deleteExamQuestion(examId: string, qid: string): Promise<void> {
  await apiFetch<{ deleted: boolean }>(`/exams/${examId}/questions/${qid}`, {
    method: 'DELETE',
  });
}

export async function reorderExamQuestions(examId: string, order: string[]): Promise<void> {
  await apiFetch<{ success: boolean }>(`/exams/${examId}/questions/reorder`, {
    method: 'PUT',
    body: JSON.stringify({ order }),
  });
}

export async function importExamQuestions(
  examId: string,
  sourceExamId: string,
  questionIds?: string[],
): Promise<{ imported: number; questions: Question[] }> {
  return apiFetch<{ imported: number; questions: Question[] }>(`/exams/${examId}/questions/import`, {
    method: 'POST',
    body: JSON.stringify({ sourceExamId, questionIds }),
  });
}

// ─── Exam Attempts / Submissions (Phase 4b / 4c-1) ────────────────────────────

export interface AttemptRow {
  id: string;
  student_name: string;
  session_id: string;
  status: string;
  started_at: string;
  submitted_at: string | null;
  score: number | null;
  max_score: number;
  grading_status: string;
  is_test?: number;
}

export async function listExamAttempts(examId: string): Promise<AttemptRow[]> {
  const data = await apiFetch<{ attempts: AttemptRow[] }>(`/exams/${examId}/attempts`);
  return data.attempts;
}

// ─── Phase 4c-2a: Grading API ────────────────────────────────────────────────

import type { GradingItem, GradeRequest, SuggestGradeResponse } from '../types';

export interface GradedAttemptRow extends AttemptRow {
  fully_graded: number;
  graded_at: string | null;
  needs_grading_count: number;
}

export interface GradingViewData {
  attempt: GradedAttemptRow;
  exam: {
    id: string;
    title: string;
    results_released: number;
    results_released_at: string | null;
    instant_results: number;
  };
  grading_items: GradingItem[];
}

export async function listExamSubmissions(examId: string, includeTest = false): Promise<GradedAttemptRow[]> {
  const qs = includeTest ? '?include_test=1' : '';
  const data = await apiFetch<{ attempts: GradedAttemptRow[] }>(`/exams/${examId}/submissions${qs}`);
  return data.attempts;
}

export async function getAttemptGradingView(attemptId: string): Promise<GradingViewData> {
  return apiFetch<GradingViewData>(`/attempts/${attemptId}/grading`);
}

export async function getQuestionAnswers(
  examId: string,
  questionId: string,
  blind = false,
): Promise<{ question: GradingItem; answers: Record<string, unknown>[] }> {
  const qs = blind ? '?blind=1' : '';
  return apiFetch<{ question: GradingItem; answers: Record<string, unknown>[] }>(
    `/exams/${examId}/grading/questions/${questionId}${qs}`,
  );
}

export async function gradeAnswer(
  attemptId: string,
  questionId: string,
  body: GradeRequest,
): Promise<{ success: boolean; awarded_points: number; fully_graded: boolean; new_score: number }> {
  return apiFetch<{ success: boolean; awarded_points: number; fully_graded: boolean; new_score: number }>(
    `/attempts/${attemptId}/answers/${questionId}/grade`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

export async function suggestGrade(
  attemptId: string,
  questionId: string,
): Promise<SuggestGradeResponse> {
  return apiFetch<SuggestGradeResponse>(
    `/attempts/${attemptId}/answers/${questionId}/suggest-grade`,
    { method: 'POST' },
  );
}

export async function releaseResults(
  examId: string,
): Promise<{ released: boolean; released_at: string; stats: Record<string, number> }> {
  return apiFetch<{ released: boolean; released_at: string; stats: Record<string, number> }>(
    `/exams/${examId}/release-results`,
    { method: 'POST' },
  );
}

export async function unreleaseResults(examId: string): Promise<{ released: boolean }> {
  return apiFetch<{ released: boolean }>(`/exams/${examId}/unrelease-results`, { method: 'POST' });
}

// ─── Phase 4c-2b: Session Lifecycle & Preview APIs ───────────────────────────

export async function fetchExamSessions(
  examId: string,
  view: SessionView = 'live',
): Promise<{ view: SessionView; counts: SessionViewCounts; sessions: ProfessorAttempt[]; unlinked?: any[] }> {
  return apiFetch<{ view: SessionView; counts: SessionViewCounts; sessions: ProfessorAttempt[]; unlinked?: any[] }>(
    `/exams/${examId}/sessions?view=${view}`,
  );
}

export async function archiveSessions(examId: string, attemptIds: string[]): Promise<SessionActionResponse> {
  return apiFetch<SessionActionResponse>(`/exams/${examId}/sessions/archive`, {
    method: 'POST',
    body: JSON.stringify({ attemptIds }),
  });
}

export async function unarchiveSessions(examId: string, attemptIds: string[]): Promise<SessionActionResponse> {
  return apiFetch<SessionActionResponse>(`/exams/${examId}/sessions/unarchive`, {
    method: 'POST',
    body: JSON.stringify({ attemptIds }),
  });
}

export async function holdSession(
  examId: string,
  attemptId: string,
  hold: boolean,
): Promise<{ ok: boolean; evidence_hold: number }> {
  return apiFetch<{ ok: boolean; evidence_hold: number }>(`/exams/${examId}/sessions/hold`, {
    method: 'POST',
    body: JSON.stringify({ attemptId, hold }),
  });
}

export async function clearSessions(examId: string, attemptIds: string[]): Promise<SessionActionResponse> {
  return apiFetch<SessionActionResponse>(`/exams/${examId}/sessions/clear`, {
    method: 'POST',
    body: JSON.stringify({ attemptIds }),
  });
}

export async function deleteSessions(
  examId: string,
  attemptIds: string[],
  confirmationName?: string,
): Promise<SessionActionResponse> {
  return apiFetch<SessionActionResponse>(`/exams/${examId}/sessions/delete`, {
    method: 'POST',
    body: JSON.stringify({ attemptIds, confirmationName }),
  });
}

export async function clearUnlinkedSessions(
  examId: string,
  sessionIds?: string[],
): Promise<{ ok: boolean; clearedCount: number }> {
  return apiFetch<{ ok: boolean; clearedCount: number }>(`/exams/${examId}/sessions/unlinked`, {
    method: 'DELETE',
    body: JSON.stringify({ sessionIds }),
  });
}

export async function startPreviewExam(
  examId: string,
): Promise<{ attempt: Attempt; questions: StudentQuestion[]; seconds_remaining: number; resumed: boolean }> {
  return apiFetch<{ attempt: Attempt; questions: StudentQuestion[]; seconds_remaining: number; resumed: boolean }>(
    `/exams/${examId}/preview-start`,
    { method: 'POST' },
  );
}

export async function fetchSessionHistory(examId: string, sessionId: string): Promise<any> {
  return apiFetch(`/exams/${examId}/sessions/${sessionId}/history`);
}


