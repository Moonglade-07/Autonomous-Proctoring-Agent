/**
 * src/components/QuestionDrawer.tsx — Slide-over drawer for creating/editing questions (Phase 4c-1)
 *
 * Supports the Phase 4c-1 types:
 *   • mcq (2-6 options, 1 correct, auto)
 *   • multi_select (2-6 options, >=1 correct, auto)
 *   • fill_in_blank (text with '___', accepted answers per blank, case-insensitive flag, auto)
 *   • short_answer (auto with accepted answers list or manual)
 *   • long_answer (optional word limit hint, manual)
 */

import { useState, useEffect, useMemo } from 'react';
import type { Question, QuestionType, GradingMode } from '../types';

export interface QuestionDrawerSaveData {
  question_text: string;
  type: QuestionType;
  options: string[] | null;
  correct_answer: string | null;
  points: number;
  topic?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  grading_mode: GradingMode;
  rubric?: string | null;
}

interface QuestionDrawerProps {
  initial?: Question | null;
  onSave: (data: QuestionDrawerSaveData) => Promise<void>;
  onClose: () => void;
}

function countBlanks(text: string): number {
  return (text.match(/___/g) || []).length;
}

function parseInitialOptions(raw: unknown): string[] {
  if (!raw) return ['Option 1', 'Option 2', 'Option 3', 'Option 4'];
  if (Array.isArray(raw)) {
    return raw.length > 0 ? raw.map(String) : ['Option 1', 'Option 2', 'Option 3', 'Option 4'];
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(String);
      }
    } catch {}
  }
  return ['Option 1', 'Option 2', 'Option 3', 'Option 4'];
}

