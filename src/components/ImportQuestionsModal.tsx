/**
 * src/components/ImportQuestionsModal.tsx — Import questions from other exams (Phase 4c-1)
 *
 * Exam-centric copy: Questions are duplicated into this exam, with fresh IDs.
 */

import { useState, useEffect } from 'react';
import type { Exam, Question } from '../types';
import { listExams, listExamQuestions, importExamQuestions, ApiError } from '../hooks/useProfessorApi';

interface ImportQuestionsModalProps {
  currentExamId: string;
  onClose: () => void;
  onImported: () => void;
}

export function ImportQuestionsModal({
  currentExamId,
  onClose,
  onImported,
}: ImportQuestionsModalProps) {
  const [exams, setExams] = useState<Exam[]>([]);
  const [selectedExamId, setSelectedExamId] = useState<string>('');
  const [questions, setQuestions] = useState<Question[]>([]);
  const [selectedQIds, setSelectedQIds] = useState<Set<string>>(new Set());
  const [loadingExams, setLoadingExams] = useState(true);
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  // Load other exams on mount
  useEffect(() => {
    listExams()
      .then((all) => {
        const others = all.filter((e) => e.id !== currentExamId);
        setExams(others);
        if (others.length > 0) {
          setSelectedExamId(others[0].id);
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoadingExams(false));
  }, [currentExamId]);

  // Load questions for selected source exam
  useEffect(() => {
    if (!selectedExamId) return;
    setLoadingQuestions(true);
    setSelectedQIds(new Set());
    listExamQuestions(selectedExamId)
      .then((qs) => {
        setQuestions(qs);
        // Default select all
        setSelectedQIds(new Set(qs.map((q) => q.id)));
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoadingQuestions(false));
  }, [selectedExamId]);

  function toggleAll() {
    if (selectedQIds.size === questions.length) {
      setSelectedQIds(new Set());
    } else {
      setSelectedQIds(new Set(questions.map((q) => q.id)));
    }
  }

  function toggleOne(id: string) {
    setSelectedQIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleImport() {
    if (selectedQIds.size === 0) return;
    setImporting(true);
    setError('');

    try {
      await importExamQuestions(currentExamId, selectedExamId, [...selectedQIds]);
      onImported();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to import questions');
      setImporting(false);
    }
  }

  return (
    <div style={overlay}>
      <div style={modal}>
        <div style={modalHeader}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#f1f5f9' }}>
              📥 Import Questions from Another Exam
            </h2>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>
              Copies questions directly into this exam with new IDs.
            </p>
          </div>
          <button style={closeBtn} onClick={onClose} disabled={importing}>
            ✕
          </button>
        </div>

        {error && <div style={errorBox}>⚠️ {error}</div>}

        <div style={modalBody}>
          {loadingExams ? (
            <div style={empty}>Loading other exams…</div>
          ) : exams.length === 0 ? (
            <div style={empty}>No other exams available to import questions from.</div>
          ) : (
            <>
              {/* Exam Selector */}
              <div>
                <label style={labelStyle}>Select Source Exam</label>
                <select
                  style={inputStyle}
                  value={selectedExamId}
                  onChange={(e) => setSelectedExamId(e.target.value)}
                  disabled={importing}
                >
                  {exams.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title} ({e.course_code || 'No code'}) · {e.status}
                    </option>
                  ))}
                </select>
              </div>

              {/* Questions List */}
              <div style={{ marginTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={labelStyle}>
                    Questions to Import ({selectedQIds.size}/{questions.length} selected)
                  </label>
                  {questions.length > 0 && (
                    <button type="button" style={btnLink} onClick={toggleAll} disabled={importing}>
                      {selectedQIds.size === questions.length ? 'Deselect All' : 'Select All'}
                    </button>
                  )}
                </div>

                {loadingQuestions ? (
                  <div style={empty}>Loading questions…</div>
                ) : questions.length === 0 ? (
                  <div style={empty}>This exam has no questions to import.</div>
                ) : (
                  <div style={questionList}>
                    {questions.map((q) => {
                      const isChecked = selectedQIds.has(q.id);
                      return (
                        <label
                          key={q.id}
                          style={{
                            ...qRow,
                            background: isChecked ? 'rgba(99,102,241,0.1)' : 'rgba(255,255,255,0.02)',
                            borderColor: isChecked ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.06)',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleOne(q.id)}
                            style={{ accentColor: '#6366f1', width: 16, height: 16 }}
                            disabled={importing}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ margin: '0 0 4px', fontSize: 13, color: '#e2e8f0', fontWeight: 500 }}>
                              {q.question_text}
                            </p>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <span style={typeBadge}>{q.type}</span>
                              <span style={{ fontSize: 11, color: '#64748b' }}>
                                {q.points} pt{q.points !== 1 ? 's' : ''}
                              </span>
                              <span style={{ fontSize: 11, color: q.grading_mode === 'auto' ? '#34d399' : '#fbbf24' }}>
                                {q.grading_mode}
                              </span>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Modal Footer */}
        <div style={modalFooter}>
          <button type="button" style={btnSecondary} onClick={onClose} disabled={importing}>
            Cancel
          </button>
          <button
            type="button"
            style={btnPrimary}
            onClick={() => void handleImport()}
            disabled={importing || selectedQIds.size === 0}
          >
            {importing ? 'Importing…' : `Import ${selectedQIds.size} Question${selectedQIds.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

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

const modal: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 14,
  maxWidth: 620,
  width: '100%',
  maxHeight: '85vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
};

const modalHeader: React.CSSProperties = {
  padding: '18px 24px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const modalBody: React.CSSProperties = {
  padding: 24,
  overflowY: 'auto',
  flex: 1,
};

const modalFooter: React.CSSProperties = {
  padding: '16px 24px',
  borderTop: '1px solid rgba(255,255,255,0.08)',
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 12,
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

const questionList: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxHeight: 320,
  overflowY: 'auto',
};

const qRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '10px 14px',
  borderRadius: 8,
  border: '1px solid',
  cursor: 'pointer',
  transition: 'all 0.15s',
};

const typeBadge: React.CSSProperties = {
  fontSize: 10,
  fontFamily: 'monospace',
  padding: '2px 6px',
  borderRadius: 4,
  background: 'rgba(255,255,255,0.07)',
  color: '#cbd5e1',
  textTransform: 'uppercase',
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

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#64748b',
  fontSize: 18,
  cursor: 'pointer',
  padding: '4px 8px',
};

const empty: React.CSSProperties = {
  textAlign: 'center',
  padding: 32,
  color: '#64748b',
  fontSize: 13,
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

