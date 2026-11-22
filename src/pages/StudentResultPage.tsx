import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import type { Attempt, QuestionType } from '../types';

interface QuestionWithAnswer {
  id: string;
  type: QuestionType;
  prompt: string;
  points: number;
  options?: string[];
  order_index?: number;
  word_limit?: number;
  awarded_points: number | null;
  grader_comment: string | null;
  correct_answer?: string | null;
}

interface AnswerRow {
  question_id: string;
  answer_json: string;
  marked_for_review: number;
  awarded_points: number | null;
  auto_points: number | null;
  grader_comment: string | null;
}

interface ResultData {
  status: 'submitted_pending_release' | 'being_graded' | 'result_available';
  message?: string;
  attempt?: Attempt;
  score?: number | null;
  max_score?: number | null;
  percentage?: number;
  answers?: AnswerRow[];
  questions_with_answers?: QuestionWithAnswer[];
}

interface ExamMeta {
  id: string;
  title: string;
  course_code: string;
  duration_minutes?: number;
  status?: string;
  results_released?: number;
  instant_results?: number;
  show_answers?: number;
}

function formatStudentAnswer(rawJson?: string | null): string {
  if (rawJson == null || rawJson.trim() === '') return 'Not answered';
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed == null || parsed === '') return 'Not answered';
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return 'Not answered';
      return parsed.map(String).join(', ');
    }
    if (typeof parsed === 'object') {
      return JSON.stringify(parsed);
    }
    return String(parsed);
  } catch {
    return rawJson;
  }
}

function formatCorrectAnswer(rawAns?: string | null): string {
  if (rawAns == null || rawAns.trim() === '') return '—';
  try {
    const parsed = JSON.parse(rawAns);
    if (Array.isArray(parsed)) {
      return parsed.map(String).join(', ');
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return JSON.stringify(parsed);
    }
    return String(parsed);
  } catch {
    return rawAns;
  }
}