export function QuestionDrawer({ initial, onSave, onClose }: QuestionDrawerProps) {
  const [questionText, setQuestionText] = useState(initial?.question_text || '');
  const [type, setType] = useState<QuestionType>(initial?.type || 'mcq');
  const [points, setPoints] = useState(initial?.points ?? 1);
  const [topic, setTopic] = useState(initial?.topic || '');
  const [difficulty, setDifficulty] = useState<'easy' | 'medium' | 'hard'>(
    initial?.difficulty || 'medium',
  );
  const [gradingMode, setGradingMode] = useState<GradingMode>(() => {
    if (initial?.grading_mode) return initial.grading_mode;
    if (initial?.type === 'long_answer') return 'manual';
    return 'auto';
  });
  const [rubric, setRubric] = useState<string>(initial?.rubric || '');

  // MCQ / Multi-select state (2-6 options)
  const [options, setOptions] = useState<string[]>(() => {
    return parseInitialOptions(initial?.options);
  });

  // Correct answer for MCQ: index as string '0', '1', etc.
  const [mcqCorrect, setMcqCorrect] = useState<string>(() => {
    if (initial?.type === 'mcq' && initial.correct_answer !== null) {
      const opts = parseInitialOptions(initial.options);
      if (opts.includes(initial.correct_answer)) {
        return String(opts.indexOf(initial.correct_answer));
      }
      return String(initial.correct_answer);
    }
    return '0';
  });

  // Correct answers for Multi-select: array of indices [0, 2]
  const [multiCorrect, setMultiCorrect] = useState<number[]>(() => {
    if (initial?.type === 'multi_select' && initial.correct_answer) {
      try {
        const parsed = JSON.parse(initial.correct_answer);
        if (Array.isArray(parsed)) {
          const opts = parseInitialOptions(initial.options);
          if (parsed.some((item) => opts.includes(String(item)))) {
            return parsed
              .map((item) => opts.indexOf(String(item)))
              .filter((idx) => idx !== -1);
          }
          return parsed.map(Number).filter((n) => !isNaN(n));
        }
      } catch {}
    }
    return [0];
  });

  // Fill in blank state: per blank accepted answers
  const detectedBlanks = useMemo(() => countBlanks(questionText), [questionText]);
  const [blankAnswers, setBlankAnswers] = useState<string[]>(() => {
    if (initial?.type === 'fill_in_blank' && initial.correct_answer) {
      try {
        const parsed = JSON.parse(initial.correct_answer) as { blanks?: string[][] };
        if (Array.isArray(parsed.blanks)) {
          return parsed.blanks.map((b) => b.join(', '));
        }
      } catch {}
    }
    return [];
  });
  const [caseInsensitive, setCaseInsensitive] = useState<boolean>(() => {
    if (initial?.type === 'fill_in_blank' && initial.correct_answer) {
      try {
        const parsed = JSON.parse(initial.correct_answer) as { case_insensitive?: boolean };
        if (typeof parsed.case_insensitive === 'boolean') return parsed.case_insensitive;
      } catch {}
    }
    return true;
  });

  // Short answer state: comma-separated accepted answers
  const [shortAnswersStr, setShortAnswersStr] = useState<string>(() => {
    if (initial?.type === 'short_answer' && initial.correct_answer) {
      try {
        const parsed = JSON.parse(initial.correct_answer);
        if (Array.isArray(parsed)) return parsed.join(', ');
      } catch {}
      return initial.correct_answer;
    }
    return '';
  });

  // Long answer word limit hint
  const [wordLimit, setWordLimit] = useState<string>(() => {
    if (initial?.type === 'long_answer' && initial.options) {
      const opts = parseInitialOptions(initial.options);
      if (opts[0] && opts[0] !== 'Option 1') return String(opts[0]);
    }
    return '';
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Keep blank answers array synced with blank count
  useEffect(() => {
    if (type === 'fill_in_blank') {
      setBlankAnswers((prev) => {
        const next = [...prev];
        while (next.length < detectedBlanks) next.push('');
        return next.slice(0, detectedBlanks);
      });
    }
  }, [type, detectedBlanks]);

  // Adjust grading mode automatically based on type
  useEffect(() => {
    if (type === 'long_answer') {
      setGradingMode('manual');
    } else if (type === 'mcq' || type === 'multi_select' || type === 'fill_in_blank') {
      setGradingMode('auto');
    }
  }, [type]);

  // Handle Escape key to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!questionText.trim()) {
      setError('Question text is required');
      return;
    }
    if (points <= 0) {
      setError('Points must be greater than 0');
      return;
    }

    let finalOptions: string[] | null = null;
    let finalCorrectAnswer: string | null = null;

    if (type === 'mcq') {
      const cleanOpts = options.map((o) => o.trim()).filter(Boolean);
      if (cleanOpts.length < 2 || cleanOpts.length > 6) {
        setError('MCQ must have between 2 and 6 options');
        return;
      }
      finalOptions = cleanOpts;
      const cIdx = parseInt(mcqCorrect, 10);
      if (isNaN(cIdx) || cIdx < 0 || cIdx >= cleanOpts.length) {
        setError('Please select a valid correct option for MCQ');
        return;
      }
      finalCorrectAnswer = cleanOpts[cIdx];
    } else if (type === 'multi_select') {
      const cleanOpts = options.map((o) => o.trim()).filter(Boolean);
      if (cleanOpts.length < 2 || cleanOpts.length > 6) {
        setError('Multi-select must have between 2 and 6 options');
        return;
      }
      finalOptions = cleanOpts;
      const validIndices = multiCorrect.filter((i) => i >= 0 && i < cleanOpts.length);
      if (validIndices.length === 0) {
        setError('Multi-select must have at least one correct option selected');
        return;
      }
      finalCorrectAnswer = JSON.stringify(validIndices.map((i) => cleanOpts[i]));
    } else if (type === 'fill_in_blank') {
      if (detectedBlanks === 0) {
        setError("Question text must contain at least one '___' (3 underscores) blank marker");
        return;
      }
      const blanksConfig: string[][] = [];
      for (let i = 0; i < detectedBlanks; i++) {
        const raw = blankAnswers[i] || '';
        const accepted = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (accepted.length === 0) {
          setError(`Blank #${i + 1} must have at least one accepted answer`);
          return;
        }
        blanksConfig.push(accepted);
      }
      finalCorrectAnswer = JSON.stringify({
        blanks: blanksConfig,
        case_insensitive: caseInsensitive,
      });
    } else if (type === 'short_answer') {
      if (gradingMode === 'auto') {
        const accepted = shortAnswersStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (accepted.length === 0) {
          setError('Auto-graded short answer must have at least one accepted answer (comma-separated)');
          return;
        }
        finalCorrectAnswer = JSON.stringify(accepted);
      } else {
        finalCorrectAnswer = null;
      }
    } else if (type === 'long_answer') {
      finalCorrectAnswer = null;
      if (wordLimit && parseInt(wordLimit, 10) > 0) {
        finalOptions = [wordLimit.trim()];
      }
    }

    setSaving(true);
    try {
      await onSave({
        question_text: questionText.trim(),
        type,
        options: finalOptions,
        correct_answer: finalCorrectAnswer,
        points: Number(points),
        topic: topic.trim() || undefined,
        difficulty,
        grading_mode: gradingMode,
        rubric: rubric.trim() || null,
      });
      onClose();
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : 'Failed to save question';
      const apiErr = err as { details?: Record<string, unknown> };
      if (apiErr?.details && typeof apiErr.details === 'object') {
        const detailsStr = Object.entries(apiErr.details)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
          .join('; ');
        if (detailsStr) msg += ` — ${detailsStr}`;
      }
      setError(msg);
      setSaving(false);
    }
  }

  return (
    <div style={overlay}>
      <div style={drawer}>
        {/* Header */}
        <div style={drawerHeader}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#f1f5f9' }}>
              {initial ? '✏️ Edit Question' : '➕ Add Question'}
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: '#64748b' }}>
              Configure question details, accepted answers, and grading mode
            </p>
          </div>
          <button style={closeBtn} onClick={onClose} disabled={saving}>
            ✕
          </button>
        </div>

        {error && <div style={errorBox}>⚠️ {error}</div>}

        {/* Form Body */}
        <form onSubmit={handleSubmit} style={drawerBody}>
          {/* Question Type */}
          <div>
            <label style={labelStyle}>Question Type *</label>
            <select
              style={inputStyle}
              value={type}
              onChange={(e) => setType(e.target.value as QuestionType)}
              disabled={Boolean(initial)}
            >
              <option value="mcq">Multiple Choice (Single Answer · Auto-Graded)</option>
              <option value="multi_select">Multi-Select (Multiple Answers · Auto-Graded)</option>
              <option value="fill_in_blank">Fill in the Blanks (Partial Credit · Auto-Graded)</option>
              <option value="short_answer">Short Answer (Auto or Manual)</option>
              <option value="long_answer">Long Answer / Essay (Manual Only)</option>
            </select>
          </div>

          {/* Question Text */}
          <div>
            <label style={labelStyle}>Question Prompt *</label>
            <textarea
              style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }}
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              placeholder={
                type === 'fill_in_blank'
                  ? 'e.g. The capital of France is ___ and the capital of Spain is ___.'
                  : 'Enter the question text…'
              }
              required
            />
            {type === 'fill_in_blank' && (
              <p style={{ margin: '4px 0 0', fontSize: 11, color: detectedBlanks > 0 ? '#34d399' : '#fbbf24' }}>
                {detectedBlanks > 0
                  ? `✓ Detected ${detectedBlanks} blank${detectedBlanks !== 1 ? 's' : ''} (___ marker)`
                  : "ℹ Insert '___' (3 underscores) to create a blank marker in the prompt."}
              </p>
            )}
          </div>

          {/* Type-Specific Answer Config */}

          {/* MCQ */}
          {type === 'mcq' && (
            <div style={sectionBox}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={sectionTitle}>MCQ Options (Select the correct answer)</span>
                {options.length < 6 && (
                  <button
                    type="button"
                    style={btnLink}
                    onClick={() => setOptions((o) => [...o, `Option ${o.length + 1}`])}
                  >
                    + Add Option
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {options.map((opt, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="radio"
                      name="mcq-correct"
                      checked={mcqCorrect === String(i)}
                      onChange={() => setMcqCorrect(String(i))}
                      style={{ accentColor: '#6366f1', width: 16, height: 16, cursor: 'pointer' }}
                      title="Mark as correct answer"
                    />
                    <input
                      style={{ ...inputStyle, flex: 1 }}
                      value={opt}
                      onChange={(e) => {
                        const next = [...options];
                        next[i] = e.target.value;
                        setOptions(next);
                      }}
                      placeholder={`Option ${i + 1}`}
                      required
                    />
                    {options.length > 2 && (
                      <button
                        type="button"
                        style={{ ...btnIcon, color: '#f87171' }}
                        onClick={() => {
                          const next = options.filter((_, idx) => idx !== i);
                          setOptions(next);
                          if (mcqCorrect === String(i)) setMcqCorrect('0');
                          else if (parseInt(mcqCorrect, 10) > i) {
                            setMcqCorrect(String(parseInt(mcqCorrect, 10) - 1));
                          }
                        }}
                        title="Remove option"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Multi-Select */}
          {type === 'multi_select' && (
            <div style={sectionBox}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={sectionTitle}>Multi-Select Options (Check all correct)</span>
                {options.length < 6 && (
                  <button
                    type="button"
                    style={btnLink}
                    onClick={() => setOptions((o) => [...o, `Option ${o.length + 1}`])}
                  >
                    + Add Option
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {options.map((opt, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={multiCorrect.includes(i)}
                      onChange={(e) => {
                        if (e.target.checked) setMultiCorrect((prev) => [...prev, i]);
                        else setMultiCorrect((prev) => prev.filter((idx) => idx !== i));
                      }}
                      style={{ accentColor: '#6366f1', width: 16, height: 16, cursor: 'pointer' }}
                      title="Check if correct"
                    />
                    <input
                      style={{ ...inputStyle, flex: 1 }}
                      value={opt}
                      onChange={(e) => {
                        const next = [...options];
                        next[i] = e.target.value;
                        setOptions(next);
                      }}
                      placeholder={`Option ${i + 1}`}
                      required
                    />
                    {options.length > 2 && (
                      <button
                        type="button"
                        style={{ ...btnIcon, color: '#f87171' }}
                        onClick={() => {
                          setOptions((prev) => prev.filter((_, idx) => idx !== i));
                          setMultiCorrect((prev) =>
                            prev
                              .filter((idx) => idx !== i)
                              .map((idx) => (idx > i ? idx - 1 : idx)),
                          );
                        }}
                        title="Remove option"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Fill in the Blanks */}
          {type === 'fill_in_blank' && (
            <div style={sectionBox}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={sectionTitle}>Accepted Answers per Blank</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#94a3b8', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={caseInsensitive}
                    onChange={(e) => setCaseInsensitive(e.target.checked)}
                    style={{ accentColor: '#6366f1' }}
                  />
                  Case-insensitive match
                </label>
              </div>

              {detectedBlanks === 0 ? (
                <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
                  Type '___' in the prompt above to create blanks.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {Array.from({ length: detectedBlanks }).map((_, i) => (
                    <div key={i}>
                      <label style={{ ...labelStyle, fontSize: 10, color: '#cbd5e1' }}>
                        Blank #{i + 1} Accepted Answers (comma-separated)
                      </label>
                      <input
                        style={inputStyle}
                        value={blankAnswers[i] || ''}
                        onChange={(e) => {
                          const next = [...blankAnswers];
                          next[i] = e.target.value;
                          setBlankAnswers(next);
                        }}
                        placeholder="e.g. Paris, City of Light"
                        required
                      />
                    </div>
                  ))}
                  <p style={{ margin: '4px 0 0', fontSize: 11, color: '#64748b' }}>
                    Points ({points} pt{points !== 1 ? 's' : ''}) are split equally across all {detectedBlanks} blanks.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Short Answer */}
          {type === 'short_answer' && (
            <div style={sectionBox}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={sectionTitle}>Grading Mode</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    style={{
                      ...btnToggle,
                      background: gradingMode === 'auto' ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.05)',
                      color: gradingMode === 'auto' ? '#a5b4fc' : '#64748b',
                      border: gradingMode === 'auto' ? '1px solid #6366f1' : '1px solid rgba(255,255,255,0.1)',
                    }}
                    onClick={() => setGradingMode('auto')}
                  >
                    ✓ Auto-graded
                  </button>
                  <button
                    type="button"
                    style={{
                      ...btnToggle,
                      background: gradingMode === 'manual' ? 'rgba(245,158,11,0.25)' : 'rgba(255,255,255,0.05)',
                      color: gradingMode === 'manual' ? '#fbbf24' : '#64748b',
                      border: gradingMode === 'manual' ? '1px solid #f59e0b' : '1px solid rgba(255,255,255,0.1)',
                    }}
                    onClick={() => setGradingMode('manual')}
                  >
                    📝 Manual grading
                  </button>
                </div>
              </div>

              {gradingMode === 'auto' ? (
                <div>
                  <label style={labelStyle}>Accepted Answers (comma-separated)</label>
                  <input
                    style={inputStyle}
                    value={shortAnswersStr}
                    onChange={(e) => setShortAnswersStr(e.target.value)}
                    placeholder="e.g. O(n log n), nlogn, O(N log N)"
                    required
                  />
                  <p style={{ margin: '4px 0 0', fontSize: 11, color: '#64748b' }}>
                    Evaluation is trimmed and case-insensitive against any of these accepted variations.
                  </p>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <p style={{ margin: 0, fontSize: 12, color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(245,158,11,0.2)' }}>
                    ⏳ This question will leave the attempt as "pending_manual" until graded. Auto-score contributes 0.
                  </p>
                  <div>
                    <label style={labelStyle}>Rubric / Grading Notes (professor-only, optional)</label>
                    <textarea
                      style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }}
                      value={rubric}
                      onChange={(e) => setRubric(e.target.value)}
                      placeholder="Describe what a full-credit answer should cover..."
                      maxLength={2000}
                    />
                    <p style={{ margin: '4px 0 0', fontSize: 11, color: '#64748b' }}>
                      Never visible to students. Used when manual grading and by AI suggestions.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Long Answer */}
          {type === 'long_answer' && (
            <div style={sectionBox}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={sectionTitle}>Long Answer Settings</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#f59e0b', background: 'rgba(245,158,11,0.15)', padding: '2px 8px', borderRadius: 6, border: '1px solid rgba(245,158,11,0.3)' }}>
                  MANUAL GRADING ONLY
                </span>
              </div>
              <div>
                <label style={labelStyle}>Word Limit Hint (optional)</label>
                <input
                  style={inputStyle}
                  type="number"
                  min={10}
                  max={5000}
                  value={wordLimit}
                  onChange={(e) => setWordLimit(e.target.value)}
                  placeholder="e.g. 250 (words)"
                />
                <p style={{ margin: '4px 0 0', fontSize: 11, color: '#64748b' }}>
                  Displays an advisory target counter to the student during exam.
                </p>
              </div>
              <div style={{ marginTop: 10 }}>
                <label style={labelStyle}>Rubric / Model Answer (professor-only, optional)</label>
                <textarea
                  style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
                  value={rubric}
                  onChange={(e) => setRubric(e.target.value)}
                  placeholder="Outline key criteria or model answer for this essay/code question..."
                  maxLength={2000}
                />
                <p style={{ margin: '4px 0 0', fontSize: 11, color: '#64748b' }}>
                  Used when grading and by AI suggestions. Never sent to students.
                </p>
              </div>
            </div>
          )}

          {/* Meta Fields: Points, Topic, Difficulty */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Points *</label>
              <input
                style={inputStyle}
                type="number"
                step="0.5"
                min="0.5"
                max="100"
                value={points}
                onChange={(e) => setPoints(Number(e.target.value))}
                required
              />
            </div>
            <div>
              <label style={labelStyle}>Topic (optional)</label>
              <input
                style={inputStyle}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="e.g. Algorithms"
              />
            </div>
            <div>
              <label style={labelStyle}>Difficulty</label>
              <select
                style={inputStyle}
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value as 'easy' | 'medium' | 'hard')}
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" style={btnSecondary} onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" style={btnPrimary} disabled={saving}>
              {saving ? 'Saving…' : initial ? 'Save Changes' : 'Create Question'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.7)',
  backdropFilter: 'blur(4px)',
  display: 'flex',
  justifyContent: 'flex-end',
  zIndex: 1000,
};

const drawer: React.CSSProperties = {
  background: '#0f172a',
  width: '100%',
  maxWidth: 560,
  height: '100%',
  boxShadow: '-10px 0 30px rgba(0,0,0,0.6)',
  borderLeft: '1px solid rgba(255,255,255,0.1)',
  display: 'flex',
  flexDirection: 'column',
};

const drawerHeader: React.CSSProperties = {
  padding: '18px 24px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  background: '#131d35',
};

const drawerBody: React.CSSProperties = {
  padding: 24,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  flex: 1,
};

const sectionBox: React.CSSProperties = {
  background: '#162038',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 10,
  padding: 16,
};

const sectionTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  color: '#cbd5e1',
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

const btnLink: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#818cf8',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  padding: 0,
};

const btnIcon: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  fontSize: 14,
  cursor: 'pointer',
  padding: '4px 8px',
};

const btnToggle: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer',
};

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#64748b',
  fontSize: 18,
  cursor: 'pointer',
  padding: '4px 8px',
};

const errorBox: React.CSSProperties = {
  margin: '12px 24px 0',
  background: 'rgba(239,68,68,0.15)',
  border: '1px solid rgba(239,68,68,0.3)',
  borderRadius: 8,
  padding: '10px 14px',
  color: '#f87171',
  fontSize: 13,
};

