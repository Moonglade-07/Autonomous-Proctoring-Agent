/**
 * ExamPage.tsx
 * ─────────────────────────────────────────────────────────────────
 * Main exam interface for the Autonomous Proctoring Agent (Phase 4b).
 *
 * Integrates:
 *   • Full multimodal proctoring:
 *     - Identity capture & face descriptor matching (Phase 2c)
 *     - Live vision detection: orientation, face count, identity mismatch (Phase 2d)
 *     - Behavioral detection: fullscreen enforcement, tab focus, clipboard (Phase 2a)
 *     - Real-time AI risk analysis with Llama 3.3 & Llava via WebSockets (Phase 2d)
 *     - Professor interventions: warn, pause, resume, force_submit (Phase 3b)
 *   • Full student exam-taking UI (Phase 4b):
 *     - Server-synced countdown timer with pause freeze & deadline enforcement
 *     - Question palette (answered / flagged / unanswered status)
 *     - 800 ms debounced autosave with local sessionStorage cache
 *     - Question types: MCQ, multi-select, short-answer, code, essay
 *     - Mark-for-review toggle & confirmation modal before submit
 *     - Server-side grading & result screen with optional answer review
 *     - Clean proctoring teardown on exam completion
 * ─────────────────────────────────────────────────────────────────
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { WebcamPreview } from '../components/WebcamPreview';
import { RiskIndicator } from '../components/RiskIndicator';
import { EventLog } from '../components/EventLog';
import { PrivacyConsentModal } from '../components/PrivacyConsentModal';
import { IdentityCaptureModal } from '../components/IdentityCaptureModal';
import { useWebSocket } from '../hooks/useWebSocket';
import { useBehavioralDetection } from '../hooks/useBehavioralDetection';
import { useFaceDetection } from '../hooks/useFaceDetection';
import type {
  RiskEvent,
  Violation,
  WSOutboundMsg,
  Intervention,
  StudentQuestion,
  Attempt,
  StudentAnswer,
  StudentExamSummary,
} from '../types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function difficultyBadge(d?: string): string {
  if (d === 'easy') return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
  if (d === 'hard') return 'text-red-400 bg-red-500/10 border-red-500/30';
  return 'text-amber-400 bg-amber-500/10 border-amber-500/30';
}

function SessionExpiredModal({
  email,
  onReauth,
}: {
  email: string;
  onReauth: (password: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true);
    setError('');
    try {
      const ok = await onReauth(password);
      if (!ok) {
        setError('Incorrect password. Please try again.');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Re-authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] bg-black/85 backdrop-blur-md flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-gray-900 border border-amber-500/30 rounded-2xl p-7 shadow-2xl">
        <div className="text-4xl text-center mb-3">🔒</div>
        <h3 className="text-base font-bold text-white text-center mb-2">Session Expired</h3>
        <p className="text-xs text-gray-400 text-center mb-5">
          Your session timed out. Re-authenticate to save your answers. <strong>Your work in progress is preserved in memory.</strong>
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider block mb-1">
              Account Email
            </label>
            <input
              type="email"
              value={email}
              disabled
              className="w-full bg-gray-800/60 border border-white/5 rounded-xl px-4 py-2.5 text-sm text-gray-400 cursor-not-allowed"
            />
          </div>
          <div>
            <label className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider block mb-1">
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoFocus
              required
              className="w-full bg-gray-800 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-500/60 transition-colors"
            />
          </div>
          {error && (
            <p className="text-xs text-red-400 bg-red-950/40 border border-red-500/30 rounded-lg p-2.5">
              ⚠️ {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting || !password}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-500 hover:to-amber-600 text-white text-sm font-semibold transition-all shadow-lg shadow-amber-900/30 cursor-pointer disabled:opacity-40"
          >
            {submitting ? 'Authenticating…' : 'Re-authenticate & Save Answers'}
          </button>
        </form>
      </div>
    </div>
  );
}

function DuplicateWindowOverlay() {
  return (
    <div className="fixed inset-0 z-[80] bg-black/90 backdrop-blur-lg flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-gray-900 border border-red-500/40 rounded-2xl p-7 shadow-2xl text-center">
        <div className="text-5xl mb-4">🚫</div>
        <h3 className="text-lg font-bold text-white mb-2">Exam Open in Another Window</h3>
        <p className="text-sm text-gray-300 mb-6 leading-relaxed">
          This exam session has been opened in another browser tab or window. To maintain academic integrity, only one live window is permitted at a time.
        </p>
        <Link
          to="/student"
          className="inline-block w-full py-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold transition-all shadow-lg shadow-red-900/40"
        >
          Return to My Exams
        </Link>
      </div>
    </div>
  );
}

// ─── Phase 3b: Intervention Modals & Overlays ─────────────────────────────────

function WarnModal({
  intervention,
  onAcknowledge,
}: {
  intervention: Intervention;
  onAcknowledge: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-gray-900 border-2 border-amber-500/60 rounded-2xl p-7 shadow-2xl shadow-amber-900/40">
        <div className="w-14 h-14 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center text-3xl mx-auto mb-4 border border-amber-500/40">
          ⚠️
        </div>
        <h3 className="text-base font-bold text-white text-center mb-2">
          Warning from Proctor
        </h3>
        <p className="text-sm text-amber-200 text-center leading-relaxed mb-6 min-h-[3rem]">
          {intervention.message ?? 'Please pay attention to your screen.'}
        </p>
        <p className="text-[11px] text-gray-500 text-center mb-5">
          Issued at {new Date(intervention.issuedAt).toLocaleTimeString()}
        </p>
        <button
          onClick={onAcknowledge}
          id="warn-acknowledge-btn"
          className="w-full py-3 px-4 rounded-xl text-sm font-bold bg-amber-500 hover:bg-amber-400 text-gray-900 shadow-lg shadow-amber-500/30 transition-all active:scale-[0.98] cursor-pointer"
        >
          I Understand
        </button>
      </div>
    </div>
  );
}

function PauseOverlay({ message }: { message?: string }) {
  return (
    <div className="fixed inset-0 z-[55] bg-indigo-950/95 backdrop-blur-sm flex flex-col items-center justify-center gap-6 select-none">
      <div className="w-20 h-20 rounded-full bg-indigo-500/20 border-2 border-indigo-500/60 flex items-center justify-center text-4xl">
        ⏸️
      </div>
      <div className="text-center">
        <h2 className="text-2xl font-black text-white mb-2">Exam Paused</h2>
        <p className="text-sm text-indigo-300 max-w-sm leading-relaxed">
          {message ?? 'Your exam has been paused by the proctor. Please wait.'}
        </p>
      </div>
      <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-500/15 border border-indigo-500/30">
        <span className="w-2 h-2 rounded-full bg-indigo-400 animate-pulse" />
        <span className="text-xs font-semibold text-indigo-300">Waiting for proctor to resume…</span>
      </div>
      <p className="text-[11px] text-gray-500">Your progress is saved. Timer is frozen.</p>
    </div>
  );
}

// ─── Submit Confirmation Modal ───────────────────────────────────────────────

function SubmitModal({
  questions,
  answeredCount,
  flaggedCount,
  onConfirm,
  onCancel,
  submitting,
}: {
  questions: StudentQuestion[];
  answeredCount: number;
  flaggedCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const unanswered = questions.length - answeredCount;
  return (
    <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-gray-900 border border-white/10 rounded-2xl p-7 shadow-2xl">
        <div className="text-4xl text-center mb-3">📋</div>
        <h3 className="text-base font-bold text-white text-center mb-4">Submit Exam?</h3>
        <div className="space-y-2 mb-6 text-sm">
          <div className="flex justify-between text-gray-300">
            <span>Total questions</span>
            <span className="font-semibold">{questions.length}</span>
          </div>
          <div className="flex justify-between text-emerald-400">
            <span>Answered</span>
            <span className="font-semibold">{answeredCount}</span>
          </div>
          {unanswered > 0 && (
            <div className="flex justify-between text-amber-400">
              <span>Unanswered</span>
              <span className="font-semibold">{unanswered}</span>
            </div>
          )}
          {flaggedCount > 0 && (
            <div className="flex justify-between text-purple-400">
              <span>Flagged for review</span>
              <span className="font-semibold">{flaggedCount}</span>
            </div>
          )}
        </div>
        {unanswered > 0 && (
          <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/30 text-amber-300 text-xs mb-4">
            You have {unanswered} unanswered question{unanswered > 1 ? 's' : ''}. Once submitted you cannot change answers.
          </div>
        )}
        <div className="flex gap-3">
          <button
            id="submit-cancel-btn"
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 py-3 rounded-xl border border-white/10 text-gray-300 text-sm font-semibold hover:bg-white/5 transition-all cursor-pointer"
          >
            Go Back
          </button>
          <button
            id="submit-confirm-btn"
            onClick={onConfirm}
            disabled={submitting}
            className="flex-1 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold transition-all cursor-pointer disabled:opacity-60 shadow-lg shadow-emerald-900/40"
          >
            {submitting ? 'Submitting…' : 'Submit Now'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Result Screen ───────────────────────────────────────────────────────────

function ResultScreen({
  attempt,
  exam,
  questions,
  answers,
  statusInfo,
}: {
  attempt?: Attempt | null;
  exam?: StudentExamSummary | null;
  questions: StudentQuestion[];
  answers: StudentAnswer[];
  statusInfo?: { status: string; message: string } | null;
}) {
  if (statusInfo) {
    return (
      <div className="min-h-screen bg-gray-950 text-white pb-12">
        <div className="border-b border-white/8 bg-gray-900/60 sticky top-0 z-10">
          <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-xl">🎓</span>
              <div>
                <h1 className="text-sm font-bold text-white">{exam?.title ?? 'Exam Result'}</h1>
                <p className="text-[11px] text-gray-400">{exam?.course_code ?? 'Student Submission'}</p>
              </div>
            </div>
            <span className="text-xs bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 px-3 py-1 rounded-full font-mono">
              Proctoring Complete
            </span>
          </div>
        </div>

        <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
          <div className="bg-gray-900 border border-white/10 rounded-2xl p-8 text-center shadow-2xl">
            <div className="text-5xl mb-4">
              {statusInfo.status === 'being_graded' ? '⏳' : '📥'}
            </div>
            <h2 className="text-xl font-black text-white mb-2">Exam Submitted Successfully</h2>
            <p className="text-sm text-gray-300 max-w-md mx-auto mb-6">
              {statusInfo.message}
            </p>
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-300 text-sm font-semibold">
              {statusInfo.status === 'being_graded' ? '📝 Grading in Progress' : '🔒 Results Pending Release'}
            </div>
            <div className="mt-8">
              <Link to="/student" className="inline-block bg-white/10 hover:bg-white/15 text-white font-semibold text-xs px-5 py-2.5 rounded-lg border border-white/15 transition">
                ← Return to My Exams
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!attempt) return null;

  const pct =
    attempt.max_score > 0
      ? Math.round(((attempt.score ?? 0) / attempt.max_score) * 100)
      : 0;
  const isPending = attempt.grading_status === 'pending_manual';
  const answerMap = new Map(answers.map((a) => [a.question_id, a.answer_json]));

  return (
    <div className="min-h-screen bg-gray-950 text-white pb-12">
      <div className="border-b border-white/8 bg-gray-900/60 sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl">🎓</span>
            <div>
              <h1 className="text-sm font-bold text-white">{exam?.title ?? 'Exam Result'}</h1>
              <p className="text-[11px] text-gray-400">{exam?.course_code ?? 'Student Submission'}</p>
            </div>
          </div>
          <span className="text-xs bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 px-3 py-1 rounded-full font-mono">
            Proctoring Complete
          </span>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        <div className="bg-gray-900 border border-white/10 rounded-2xl p-8 text-center shadow-2xl">
          <div className="text-5xl mb-4">
            {attempt.status === 'terminated'
              ? '🛑'
              : pct >= 80
              ? '🏆'
              : pct >= 60
              ? '✅'
              : '📚'}
          </div>
          <h2 className="text-xl font-black text-white mb-1">
            {attempt.status === 'auto_submitted'
              ? 'Exam Auto-Submitted'
              : attempt.status === 'terminated'
              ? 'Exam Terminated by Proctor'
              : 'Exam Submitted Successfully'}
          </h2>
          <p className="text-sm text-gray-400 mb-6">
            {attempt.submitted_at
              ? `Submitted at ${new Date(attempt.submitted_at).toLocaleString()}`
              : 'Submission recorded'}
          </p>
          {isPending ? (
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm font-semibold">
              ⏳ Awaiting manual grading (Code / Essay questions)
            </div>
          ) : (
            <div className="flex items-center justify-center gap-6">
              <div>
                <p className="text-5xl font-black text-white">{pct}%</p>
                <p className="text-xs text-gray-400 mt-1 font-mono">
                  {attempt.score ?? 0} / {attempt.max_score} pts
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Question review (if show_answers is enabled) */}
        {exam?.show_answers === 1 && !isPending && (
          <div>
            <h3 className="text-sm font-bold text-white mb-4">Question Breakdown</h3>
            <div className="space-y-4">
              {questions.map((q, i) => {
                const studentAnswerRaw = answerMap.get(q.id);
                let studentAnswer: unknown = null;
                if (studentAnswerRaw) {
                  try {
                    studentAnswer = JSON.parse(studentAnswerRaw);
                  } catch {
                    studentAnswer = studentAnswerRaw;
                  }
                }
                if (Array.isArray(studentAnswer)) studentAnswer = studentAnswer.join(', ');
                return (
                  <div key={q.id} className="bg-gray-900 border border-white/8 rounded-xl p-5">
                    <div className="flex items-start gap-2 mb-2">
                      <span className="text-[11px] text-gray-500 font-mono mt-0.5">Q{i + 1}</span>
                      <p className="text-sm text-gray-200 flex-1">{q.question_text}</p>
                      <span className="text-[10px] text-gray-500 flex-shrink-0">{q.points} pt</span>
                    </div>
                    <div className="ml-6 text-xs text-gray-400">
                      {studentAnswer !== null ? (
                        <span>
                          Your answer:{' '}
                          <span className="text-white font-medium">{String(studentAnswer)}</span>
                        </span>
                      ) : (
                        <span className="text-gray-500 italic">Not answered</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex items-center justify-center gap-4">
          <Link
            to="/student"
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all shadow-lg shadow-indigo-900/40"
          >
            ← Back to Exams Portal
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Question Input Components ───────────────────────────────────────────────

function MCQQuestion({
  q,
  value,
  onChange,
  disabled,
}: {
  q: StudentQuestion;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-2">
      {(q.options ?? []).map((opt) => (
        <label
          key={opt}
          className={`flex items-center gap-3 p-3.5 rounded-xl border cursor-pointer transition-all ${
            value === opt
              ? 'bg-indigo-500/15 border-indigo-500/50 text-white shadow-sm'
              : 'bg-white/[0.03] border-white/8 text-gray-300 hover:border-white/20 hover:bg-white/5'
          } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          <input
            type="radio"
            name={`mcq-${q.id}`}
            value={opt}
            checked={value === opt}
            onChange={() => !disabled && onChange(opt)}
            disabled={disabled}
            className="accent-indigo-500 w-4 h-4 cursor-pointer"
          />
          <span className="text-sm font-normal">{opt}</span>
        </label>
      ))}
    </div>
  );
}

function MultiSelectQuestion({
  q,
  value,
  onChange,
  disabled,
}: {
  q: StudentQuestion;
  value: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
}) {
  const toggle = (opt: string) => {
    if (disabled) return;
    const next = value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-gray-500 mb-1">Select all that apply</p>
      {(q.options ?? []).map((opt) => (
        <label
          key={opt}
          className={`flex items-center gap-3 p-3.5 rounded-xl border cursor-pointer transition-all ${
            value.includes(opt)
              ? 'bg-indigo-500/15 border-indigo-500/50 text-white shadow-sm'
              : 'bg-white/[0.03] border-white/8 text-gray-300 hover:border-white/20 hover:bg-white/5'
          } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
        >
          <input
            type="checkbox"
            checked={value.includes(opt)}
            onChange={() => toggle(opt)}
            disabled={disabled}
            className="accent-indigo-500 w-4 h-4 rounded cursor-pointer"
          />
          <span className="text-sm font-normal">{opt}</span>
        </label>
      ))}
    </div>
  );
}

function FillInBlankQuestion({
  q,
  value,
  onChange,
  disabled,
}: {
  q: StudentQuestion;
  value: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
}) {
  const blankCount = q.blank_count || (q.question_text.match(/___/g) || []).length || 1;
  const currentValues = Array.from({ length: blankCount }).map((_, i) => value[i] || '');

  const handleChange = (index: number, val: string) => {
    if (disabled) return;
    const next = [...currentValues];
    next[index] = val;
    onChange(next);
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-400">Fill in the missing words for each blank (___) in the prompt:</p>
      <div className="space-y-2">
        {Array.from({ length: blankCount }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <span className="text-xs font-semibold text-gray-400 min-w-[4.5rem]">Blank #{i + 1}:</span>
            <input
              type="text"
              value={currentValues[i]}
              onChange={(e) => handleChange(i, e.target.value)}
              disabled={disabled}
              placeholder={`Enter answer for blank #${i + 1}…`}
              className={`flex-1 px-4 py-2.5 rounded-xl bg-gray-800 border border-white/10 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500/60 transition-all ${
                disabled ? 'opacity-60 cursor-not-allowed' : ''
              }`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function TextQuestion({
  q,
  value,
  onChange,
  disabled,
}: {
  q: StudentQuestion;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  if (q.type === 'short_answer') {
    return (
      <input
        id={`answer-${q.id}`}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="Type your short answer here…"
        className={`w-full px-4 py-3 rounded-xl bg-gray-800 border border-white/10 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500/60 transition-all ${
          disabled ? 'opacity-60 cursor-not-allowed' : ''
        }`}
      />
    );
  }

  const isLong = q.type === 'long_answer';
  const rows = isLong ? 9 : 4;
  const wordLimit = q.word_limit || (q.options && q.options[0] ? parseInt(q.options[0], 10) : null);
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  return (
    <div className="space-y-1.5">
      <textarea
        id={`answer-${q.id}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        rows={rows}
        placeholder={isLong ? 'Write your comprehensive answer here…' : 'Type your answer…'}
        className={`w-full px-4 py-3 rounded-xl bg-gray-800 border border-white/10 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500/60 resize-y transition-all ${
          disabled ? 'opacity-60 cursor-not-allowed' : ''
        }`}
      />
      {isLong && (
        <div className="flex items-center justify-between text-[11px] text-gray-500 font-mono">
          <span>
            {wordLimit ? `Target: ~${wordLimit} words · ` : ''}
            Words: {words.toLocaleString()}
          </span>
          <span>{value.length.toLocaleString()} / 10,000 characters</span>
        </div>
      )}
    </div>
  );
}

// ─── Header Timer Component ──────────────────────────────────────────────────

function ExamTimer({
  secondsRemaining,
  isPaused,
}: {
  secondsRemaining: number;
  isPaused: boolean;
}) {
  const urgent = secondsRemaining < 300 && !isPaused && secondsRemaining > 0;
  return (
    <div
      id="exam-timer"
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono font-bold border transition-all ${
        isPaused
          ? 'bg-indigo-950/90 border-indigo-500/60 text-indigo-300 ring-1 ring-indigo-500/40 animate-pulse'
          : urgent
          ? 'bg-red-950/80 border-red-500/60 text-red-300 animate-pulse'
          : 'bg-white/[0.04] border-white/10 text-gray-200'
      }`}
      title={isPaused ? 'Timer frozen while paused' : 'Time remaining'}
    >
      <span>{isPaused ? '⏸' : '⏱'}</span>
      <span>{formatTime(secondsRemaining)}</span>
      {isPaused && (
        <span className="text-[9px] font-black uppercase tracking-wider text-indigo-400 bg-indigo-500/20 px-1 py-0.5 rounded">
          Paused
        </span>
      )}
    </div>
  );
}

// ─── Status Rows & Indicators ────────────────────────────────────────────────

interface SignalRowProps {
  label: string;
  icon: string;
  value: string | React.ReactNode;
  status: 'ok' | 'warn' | 'off' | 'error';
}

function SignalRow({ label, icon, value, status }: SignalRowProps) {
  const colors = {
    ok: 'text-emerald-400',
    warn: 'text-amber-400',
    error: 'text-red-400',
    off: 'text-gray-500',
  };
  const dotColors = {
    ok: 'bg-emerald-500',
    warn: 'bg-amber-500 animate-pulse',
    error: 'bg-red-500 animate-pulse',
    off: 'bg-gray-700',
  };
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className="text-base flex-shrink-0 select-none" aria-hidden>{icon}</span>
      <span className="text-xs text-gray-400 min-w-[6.5rem]">{label}</span>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColors[status]}`} />
      <span className={`text-xs font-medium ${colors[status]}`}>{value}</span>
    </div>
  );
}

function WSStatusDot({ status }: { status: string }) {
  const map: Record<string, { color: string; ping: boolean; label: string }> = {
    connecting: { color: 'bg-yellow-400', ping: true, label: 'Connecting…' },
    open: { color: 'bg-emerald-400', ping: true, label: 'Live' },
    closed: { color: 'bg-orange-400', ping: false, label: 'Reconnecting…' },
    error: { color: 'bg-red-500', ping: false, label: 'Error' },
  };
  const s = map[status] ?? map.closed;
  return (
    <div className="flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        {s.ping && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${s.color} opacity-60`} />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${s.color}`} />
      </span>
      <span className="text-xs text-gray-500">{s.label}</span>
    </div>
  );
}

// ─── Main ExamPage Component ─────────────────────────────────────────────────

export function ExamPage() {
  const params = useParams<{ examId: string }>();
  const [searchParams] = useSearchParams();

  const examId =
    params.examId || searchParams.get('exam') || searchParams.get('examId') || 'exam-1';

  const { user, login, logout } = useAuth();
  const navigate = useNavigate();

  const [studentName, setStudentName] = useState<string>(() => {
    return user?.name || searchParams.get('name') || 'Student';
  });

  const [sessionId, setSessionId] = useState<string>(() => {
    return searchParams.get('sessionId') || searchParams.get('session') || '';
  });

  useEffect(() => {
    if (user?.name) {
      setStudentName(user.name);
    }
  }, [user]);

  // ── Exam & Question State ──────────────────────────────────────────────────
  const [examMeta, setExamMeta] = useState<StudentExamSummary | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [questions, setQuestions] = useState<StudentQuestion[]>([]);
  const [answers, setAnswers] = useState<Map<string, string>>(new Map()); // qId -> JSON string
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [currentIdx, setCurrentIdx] = useState(0);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [activeTab, setActiveTab] = useState<'questions' | 'telemetry'>('questions');
  const [showSessionExpiredModal, setShowSessionExpiredModal] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);

  // Submission & Result state
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resultAttempt, setResultAttempt] = useState<Attempt | null>(null);
  const [resultAnswers, setResultAnswers] = useState<StudentAnswer[]>([]);
  const [resultStatusInfo, setResultStatusInfo] = useState<{ status: string; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverErrorMsg, setServerErrorMsg] = useState<string | null>(null);

  // Proctoring telemetry state
  const previewParam = searchParams.get('preview');
  const isPreview = previewParam === 'questions_only' || previewParam === 'full' || attempt?.is_test === 1;
  const isQuestionsOnly = previewParam === 'questions_only';

  const [riskScore, setRiskScore] = useState(0);
  const [riskHistory, setRiskHistory] = useState<RiskEvent[]>([]);
  const [visibleLog, setVisibleLog] = useState<RiskEvent[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [lastActivity, setLastActivity] = useState<string>('—');
  const [showIdentityModal, setShowIdentityModal] = useState(false);

  // Professor intervention state
  const [isPaused, setIsPaused] = useState(false);
  const [pauseMessage, setPauseMessage] = useState<string | undefined>();
  const [isTerminated, setIsTerminated] = useState(false);
  const [pendingWarn, setPendingWarn] = useState<Intervention | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  attemptRef.current = attempt;

  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRefForAck = useRef<((id: string) => void) | null>(null);
  const stopMonitoringRef = useRef<(() => void) | null>(null);

  // ── Sync Server Time ───────────────────────────────────────────────────────
  const syncServerTime = useCallback(async (attemptId: string) => {
    try {
      const r = await fetch(`/api/student/attempts/${attemptId}/time`);
      if (r.status === 401) {
        setShowSessionExpiredModal(true);
        return;
      }
      const ct = r.headers.get('content-type');
      if (r.ok && ct && ct.includes('application/json')) {
        const d = (await r.json()) as {
          seconds_remaining?: number;
          is_paused?: boolean;
          status?: string;
        };
        if (typeof d.seconds_remaining === 'number') {
          setSecondsRemaining(d.seconds_remaining);
        }
        if (typeof d.is_paused === 'boolean') {
          setIsPaused(d.is_paused);
        }
        if (d.status === 'auto_submitted' || d.status === 'terminated' || d.status === 'submitted') {
          await loadResult(attemptId);
        }
      }
    } catch {}
  }, []);

  // ── Load Result ────────────────────────────────────────────────────────────
  const loadResult = useCallback(async (attemptId: string) => {
    try {
      const r = await fetch(`/api/student/attempts/${attemptId}/result`);
      const ct = r.headers.get('content-type');
      if (r.ok && ct && ct.includes('application/json')) {
        const data = (await r.json()) as {
          status?: string;
          message?: string;
          attempt?: Attempt;
          answers?: StudentAnswer[];
        };
        if (data.status === 'submitted_pending_release' || data.status === 'being_graded') {
          setResultStatusInfo({
            status: data.status,
            message: data.message || 'Your submission has been received.',
          });
          setIsSubmitted(true);
        } else if (data.attempt) {
          setResultStatusInfo(null);
          setResultAttempt(data.attempt);
          setResultAnswers(data.answers ?? []);
          setIsSubmitted(true);
        }
      }
    } catch {}
  }, []);

  // ── WebSocket Message Handler ──────────────────────────────────────────────
  const handleMessage = useCallback(
    (msg: WSOutboundMsg) => {
      if (msg.type === 'session_snapshot') {
        setRiskScore(msg.session.riskScore);
        setRiskHistory(msg.session.riskHistory);
        setVisibleLog(msg.session.riskHistory);
        setViolations(msg.session.violations);
        if (msg.session.sessionStatus === 'paused') {
          setIsPaused(true);
        } else if (msg.session.sessionStatus === 'terminated') {
          setIsTerminated(true);
          setIsSubmitted(true);
          if (attemptRef.current) void loadResult(attemptRef.current.id);
        } else if (msg.session.sessionStatus === 'submitted') {
          setIsSubmitted(true);
          if (attemptRef.current) void loadResult(attemptRef.current.id);
        }
      } else if (msg.type === 'risk_update') {
        setRiskScore(msg.riskScore);
        setRiskHistory((prev) => [...prev, msg.riskEvent]);
        setVisibleLog((prev) => [...prev, msg.riskEvent]);
        setViolations(msg.violations);
        setLastActivity(msg.riskEvent.triggers[0] ?? 'unknown');
        setServerErrorMsg(null);
      } else if (msg.type === 'error') {
        setServerErrorMsg(msg.message);
      } else if (msg.type === 'command') {
        const { intervention } = msg;
        if (intervention.action === 'warn') {
          setPendingWarn(intervention);
        } else if (intervention.action === 'pause') {
          setIsPaused(true);
          setPauseMessage(intervention.message);
          wsRefForAck.current?.(intervention.id);
        } else if (intervention.action === 'resume') {
          setIsPaused(false);
          wsRefForAck.current?.(intervention.id);
          if (attemptRef.current) {
            void syncServerTime(attemptRef.current.id);
          }
        } else if (intervention.action === 'force_submit') {
          setIsTerminated(true);
          setIsSubmitted(true);
          wsRefForAck.current?.(intervention.id);
          stopMonitoringRef.current?.();
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
          }
          if (videoRef.current?.srcObject) {
            const stream = videoRef.current.srcObject as MediaStream;
            stream.getTracks().forEach((t) => t.stop());
          }
          if (attemptRef.current) {
            void loadResult(attemptRef.current.id);
          }
        }
      }
    },
    [loadResult, syncServerTime],
  );

  const { sendEvent, status, sendRaw, closeReason } = useWebSocket({
    sessionId,
    examId,
    studentName,
    onMessage: handleMessage,
  });

  useEffect(() => {
    wsRefForAck.current = (interventionId: string) => {
      sendRaw?.({ type: 'command_ack', interventionId, sessionId });
    };
  }, [sendRaw, sessionId]);

  // ── Behavioral Detection ───────────────────────────────────────────────────
  const {
    monitoringState,
    startMonitoring: startBehavioral,
    stopMonitoring,
    reenterFullscreen,
  } = useBehavioralDetection({
    sendEvent,
    wsStatus: isPaused || isSubmitted ? 'closed' : status,
  });

  useEffect(() => {
    stopMonitoringRef.current = stopMonitoring;
  }, [stopMonitoring]);

  // ── Face Detection & Identity ──────────────────────────────────────────────
  const { faceState, activeFlags, referenceCapture, captureReference } = useFaceDetection({
    videoRef,
    monitoringActive: !isQuestionsOnly && monitoringState.active && !isSubmitted && !isPaused,
    sendEvent,
  });

  // ── Auto-initialize Preview Attempt if launched from editor ─────────────────
  useEffect(() => {
    if (!isPreview) return;
    const stored = sessionStorage.getItem(`apa_preview_data_${examId}`);
    if (stored) {
      try {
        const data = JSON.parse(stored) as {
          attempt: Attempt;
          questions: StudentQuestion[];
          seconds_remaining: number;
        };
        if (data.attempt && data.questions) {
          setAttempt(data.attempt);
          setQuestions(data.questions);
          setSecondsRemaining(data.seconds_remaining);
          setStudentName(data.attempt.student_name);
          sessionStorage.setItem(`apa_attempt_${examId}_${data.attempt.student_name}`, data.attempt.id);
        }
      } catch (e) {
        console.error('Failed to parse preview data', e);
      }
    }
  }, [examId, isPreview]);

  // ── Fetch Exam Metadata on Mount ───────────────────────────────────────────
  useEffect(() => {
    fetch(`/api/student/exams/${examId}`)
      .then(async (r) => {
        const ct = r.headers.get('content-type');
        if (!r.ok) {
          if (ct && ct.includes('application/json')) {
            const e = (await r.json()) as { error?: string | { code?: string; message?: string }; code?: string };
            if (
              r.status === 403 &&
              (e.code === 'privacy_required' ||
                (typeof e.error === 'object' && e.error?.code === 'privacy_required'))
            ) {
              setShowPrivacyModal(true);
              return null;
            }
            const msg = typeof e.error === 'string' ? e.error : e.error?.message || `HTTP ${r.status}`;
            throw new Error(msg);
          }
          throw new Error(`Server returned HTTP ${r.status}`);
        }
        if (ct && ct.includes('application/json')) {
          return r.json() as Promise<{ exam: StudentExamSummary; error?: string }>;
        }
        throw new Error('Server returned non-JSON response');
      })
      .then((data) => {
        if (!data) return;
        if (data.error) setLoadError(data.error);
        else setExamMeta(data.exam);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [examId]);

  // ── Autosave Engine ────────────────────────────────────────────────────────
  const doAutosave = useCallback(async () => {
    const at = attemptRef.current;
    if (!at || at.status !== 'in_progress') return;

    const body = [...answers.entries()].map(([qId, aJson]) => ({
      question_id: qId,
      answer_json: aJson,
      marked_for_review: flagged.has(qId),
    }));
    if (body.length === 0) return;

    setAutoSaveStatus('saving');
    try {
      const r = await fetch(`/api/student/attempts/${at.id}/answers`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: body }),
      });
      if (r.status === 401) {
        setShowSessionExpiredModal(true);
        setAutoSaveStatus('error');
        return;
      }
      if (r.status === 410) {
        // Deadline passed — trigger auto-submit
        await handleAutoSubmit();
        return;
      }
      const ct = r.headers.get('content-type');
      if (r.ok && ct && ct.includes('application/json')) {
        const data = (await r.json()) as { seconds_remaining?: number };
        if (typeof data.seconds_remaining === 'number') {
          setSecondsRemaining(data.seconds_remaining);
        }
      }
      setAutoSaveStatus(r.ok ? 'saved' : 'error');
    } catch {
      setAutoSaveStatus('error');
    }
    setTimeout(() => setAutoSaveStatus('idle'), 2000);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, flagged]);

  const scheduleAutosave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void doAutosave();
    }, 800);
  }, [doAutosave]);

  // ── Answer Change Handlers ─────────────────────────────────────────────────
  const setAnswer = useCallback(
    (qId: string, jsonValue: string) => {
      setAnswers((prev) => {
        const next = new Map(prev);
        next.set(qId, jsonValue);
        if (attemptRef.current) {
          sessionStorage.setItem(
            `apa_answers_${attemptRef.current.id}`,
            JSON.stringify([...next.entries()]),
          );
        }
        return next;
      });
      scheduleAutosave();
    },
    [scheduleAutosave],
  );

  const toggleFlagged = useCallback(
    (qId: string) => {
      setFlagged((prev) => {
        const next = new Set(prev);
        if (next.has(qId)) next.delete(qId);
        else next.add(qId);
        return next;
      });
      scheduleAutosave();
    },
    [scheduleAutosave],
  );

  const handleIdentityConfirmed = useCallback(async () => {
    setShowIdentityModal(false);

    try {
      const res = await fetch(`/api/student/exams/${examId}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const ct = res.headers.get('content-type');
      if (!res.ok) {
        if (ct && ct.includes('application/json')) {
          const errJson = (await res.json()) as { error?: string | { code?: string; message?: string }; code?: string };
          if (
            res.status === 403 &&
            (errJson.code === 'privacy_required' ||
              (typeof errJson.error === 'object' && errJson.error?.code === 'privacy_required'))
          ) {
            setShowPrivacyModal(true);
            return;
          }
          const msg = typeof errJson.error === 'string' ? errJson.error : errJson.error?.message || `Failed to start exam (HTTP ${res.status})`;
          throw new Error(msg);
        }
        throw new Error(`Failed to start exam (HTTP ${res.status})`);
      }

      if (!ct || !ct.includes('application/json')) {
        throw new Error('Server returned non-JSON response');
      }

      const data = (await res.json()) as {
        attempt: Attempt;
        questions: StudentQuestion[];
        answers?: StudentAnswer[];
        seconds_remaining: number;
        resumed: boolean;
      };

      setAttempt(data.attempt);
      if (data.attempt.session_id) {
        setSessionId(data.attempt.session_id);
      }
      if (data.attempt.student_name) {
        setStudentName(data.attempt.student_name);
      }
      setQuestions(data.questions);
      setSecondsRemaining(data.seconds_remaining);
      setIsPaused(!!data.attempt.paused_at);

      sessionStorage.setItem(`apa_attempt_${examId}_${studentName}`, data.attempt.id);

      // Restore saved answers if resuming
      if (data.answers && Array.isArray(data.answers) && data.answers.length > 0) {
        const ansMap = new Map<string, string>();
        const flgSet = new Set<string>();
        for (const a of data.answers) {
          ansMap.set(a.question_id, a.answer_json);
          if (a.marked_for_review) flgSet.add(a.question_id);
        }
        setAnswers(ansMap);
        setFlagged(flgSet);
      } else {
        const storedAnswers = sessionStorage.getItem(`apa_answers_${data.attempt.id}`);
        if (storedAnswers && data.resumed) {
          setAnswers(new Map(JSON.parse(storedAnswers) as [string, string][]));
        }
      }

      if (
        data.attempt.status === 'submitted' ||
        data.attempt.status === 'auto_submitted' ||
        data.attempt.status === 'terminated'
      ) {
        await loadResult(data.attempt.id);
        return;
      }

      // Enter fullscreen and begin behavioral & proctoring monitors (skipped in questions-only preview)
      if (!isQuestionsOnly) {
        await startBehavioral();
      }
      sendEvent('normal');
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [examId, studentName, startBehavioral, sendEvent, loadResult, isQuestionsOnly]);

  const handleReauth = useCallback(
    async (password: string): Promise<boolean> => {
      if (!user?.email) return false;
      try {
        await login(user.email, password);
        setShowSessionExpiredModal(false);
        void doAutosave();
        return true;
      } catch {
        return false;
      }
    },
    [user?.email, login, doAutosave],
  );

  const handleMidExamLogout = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      }
    } catch {}

    try {
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((t) => t.stop());
        videoRef.current.srcObject = null;
      }
    } catch {}

    try {
      stopMonitoringRef.current?.();
    } catch {}

    try {
      await logout();
    } catch {}
    navigate('/login');
  }, [logout, navigate]);

  // ── Exam Start Flow ────────────────────────────────────────────────────────
  const handleStartExam = useCallback(() => {
    if (isQuestionsOnly) {
      void handleIdentityConfirmed();
    } else {
      setShowIdentityModal(true);
    }
  }, [isQuestionsOnly, handleIdentityConfirmed]);

  // ── Auto-Submit on Deadline ────────────────────────────────────────────────
  const handleAutoSubmit = useCallback(async () => {
    const at = attemptRef.current;
    if (!at || isSubmitted) return;
    setIsSubmitted(true);
    stopMonitoring();

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((t) => t.stop());
    }

    try {
      await fetch(`/api/student/attempts/${at.id}/submit`, { method: 'POST' });
    } catch {}
    await loadResult(at.id);
  }, [isSubmitted, stopMonitoring, loadResult]);

  // ── Manual Submission Confirmation ─────────────────────────────────────────
  const handleConfirmSubmit = useCallback(async () => {
    const at = attemptRef.current;
    if (!at) return;
    setSubmitting(true);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    await doAutosave();

    try {
      const r = await fetch(`/api/student/attempts/${at.id}/submit`, { method: 'POST' });
      const ct = r.headers.get('content-type');
      let dataAttemptId = at.id;
      if (r.ok && ct && ct.includes('application/json')) {
        const data = (await r.json()) as { attempt: Attempt };
        if (data.attempt?.id) dataAttemptId = data.attempt.id;
      }
      setIsSubmitted(true);
      setShowSubmitModal(false);

      stopMonitoring();
      sendEvent('submit');

      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((t) => t.stop());
      }

      await loadResult(dataAttemptId);
    } catch {
      setSubmitting(false);
    }
  }, [doAutosave, stopMonitoring, sendEvent, loadResult]);

  // ── Countdown Timer Tick ───────────────────────────────────────────────────
  useEffect(() => {
    if (!attempt || isSubmitted || isPaused || showPrivacyModal) return;
    if (secondsRemaining <= 0) {
      void handleAutoSubmit();
      return;
    }
    const t = setInterval(() => {
      setSecondsRemaining((s) => {
        const next = s - 1;
        if (next <= 0) {
          clearInterval(t);
          void handleAutoSubmit();
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [attempt, isSubmitted, isPaused, secondsRemaining, handleAutoSubmit]);

  // ── Periodic Server Time Sync (every 30s) ──────────────────────────────────
  useEffect(() => {
    if (isSubmitted || !attempt?.id) return;
    const interval = setInterval(() => {
      void syncServerTime(attempt.id);
    }, 30000);
    return () => clearInterval(interval);
  }, [isSubmitted, attempt?.id, syncServerTime]);

  // ── Warn Acknowledgement ───────────────────────────────────────────────────
  const handleWarnAcknowledge = useCallback(() => {
    if (pendingWarn) {
      wsRefForAck.current?.(pendingWarn.id);
      setPendingWarn(null);
    }
  }, [pendingWarn]);

  // ── Answer Accessor Helpers ────────────────────────────────────────────────
  const getStringAnswer = (qId: string): string => {
    const v = answers.get(qId);
    if (!v) return '';
    try {
      return JSON.parse(v) as string;
    } catch {
      return v;
    }
  };

  const getArrayAnswer = (qId: string): string[] => {
    const v = answers.get(qId);
    if (!v) return [];
    try {
      return JSON.parse(v) as string[];
    } catch {
      return [];
    }
  };

  const answeredCount = questions.filter((q) => {
    const v = answers.get(q.id);
    if (!v) return false;
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.length > 0;
      return String(parsed).trim().length > 0;
    } catch {
      return v.trim().length > 0;
    }
  }).length;

  const flaggedCount = flagged.size;

  const questionStatus = (q: StudentQuestion): 'answered' | 'flagged' | 'unanswered' => {
    const v = answers.get(q.id);
    let hasAnswer = false;
    if (v) {
      try {
        const parsed = JSON.parse(v);
        if (Array.isArray(parsed)) hasAnswer = parsed.length > 0;
        else hasAnswer = String(parsed).trim().length > 0;
      } catch {
        hasAnswer = v.trim().length > 0;
      }
    }
    if (flagged.has(q.id)) return 'flagged';
    if (hasAnswer) return 'answered';
    return 'unanswered';
  };

  // ── Signal Formats ─────────────────────────────────────────────────────────
  let faceLabel = 'Loading models…';
  let faceStatus: 'ok' | 'warn' | 'error' | 'off' = 'off';

  if (faceState.modelState === 'error') {
    faceLabel = 'Models failed to load';
    faceStatus = 'error';
  } else if (faceState.modelState === 'ready' && !monitoringState.active) {
    faceLabel = 'Ready to monitor';
    faceStatus = 'off';
  } else if (monitoringState.active && faceState.detecting) {
    if (faceState.faceCount === 0) {
      faceLabel = 'No face detected';
      faceStatus = 'error';
    } else if (faceState.faceCount > 1) {
      faceLabel = `${faceState.faceCount} faces detected`;
      faceStatus = 'error';
    } else {
      faceLabel = '1 face detected';
      faceStatus = 'ok';
    }
  }

  let orientationLabel = '—';
  let orientationStatus: 'ok' | 'warn' | 'off' = 'off';

  if (monitoringState.active && faceState.faceCount === 1) {
    orientationLabel = faceState.orientation;
    orientationStatus = faceState.orientation === 'forward' ? 'ok' : 'warn';
  }

  let identityLabel = '—';
  let identityStatusColor: 'ok' | 'warn' | 'error' | 'off' = 'off';

  if (faceState.identityStatus === 'verified') {
    identityLabel = `Verified${faceState.identityDistance !== null ? ` (${faceState.identityDistance.toFixed(2)})` : ''}`;
    identityStatusColor = 'ok';
  } else if (faceState.identityStatus === 'mismatch') {
    identityLabel = `Mismatch${faceState.identityDistance !== null ? ` (${faceState.identityDistance.toFixed(2)})` : ''}`;
    identityStatusColor = 'error';
  } else if (faceState.identityStatus === 'captured') {
    identityLabel = 'Captured — verifying…';
    identityStatusColor = 'off';
  } else if (faceState.identityStatus === 'not_captured') {
    identityLabel = 'Not captured';
    identityStatusColor = 'off';
  }

  const clipboardText = monitoringState.lastClipboard
    ? `${monitoringState.lastClipboard.action} at ${new Date(monitoringState.lastClipboard.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    : 'None';

  const criticalCount = violations.filter((v) => v.severity === 'critical').length;
  const highCount = violations.filter((v) => v.severity === 'high').length;

  const flagLabel = (f: (typeof activeFlags)[number]) => {
    if (f.type === 'identity_mismatch') return 'Identity mismatch';
    if (f.type === 'head_turned') return `Head turned${f.orientation ? ` (looking ${f.orientation})` : ''}`;
    return f.type.replace(/_/g, ' ');
  };

  // ── Render Result Screen ───────────────────────────────────────────────────
  if (isSubmitted && (resultAttempt || resultStatusInfo)) {
    return (
      <ResultScreen
        attempt={resultAttempt}
        exam={examMeta}
        questions={questions}
        answers={resultAnswers}
        statusInfo={resultStatusInfo}
      />
    );
  }

  const currentQuestion = questions[currentIdx];

  return (
    <div className="min-h-screen bg-gray-950 text-white font-sans flex flex-col">
      {/* ── Interventions & Modals ────────────────────────────────────────── */}
      {closeReason === 'This exam is open in another window' && <DuplicateWindowOverlay />}
      {showSessionExpiredModal && user?.email && (
        <SessionExpiredModal email={user.email} onReauth={handleReauth} />
      )}
      {isPaused && !isSubmitted && <PauseOverlay message={pauseMessage} />}
      {pendingWarn && !isSubmitted && (
        <WarnModal intervention={pendingWarn} onAcknowledge={handleWarnAcknowledge} />
      )}
      {showIdentityModal && (
        <IdentityCaptureModal
          onCapture={captureReference}
          onConfirm={handleIdentityConfirmed}
          onCancel={() => setShowIdentityModal(false)}
          videoRef={videoRef}
        />
      )}
      {showSubmitModal && (
        <SubmitModal
          questions={questions}
          answeredCount={answeredCount}
          flaggedCount={flaggedCount}
          onConfirm={handleConfirmSubmit}
          onCancel={() => setShowSubmitModal(false)}
          submitting={submitting}
        />
      )}
      <PrivacyConsentModal
        isOpen={showPrivacyModal}
        onConsentSuccess={async () => {
          setShowPrivacyModal(false);
          await handleIdentityConfirmed();
        }}
        onCancel={() => {
          setShowPrivacyModal(false);
          navigate('/student');
        }}
      />

      {/* ── Top Header ────────────────────────────────────────────────────── */}
      <header className="border-b border-white/[0.08] bg-gray-900/90 backdrop-blur-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white font-bold text-sm shadow-lg shadow-violet-900/30">
              AP
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-bold text-white tracking-wide truncate">
                  {examMeta?.title ?? 'Autonomous Proctoring Agent'}
                </h1>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
                  {examId}
                </span>
              </div>
              <p className="text-xs text-gray-400 font-mono truncate">
                {studentName} · Session: {sessionId}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            {monitoringState.active && (
              <span className="text-xs bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40 px-2 py-0.5 rounded-full font-semibold animate-pulse">
                Proctoring Active
              </span>
            )}
            {criticalCount > 0 && (
              <span className="text-xs bg-red-500/15 text-red-400 ring-1 ring-red-500/40 px-2 py-0.5 rounded-full font-semibold">
                {criticalCount} Critical
              </span>
            )}
            {highCount > 0 && (
              <span className="text-xs bg-orange-500/15 text-orange-400 ring-1 ring-orange-500/40 px-2 py-0.5 rounded-full font-semibold">
                {highCount} High
              </span>
            )}

            {/* Autosave status indicator */}
            {attempt && (
              <div className="text-[11px] font-mono">
                {autoSaveStatus === 'saving' && <span className="text-indigo-400">💾 Saving…</span>}
                {autoSaveStatus === 'saved' && <span className="text-emerald-400">✅ Saved</span>}
                {autoSaveStatus === 'error' && <span className="text-amber-400">⚠️ Save error</span>}
              </div>
            )}

            {attempt && <ExamTimer secondsRemaining={secondsRemaining} isPaused={isPaused} />}
            <WSStatusDot status={status} />

            <button
              type="button"
              onClick={handleMidExamLogout}
              title="Sign out of your account"
              className="px-2.5 py-1.5 rounded-xl border border-white/10 hover:bg-white/5 text-gray-400 hover:text-white text-xs font-medium transition-all"
            >
              Sign Out
            </button>

            {attempt && !isSubmitted && (
              <button
                id="exam-submit-header-btn"
                onClick={() => setShowSubmitModal(true)}
                disabled={isPaused}
                className="px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all cursor-pointer shadow-lg shadow-emerald-900/30 disabled:opacity-40"
              >
                Submit Exam
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Phase 4c-2b: Preview Mode Banner ─────────────────────────────────── */}
      {isPreview && (
        <div className="bg-amber-500/20 border-b border-amber-500/40 px-4 py-2 text-center text-xs font-bold text-amber-300 flex items-center justify-center gap-2">
          <span>🧪</span>
          <span>Preview Mode — Test Attempt (Not counted towards exam statistics, submissions, or release)</span>
        </div>
      )}

      {/* ── Banners: Errors, Local Flags, Fullscreen Exit ───────────────────── */}
      {loadError && (
        <div className="mx-4 sm:mx-6 mt-3 rounded-xl border border-red-700/40 bg-red-950/50 px-4 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">❌</span>
            <span className="text-xs text-red-300 font-semibold">{loadError}</span>
          </div>
          <button
            onClick={() => setLoadError(null)}
            className="text-xs text-red-400 hover:text-red-200"
          >
            Dismiss
          </button>
        </div>
      )}

      {serverErrorMsg && (
        <div className="mx-4 sm:mx-6 mt-3 rounded-xl border border-red-700/30 bg-red-950/40 px-4 py-2.5 flex items-start gap-2">
          <span className="text-base flex-shrink-0">⚠️</span>
          <div>
            <p className="text-xs font-semibold text-red-400">AI Response Error</p>
            <p className="text-xs text-red-500 mt-0.5">{serverErrorMsg}</p>
          </div>
          <button
            onClick={() => setServerErrorMsg(null)}
            className="ml-auto text-red-700 hover:text-red-500 transition-colors text-lg leading-none cursor-pointer"
          >
            ×
          </button>
        </div>
      )}

      {/* Active Flags Banner */}
      {activeFlags.length > 0 && (
        <div className="mx-4 sm:mx-6 mt-3 rounded-xl border border-rose-700/40 bg-rose-950/40 px-4 py-3 flex items-center gap-3">
          <span className="text-xl flex-shrink-0 animate-pulse">🚨</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-rose-300">Pending Review (Local Only)</p>
            <div className="text-xs text-rose-500 mt-0.5 space-y-1">
              {activeFlags.map((f, i) => (
                <p key={i}>
                  • {flagLabel(f)} — {(f.durationMs / 1000).toFixed(1)}s and counting…
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Fullscreen Required Banner */}
      {monitoringState.active && !monitoringState.isFullscreen && (
        <div className="mx-4 sm:mx-6 mt-3 rounded-xl border border-amber-700/40 bg-amber-950/50 px-4 py-3 flex items-center gap-3">
          <span className="text-xl flex-shrink-0">⚠️</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-300">Fullscreen Required</p>
            <p className="text-xs text-amber-600 mt-0.5">
              You exited fullscreen mode. This event has been recorded by the proctoring agent.
            </p>
          </div>
          <button
            id="reenter-fullscreen-btn"
            onClick={reenterFullscreen}
            className="flex-shrink-0 px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-semibold rounded-lg ring-1 ring-amber-500/40 transition-colors cursor-pointer"
          >
            Re-enter Fullscreen
          </button>
        </div>
      )}

      {/* ── Main Workspace ─────────────────────────────────────────────────── */}
      <main className="max-w-7xl mx-auto w-full px-4 sm:px-6 py-5 flex-1 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Left Column: Live Proctoring & Webcam ─────────────────────────── */}
        <div className="lg:col-span-1 flex flex-col gap-4">
          {/* Live Webcam Preview / Questions-Only Placeholder */}
          {isQuestionsOnly ? (
            <div className="rounded-2xl bg-gray-900/60 border border-white/[0.08] p-6 text-center">
              <div className="w-12 h-12 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 flex items-center justify-center text-2xl mx-auto mb-2">
                🧪
              </div>
              <p className="text-xs font-bold text-white mb-1">Questions-Only Preview</p>
              <p className="text-[11px] text-gray-400">
                Webcam, facial verification, and fullscreen enforcement are disabled.
              </p>
            </div>
          ) : (
            <WebcamPreview
              videoRef={videoRef}
              faceOverlay={
                monitoringState.active && faceState.detecting && (
                  <div className="bg-black/60 backdrop-blur-sm border border-white/10 px-2 py-1 rounded-lg flex items-center gap-2">
                    <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">
                      Face
                    </span>
                    <div
                      className={`w-2 h-2 rounded-full ${
                        faceStatus === 'ok' ? 'bg-emerald-500' : 'bg-rose-500 animate-pulse'
                      }`}
                    />
                    <span className="text-xs font-mono font-medium text-white/90">
                      {faceState.faceCount > 0 ? `${faceState.faceCount}` : '0'}
                    </span>
                  </div>
                )
              }
            />
          )}

          {/* Proctoring Signals Panel */}
          <div className="rounded-2xl bg-gray-900/60 border border-white/[0.07] p-4">
            <div className="flex items-center justify-between mb-3 border-b border-white/5 pb-2">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full ${
                      monitoringState.active ? 'bg-emerald-500 opacity-60' : 'bg-gray-500'
                    }`}
                  />
                  <span
                    className={`relative inline-flex rounded-full h-2 w-2 ${
                      monitoringState.active ? 'bg-emerald-500' : 'bg-gray-500'
                    }`}
                  />
                </span>
                <h2 className="text-xs font-bold tracking-[0.18em] text-gray-300 uppercase">
                  {monitoringState.active ? 'Proctoring Active' : 'Proctoring Ready'}
                </h2>
              </div>

              {referenceCapture && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[9px] text-gray-500 uppercase tracking-wider">Ref ID</span>
                  <img
                    src={referenceCapture.thumbnailDataUrl}
                    alt="Reference face"
                    className="w-6 h-6 rounded-md object-cover border border-violet-500/40"
                  />
                </div>
              )}
            </div>

            {/* Vision AI Signals */}
            <div className="space-y-0.5 mb-2 border-b border-white/5 pb-2">
              <SignalRow label="Face Detection" icon="👤" value={faceLabel} status={faceStatus} />
              <SignalRow
                label="Orientation"
                icon="🧭"
                value={<span className="capitalize">{orientationLabel}</span>}
                status={orientationStatus}
              />
              <SignalRow
                label="Identity Match"
                icon="🔐"
                value={identityLabel}
                status={identityStatusColor}
              />
            </div>

            {/* Behavioral Signals */}
            <div className="space-y-0.5">
              <SignalRow
                label="Tab Focus"
                icon="🔀"
                value={monitoringState.tabFocused ? 'Focused' : 'Switched Away'}
                status={monitoringState.tabFocused ? 'ok' : 'warn'}
              />
              <SignalRow
                label="Fullscreen"
                icon="🖥️"
                value={monitoringState.isFullscreen ? 'Active' : 'Exited'}
                status={monitoringState.isFullscreen ? 'ok' : 'warn'}
              />
              <SignalRow
                label="Clipboard"
                icon="📋"
                value={clipboardText}
                status={monitoringState.lastClipboard ? 'warn' : 'ok'}
              />
            </div>
          </div>

          {/* Session Stats Strip */}
          <div className="rounded-2xl bg-gray-900/60 border border-white/[0.07] p-4 grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-xl font-bold text-white tabular-nums">{violations.length}</p>
              <p className="text-xs text-gray-500 mt-0.5 uppercase tracking-wide">Violations</p>
            </div>
            <div>
              <p className="text-xl font-bold text-white tabular-nums">{riskHistory.length}</p>
              <p className="text-xs text-gray-500 mt-0.5 uppercase tracking-wide">Events</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-300 break-words leading-tight mt-1 capitalize">
                {lastActivity.replace(/_/g, ' ')}
              </p>
              <p className="text-xs text-gray-500 mt-0.5 uppercase tracking-wide">Last</p>
            </div>
          </div>
        </div>

        {/* ── Right Column: Exam Taking / Questions Workspace ──────────────── */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          {!attempt ? (
            /* ── Pre-Exam Gate: Details & Start Button ─────────────────────── */
            <div className="rounded-2xl bg-gray-900/60 border border-white/[0.07] p-8 flex flex-col items-center justify-center text-center my-auto space-y-6">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-600/30 to-indigo-600/30 border border-violet-500/40 flex items-center justify-center text-3xl">
                🛡️
              </div>
              <div className="max-w-md">
                <h2 className="text-xl font-bold text-white mb-2">
                  {examMeta?.title ?? 'Ready to Take Your Exam'}
                </h2>
                <p className="text-xs text-gray-400 leading-relaxed mb-4">
                  {examMeta?.description ??
                    'Before beginning, confirm your identity. A reference snapshot will be captured via webcam and verified throughout the exam.'}
                </p>

                <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4 text-left space-y-2 mb-6">
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>Course:</span>
                    <span className="text-gray-200 font-medium">{examMeta?.course_code ?? 'CS101'}</span>
                  </div>
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>Duration:</span>
                    <span className="text-gray-200 font-medium">
                      {examMeta?.duration_minutes ? `${examMeta.duration_minutes} minutes` : 'Timed Exam'}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-gray-400">
                    <span>Proctoring:</span>
                    <span className="text-emerald-400 font-medium">Webcam + Vision + Behavioral AI</span>
                  </div>
                </div>

                <div className="text-left mb-6 p-3.5 bg-gray-800/80 border border-white/10 rounded-xl">
                  <div className="text-[11px] text-gray-400 font-semibold uppercase tracking-wider mb-1">
                    Student Account
                  </div>
                  <div className="text-sm font-semibold text-white">
                    {user?.name || studentName}
                  </div>
                  <div className="text-xs text-gray-400">
                    {user?.email} {user?.student_id ? `· ID: ${user.student_id}` : ''}
                  </div>
                </div>

                <button
                  id="start-exam-btn"
                  onClick={handleStartExam}
                  disabled={isQuestionsOnly ? false : (faceState.modelState === 'loading')}
                  className="w-full py-3.5 px-6 rounded-xl text-sm font-bold bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white shadow-lg shadow-violet-900/40 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
                >
                  {isQuestionsOnly
                    ? '🚀 Begin Questions-Only Preview'
                    : faceState.modelState === 'loading'
                    ? 'Loading Face AI Models…'
                    : '📷 Verify Identity & Begin Exam'}
                </button>
              </div>
            </div>
          ) : (
            /* ── Active Exam Taking Interface ──────────────────────────────── */
            <div className="flex flex-col gap-4">
              {/* Tab Selector: Questions vs Real-time AI Risk */}
              <div className="flex items-center justify-between border-b border-white/[0.08] pb-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setActiveTab('questions')}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                      activeTab === 'questions'
                        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/40'
                        : 'bg-white/5 text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    📝 Questions ({answeredCount}/{questions.length})
                  </button>
                  <button
                    onClick={() => setActiveTab('telemetry')}
                    className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5 ${
                      activeTab === 'telemetry'
                        ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-900/40'
                        : 'bg-white/5 text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    <span>📊 Live AI Risk & Logs</span>
                    <span
                      className={`w-2 h-2 rounded-full ${
                        riskScore >= 70 ? 'bg-red-500' : riskScore >= 40 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                    />
                  </button>
                </div>

                {/* Flag toggle for current question */}
                {activeTab === 'questions' && currentQuestion && (
                  <button
                    id={`flag-q-${currentIdx + 1}`}
                    onClick={() => toggleFlagged(currentQuestion.id)}
                    className={`px-3 py-1.5 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                      flagged.has(currentQuestion.id)
                        ? 'bg-purple-500/20 border-purple-500/50 text-purple-300'
                        : 'bg-white/5 border-white/10 text-gray-400 hover:text-gray-200'
                    }`}
                  >
                    <span>🚩</span>
                    <span>{flagged.has(currentQuestion.id) ? 'Flagged' : 'Flag for review'}</span>
                  </button>
                )}
              </div>

              {activeTab === 'questions' ? (
                <>
                  {/* Question Palette Strip */}
                  <div className="bg-gray-900/60 border border-white/[0.07] rounded-2xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">
                        Question Palette
                      </span>
                      <div className="flex items-center gap-3 text-[10px] text-gray-500">
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded bg-emerald-500/40 border border-emerald-500/60" />
                          Answered
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded bg-purple-500/40 border border-purple-500/60" />
                          Flagged
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded bg-white/5 border border-white/10" />
                          Unanswered
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {questions.map((q, i) => {
                        const st = questionStatus(q);
                        return (
                          <button
                            key={q.id}
                            id={`palette-q-${i + 1}`}
                            onClick={() => setCurrentIdx(i)}
                            className={`w-9 h-9 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                              i === currentIdx
                                ? 'ring-2 ring-indigo-500 bg-indigo-600 text-white shadow-md'
                                : st === 'answered'
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                                : st === 'flagged'
                                ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                                : 'bg-white/5 text-gray-400 border border-white/10 hover:border-white/20'
                            }`}
                          >
                            {i + 1}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Active Question Card */}
                  {currentQuestion && (
                    <div className="bg-gray-900/60 border border-white/[0.07] rounded-2xl p-6 md:p-8 flex flex-col justify-between min-h-[22rem]">
                      <div>
                        <div className="flex items-start justify-between gap-4 mb-4">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-mono text-gray-400">
                              Question {currentIdx + 1} of {questions.length}
                            </span>
                            {currentQuestion.topic && (
                              <span className="text-[10px] text-gray-400 bg-white/5 px-2.5 py-0.5 rounded-full border border-white/8">
                                {currentQuestion.topic}
                              </span>
                            )}
                            <span
                              className={`text-[10px] font-semibold px-2.5 py-0.5 rounded-full border ${difficultyBadge(
                                currentQuestion.difficulty,
                              )}`}
                            >
                              {currentQuestion.difficulty}
                            </span>
                          </div>
                          <span className="text-xs font-semibold text-gray-400 font-mono">
                            {currentQuestion.points} {currentQuestion.points === 1 ? 'pt' : 'pts'}
                          </span>
                        </div>

                        <h3 className="text-base font-semibold text-white leading-relaxed mb-6">
                          {currentQuestion.question_text}
                        </h3>

                        {/* Question Inputs */}
                        <div className="mb-6">
                          {currentQuestion.type === 'mcq' && (
                            <MCQQuestion
                              q={currentQuestion}
                              value={getStringAnswer(currentQuestion.id)}
                              onChange={(v) => setAnswer(currentQuestion.id, JSON.stringify(v))}
                              disabled={isPaused || isSubmitted}
                            />
                          )}
                          {currentQuestion.type === 'multi_select' && (
                            <MultiSelectQuestion
                              q={currentQuestion}
                              value={getArrayAnswer(currentQuestion.id)}
                              onChange={(v) => setAnswer(currentQuestion.id, JSON.stringify(v))}
                              disabled={isPaused || isSubmitted}
                            />
                          )}
                          {currentQuestion.type === 'fill_in_blank' && (
                            <FillInBlankQuestion
                              q={currentQuestion}
                              value={getArrayAnswer(currentQuestion.id)}
                              onChange={(v) => setAnswer(currentQuestion.id, JSON.stringify(v))}
                              disabled={isPaused || isSubmitted}
                            />
                          )}
                          {(currentQuestion.type === 'short_answer' ||
                            currentQuestion.type === 'long_answer') && (
                            <TextQuestion
                              q={currentQuestion}
                              value={getStringAnswer(currentQuestion.id)}
                              onChange={(v) => setAnswer(currentQuestion.id, JSON.stringify(v))}
                              disabled={isPaused || isSubmitted}
                            />
                          )}
                        </div>
                      </div>

                      {/* Navigation Controls */}
                      <div className="flex items-center justify-between pt-4 border-t border-white/5">
                        <button
                          id="prev-question-btn"
                          onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
                          disabled={currentIdx === 0}
                          className="px-4 py-2.5 rounded-xl border border-white/10 text-gray-300 text-xs font-semibold hover:bg-white/5 transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                          ← Previous Question
                        </button>

                        <div className="flex items-center gap-2">
                          {currentIdx === questions.length - 1 ? (
                            <button
                              id="submit-from-last-btn"
                              onClick={() => setShowSubmitModal(true)}
                              disabled={isPaused}
                              className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all cursor-pointer shadow-lg shadow-emerald-900/40"
                            >
                              Finish & Submit Exam →
                            </button>
                          ) : (
                            <button
                              id="next-question-btn"
                              onClick={() => setCurrentIdx((i) => Math.min(questions.length - 1, i + 1))}
                              className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-all cursor-pointer"
                            >
                              Next Question →
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                /* ── Telemetry & Event Log Tab ─────────────────────────────── */
                <div className="flex flex-col gap-4">
                  {/* Risk analysis card */}
                  <div className="rounded-2xl bg-gray-900/60 border border-white/[0.07] p-5">
                    <div className="flex flex-col sm:flex-row items-center gap-6">
                      <RiskIndicator score={riskScore} />
                      <div className="flex-1 min-w-0">
                        <h3 className="text-sm font-semibold text-gray-200 mb-1.5">
                          Real-time AI Risk Analysis
                        </h3>
                        <p className="text-xs text-gray-500 leading-relaxed mb-4">
                          Computed by <span className="text-violet-400">Llama 3.3-70B</span> on
                          Cloudflare Workers AI. Behavioral and visual signals are analyzed against the full
                          session history.
                        </p>

                        {violations.length > 0 ? (
                          <div className="space-y-1.5 max-h-36 overflow-y-auto custom-scroll">
                            {[...violations].reverse().slice(0, 6).map((v) => (
                              <div key={v.id} className="flex items-center gap-2 text-xs">
                                <span
                                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                                    v.severity === 'critical'
                                      ? 'bg-red-500'
                                      : v.severity === 'high'
                                      ? 'bg-orange-500'
                                      : v.severity === 'medium'
                                      ? 'bg-yellow-500'
                                      : 'bg-emerald-500'
                                  }`}
                                />
                                <span className="capitalize text-gray-500">{v.type}</span>
                                <span className="text-gray-700">·</span>
                                <span
                                  className={`capitalize font-semibold ${
                                    v.severity === 'critical'
                                      ? 'text-red-400'
                                      : v.severity === 'high'
                                      ? 'text-orange-400'
                                      : v.severity === 'medium'
                                      ? 'text-yellow-400'
                                      : 'text-emerald-400'
                                  }`}
                                >
                                  {v.severity}
                                </span>
                                <span className="text-gray-700 ml-auto font-mono">
                                  {Math.round(v.aiConfidence * 100)}% conf.
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-gray-700 italic">No violations recorded yet.</p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Event log card */}
                  <div className="rounded-2xl bg-gray-900/60 border border-white/[0.07] p-4 min-h-[22rem] flex flex-col">
                    <EventLog events={visibleLog} onClear={() => setVisibleLog([])} />
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* ── Footer ────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.07] mt-auto py-3 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-gray-600">
          <span>
            Autonomous Proctoring Agent
            {isPaused ? ' · ⏸️ Exam Paused' : ''}
            {isTerminated ? ' · 🛑 Exam Terminated' : ''}
          </span>
          <span>Powered by Cloudflare Workers AI · Durable Objects · WebSockets</span>
        </div>
      </footer>
    </div>
  );
}
