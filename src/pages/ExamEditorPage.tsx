/**
 * src/pages/ExamEditorPage.tsx — Exam-centric editor & command center (Phase 4c-1)
 *
 * Scoped container tabs:
 *   • Overview: Large join code, copy/regenerate, active toggle, schedule, student flow guide
 *   • Questions: Question list with reorder, edit, delete, question drawer, import modal
 *   • Live Monitor: Embedded live proctoring dashboard scoped to this exam
 *   • Submissions: Attempts table with scores and auto/manual status
 *   • Settings: Proctoring settings, show_answers toggle, schedule edits (draft only)
 */

import { useEffect, useState, useCallback } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import type { Exam, Question, DerivedExamStatus } from '../types';
import {
  getExam,
  updateExam,
  publishExam,
  regenerateJoinCode,
  toggleJoinCode,
  listExamQuestions,
  createExamQuestion,
  updateExamQuestion,
  deleteExamQuestion,
  reorderExamQuestions,
  listExamSubmissions,
  startPreviewExam,
  releaseResults,
  unreleaseResults,
  type GradedAttemptRow,
  ApiError,
} from '../hooks/useProfessorApi';
import { QuestionDrawer, type QuestionDrawerSaveData } from '../components/QuestionDrawer';
import { ImportQuestionsModal } from '../components/ImportQuestionsModal';
import { ProfessorDashboard } from './ProfessorDashboard';
import { GradingView } from '../components/GradingView';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatJoinCode(code?: string | null): string {
  if (!code) return '—';
  const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

const STATUS_COLORS: Record<DerivedExamStatus, { bg: string; text: string; border: string }> = {
  draft: { bg: 'rgba(107, 114, 128, 0.15)', text: '#9ca3af', border: 'rgba(107, 114, 128, 0.3)' },
  scheduled: { bg: 'rgba(59, 130, 246, 0.15)', text: '#60a5fa', border: 'rgba(59, 130, 246, 0.3)' },
  live: { bg: 'rgba(16, 185, 129, 0.15)', text: '#34d399', border: 'rgba(16, 185, 129, 0.3)' },
  ended: { bg: 'rgba(239, 68, 68, 0.15)', text: '#f87171', border: 'rgba(239, 68, 68, 0.3)' },
};

function DerivedStatusBadge({ status }: { status?: DerivedExamStatus }) {
  const s = status || 'draft';
  const style = STATUS_COLORS[s] || STATUS_COLORS.draft;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 10px',
        borderRadius: 12,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        background: style.bg,
        color: style.text,
        border: `1px solid ${style.border}`,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: style.text,
        }}
      />
      {s}
    </span>
  );
}

// ─── Submissions Tab Component ───────────────────────────────────────────────