export function StudentResultPage() {
  const { examId } = useParams<{ examId: string }>();

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [examMeta, setExamMeta] = useState<ExamMeta | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [resultData, setResultData] = useState<ResultData | null>(null);

  const loadData = useCallback(async () => {
    if (!examId) {
      setError('Exam ID is missing');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // 1. Fetch attempt for this exam and student
      const attemptRes = await fetch(
        `/api/student/exams/${encodeURIComponent(examId)}/attempt`,
      );

      if (!attemptRes.ok) {
        if (attemptRes.status === 404) {
          setAttempt(null);
          setLoading(false);
          return;
        }
        const errJson = (await attemptRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(errJson.error || `Failed to fetch attempt (HTTP ${attemptRes.status})`);
      }

      const attemptData = (await attemptRes.json()) as {
        exam?: ExamMeta;
        attempt?: Attempt | null;
      };

      if (attemptData.exam) {
        setExamMeta(attemptData.exam);
      }

      if (!attemptData.attempt) {
        setAttempt(null);
        setLoading(false);
        return;
      }

      const att = attemptData.attempt;
      setAttempt(att);

      // If attempt is in progress, do not call result endpoint (which returns 403)
      if (att.status === 'in_progress') {
        setLoading(false);
        return;
      }

      // 2. Attempt is submitted, auto_submitted, or terminated -> call result endpoint
      const resultRes = await fetch(`/api/student/attempts/${encodeURIComponent(att.id)}/result`);
      if (!resultRes.ok) {
        const errJson = (await resultRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(errJson.error || `Failed to load result (HTTP ${resultRes.status})`);
      }

      const resJson = (await resultRes.json()) as ResultData;
      setResultData(resJson);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    } finally {
      setLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  return (
    <div className="min-h-screen bg-gray-950 text-white pb-16">
      {/* Top Navigation Bar */}
      <header className="border-b border-white/10 bg-gray-900/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">🎓</span>
            <div>
              <h1 className="text-sm font-bold text-white leading-tight">
                {examMeta?.title ?? 'Exam Result'}
              </h1>
              <p className="text-[11px] text-gray-400">
                {examMeta?.course_code ? `${examMeta.course_code} · ` : ''}Autonomous Proctoring Agent
              </p>
            </div>
          </div>
          <Link
            to="/student"
            className="px-3.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-semibold text-gray-300 border border-white/10 transition-colors inline-flex items-center gap-1.5"
          >
            ← Back to My Exams
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-10">
        {/* Loading State */}
        {loading && (
          <div className="bg-gray-900 border border-white/10 rounded-2xl p-12 text-center shadow-xl">
            <div className="w-10 h-10 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <h2 className="text-base font-semibold text-white mb-1">Loading Exam Result…</h2>
            <p className="text-xs text-gray-400">Fetching submission status and score records</p>
          </div>
        )}

        {/* Error State */}
        {!loading && error && (
          <div className="bg-gray-900 border border-red-500/30 rounded-2xl p-8 text-center shadow-xl">
            <div className="text-4xl mb-3">⚠️</div>
            <h2 className="text-base font-bold text-red-400 mb-2">Unable to Load Result</h2>
            <p className="text-xs text-gray-300 max-w-md mx-auto mb-6">{error}</p>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => void loadData()}
                className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white transition-colors"
              >
                Try Again
              </button>
              <Link
                to="/student"
                className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-xs font-semibold text-gray-200 transition-colors"
              >
                Back to My Exams
              </Link>
            </div>
          </div>
        )}

        {/* No Attempt Found State */}
        {!loading && !error && !attempt && (
          <div className="bg-gray-900 border border-white/10 rounded-2xl p-10 text-center shadow-xl">
            <div className="text-4xl mb-3">🔍</div>
            <h2 className="text-lg font-bold text-white mb-2">No Attempt Found</h2>
            <p className="text-xs text-gray-400 max-w-md mx-auto mb-6">
              We couldn't find any exam attempt for your account in this exam.
            </p>
            <Link
              to="/student"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all shadow-lg shadow-indigo-900/40"
            >
              ← Back to My Exams
            </Link>
          </div>
        )}

        {/* Attempt In Progress State */}
        {!loading && !error && attempt && attempt.status === 'in_progress' && (
          <div className="bg-gray-900 border border-amber-500/30 rounded-2xl p-10 text-center shadow-xl">
            <div className="text-5xl mb-4">⏳</div>
            <h2 className="text-xl font-black text-white mb-2">Exam Currently In Progress</h2>
            <p className="text-sm text-gray-300 max-w-md mx-auto mb-6">
              You have an active exam session for this exam. You have not submitted yet.
            </p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Link
                to={`/student/lobby/${encodeURIComponent(examId!)}`}
                className="px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-900/40 transition-colors"
              >
                Continue Exam →
              </Link>
              <Link
                to="/student"
                className="px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-gray-200 text-xs font-semibold transition-colors"
              >
                Back to My Exams
              </Link>
            </div>
          </div>
        )}

        {/* Submitted: Pending Release State */}
        {!loading &&
          !error &&
          attempt &&
          attempt.status !== 'in_progress' &&
          resultData?.status === 'submitted_pending_release' && (
            <div className="bg-gray-900 border border-white/10 rounded-2xl p-10 text-center shadow-xl">
              <div className="text-5xl mb-4">📥</div>
              <h2 className="text-xl font-black text-white mb-2">Exam Submitted Successfully</h2>
              <p className="text-sm text-gray-300 max-w-md mx-auto mb-6">
                Submitted. Results will appear when your professor releases them.
              </p>
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-300 text-xs font-semibold mb-8">
                🔒 Results Pending Release
              </div>
              <div>
                <Link
                  to="/student"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-semibold border border-white/15 transition"
                >
                  ← Back to My Exams
                </Link>
              </div>
            </div>
          )}

        {/* Submitted: Being Graded State */}
        {!loading &&
          !error &&
          attempt &&
          attempt.status !== 'in_progress' &&
          resultData?.status === 'being_graded' && (
            <div className="bg-gray-900 border border-white/10 rounded-2xl p-10 text-center shadow-xl">
              <div className="text-5xl mb-4">⏳</div>
              <h2 className="text-xl font-black text-white mb-2">Exam Submitted Successfully</h2>
              <p className="text-sm text-gray-300 max-w-md mx-auto mb-6">
                Your answers are being graded.
              </p>
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-semibold mb-8">
                📝 Grading in Progress
              </div>
              <div>
                <Link
                  to="/student"
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white text-xs font-semibold border border-white/15 transition"
                >
                  ← Back to My Exams
                </Link>
              </div>
            </div>
          )}

        {/* Submitted: Result Available State */}
        {!loading &&
          !error &&
          attempt &&
          attempt.status !== 'in_progress' &&
          resultData?.status === 'result_available' && (
            <div className="space-y-8">
              {/* Score Header Card */}
              <div className="bg-gray-900 border border-white/10 rounded-2xl p-8 text-center shadow-xl">
                <div className="text-5xl mb-4">
                  {attempt.status === 'terminated'
                    ? '🛑'
                    : (resultData.percentage ?? 0) >= 80
                    ? '🏆'
                    : (resultData.percentage ?? 0) >= 60
                    ? '✅'
                    : '📚'}
                </div>
                <h2 className="text-2xl font-black text-white mb-1">
                  {attempt.status === 'auto_submitted'
                    ? 'Exam Auto-Submitted'
                    : attempt.status === 'terminated'
                    ? 'Exam Terminated by Proctor'
                    : 'Exam Results Released'}
                </h2>
                <p className="text-xs text-gray-400 mb-6">
                  {attempt.submitted_at
                    ? `Submitted on ${new Date(attempt.submitted_at).toLocaleString()}`
                    : 'Submission recorded'}
                </p>

                <div className="flex items-center justify-center gap-8 mb-2">
                  <div>
                    <p className="text-5xl font-black text-white tracking-tight">
                      {resultData.percentage ?? 0}%
                    </p>
                    <p className="text-xs text-gray-400 mt-1 font-mono">
                      {resultData.score ?? 0} / {resultData.max_score ?? 0} pts
                    </p>
                  </div>
                </div>
              </div>

              {/* Question Breakdown List */}
              {resultData.questions_with_answers && resultData.questions_with_answers.length > 0 && (
                <div>
                  <h3 className="text-sm font-bold text-white mb-4 flex items-center justify-between">
                    <span>Question Breakdown</span>
                    <span className="text-xs text-gray-400 font-normal">
                      {resultData.questions_with_answers.length} Questions
                    </span>
                  </h3>
                  <div className="space-y-4">
                    {resultData.questions_with_answers.map((q, idx) => {
                      const ansObj = resultData.answers?.find((a) => a.question_id === q.id);
                      const answerText = formatStudentAnswer(ansObj?.answer_json);
                      const pointsEarned =
                        q.awarded_points !== null
                          ? q.awarded_points
                          : ansObj?.awarded_points ?? null;

                      return (
                        <div
                          key={q.id}
                          className="bg-gray-900/80 border border-white/10 rounded-xl p-5 space-y-3"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono font-bold text-indigo-400">
                                Q{idx + 1}
                              </span>
                              <span className="text-[10px] uppercase font-semibold text-gray-400 bg-white/5 px-2 py-0.5 rounded border border-white/5">
                                {q.type.replace('_', ' ')}
                              </span>
                            </div>
                            <span className="text-xs font-mono font-semibold text-gray-300">
                              {pointsEarned !== null ? `${pointsEarned}` : '—'} / {q.points} pts
                            </span>
                          </div>

                          <p className="text-sm text-gray-200 font-medium leading-relaxed">
                            {q.prompt}
                          </p>

                          <div className="pt-2 border-t border-white/5 space-y-2">
                            <div className="text-xs">
                              <span className="text-gray-400 block mb-0.5">Your Answer:</span>
                              <div className="bg-gray-950/60 border border-white/5 rounded-lg px-3.5 py-2 text-gray-200 font-mono text-xs whitespace-pre-wrap">
                                {answerText}
                              </div>
                            </div>

                            {/* Instructor feedback comment if available */}
                            {(q.grader_comment || ansObj?.grader_comment) && (
                              <div className="text-xs bg-indigo-950/40 border border-indigo-500/20 rounded-lg p-3">
                                <span className="font-semibold text-indigo-300 block mb-0.5">
                                  💬 Instructor Feedback:
                                </span>
                                <p className="text-gray-300 leading-relaxed">
                                  {q.grader_comment || ansObj?.grader_comment}
                                </p>
                              </div>
                            )}

                            {/* Show correct answer ONLY if returned by the API (show_answers enabled) */}
                            {q.correct_answer && (
                              <div className="text-xs bg-emerald-950/40 border border-emerald-500/20 rounded-lg p-3">
                                <span className="font-semibold text-emerald-400 block mb-0.5">
                                  ✓ Correct Answer:
                                </span>
                                <span className="text-emerald-200 font-mono">
                                  {formatCorrectAnswer(q.correct_answer)}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Bottom Back Button */}
              <div className="text-center pt-4">
                <Link
                  to="/student"
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all shadow-lg shadow-indigo-900/40"
                >
                  ← Back to My Exams
                </Link>
              </div>
            </div>
          )}
      </main>
    </div>
  );
}

