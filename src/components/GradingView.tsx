/**
 * src/components/GradingView.tsx — Interactive Grading Suite (Phase 4c-2a)
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides:
 *   - "By Student" view: Grade all questions for a single attempt
 *   - "By Question" view: Grade one question across all students with blind mode
 *   - AI Suggest Grade with anti-prompt-injection & safe clamping
 *   - Score overrides for auto-graded short answer & fill in blank
 *   - Keyboard shortcuts: Ctrl+Enter / Cmd+Enter to save & advance
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useCallback } from 'react';
import type { GradingItem } from '../types';
import {
  getAttemptGradingView,
  getQuestionAnswers,
  gradeAnswer,
  suggestGrade,
  type GradingViewData,
} from '../hooks/useProfessorApi';

interface GradingViewProps {
  examId: string;
  initialAttemptId?: string | null;
  onClose: () => void;
  onGraded?: () => void;
}

export function GradingView({ examId, initialAttemptId, onClose, onGraded }: GradingViewProps) {
  // Mode: 'by_student' | 'by_question'
  const [mode, setMode] = useState<'by_student' | 'by_question'>(
    initialAttemptId ? 'by_student' : 'by_question',
  );

  // ── By Student State ───────────────────────────────────────────────────────
  const [currentAttemptId] = useState<string>(initialAttemptId || '');
  const [studentData, setStudentData] = useState<GradingViewData | null>(null);
  const [loadingStudent, setLoadingStudent] = useState<boolean>(false);

  // ── By Question State ──────────────────────────────────────────────────────
  const [selectedQuestionId, setSelectedQuestionId] = useState<string>('');
  const [blindMode, setBlindMode] = useState<boolean>(false);
  const [questionData, setQuestionData] = useState<{
    question: GradingItem;
    answers: Record<string, unknown>[];
  } | null>(null);
  const [loadingQuestion, setLoadingQuestion] = useState<boolean>(false);

  // Local editing states: [questionId or attemptId]: { points, comment, saved, saving, aiLoading, aiSuggestion }
  const [itemForms, setItemForms] = useState<
    Record<
      string,
      {
        points: number;
        comment: string;
        saved: boolean;
        saving: boolean;
        aiLoading: boolean;
        aiSuggestion?: { points: number; rationale: string };
        error?: string;
      }
    >
  >({});

  // ── Load By Student Data ───────────────────────────────────────────────────
  const loadStudentView = useCallback(
    async (attId: string) => {
      if (!attId) return;
      setLoadingStudent(true);
      try {
        const data = await getAttemptGradingView(attId);
        setStudentData(data);

        // Populate form state for each item
        const forms: typeof itemForms = {};
        for (const item of data.grading_items) {
          forms[item.question_id] = {
            points: item.awarded_points !== null ? item.awarded_points : 0,
            comment: item.grader_comment || '',
            saved: item.awarded_points !== null,
            saving: false,
            aiLoading: false,
          };
        }
        setItemForms(forms);
      } catch (e) {
        console.error('Failed to load attempt grading view:', e);
      } finally {
        setLoadingStudent(false);
      }
    },
    [],
  );

  // ── Load By Question Data ──────────────────────────────────────────────────
  const loadQuestionView = useCallback(
    async (qId: string, blind: boolean) => {
      if (!qId) return;
      setLoadingQuestion(true);
      try {
        const data = await getQuestionAnswers(examId, qId, blind);
        setQuestionData(data);

        // Populate forms keyed by attempt_id
        const forms: typeof itemForms = {};
        for (const ans of data.answers) {
          const aId = ans.attempt_id as string;
          forms[aId] = {
            points: ans.awarded_points !== null ? (ans.awarded_points as number) : 0,
            comment: (ans.grader_comment as string) || '',
            saved: ans.awarded_points !== null,
            saving: false,
            aiLoading: false,
          };
        }
        setItemForms(forms);
      } catch (e) {
        console.error('Failed to load question answers:', e);
      } finally {
        setLoadingQuestion(false);
      }
    },
    [examId],
  );

  useEffect(() => {
    if (mode === 'by_student' && currentAttemptId) {
      loadStudentView(currentAttemptId);
    }
  }, [mode, currentAttemptId, loadStudentView]);

  useEffect(() => {
    if (mode === 'by_question' && selectedQuestionId) {
      loadQuestionView(selectedQuestionId, blindMode);
    }
  }, [mode, selectedQuestionId, blindMode, loadQuestionView]);

  // If in by_question mode and no question selected, use first question from studentData if available
  useEffect(() => {
    if (mode === 'by_question' && !selectedQuestionId && studentData?.grading_items[0]) {
      setSelectedQuestionId(studentData.grading_items[0].question_id);
    }
  }, [mode, selectedQuestionId, studentData]);

  // ── Save Grade ─────────────────────────────────────────────────────────────
  const handleSaveGrade = async (attemptId: string, questionId: string) => {
    const key = mode === 'by_student' ? questionId : attemptId;
    const form = itemForms[key];
    if (!form || form.saving) return;

    setItemForms((prev) => ({
      ...prev,
      [key]: { ...prev[key], saving: true, error: undefined },
    }));

    try {
      const res = await gradeAnswer(attemptId, questionId, {
        points: Number(form.points),
        comment: form.comment.trim() || undefined,
      });

      setItemForms((prev) => ({
        ...prev,
        [key]: { ...prev[key], saving: false, saved: true },
      }));

      // Update student data total score if present
      if (studentData && studentData.attempt.id === attemptId) {
        setStudentData((prev) =>
          prev
            ? {
                ...prev,
                attempt: {
                  ...prev.attempt,
                  score: res.new_score,
                  fully_graded: res.fully_graded ? 1 : 0,
                },
              }
            : null,
        );
      }

      onGraded?.();
    } catch (e) {
      setItemForms((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          saving: false,
          error: e instanceof Error ? e.message : 'Save failed',
        },
      }));
    }
  };

  // ── AI Suggestion ──────────────────────────────────────────────────────────
  const handleSuggest = async (attemptId: string, questionId: string) => {
    const key = mode === 'by_student' ? questionId : attemptId;
    setItemForms((prev) => ({
      ...prev,
      [key]: { ...prev[key], aiLoading: true, error: undefined },
    }));

    try {
      const suggestion = await suggestGrade(attemptId, questionId);
      setItemForms((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          aiLoading: false,
          aiSuggestion: {
            points: suggestion.suggestedPoints,
            rationale: suggestion.rationale,
          },
        },
      }));
    } catch (e: unknown) {
      let msg = e instanceof Error ? e.message : 'AI suggestion failed';
      const apiErr = e as { details?: Record<string, unknown> };
      if (apiErr?.details && typeof apiErr.details === 'object') {
        const detailsStr = Object.entries(apiErr.details)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
          .join('; ');
        if (detailsStr) msg += ` (${detailsStr})`;
      }
      setItemForms((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          aiLoading: false,
          error: msg,
        },
      }));
    }
  };

  const applySuggestion = (key: string) => {
    const form = itemForms[key];
    if (!form?.aiSuggestion) return;
    setItemForms((prev) => ({
      ...prev,
      [key]: {
        ...prev[key],
        points: form.aiSuggestion!.points,
        comment: form.comment
          ? `${form.comment}\n[AI Notes: ${form.aiSuggestion!.rationale}]`
          : form.aiSuggestion!.rationale,
        aiSuggestion: undefined,
      },
    }));
  };

  // Keyboard shortcut: Ctrl+Enter saves
  const handleKeyDown = (e: React.KeyboardEvent, attId: string, qId: string) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSaveGrade(attId, qId);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(3, 7, 18, 0.85)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '20px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 1040,
          maxHeight: '92vh',
          background: '#0f172a',
          borderRadius: 16,
          border: '1px solid rgba(255, 255, 255, 0.1)',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)',
          overflow: 'hidden',
        }}
      >
        {/* Top Header */}
        <div
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'rgba(255, 255, 255, 0.02)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#f8fafc' }}>
              Exam Grading Suite
            </h2>
            {/* View Mode Toggle */}
            <div
              style={{
                display: 'inline-flex',
                background: 'rgba(255, 255, 255, 0.05)',
                padding: 3,
                borderRadius: 8,
                border: '1px solid rgba(255, 255, 255, 0.1)',
              }}
            >
              <button
                type="button"
                onClick={() => setMode('by_student')}
                style={{
                  padding: '5px 12px',
                  borderRadius: 6,
                  border: 'none',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: mode === 'by_student' ? '#6366f1' : 'transparent',
                  color: mode === 'by_student' ? '#fff' : '#94a3b8',
                }}
              >
                👤 By Student
              </button>
              <button
                type="button"
                onClick={() => setMode('by_question')}
                style={{
                  padding: '5px 12px',
                  borderRadius: 6,
                  border: 'none',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: mode === 'by_question' ? '#6366f1' : 'transparent',
                  color: mode === 'by_question' ? '#fff' : '#94a3b8',
                }}
              >
                📋 By Question
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              fontSize: 22,
              cursor: 'pointer',
              padding: '4px 8px',
              borderRadius: 6,
            }}
          >
            ✕
          </button>
        </div>

        {/* Content Area */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {/* ────────────────── BY STUDENT MODE ────────────────── */}
          {mode === 'by_student' && (
            <div>
              {loadingStudent ? (
                <div style={{ color: '#94a3b8', textAlign: 'center', padding: '40px 0' }}>
                  Loading submission…
                </div>
              ) : !studentData ? (
                <div style={{ color: '#ef4444', textAlign: 'center', padding: '40px 0' }}>
                  No submission selected or failed to load.
                </div>
              ) : (
                <div>
                  {/* Student Summary Bar */}
                  <div
                    style={{
                      background: 'rgba(255, 255, 255, 0.03)',
                      borderRadius: 12,
                      padding: '16px 20px',
                      border: '1px solid rgba(255, 255, 255, 0.06)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 20,
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc' }}>
                        {studentData.attempt.student_name}
                      </div>
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                        Status: {studentData.attempt.status} • Submitted:{' '}
                        {studentData.attempt.submitted_at
                          ? new Date(studentData.attempt.submitted_at).toLocaleString()
                          : 'In progress'}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#38bdf8' }}>
                        {studentData.attempt.score ?? 0} / {studentData.attempt.max_score} pts
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: studentData.attempt.fully_graded ? '#10b981' : '#f59e0b',
                        }}
                      >
                        {studentData.attempt.fully_graded ? '✓ Fully Graded' : '⏳ Pending Grading'}
                      </div>
                    </div>
                  </div>

                  {/* Question Cards List */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {studentData.grading_items.map((item, idx) => {
                      const form = itemForms[item.question_id] || {
                        points: item.awarded_points ?? 0,
                        comment: item.grader_comment || '',
                        saved: false,
                        saving: false,
                        aiLoading: false,
                      };

                      const isManual = item.grading_mode === 'manual';
                      const isOverridable =
                        item.type === 'short_answer' || item.type === 'fill_in_blank';
                      const canGrade = isManual || isOverridable;

                      return (
                        <div
                          key={item.question_id}
                          style={{
                            background: '#1e293b',
                            borderRadius: 12,
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            padding: '20px',
                          }}
                        >
                          {/* Card Header */}
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'flex-start',
                              marginBottom: 12,
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <span
                                style={{
                                  fontSize: 12,
                                  fontWeight: 700,
                                  background: 'rgba(99, 102, 241, 0.2)',
                                  color: '#818cf8',
                                  padding: '2px 8px',
                                  borderRadius: 6,
                                }}
                              >
                                Q{idx + 1} • {item.type.replace(/_/g, ' ')}
                              </span>
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 600,
                                  padding: '2px 8px',
                                  borderRadius: 6,
                                  background: isManual
                                    ? 'rgba(245, 158, 11, 0.15)'
                                    : 'rgba(16, 185, 129, 0.15)',
                                  color: isManual ? '#fbbf24' : '#34d399',
                                }}
                              >
                                {isManual ? 'Manual' : 'Auto'}
                              </span>
                            </div>
                            <span style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8' }}>
                              Max: {item.points} pts
                            </span>
                          </div>

                          {/* Question Text */}
                          <div
                            style={{
                              fontSize: 14,
                              fontWeight: 600,
                              color: '#f1f5f9',
                              marginBottom: 14,
                            }}
                          >
                            {item.question_text}
                          </div>

                          {/* Rubric (Professor Only) */}
                          {item.rubric && (
                            <div
                              style={{
                                background: 'rgba(59, 130, 246, 0.08)',
                                border: '1px dashed rgba(59, 130, 246, 0.3)',
                                borderRadius: 8,
                                padding: '8px 12px',
                                fontSize: 12,
                                color: '#93c5fd',
                                marginBottom: 14,
                              }}
                            >
                              <strong>Rubric / Grading Notes:</strong> {item.rubric}
                            </div>
                          )}

                          {/* Student Answer */}
                          <div
                            style={{
                              background: 'rgba(0, 0, 0, 0.3)',
                              borderRadius: 8,
                              padding: '12px 14px',
                              marginBottom: 16,
                              border: '1px solid rgba(255, 255, 255, 0.04)',
                            }}
                          >
                            <div
                              style={{
                                fontSize: 11,
                                textTransform: 'uppercase',
                                color: '#64748b',
                                fontWeight: 700,
                                marginBottom: 4,
                              }}
                            >
                              Student Answer:
                            </div>
                            <div
                              style={{
                                fontSize: 13,
                                color: '#e2e8f0',
                                whiteSpace: 'pre-wrap',
                                fontFamily: item.type === 'long_answer' ? 'monospace' : 'inherit',
                              }}
                            >
                              {item.answer_json ? (
                                (() => {
                                  try {
                                    const p = JSON.parse(item.answer_json);
                                    if (Array.isArray(p)) return p.join(', ');
                                    return String(p);
                                  } catch {
                                    return item.answer_json;
                                  }
                                })()
                              ) : (
                                <em style={{ color: '#64748b' }}>No answer provided</em>
                              )}
                            </div>
                          </div>

                          {/* Correct Answer for Reference */}
                          {item.correct_answer && (
                            <div
                              style={{
                                fontSize: 12,
                                color: '#94a3b8',
                                marginBottom: 14,
                                padding: '6px 10px',
                                background: 'rgba(255, 255, 255, 0.02)',
                                borderRadius: 6,
                              }}
                            >
                              <strong style={{ color: '#10b981' }}>Model / Correct Answer:</strong>{' '}
                              {item.correct_answer}
                            </div>
                          )}

                          {/* Grading Controls */}
                          {canGrade ? (
                            <div
                              style={{
                                background: 'rgba(255, 255, 255, 0.02)',
                                borderRadius: 8,
                                padding: '12px',
                                border: '1px solid rgba(255, 255, 255, 0.06)',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'space-between',
                                  marginBottom: 8,
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <label
                                    style={{
                                      fontSize: 12,
                                      fontWeight: 600,
                                      color: '#94a3b8',
                                    }}
                                  >
                                    Awarded Points (0 – {item.points}):
                                  </label>
                                  <input
                                    type="number"
                                    step="0.25"
                                    min="0"
                                    max={item.points}
                                    value={form.points}
                                    onChange={(e) =>
                                      setItemForms((prev) => ({
                                        ...prev,
                                        [item.question_id]: {
                                          ...prev[item.question_id],
                                          points: Number(e.target.value),
                                          saved: false,
                                        },
                                      }))
                                    }
                                    onKeyDown={(e) =>
                                      handleKeyDown(
                                        e,
                                        studentData.attempt.id,
                                        item.question_id,
                                      )
                                    }
                                    style={{
                                      width: 80,
                                      background: '#0f172a',
                                      border: '1px solid rgba(255, 255, 255, 0.15)',
                                      borderRadius: 6,
                                      padding: '6px 10px',
                                      color: '#f8fafc',
                                      fontWeight: 700,
                                      fontSize: 13,
                                    }}
                                  />
                                  <span style={{ fontSize: 11, color: '#64748b' }}>
                                    (Step 0.25)
                                  </span>
                                </div>

                                {/* AI Suggest Button */}
                                {(item.type === 'short_answer' || item.type === 'long_answer') && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleSuggest(studentData.attempt.id, item.question_id)
                                    }
                                    disabled={form.aiLoading}
                                    style={{
                                      background: 'rgba(99, 102, 241, 0.15)',
                                      border: '1px solid rgba(99, 102, 241, 0.3)',
                                      borderRadius: 6,
                                      padding: '5px 12px',
                                      fontSize: 12,
                                      color: '#a5b4fc',
                                      fontWeight: 600,
                                      cursor: form.aiLoading ? 'not-allowed' : 'pointer',
                                    }}
                                  >
                                    {form.aiLoading ? '✨ Thinking…' : '✨ Suggest Grade (AI)'}
                                  </button>
                                )}
                              </div>

                              {/* AI Suggestion Box */}
                              {form.aiSuggestion && (
                                <div
                                  style={{
                                    background: 'rgba(99, 102, 241, 0.08)',
                                    border: '1px solid rgba(99, 102, 241, 0.25)',
                                    borderRadius: 8,
                                    padding: '10px 14px',
                                    marginBottom: 10,
                                    fontSize: 12,
                                  }}
                                >
                                  <div
                                    style={{
                                      display: 'flex',
                                      justifyContent: 'space-between',
                                      alignItems: 'center',
                                      marginBottom: 4,
                                    }}
                                  >
                                    <span style={{ color: '#a5b4fc', fontWeight: 700 }}>
                                      AI Suggestion: {form.aiSuggestion.points} / {item.points} pts
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => applySuggestion(item.question_id)}
                                      style={{
                                        background: '#6366f1',
                                        color: '#fff',
                                        border: 'none',
                                        borderRadius: 4,
                                        padding: '3px 8px',
                                        fontSize: 11,
                                        fontWeight: 600,
                                        cursor: 'pointer',
                                      }}
                                    >
                                      Apply
                                    </button>
                                  </div>
                                  <div style={{ color: '#94a3b8', fontStyle: 'italic' }}>
                                    {form.aiSuggestion.rationale}
                                  </div>
                                  <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>
                                    ⚠️ AI suggestion, review before saving
                                  </div>
                                </div>
                              )}

                              {/* Grader Comment */}
                              <textarea
                                value={form.comment}
                                onChange={(e) =>
                                  setItemForms((prev) => ({
                                    ...prev,
                                    [item.question_id]: {
                                      ...prev[item.question_id],
                                      comment: e.target.value,
                                      saved: false,
                                    },
                                  }))
                                }
                                onKeyDown={(e) =>
                                  handleKeyDown(e, studentData.attempt.id, item.question_id)
                                }
                                placeholder="Feedback for student (optional)…"
                                rows={2}
                                style={{
                                  width: '100%',
                                  boxSizing: 'border-box',
                                  background: '#0f172a',
                                  border: '1px solid rgba(255, 255, 255, 0.1)',
                                  borderRadius: 6,
                                  padding: '8px 10px',
                                  color: '#e2e8f0',
                                  fontSize: 12,
                                  resize: 'vertical',
                                  marginBottom: 8,
                                }}
                              />

                              {/* Save Action */}
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                }}
                              >
                                <span style={{ fontSize: 11, color: '#64748b' }}>
                                  Tip: Press <kbd style={{ color: '#cbd5e1' }}>Ctrl+Enter</kbd> to
                                  save
                                </span>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  {form.saved && (
                                    <span
                                      style={{
                                        fontSize: 12,
                                        color: '#10b981',
                                        fontWeight: 600,
                                      }}
                                    >
                                      ✓ Saved
                                    </span>
                                  )}
                                  {form.error && (
                                    <span style={{ fontSize: 12, color: '#ef4444' }}>
                                      {form.error}
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleSaveGrade(studentData.attempt.id, item.question_id)
                                    }
                                    disabled={form.saving}
                                    style={{
                                      background: form.saved ? '#334155' : '#10b981',
                                      color: '#fff',
                                      border: 'none',
                                      borderRadius: 6,
                                      padding: '6px 14px',
                                      fontSize: 12,
                                      fontWeight: 600,
                                      cursor: form.saving ? 'not-allowed' : 'pointer',
                                    }}
                                  >
                                    {form.saving ? 'Saving…' : form.saved ? 'Update' : 'Save Grade'}
                                  </button>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div
                              style={{
                                fontSize: 12,
                                color: '#10b981',
                                fontWeight: 600,
                                padding: '8px 12px',
                                background: 'rgba(16, 185, 129, 0.08)',
                                borderRadius: 6,
                              }}
                            >
                              ✓ Auto-graded: {item.awarded_points ?? item.auto_points ?? 0} /{' '}
                              {item.points} pts
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ────────────────── BY QUESTION MODE ────────────────── */}
          {mode === 'by_question' && (
            <div>
              {/* Question Picker & Blind Toggle Bar */}
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  borderRadius: 12,
                  padding: '16px 20px',
                  border: '1px solid rgba(255, 255, 255, 0.06)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 20,
                  gap: 16,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flex: 1,
                  }}
                >
                  <label
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: '#94a3b8',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    Select Question:
                  </label>
                  <input
                    type="text"
                    placeholder="Enter question ID (e.g. q-001)"
                    value={selectedQuestionId}
                    onChange={(e) => setSelectedQuestionId(e.target.value.trim())}
                    style={{
                      background: '#0f172a',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                      borderRadius: 6,
                      padding: '6px 12px',
                      color: '#f8fafc',
                      fontSize: 13,
                      width: 200,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => loadQuestionView(selectedQuestionId, blindMode)}
                    style={{
                      background: '#6366f1',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 6,
                      padding: '6px 14px',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Load
                  </button>
                </div>

                {/* Blind Mode Toggle */}
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    cursor: 'pointer',
                    fontSize: 13,
                    color: '#e2e8f0',
                    fontWeight: 600,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={blindMode}
                    onChange={(e) => setBlindMode(e.target.checked)}
                    style={{ cursor: 'pointer', width: 16, height: 16 }}
                  />
                  🕶️ Blind Grading Mode
                </label>
              </div>

              {loadingQuestion ? (
                <div style={{ color: '#94a3b8', textAlign: 'center', padding: '40px 0' }}>
                  Loading question answers…
                </div>
              ) : !questionData ? (
                <div style={{ color: '#64748b', textAlign: 'center', padding: '40px 0' }}>
                  Please enter or select a question ID to view all student answers.
                </div>
              ) : (
                <div>
                  {/* Question Details Card */}
                  <div
                    style={{
                      background: '#1e293b',
                      borderRadius: 12,
                      padding: '18px 20px',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      marginBottom: 20,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 8,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: '#818cf8',
                          background: 'rgba(99, 102, 241, 0.15)',
                          padding: '2px 8px',
                          borderRadius: 6,
                        }}
                      >
                        {questionData.question.type.replace(/_/g, ' ')} • Max:{' '}
                        {questionData.question.points} pts
                      </span>
                      <span style={{ fontSize: 12, color: '#64748b' }}>
                        {questionData.answers.length} submission(s)
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 600,
                        color: '#f8fafc',
                        marginBottom: 10,
                      }}
                    >
                      {questionData.question.question_text}
                    </div>
                    {questionData.question.rubric && (
                      <div
                        style={{
                          background: 'rgba(59, 130, 246, 0.08)',
                          border: '1px dashed rgba(59, 130, 246, 0.3)',
                          borderRadius: 8,
                          padding: '8px 12px',
                          fontSize: 12,
                          color: '#93c5fd',
                        }}
                      >
                        <strong>Rubric:</strong> {questionData.question.rubric}
                      </div>
                    )}
                  </div>

                  {/* Answers by Student List */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {questionData.answers.map((ans) => {
                      const attId = ans.attempt_id as string;
                      const form = itemForms[attId] || {
                        points: (ans.awarded_points as number) ?? 0,
                        comment: (ans.grader_comment as string) || '',
                        saved: false,
                        saving: false,
                        aiLoading: false,
                      };

                      return (
                        <div
                          key={attId}
                          style={{
                            background: '#1e293b',
                            borderRadius: 12,
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                            padding: '16px 20px',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              marginBottom: 10,
                            }}
                          >
                            <span style={{ fontSize: 13, fontWeight: 700, color: '#38bdf8' }}>
                              {ans.student_name as string}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 600,
                                color: ans.awarded_points !== null ? '#10b981' : '#f59e0b',
                              }}
                            >
                              {ans.awarded_points !== null
                                ? `Graded: ${ans.awarded_points} pts`
                                : '⏳ Pending'}
                            </span>
                          </div>

                          {/* Student Answer */}
                          <div
                            style={{
                              background: 'rgba(0, 0, 0, 0.3)',
                              borderRadius: 8,
                              padding: '10px 14px',
                              marginBottom: 12,
                              fontSize: 13,
                              color: '#e2e8f0',
                            }}
                          >
                            {ans.answer_json ? (
                              (() => {
                                try {
                                  const p = JSON.parse(ans.answer_json as string);
                                  if (Array.isArray(p)) return p.join(', ');
                                  return String(p);
                                } catch {
                                  return String(ans.answer_json);
                                }
                              })()
                            ) : (
                              <em style={{ color: '#64748b' }}>No answer provided</em>
                            )}
                          </div>

                          {/* Grade Controls */}
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 12,
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <label
                                style={{
                                  fontSize: 12,
                                  color: '#94a3b8',
                                  fontWeight: 600,
                                }}
                              >
                                Points:
                              </label>
                              <input
                                type="number"
                                step="0.25"
                                min="0"
                                max={questionData.question.points}
                                value={form.points}
                                onChange={(e) =>
                                  setItemForms((prev) => ({
                                    ...prev,
                                    [attId]: {
                                      ...prev[attId],
                                      points: Number(e.target.value),
                                      saved: false,
                                    },
                                  }))
                                }
                                onKeyDown={(e) =>
                                  handleKeyDown(e, attId, questionData.question.question_id)
                                }
                                style={{
                                  width: 70,
                                  background: '#0f172a',
                                  border: '1px solid rgba(255, 255, 255, 0.15)',
                                  borderRadius: 6,
                                  padding: '5px 8px',
                                  color: '#f8fafc',
                                  fontWeight: 700,
                                  fontSize: 12,
                                }}
                              />
                              <input
                                type="text"
                                placeholder="Feedback comment…"
                                value={form.comment}
                                onChange={(e) =>
                                  setItemForms((prev) => ({
                                    ...prev,
                                    [attId]: {
                                      ...prev[attId],
                                      comment: e.target.value,
                                      saved: false,
                                    },
                                  }))
                                }
                                onKeyDown={(e) =>
                                  handleKeyDown(e, attId, questionData.question.question_id)
                                }
                                style={{
                                  flex: 1,
                                  background: '#0f172a',
                                  border: '1px solid rgba(255, 255, 255, 0.1)',
                                  borderRadius: 6,
                                  padding: '5px 10px',
                                  color: '#e2e8f0',
                                  fontSize: 12,
                                }}
                              />
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              {form.saved && (
                                <span
                                  style={{
                                    fontSize: 11,
                                    color: '#10b981',
                                    fontWeight: 600,
                                  }}
                                >
                                  ✓
                                </span>
                              )}
                              <button
                                type="button"
                                onClick={() =>
                                  handleSaveGrade(attId, questionData.question.question_id)
                                }
                                disabled={form.saving}
                                style={{
                                  background: form.saved ? '#334155' : '#10b981',
                                  color: '#fff',
                                  border: 'none',
                                  borderRadius: 6,
                                  padding: '5px 12px',
                                  fontSize: 12,
                                  fontWeight: 600,
                                  cursor: form.saving ? 'not-allowed' : 'pointer',
                                }}
                              >
                                {form.saving ? '…' : form.saved ? 'Update' : 'Save'}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