function SubmissionsTab({
  examId,
  exam,
  onRefreshExam,
}: {
  examId: string;
  exam?: Exam | null;
  onRefreshExam?: () => void;
}) {
  const [attempts, setAttempts] = useState<GradedAttemptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showTestAttempts, setShowTestAttempts] = useState(false);
  const [gradingAttemptId, setGradingAttemptId] = useState<string | null | undefined>(undefined);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [releasing, setReleasing] = useState(false);

  const loadSubmissions = useCallback(() => {
    setLoading(true);
    listExamSubmissions(examId, showTestAttempts)
      .then(setAttempts)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [examId, showTestAttempts]);

  useEffect(() => {
    loadSubmissions();
  }, [loadSubmissions]);

  // Statistics
  const totalSubmissions = attempts.length;
  const needsGradingAttempts = attempts.filter(
    (a) => a.status !== 'in_progress' && (a.needs_grading_count > 0 || !a.fully_graded),
  );
  const fullyGradedAttempts = attempts.filter(
    (a) => a.status !== 'in_progress' && a.fully_graded === 1,
  );
  const inProgressCount = attempts.filter((a) => a.status === 'in_progress').length;

  const gradedScores = attempts
    .filter((a) => a.fully_graded === 1 && a.score !== null)
    .map((a) => a.score as number);
  const avgScore =
    gradedScores.length > 0
      ? Math.round(
          (gradedScores.reduce((sum, s) => sum + s, 0) / gradedScores.length) * 10,
        ) / 10
      : null;

  const isReleased = exam?.results_released === 1;

  async function handleToggleRelease() {
    if (isReleased) {
      if (!confirm('Are you sure you want to unrelease results? Students will no longer see scores.')) {
        return;
      }
      setReleasing(true);
      try {
        await unreleaseResults(examId);
        onRefreshExam?.();
      } catch (e) {
        alert(e instanceof Error ? e.message : 'Failed to unrelease results');
      } finally {
        setReleasing(false);
      }
    } else {
      setConfirmRelease(true);
    }
  }

  async function handleExecuteRelease() {
    setReleasing(true);
    try {
      await releaseResults(examId);
      setConfirmRelease(false);
      onRefreshExam?.();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to release results');
    } finally {
      setReleasing(false);
    }
  }

  function statusColor(s: string) {
    if (s === 'submitted') return '#10b981';
    if (s === 'auto_submitted') return '#3b82f6';
    if (s === 'terminated') return '#ef4444';
    return '#f59e0b';
  }

  if (loading) {
    return (
      <div style={{ color: '#64748b', fontSize: 13, padding: '24px 0' }}>Loading submissions…</div>
    );
  }
  if (error) {
    return <div style={{ color: '#f87171', fontSize: 13 }}>Error: {error}</div>;
  }

  return (
    <div>
      {/* Needs Grading Banner */}
      {needsGradingAttempts.length > 0 && (
        <div
          style={{
            background: 'rgba(245, 158, 11, 0.1)',
            border: '1px solid rgba(245, 158, 11, 0.3)',
            borderRadius: 12,
            padding: '14px 18px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>⚠️</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24' }}>
                {needsGradingAttempts.length} submission(s) need manual grading
              </div>
              <div style={{ fontSize: 11, color: '#d97706' }}>
                Students with manual questions cannot see finalized results until graded.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setGradingAttemptId(null)}
            style={{
              background: '#f59e0b',
              color: '#0f172a',
              border: 'none',
              borderRadius: 6,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            📋 Grade by Question
          </button>
        </div>
      )}

      {/* Summary Metrics & Actions Bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 16,
        }}
      >
        {/* Metric Pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 8,
              padding: '6px 14px',
              fontSize: 12,
              color: '#94a3b8',
            }}
          >
            Total Submissions: <strong style={{ color: '#f8fafc' }}>{totalSubmissions}</strong>
          </div>
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 8,
              padding: '6px 14px',
              fontSize: 12,
              color: '#94a3b8',
            }}
          >
            Needs Grading:{' '}
            <strong style={{ color: needsGradingAttempts.length > 0 ? '#f59e0b' : '#10b981' }}>
              {needsGradingAttempts.length}
            </strong>
          </div>
          <div
            style={{
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              borderRadius: 8,
              padding: '6px 14px',
              fontSize: 12,
              color: '#94a3b8',
            }}
          >
            Fully Graded:{' '}
            <strong style={{ color: '#10b981' }}>{fullyGradedAttempts.length}</strong>
          </div>
          {avgScore !== null && (
            <div
              style={{
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: 8,
                padding: '6px 14px',
                fontSize: 12,
                color: '#94a3b8',
              }}
            >
              Avg Score: <strong style={{ color: '#38bdf8' }}>{avgScore}</strong>
            </div>
          )}
        </div>

        {/* Global Action Buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: '#94a3b8',
              cursor: 'pointer',
              userSelect: 'none',
              padding: '6px 10px',
              borderRadius: 6,
              background: showTestAttempts ? 'rgba(236,72,153,0.1)' : 'transparent',
              border: showTestAttempts ? '1px solid rgba(236,72,153,0.3)' : '1px solid transparent',
            }}
          >
            <input
              type="checkbox"
              checked={showTestAttempts}
              onChange={(e) => setShowTestAttempts(e.target.checked)}
              style={{ accentColor: '#ec4899' }}
            />
            <span>Show test attempts</span>
          </label>

          <button
            type="button"
            onClick={() => setGradingAttemptId(null)}
            style={{
              background: 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: 8,
              padding: '7px 14px',
              fontSize: 12,
              fontWeight: 600,
              color: '#e2e8f0',
              cursor: 'pointer',
            }}
          >
            📋 Grade by Question
          </button>

          <button
            type="button"
            onClick={handleToggleRelease}
            disabled={releasing}
            style={{
              background: isReleased ? 'rgba(16, 185, 129, 0.15)' : '#6366f1',
              color: isReleased ? '#34d399' : '#fff',
              border: isReleased ? '1px solid rgba(16, 185, 129, 0.4)' : 'none',
              borderRadius: 8,
              padding: '7px 16px',
              fontSize: 12,
              fontWeight: 700,
              cursor: releasing ? 'not-allowed' : 'pointer',
            }}
          >
            {releasing
              ? 'Updating…'
              : isReleased
                ? '✓ Results Released (Unrelease)'
                : '📢 Release Results'}
          </button>
        </div>
      </div>

      {/* Submissions Table */}
      {attempts.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>
          No students have submitted this exam yet.
        </div>
      ) : (
        <div
          style={{
            overflowX: 'auto',
            background: '#0f172a',
            borderRadius: 12,
            border: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr
                style={{
                  borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                  background: 'rgba(255, 255, 255, 0.02)',
                }}
              >
                {['Student', 'Status', 'Score', 'Grading', 'Started', 'Submitted', 'Action'].map(
                  (h) => (
                    <th
                      key={h}
                      style={{
                        padding: '12px 16px',
                        textAlign: 'left',
                        color: '#64748b',
                        fontWeight: 600,
                        letterSpacing: '0.04em',
                        fontSize: 11,
                        textTransform: 'uppercase',
                      }}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr
                  key={a.id}
                  style={{
                    borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = 'rgba(255, 255, 255, 0.03)')
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '12px 16px', color: '#e2e8f0', fontWeight: 600 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{a.student_name}</span>
                      {a.is_test === 1 && (
                        <span
                          style={{
                            fontSize: 10,
                            padding: '1px 6px',
                            borderRadius: 4,
                            background: 'rgba(236, 72, 153, 0.2)',
                            color: '#f472b6',
                            border: '1px solid rgba(236, 72, 153, 0.4)',
                            fontWeight: 700,
                            letterSpacing: '0.04em',
                          }}
                        >
                          TEST
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 8,
                        background: `${statusColor(a.status)}22`,
                        color: statusColor(a.status),
                        border: `1px solid ${statusColor(a.status)}44`,
                      }}
                    >
                      {a.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td style={{ padding: '12px 16px', color: '#e2e8f0', fontWeight: 600 }}>
                    {a.score !== null ? `${a.score} / ${a.max_score}` : '—'}
                  </td>
                  <td style={{ padding: '12px 16px', fontSize: 12 }}>
                    {a.fully_graded === 1 ? (
                      <span style={{ color: '#10b981' }}>✓ Fully graded</span>
                    ) : a.needs_grading_count > 0 ? (
                      <span style={{ color: '#f59e0b' }}>
                        ⏳ Needs grading ({a.needs_grading_count})
                      </span>
                    ) : (
                      <span style={{ color: '#64748b' }}>Pending</span>
                    )}
                  </td>
                  <td style={{ padding: '12px 16px', color: '#64748b', fontSize: 12 }}>
                    {new Date(a.started_at).toLocaleString()}
                  </td>
                  <td style={{ padding: '12px 16px', color: '#64748b', fontSize: 12 }}>
                    {a.submitted_at ? new Date(a.submitted_at).toLocaleString() : '—'}
                  </td>
                  <td style={{ padding: '12px 16px' }}>
                    <button
                      type="button"
                      onClick={() => setGradingAttemptId(a.id)}
                      style={{
                        background: 'rgba(99, 102, 241, 0.15)',
                        border: '1px solid rgba(99, 102, 241, 0.3)',
                        borderRadius: 6,
                        color: '#a5b4fc',
                        fontSize: 12,
                        fontWeight: 600,
                        padding: '4px 10px',
                        cursor: 'pointer',
                      }}
                    >
                      📝 Grade
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Release Results Confirmation Modal */}
      {confirmRelease && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            background: 'rgba(3, 7, 18, 0.8)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
        >
          <div
            style={{
              background: '#0f172a',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: 14,
              padding: '24px',
              maxWidth: 480,
              width: '100%',
              boxShadow: '0 20px 25px -5px rgba(0,0,0,0.5)',
            }}
          >
            <h3 style={{ margin: '0 0 12px', fontSize: 17, color: '#f8fafc', fontWeight: 700 }}>
              Release Exam Results to Students?
            </h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#94a3b8', lineHeight: 1.5 }}>
              Releasing results makes final scores and feedback available to enrolled students.
            </p>

            <div
              style={{
                background: 'rgba(255, 255, 255, 0.03)',
                borderRadius: 8,
                padding: '12px 16px',
                marginBottom: 20,
                fontSize: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#cbd5e1' }}>
                <span>Total Submissions:</span>
                <strong>{totalSubmissions}</strong>
              </div>
              {inProgressCount > 0 && (
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', color: '#f59e0b' }}
                >
                  <span>⚠️ Still In Progress:</span>
                  <strong>{inProgressCount} students</strong>
                </div>
              )}
              {needsGradingAttempts.length > 0 && (
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', color: '#f59e0b' }}
                >
                  <span>⚠️ Pending Manual Grading:</span>
                  <strong>{needsGradingAttempts.length} submissions</strong>
                </div>
              )}
              {needsGradingAttempts.length === 0 && inProgressCount === 0 && (
                <div style={{ color: '#10b981' }}>✓ All submissions are fully graded!</div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                onClick={() => setConfirmRelease(false)}
                disabled={releasing}
                style={{
                  background: 'transparent',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  color: '#94a3b8',
                  borderRadius: 6,
                  padding: '7px 14px',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteRelease}
                disabled={releasing}
                style={{
                  background: '#6366f1',
                  border: 'none',
                  color: '#fff',
                  borderRadius: 6,
                  padding: '7px 16px',
                  fontSize: 13,
                  fontWeight: 700,
                  cursor: releasing ? 'not-allowed' : 'pointer',
                }}
              >
                {releasing ? 'Releasing…' : 'Confirm & Release Results'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Grading View Modal */}
      {gradingAttemptId !== undefined && (
        <GradingView
          examId={examId}
          initialAttemptId={gradingAttemptId}
          onClose={() => setGradingAttemptId(undefined)}
          onGraded={() => {
            loadSubmissions();
            onRefreshExam?.();
          }}
        />
      )}
    </div>
  );
}

// ─── Main ExamEditorPage ──────────────────────────────────────────────────────

type EditorTab = 'overview' | 'questions' | 'live' | 'submissions' | 'settings';

export function ExamEditorPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();

  // Active tab state
  const initialTab = (searchParams.get('tab') as EditorTab) || (window.location.pathname.endsWith('/live') ? 'live' : 'overview');
  const [activeTab, setActiveTab] = useState<EditorTab>(initialTab);

  // Exam and questions state
  const [exam, setExam] = useState<Exam | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  // Join code states
  const [copyCodeSuccess, setCopyCodeSuccess] = useState(false);
  const [copyLinkSuccess, setCopyLinkSuccess] = useState(false);
  const [togglingCode, setTogglingCode] = useState(false);

  // Question Drawer & Modal states
  const [editingQuestion, setEditingQuestion] = useState<Question | null | undefined>(undefined);
  const [showImportModal, setShowImportModal] = useState(false);
  const [deleteQTarget, setDeleteQTarget] = useState<Question | null>(null);

  // Preview exam states (Phase 4c-2b)
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [previewMode, setPreviewMode] = useState<'questions_only' | 'full'>('questions_only');
  const [previewLoading, setPreviewLoading] = useState(false);

  // Settings form state
  const [settingsForm, setSettingsForm] = useState({
    title: '',
    course_code: '',
    description: '',
    duration_minutes: 60,
    start_time: '',
    end_time: '',
    strictness: 'medium' as 'low' | 'medium' | 'high' | 'custom',
    enable_vision: true,
    enable_identity: true,
    max_risk_score: 80,
    show_answers: false,
    instant_results: false,
    retention_days: 90,
  });

  const isDraft = exam?.status === 'draft';

  // Load exam and its questions
  const loadExamData = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const e = await getExam(id);
      setExam(e);

      setSettingsForm({
        title: e.title || '',
        course_code: e.course_code || '',
        description: e.description || '',
        duration_minutes: e.duration_minutes || 60,
        start_time: e.start_time ? e.start_time.slice(0, 16) : '',
        end_time: e.end_time ? e.end_time.slice(0, 16) : '',
        strictness: (e.strictness as 'low' | 'medium' | 'high' | 'custom') || 'medium',
        enable_vision: Boolean(e.enable_vision),
        enable_identity: Boolean(e.enable_identity),
        max_risk_score: e.max_risk_score || 80,
        show_answers: Boolean(e.show_answers),
        instant_results: Boolean(e.instant_results),
        retention_days: e.retention_days !== undefined ? e.retention_days : 90,
      });

      const qs = await listExamQuestions(id);
      setQuestions(qs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load exam');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadExamData();
  }, [loadExamData]);

  // Keep query param in sync with active tab
  const handleTabChange = (t: EditorTab) => {
    setActiveTab(t);
    setSearchParams({ tab: t });
  };

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handlePublish() {
    if (!exam) return;
    if (questions.length === 0) {
      setError('Cannot publish: Exam must have at least one question.');
      return;
    }
    const totalPts = questions.reduce((acc, q) => acc + (q.points || 0), 0);
    if (totalPts <= 0) {
      setError('Cannot publish: Total points must be greater than 0.');
      return;
    }

    setPublishing(true);
    setError('');
    try {
      const updated = await publishExam(exam.id, {
        status: 'scheduled',
        start_time: exam.start_time,
        end_time: exam.end_time,
      });
      setExam(updated);
      setSuccessMsg('Exam published successfully! Questions and timing are now frozen.');
      setTimeout(() => setSuccessMsg(''), 4000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Publish failed');
    } finally {
      setPublishing(false);
    }
  }

  async function handleRegenerateCode() {
    if (!exam || !isDraft) return;
    if (!window.confirm('Regenerate join code? Previous code will immediately stop working.')) return;
    try {
      const newCode = await regenerateJoinCode(exam.id);
      setExam((prev) => (prev ? { ...prev, join_code: newCode } : prev));
      setSuccessMsg('Join code regenerated successfully.');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to regenerate code');
    }
  }

  async function handleToggleCodeActive() {
    if (!exam) return;
    setTogglingCode(true);
    try {
      const next = !exam.join_code_active;
      await toggleJoinCode(exam.id, next);
      setExam((prev) => (prev ? { ...prev, join_code_active: next } : prev));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to toggle code status');
    } finally {
      setTogglingCode(false);
    }
  }

  function handleCopyCode() {
    if (!exam?.join_code) return;
    navigator.clipboard.writeText(formatJoinCode(exam.join_code));
    setCopyCodeSuccess(true);
    setTimeout(() => setCopyCodeSuccess(false), 2000);
  }

  function handleCopyLink() {
    if (!exam?.join_code) return;
    const url = `${window.location.origin}/student?code=${exam.join_code}`;
    navigator.clipboard.writeText(url);
    setCopyLinkSuccess(true);
    setTimeout(() => setCopyLinkSuccess(false), 2000);
  }

  async function handleLaunchPreview() {
    if (!exam) return;
    setPreviewLoading(true);
    try {
      const data = await startPreviewExam(exam.id);
      sessionStorage.setItem(`apa_preview_data_${exam.id}`, JSON.stringify(data));
      sessionStorage.setItem('apa_student_name', data.attempt.student_name);
      sessionStorage.setItem(`apa_attempt_${exam.id}_${data.attempt.student_name}`, data.attempt.id);
      setShowPreviewModal(false);
      window.open(`/exam?exam=${exam.id}&preview=${previewMode}&attemptId=${data.attempt.id}`, '_blank');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to launch preview');
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleSaveSettings(e: React.FormEvent) {
    e.preventDefault();
    if (!exam) return;
    setSavingSettings(true);
    setError('');
    try {
      const updated = await updateExam(exam.id, {
        title: settingsForm.title.trim(),
        course_code: settingsForm.course_code.trim(),
        description: settingsForm.description.trim(),
        duration_minutes: Number(settingsForm.duration_minutes),
        start_time: settingsForm.start_time ? new Date(settingsForm.start_time).toISOString() : null,
        end_time: settingsForm.end_time ? new Date(settingsForm.end_time).toISOString() : null,
        strictness: settingsForm.strictness,
        enable_vision: settingsForm.enable_vision ? 1 : 0,
        enable_identity: settingsForm.enable_identity ? 1 : 0,
        max_risk_score: Number(settingsForm.max_risk_score),
        show_answers: settingsForm.show_answers ? 1 : 0,
        instant_results: settingsForm.instant_results ? 1 : 0,
        retention_days: Number(settingsForm.retention_days),
      });
      setExam(updated);
      setSuccessMsg('Settings saved successfully.');
      setTimeout(() => setSuccessMsg(''), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  }

  // ── Question Operations ────────────────────────────────────────────────────

  async function handleSaveQuestion(data: QuestionDrawerSaveData) {
    if (!exam) return;
    if (editingQuestion) {
      // Update
      const updated = await updateExamQuestion(exam.id, editingQuestion.id, data);
      setQuestions((prev) => prev.map((q) => (q.id === updated.id ? updated : q)));
    } else {
      // Create
      const created = await createExamQuestion(exam.id, data);
      setQuestions((prev) => [...prev, created]);
    }
    setEditingQuestion(undefined);
  }

  async function handleDeleteQuestion(qid: string) {
    if (!exam) return;
    setDeleteQTarget(null);
    try {
      await deleteExamQuestion(exam.id, qid);
      setQuestions((prev) => prev.filter((q) => q.id !== qid));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete question');
    }
  }

  async function handleMoveQuestion(idx: number, direction: 'up' | 'down') {
    if (!exam || !isDraft) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= questions.length) return;

    const copy = [...questions];
    [copy[idx], copy[targetIdx]] = [copy[targetIdx], copy[idx]];
    setQuestions(copy);

    try {
      await reorderExamQuestions(
        exam.id,
        copy.map((q) => q.id),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save reorder');
      void loadExamData();
    }
  }

  if (loading) {
    return (
      <div style={{ ...pageStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>
        Loading exam workspace…
      </div>
    );
  }

  if (!exam) {
    return (
      <div style={pageStyle}>
        <div style={errorBox}>Exam not found.</div>
        <Link to="/professor/exams" style={{ color: '#818cf8', textDecoration: 'none' }}>
          ← Back to Exams
        </Link>
      </div>
    );
  }

  const totalPoints = questions.reduce((acc, q) => acc + (q.points || 0), 0);

  return (
    <div style={pageStyle}>
      {/* ── Top Bar ───────────────────────────────────────────────────────── */}
      <div style={topBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/professor/exams" style={backLink}>
            ← Exams
          </Link>
          <span style={{ color: '#475569' }}>/</span>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#f1f5f9' }}>
            {exam.title}
          </h1>
          <DerivedStatusBadge status={exam.derived_status} />
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            type="button"
            style={{
              ...btnSecondary,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              background: 'rgba(129, 140, 248, 0.12)',
              borderColor: 'rgba(129, 140, 248, 0.35)',
              color: '#c7d2fe',
            }}
            onClick={() => setShowPreviewModal(true)}
            id="preview-exam-btn"
          >
            <span>👁️</span>
            <span>Preview Exam</span>
          </button>

          {isDraft && (
            <button
              style={{ ...btnPrimary, background: 'linear-gradient(135deg,#3b82f6,#6366f1)' }}
              onClick={() => void handlePublish()}
              disabled={publishing}
              id="publish-exam-btn"
            >
              {publishing ? 'Publishing…' : '🚀 Publish Exam'}
            </button>
          )}
        </div>
      </div>

      {error && <div style={errorBox}>⚠️ {error}</div>}
      {successMsg && <div style={successBox}>✓ {successMsg}</div>}

      {/* ── Tabs Navigation ───────────────────────────────────────────────── */}
      <div style={tabStrip}>
        <button
          style={{ ...tabBtn, borderBottom: activeTab === 'overview' ? '2px solid #818cf8' : '2px solid transparent', color: activeTab === 'overview' ? '#f1f5f9' : '#64748b' }}
          onClick={() => handleTabChange('overview')}
        >
          📌 Overview & Join Code
        </button>
        <button
          style={{ ...tabBtn, borderBottom: activeTab === 'questions' ? '2px solid #818cf8' : '2px solid transparent', color: activeTab === 'questions' ? '#f1f5f9' : '#64748b' }}
          onClick={() => handleTabChange('questions')}
        >
          📝 Questions ({questions.length})
        </button>
        <button
          style={{ ...tabBtn, borderBottom: activeTab === 'live' ? '2px solid #818cf8' : '2px solid transparent', color: activeTab === 'live' ? '#f1f5f9' : '#64748b' }}
          onClick={() => handleTabChange('live')}
        >
          📡 Live Monitor
        </button>
        <button
          style={{ ...tabBtn, borderBottom: activeTab === 'submissions' ? '2px solid #818cf8' : '2px solid transparent', color: activeTab === 'submissions' ? '#f1f5f9' : '#64748b' }}
          onClick={() => handleTabChange('submissions')}
        >
          📥 Submissions
        </button>
        <button
          style={{ ...tabBtn, borderBottom: activeTab === 'settings' ? '2px solid #818cf8' : '2px solid transparent', color: activeTab === 'settings' ? '#f1f5f9' : '#64748b' }}
          onClick={() => handleTabChange('settings')}
        >
          ⚙️ Settings
        </button>
      </div>

      {/* ── Tab Content ───────────────────────────────────────────────────── */}

      {/* ── Tab 1: OVERVIEW ───────────────────────────────────────────────── */}
      {activeTab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Join Code Hero Card */}
          <div style={heroCard}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
              <div>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#818cf8' }}>
                  Exam Access Code
                </span>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 4 }}>
                  <span style={heroCodeText}>
                    {formatJoinCode(exam.join_code)}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: '2px 8px',
                      borderRadius: 6,
                      background: exam.join_code_active ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                      color: exam.join_code_active ? '#34d399' : '#f87171',
                      border: `1px solid ${exam.join_code_active ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                    }}
                  >
                    {exam.join_code_active ? 'CODE ACTIVE' : 'CODE DISABLED'}
                  </span>
                </div>
                <p style={{ margin: '6px 0 0', fontSize: 12, color: '#94a3b8' }}>
                  Share this 8-character code with students to join the exam lobby.
                </p>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  style={btnPrimary}
                  onClick={handleCopyCode}
                  id="copy-join-code-btn"
                >
                  {copyCodeSuccess ? '✓ Copied Code!' : '📋 Copy Code'}
                </button>
                <button
                  style={btnSecondary}
                  onClick={handleCopyLink}
                >
                  {copyLinkSuccess ? '✓ Copied Link!' : '🔗 Copy Student Link'}
                </button>
                <button
                  style={{
                    ...btnSecondary,
                    color: exam.join_code_active ? '#f87171' : '#34d399',
                  }}
                  onClick={() => void handleToggleCodeActive()}
                  disabled={togglingCode}
                >
                  {togglingCode ? '…' : exam.join_code_active ? 'Disable Code' : 'Enable Code'}
                </button>
                {isDraft && (
                  <button
                    style={btnSecondary}
                    onClick={() => void handleRegenerateCode()}
                    title="Generate a new random join code"
                  >
                    🔄 Regenerate
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Schedule & Counts Strip */}
          <div style={statsGrid}>
            <div style={statBox}>
              <span style={statLabel}>Duration</span>
              <span style={statValue}>{exam.duration_minutes} min</span>
              <span style={statSub}>Enforced server-side</span>
            </div>
            <div style={statBox}>
              <span style={statLabel}>Questions</span>
              <span style={statValue}>{questions.length}</span>
              <span style={statSub}>{totalPoints} total points</span>
            </div>
            <div style={statBox}>
              <span style={statLabel}>Enrolled Students</span>
              <span style={statValue}>{exam.student_count ?? 0}</span>
              <span style={statSub}>Joined with code</span>
            </div>
            <div style={statBox}>
              <span style={statLabel}>Window</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0', marginTop: 4 }}>
                {exam.start_time ? new Date(exam.start_time).toLocaleDateString() : 'Always open'}
              </span>
              <span style={statSub}>
                {exam.end_time ? `Ends ${new Date(exam.end_time).toLocaleDateString()}` : 'No end deadline'}
              </span>
            </div>
          </div>

          {/* Student Join Flow Guide */}
          <div style={guideCard}>
            <h3 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
              💡 How students take this exam
            </h3>
            <div style={stepsGrid}>
              <div style={stepItem}>
                <span style={stepNumber}>1</span>
                <div>
                  <h4 style={stepTitle}>Enter Code</h4>
                  <p style={stepDesc}>Student opens <code>/student</code>, inputs their name and enters code <code>{formatJoinCode(exam.join_code)}</code>.</p>
                </div>
              </div>
              <div style={stepItem}>
                <span style={stepNumber}>2</span>
                <div>
                  <h4 style={stepTitle}>Pass Lobby Checks</h4>
                  <p style={stepDesc}>Student completes automated camera, fullscreen, and browser readiness checks in the lobby.</p>
                </div>
              </div>
              <div style={stepItem}>
                <span style={stepNumber}>3</span>
                <div>
                  <h4 style={stepTitle}>Identity & Proctoring</h4>
                  <p style={stepDesc}>Face reference is captured and real-time behavioral AI runs throughout the exam.</p>
                </div>
              </div>
              <div style={stepItem}>
                <span style={stepNumber}>4</span>
                <div>
                  <h4 style={stepTitle}>Live Monitoring</h4>
                  <p style={stepDesc}>Watch telemetry, flags, and interventions in real-time in the <strong>Live Monitor</strong> tab.</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Tab 2: QUESTIONS ──────────────────────────────────────────────── */}
      {activeTab === 'questions' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Header Action Bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
                Questions in this Exam
              </span>
              <span style={{ fontSize: 12, color: '#64748b', marginLeft: 12 }}>
                {questions.length} questions · {totalPoints} total points
              </span>
              {!isDraft && (
                <span style={{ marginLeft: 12, fontSize: 11, color: '#38bdf8', background: 'rgba(56,189,248,0.1)', padding: '2px 8px', borderRadius: 6, border: '1px solid rgba(56,189,248,0.2)' }}>
                  🔒 Questions frozen in published snapshot
                </span>
              )}
            </div>

            {isDraft && (
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  style={btnSecondary}
                  onClick={() => setShowImportModal(true)}
                  id="import-questions-btn"
                >
                  📥 Import from Previous Exams
                </button>
                <button
                  style={btnPrimary}
                  onClick={() => setEditingQuestion(null)}
                  id="add-question-btn"
                >
                  ➕ Add Question
                </button>
              </div>
            )}
          </div>

          {/* Question List */}
          {questions.length === 0 ? (
            <div style={emptyBox}>
              <div style={{ fontSize: 32, marginBottom: 8 }}>📝</div>
              <p style={{ margin: 0, fontSize: 14, color: '#cbd5e1', fontWeight: 600 }}>
                No questions added to this exam yet.
              </p>
              <p style={{ margin: '4px 0 16px', fontSize: 12, color: '#64748b' }}>
                Build questions directly here or import them from existing exams.
              </p>
              {isDraft && (
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                  <button style={btnPrimary} onClick={() => setEditingQuestion(null)}>
                    ➕ Add Question
                  </button>
                  <button style={btnSecondary} onClick={() => setShowImportModal(true)}>
                    📥 Import Questions
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {questions.map((q, idx) => (
                <div key={q.id} style={questionCard}>
                  {/* Position & Reorder */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b' }}>#{idx + 1}</span>
                    {isDraft && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <button
                          style={{ ...btnIconSmall, opacity: idx === 0 ? 0.2 : 0.8 }}
                          disabled={idx === 0}
                          onClick={() => void handleMoveQuestion(idx, 'up')}
                          title="Move up"
                        >
                          ▲
                        </button>
                        <button
                          style={{ ...btnIconSmall, opacity: idx === questions.length - 1 ? 0.2 : 0.8 }}
                          disabled={idx === questions.length - 1}
                          onClick={() => void handleMoveQuestion(idx, 'down')}
                          title="Move down"
                        >
                          ▼
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Main Question Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ margin: '0 0 6px', fontSize: 14, color: '#f1f5f9', fontWeight: 500, lineHeight: 1.4 }}>
                      {q.question_text}
                    </p>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={pill}>{q.type}</span>
                      <span style={{ fontSize: 11, color: '#94a3b8' }}>
                        {q.points} pt{q.points !== 1 ? 's' : ''}
                      </span>
                      {q.topic && (
                        <span style={{ fontSize: 11, color: '#64748b' }}>
                          Topic: {q.topic}
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: q.grading_mode === 'auto' ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)',
                          color: q.grading_mode === 'auto' ? '#34d399' : '#fbbf24',
                        }}
                      >
                        {q.grading_mode === 'auto' ? '✓ Auto-Graded' : '⏳ Manual'}
                      </span>
                    </div>
                  </div>

                  {/* Row Actions */}
                  {isDraft && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <button
                        style={btnSmSecondary}
                        onClick={() => setEditingQuestion(q)}
                        title="Edit Question"
                      >
                        Edit
                      </button>
                      <button
                        style={{ ...btnSmSecondary, color: '#f87171' }}
                        onClick={() => setDeleteQTarget(q)}
                        title="Delete Question"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Tab 3: LIVE MONITOR ───────────────────────────────────────────── */}
      {activeTab === 'live' && (
        <div style={{ borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
          <ProfessorDashboard fixedExamId={exam.id} />
        </div>
      )}

      {/* ── Tab 4: SUBMISSIONS ────────────────────────────────────────────── */}
      {activeTab === 'submissions' && (
        <div>
          <h2 style={{ margin: '0 0 16px', fontSize: 16, color: '#f1f5f9' }}>
            Student Exam Attempts
          </h2>
          <SubmissionsTab examId={exam.id} exam={exam} onRefreshExam={loadExamData} />
        </div>
      )}

      {/* ── Tab 5: SETTINGS ───────────────────────────────────────────────── */}
      {activeTab === 'settings' && (
        <form onSubmit={handleSaveSettings} style={{ maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Metadata */}
          <div style={settingsCard}>
            <h3 style={settingsSectionTitle}>Exam Information</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={labelStyle}>Title</label>
                <input
                  style={inputStyle}
                  value={settingsForm.title}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, title: e.target.value }))}
                  disabled={!isDraft}
                  required
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Course Code</label>
                  <input
                    style={inputStyle}
                    value={settingsForm.course_code}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, course_code: e.target.value }))}
                    disabled={!isDraft}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Duration (minutes)</label>
                  <input
                    style={inputStyle}
                    type="number"
                    min={1}
                    max={600}
                    value={settingsForm.duration_minutes}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, duration_minutes: Number(e.target.value) }))}
                    disabled={!isDraft}
                    required
                  />
                </div>
              </div>
              <div>
                <label style={labelStyle}>Description</label>
                <textarea
                  style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }}
                  value={settingsForm.description}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, description: e.target.value }))}
                  disabled={!isDraft}
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Start Window (local time)</label>
                  <input
                    style={inputStyle}
                    type="datetime-local"
                    value={settingsForm.start_time}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, start_time: e.target.value }))}
                    disabled={!isDraft}
                  />
                </div>
                <div>
                  <label style={labelStyle}>End Window (local time)</label>
                  <input
                    style={inputStyle}
                    type="datetime-local"
                    value={settingsForm.end_time}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, end_time: e.target.value }))}
                    disabled={!isDraft}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Proctoring Settings */}
          <div style={settingsCard}>
            <h3 style={settingsSectionTitle}>Proctoring Controls</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Strictness Profile</label>
                  <select
                    style={inputStyle}
                    value={settingsForm.strictness}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, strictness: e.target.value as any }))}
                  >
                    <option value="low">Low (Forgiving thresholds)</option>
                    <option value="medium">Medium (Standard academic)</option>
                    <option value="high">High (Strict verification)</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Max Risk Score Threshold (0-100)</label>
                  <input
                    style={inputStyle}
                    type="number"
                    min={10}
                    max={100}
                    value={settingsForm.max_risk_score}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, max_risk_score: Number(e.target.value) }))}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
                <label style={checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={settingsForm.enable_vision}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, enable_vision: e.target.checked }))}
                    style={{ accentColor: '#6366f1', width: 16, height: 16 }}
                  />
                  <span>Enable Vision AI (orientation away, face count, phone detection)</span>
                </label>

                <label style={checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={settingsForm.enable_identity}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, enable_identity: e.target.checked }))}
                    style={{ accentColor: '#6366f1', width: 16, height: 16 }}
                  />
                  <span>Enable Identity Verification (reference face descriptor matching)</span>
                </label>

                <label style={checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={settingsForm.show_answers}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, show_answers: e.target.checked }))}
                    style={{ accentColor: '#6366f1', width: 16, height: 16 }}
                  />
                  <span>Release Answers (Show correct answers on student result screen after submit)</span>
                </label>

                <label style={checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={settingsForm.instant_results}
                    onChange={(e) => setSettingsForm((f) => ({ ...f, instant_results: e.target.checked }))}
                    style={{ accentColor: '#6366f1', width: 16, height: 16 }}
                  />
                  <span>Instant Results (Automatically release score immediately on submit for auto-graded exams)</span>
                </label>
              </div>
            </div>

            {/* Phase 4c-2b: Data Retention Policy */}
            <div style={settingsCard}>
              <h3 style={settingsSectionTitle}>Data Retention Policy</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={labelStyle}>
                  Retention Period (Days)
                  <input
                    type="number"
                    min="0"
                    step="1"
                    style={{ ...inputStyle, width: 140, marginTop: 4 }}
                    value={settingsForm.retention_days}
                    onChange={(e) =>
                      setSettingsForm((f) => ({
                        ...f,
                        retention_days: Math.max(0, parseInt(e.target.value, 10) || 0),
                      }))
                    }
                  />
                </label>
                <p style={{ margin: 0, fontSize: 12, color: '#94a3b8', lineHeight: 1.5 }}>
                  Proctoring evidence will be deleted N days after each attempt ends. Attempts and scores are preserved. 0 keeps forever.
                </p>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button type="submit" style={btnPrimary} disabled={savingSettings}>
              {savingSettings ? 'Saving…' : '💾 Save Settings'}
            </button>
          </div>
        </form>
      )}

      {/* ── Drawers & Modals ──────────────────────────────────────────────── */}

      {/* Phase 4c-2b: Preview Exam Modal */}
      {showPreviewModal && (
        <div style={overlay}>
          <div style={{ ...confirmModal, maxWidth: 460 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 22 }}>🧪</span>
              <h3 style={{ margin: 0, color: '#f8fafc', fontSize: 16, fontWeight: 700 }}>
                Preview Exam as Student
              </h3>
            </div>
            <p style={{ margin: '0 0 16px', color: '#94a3b8', fontSize: 13, lineHeight: 1.5 }}>
              Launch a test session to experience your exam questions and grading flow. Test attempts are flagged with a TEST badge, excluded from student score distributions and grade release, and can be deleted anytime.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '12px 14px',
                  borderRadius: 10,
                  background: previewMode === 'questions_only' ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                  border: previewMode === 'questions_only' ? '1px solid #6366f1' : '1px solid rgba(255,255,255,0.08)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="preview_mode"
                  value="questions_only"
                  checked={previewMode === 'questions_only'}
                  onChange={() => setPreviewMode('questions_only')}
                  style={{ accentColor: '#6366f1', marginTop: 2 }}
                />
                <div>
                  <div style={{ color: '#f1f5f9', fontSize: 13, fontWeight: 600 }}>Questions only (no webcam)</div>
                  <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
                    Quickly test question formatting, inputs, and auto-grading. Skips camera setup and fullscreen.
                  </div>
                </div>
              </label>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '12px 14px',
                  borderRadius: 10,
                  background: previewMode === 'full' ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.03)',
                  border: previewMode === 'full' ? '1px solid #6366f1' : '1px solid rgba(255,255,255,0.08)',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="preview_mode"
                  value="full"
                  checked={previewMode === 'full'}
                  onChange={() => setPreviewMode('full')}
                  style={{ accentColor: '#6366f1', marginTop: 2 }}
                />
                <div>
                  <div style={{ color: '#f1f5f9', fontSize: 13, fontWeight: 600 }}>Full proctoring test</div>
                  <div style={{ color: '#64748b', fontSize: 12, marginTop: 2 }}>
                    Runs webcam, face recognition, fullscreen enforcement, and streams to the Live Monitor Test tab.
                  </div>
                </div>
              </label>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                type="button"
                style={btnSecondary}
                onClick={() => setShowPreviewModal(false)}
                disabled={previewLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                style={{ ...btnPrimary, background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}
                disabled={previewLoading}
                onClick={() => void handleLaunchPreview()}
              >
                {previewLoading ? 'Starting…' : '🚀 Launch Preview'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Question Drawer (Create / Edit) */}
      {editingQuestion !== undefined && (
        <QuestionDrawer
          initial={editingQuestion}
          onSave={handleSaveQuestion}
          onClose={() => setEditingQuestion(undefined)}
        />
      )}

      {/* Import Questions Modal */}
      {showImportModal && (
        <ImportQuestionsModal
          currentExamId={exam.id}
          onClose={() => setShowImportModal(false)}
          onImported={() => {
            void loadExamData();
            setSuccessMsg('Questions imported successfully.');
            setTimeout(() => setSuccessMsg(''), 3000);
          }}
        />
      )}

      {/* Delete Question Confirmation */}
      {deleteQTarget && (
        <div style={overlay}>
          <div style={confirmModal}>
            <h3 style={{ margin: '0 0 10px', color: '#f1f5f9', fontSize: 16 }}>Confirm Delete</h3>
            <p style={{ margin: '0 0 18px', color: '#cbd5e1', fontSize: 13 }}>
              Are you sure you want to delete this question?
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button style={btnSecondary} onClick={() => setDeleteQTarget(null)}>
                Cancel
              </button>
              <button
                style={{ ...btnPrimary, background: '#ef4444' }}
                onClick={() => void handleDeleteQuestion(deleteQTarget.id)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  maxWidth: 1200,
  margin: '0 auto',
  padding: '24px',
  color: '#e2e8f0',
};

const topBar: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 20,
  flexWrap: 'wrap',
  gap: 12,
};

const backLink: React.CSSProperties = {
  color: '#818cf8',
  textDecoration: 'none',
  fontSize: 13,
  fontWeight: 600,
};

const tabStrip: React.CSSProperties = {
  display: 'flex',
  gap: 16,
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  marginBottom: 24,
  overflowX: 'auto',
};

const tabBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: '10px 14px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'all 0.15s',
  whiteSpace: 'nowrap',
};

const heroCard: React.CSSProperties = {
  background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.7), rgba(15, 23, 42, 0.9))',
  border: '1px solid rgba(99, 102, 241, 0.25)',
  borderRadius: 14,
  padding: '24px 28px',
  boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
};

const heroCodeText: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 32,
  fontWeight: 800,
  letterSpacing: '0.1em',
  color: '#e0e7ff',
  textShadow: '0 0 20px rgba(99,102,241,0.5)',
};

const statsGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 16,
};

const statBox: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  padding: '16px 20px',
  display: 'flex',
  flexDirection: 'column',
};

const statLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: '#64748b',
};

const statValue: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  color: '#f1f5f9',
  marginTop: 4,
};

const statSub: React.CSSProperties = {
  fontSize: 11,
  color: '#94a3b8',
  marginTop: 2,
};

const guideCard: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  padding: '20px 24px',
};

const stepsGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 16,
};

const stepItem: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'flex-start',
};

const stepNumber: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: '50%',
  background: 'rgba(99,102,241,0.2)',
  color: '#818cf8',
  border: '1px solid rgba(99,102,241,0.4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontWeight: 700,
  fontSize: 13,
  flexShrink: 0,
};

const stepTitle: React.CSSProperties = {
  margin: '0 0 4px',
  fontSize: 13,
  fontWeight: 600,
  color: '#f1f5f9',
};

const stepDesc: React.CSSProperties = {
  margin: 0,
  fontSize: 11,
  color: '#94a3b8',
  lineHeight: 1.4,
};

const questionCard: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  padding: '14px 18px',
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  transition: 'border-color 0.15s',
};

const pill: React.CSSProperties = {
  fontSize: 10,
  fontFamily: 'monospace',
  padding: '2px 6px',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.06)',
  color: '#cbd5e1',
  textTransform: 'uppercase',
};

const settingsCard: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  padding: '20px 24px',
};

const settingsSectionTitle: React.CSSProperties = {
  margin: '0 0 16px',
  fontSize: 14,
  fontWeight: 700,
  color: '#f1f5f9',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  paddingBottom: 8,
};

const checkboxLabel: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  fontSize: 12,
  color: '#cbd5e1',
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  background: '#1e293b',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  padding: '8px 12px',
  color: '#f1f5f9',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
  outline: 'none',
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: '#94a3b8',
  display: 'block',
  marginBottom: 6,
};

const btnPrimary: React.CSSProperties = {
  background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const btnSecondary: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  color: '#94a3b8',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

const btnSmSecondary: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)',
  color: '#94a3b8',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  padding: '4px 10px',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

const btnIconSmall: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#94a3b8',
  fontSize: 9,
  cursor: 'pointer',
  padding: '2px 4px',
};

const emptyBox: React.CSSProperties = {
  textAlign: 'center',
  padding: '48px 20px',
  background: '#0f172a',
  borderRadius: 12,
  border: '1px dashed rgba(255,255,255,0.1)',
};

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.7)',
  backdropFilter: 'blur(4px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 16,
};

const confirmModal: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 12,
  padding: 24,
  maxWidth: 400,
  width: '100%',
};

const errorBox: React.CSSProperties = {
  background: 'rgba(239,68,68,0.15)',
  border: '1px solid rgba(239,68,68,0.3)',
  borderRadius: 8,
  padding: '10px 14px',
  color: '#f87171',
  fontSize: 13,
  marginBottom: 16,
};

const successBox: React.CSSProperties = {
  background: 'rgba(16,185,129,0.15)',
  border: '1px solid rgba(16,185,129,0.3)',
  borderRadius: 8,
  padding: '10px 14px',
  color: '#34d399',
  fontSize: 13,
  marginBottom: 16,
};
