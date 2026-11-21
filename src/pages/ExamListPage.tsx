/**
 * src/pages/ExamListPage.tsx — Professor: list, search, and manage exams (Phase 4c-1)
 *
 * Exam-centric dashboard:
 * • Displays derived status (draft, scheduled, live, ended)
 * • Join code badge (XXXX-XXXX)
 * • Question count, total points, enrolled student count
 * • Short modal "Create Exam" (replaces 4-step wizard)
 * • Row actions: Open, Duplicate, Delete (drafts only)
 */
import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Exam, DerivedExamStatus } from '../types';
import {
  listExams,
  deleteExam,
  duplicateExam,
  createExam,
  ApiError,
  type ListExamsParams,
} from '../hooks/useProfessorApi';

// ─── Join Code Formatter ──────────────────────────────────────────────────────

function formatJoinCode(code?: string | null): string {
  if (!code) return '—';
  const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

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
        padding: '2px 9px',
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

// ─── Confirm Delete Modal ────────────────────────────────────────────────────

function ConfirmModal({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={overlay}>
      <div style={modal}>
        <h3 style={{ margin: '0 0 12px', color: '#f1f5f9', fontSize: 16 }}>Confirm Action</h3>
        <p style={{ margin: '0 0 20px', color: '#cbd5e1', fontSize: 13, lineHeight: 1.5 }}>
          {message}
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button style={btnSecondary} onClick={onCancel}>
            Cancel
          </button>
          <button style={{ ...btnPrimary, background: '#ef4444' }} onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Short "Create Exam" Modal (replaces 4-step wizard) ────────────────────────

interface CreateExamModalProps {
  onClose: () => void;
  onCreated: (newExam: Exam) => void;
}

function CreateExamModal({ onClose, onCreated }: CreateExamModalProps) {
  const [title, setTitle] = useState('');
  const [courseCode, setCourseCode] = useState('');
  const [description, setDescription] = useState('');
  const [duration, setDuration] = useState(60);
  const [startTimeLocal, setStartTimeLocal] = useState('');
  const [endTimeLocal, setEndTimeLocal] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setError('Title is required');
      return;
    }
    if (duration <= 0) {
      setError('Duration must be greater than 0 minutes');
      return;
    }
    if (startTimeLocal && endTimeLocal && new Date(endTimeLocal) <= new Date(startTimeLocal)) {
      setError('End time must be after start time');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const startUtc = startTimeLocal ? new Date(startTimeLocal).toISOString() : null;
      const endUtc = endTimeLocal ? new Date(endTimeLocal).toISOString() : null;

      const created = await createExam({
        title: title.trim(),
        course_code: courseCode.trim(),
        description: description.trim(),
        duration_minutes: Number(duration),
        start_time: startUtc,
        end_time: endUtc,
      });

      onCreated(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to create exam');
      setSaving(false);
    }
  }

  return (
    <div style={overlay}>
      <div style={{ ...modal, maxWidth: 540 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18, color: '#f1f5f9' }}>✨ Create New Exam</h2>
          <button style={closeBtn} onClick={onClose} disabled={saving}>
            ✕
          </button>
        </div>

        {error && <div style={errorBox}>⚠️ {error}</div>}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Exam Title *</label>
            <input
              style={inputStyle}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. CS101 Midterm Examination"
              required
              autoFocus
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Course Code</label>
              <input
                style={inputStyle}
                value={courseCode}
                onChange={(e) => setCourseCode(e.target.value)}
                placeholder="e.g. CS101"
              />
            </div>
            <div>
              <label style={labelStyle}>Duration (minutes) *</label>
              <input
                style={inputStyle}
                type="number"
                min={1}
                max={600}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                required
              />
            </div>
          </div>

          <div>
            <label style={labelStyle}>Description (optional)</label>
            <textarea
              style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description or instructions for students"
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Start Window (local time)</label>
              <input
                style={inputStyle}
                type="datetime-local"
                value={startTimeLocal}
                onChange={(e) => setStartTimeLocal(e.target.value)}
              />
            </div>
            <div>
              <label style={labelStyle}>End Window (local time)</label>
              <input
                style={inputStyle}
                type="datetime-local"
                value={endTimeLocal}
                onChange={(e) => setEndTimeLocal(e.target.value)}
              />
            </div>
          </div>

          <p style={{ margin: '2px 0 0', fontSize: 11, color: '#64748b' }}>
            A unique join code will be auto-generated. You will build questions on the next screen.
          </p>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 10 }}>
            <button type="button" style={btnSecondary} onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" style={btnPrimary} disabled={saving}>
              {saving ? 'Creating…' : 'Continue to Questions →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function ExamListPage() {
  const navigate = useNavigate();
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [params, setParams] = useState<ListExamsParams>({ sort: 'created_at', order: 'desc' });
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Exam | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listExams({ ...params, search, status: statusFilter });
      setExams(data);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load exams');
    } finally {
      setLoading(false);
    }
  }, [params, search, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDelete(exam: Exam) {
    setDeleteTarget(null);
    try {
      await deleteExam(exam.id);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Delete failed');
    }
  }

  async function handleDuplicate(exam: Exam) {
    setDuplicatingId(exam.id);
    try {
      const dup = await duplicateExam(exam.id);
      navigate(`/professor/exams/${dup.id}?tab=questions`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Duplicate failed');
      setDuplicatingId(null);
    }
  }

  return (
    <div style={pageStyle}>
      {/* Header */}
      <div style={header}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#f1f5f9' }}>
            📋 Exam Management
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748b' }}>
            The exam is the container. Build questions, share join codes, and monitor sessions live.
          </p>
        </div>
        <button
          style={btnPrimary}
          onClick={() => setShowCreateModal(true)}
          id="create-exam-btn"
        >
          ✨ Create Exam
        </button>
      </div>

      {error && <div style={errorBox}>⚠️ {error}</div>}

      {/* Filter and Search Bar */}
      <div style={filterBar}>
        <input
          style={{ ...inputStyle, width: 280 }}
          placeholder="🔍 Search by title, code, course…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          style={{ ...inputStyle, width: 160 }}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Statuses</option>
          <option value="draft">Draft</option>
          <option value="scheduled">Scheduled</option>
          <option value="active">Active</option>
          <option value="closed">Closed / Ended</option>
        </select>
        <select
          style={{ ...inputStyle, width: 170 }}
          value={`${params.sort}:${params.order}`}
          onChange={(e) => {
            const [sort, order] = e.target.value.split(':') as [string, 'asc' | 'desc'];
            setParams((prev) => ({ ...prev, sort, order }));
          }}
        >
          <option value="created_at:desc">Newest first</option>
          <option value="created_at:asc">Oldest first</option>
          <option value="title:asc">Title A–Z</option>
          <option value="duration_minutes:desc">Longest duration</option>
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div style={emptyState}>Loading exams…</div>
      ) : exams.length === 0 ? (
        <div style={emptyState}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>📝</div>
          <p style={{ margin: 0, fontSize: 15, color: '#94a3b8', fontWeight: 500 }}>
            No exams match your filters.
          </p>
          <p style={{ margin: '4px 0 16px', fontSize: 12, color: '#64748b' }}>
            Create an exam to get started with an automated join code.
          </p>
          <button style={btnPrimary} onClick={() => setShowCreateModal(true)}>
            Create Exam
          </button>
        </div>
      ) : (
        <div style={tableContainer}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={thRow}>
                <th style={{ ...th, width: '28%' }}>Exam</th>
                <th style={{ ...th, width: '12%' }}>Course</th>
                <th style={{ ...th, width: '10%' }}>Status</th>
                <th style={{ ...th, width: '14%' }}>Join Code</th>
                <th style={{ ...th, width: '10%', textAlign: 'center' }}>Questions</th>
                <th style={{ ...th, width: '10%', textAlign: 'center' }}>Points</th>
                <th style={{ ...th, width: '8%', textAlign: 'center' }}>Students</th>
                <th style={{ ...th, width: '8%', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {exams.map((exam) => {
                const isDraft = exam.status === 'draft';
                return (
                  <tr
                    key={exam.id}
                    style={tr}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.03)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <td style={td}>
                      <Link
                        to={`/professor/exams/${exam.id}`}
                        style={{
                          fontWeight: 600,
                          color: '#f1f5f9',
                          textDecoration: 'none',
                          display: 'block',
                        }}
                      >
                        {exam.title}
                      </Link>
                      <span style={{ fontSize: 11, color: '#64748b' }}>
                        ⏱ {exam.duration_minutes}m · Created {new Date(exam.created_at).toLocaleDateString()}
                      </span>
                    </td>

                    <td style={td}>
                      <span style={{ color: '#94a3b8', fontWeight: 500 }}>
                        {exam.course_code || '—'}
                      </span>
                    </td>

                    <td style={td}>
                      <DerivedStatusBadge status={exam.derived_status} />
                    </td>

                    <td style={td}>
                      {exam.join_code ? (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span
                            style={{
                              fontFamily: 'monospace',
                              fontWeight: 700,
                              fontSize: 12,
                              color: exam.join_code_active ? '#a5b4fc' : '#64748b',
                              background: exam.join_code_active ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.05)',
                              border: `1px solid ${exam.join_code_active ? 'rgba(99,102,241,0.3)' : 'rgba(255,255,255,0.1)'}`,
                              padding: '2px 8px',
                              borderRadius: 6,
                              letterSpacing: '0.05em',
                            }}
                          >
                            {formatJoinCode(exam.join_code)}
                          </span>
                          {!exam.join_code_active && (
                            <span style={{ fontSize: 10, color: '#ef4444', fontWeight: 600 }}>OFF</span>
                          )}
                        </div>
                      ) : (
                        <span style={{ color: '#64748b' }}>—</span>
                      )}
                    </td>

                    <td style={{ ...td, textAlign: 'center', color: '#cbd5e1' }}>
                      {exam.question_count ?? (exam.questions?.length || 0)}
                    </td>

                    <td style={{ ...td, textAlign: 'center', color: '#cbd5e1' }}>
                      {exam.total_points ?? 0}
                    </td>

                    <td style={{ ...td, textAlign: 'center', color: '#cbd5e1' }}>
                      {exam.student_count ?? 0}
                    </td>

                    <td style={{ ...td, textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <Link
                          to={`/professor/exams/${exam.id}`}
                          style={{
                            ...btnSm,
                            background: 'rgba(99, 102, 241, 0.15)',
                            color: '#818cf8',
                            border: '1px solid rgba(99, 102, 241, 0.3)',
                            textDecoration: 'none',
                          }}
                        >
                          Open
                        </Link>
                        <button
                          style={{
                            ...btnSm,
                            background: 'rgba(255, 255, 255, 0.05)',
                            color: '#94a3b8',
                            border: '1px solid rgba(255, 255, 255, 0.1)',
                          }}
                          disabled={duplicatingId === exam.id}
                          onClick={() => void handleDuplicate(exam)}
                          title="Duplicate as new draft"
                        >
                          {duplicatingId === exam.id ? '…' : 'Copy'}
                        </button>
                        {isDraft && (
                          <button
                            style={{
                              ...btnSm,
                              background: 'rgba(239, 68, 68, 0.1)',
                              color: '#f87171',
                              border: '1px solid rgba(239, 68, 68, 0.25)',
                            }}
                            onClick={() => setDeleteTarget(exam)}
                            title="Delete draft exam"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modals */}
      {showCreateModal && (
        <CreateExamModal
          onClose={() => setShowCreateModal(false)}
          onCreated={(newExam) => {
            setShowCreateModal(false);
            navigate(`/professor/exams/${newExam.id}?tab=questions`);
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          message={`Are you sure you want to delete draft exam "${deleteTarget.title}"? This action cannot be undone.`}
          onConfirm={() => void handleDelete(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const pageStyle: React.CSSProperties = {
  maxWidth: 1200,
  margin: '0 auto',
  padding: '32px 24px',
  color: '#e2e8f0',
};

const header: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: 28,
};

const filterBar: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  marginBottom: 20,
  flexWrap: 'wrap',
};

const inputStyle: React.CSSProperties = {
  background: '#1e293b',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 8,
  padding: '8px 14px',
  color: '#f1f5f9',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
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

const tableContainer: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  overflow: 'hidden',
};

const thRow: React.CSSProperties = {
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  background: 'rgba(255,255,255,0.02)',
};

const th: React.CSSProperties = {
  padding: '12px 16px',
  textAlign: 'left',
  color: '#64748b',
  fontWeight: 600,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const tr: React.CSSProperties = {
  borderBottom: '1px solid rgba(255,255,255,0.04)',
  transition: 'background 0.15s',
};

const td: React.CSSProperties = {
  padding: '14px 16px',
  verticalAlign: 'middle',
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

const btnSm: React.CSSProperties = {
  padding: '4px 10px',
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
  border: 'none',
};

const errorBox: React.CSSProperties = {
  background: 'rgba(239,68,68,0.15)',
  border: '1px solid rgba(239,68,68,0.3)',
  borderRadius: 8,
  padding: '10px 14px',
  color: '#f87171',
  fontSize: 13,
  marginBottom: 20,
};

const emptyState: React.CSSProperties = {
  textAlign: 'center',
  padding: '64px 20px',
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

const modal: React.CSSProperties = {
  background: '#0f172a',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 14,
  padding: 24,
  maxWidth: 440,
  width: '100%',
  boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
};

const closeBtn: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#64748b',
  fontSize: 18,
  cursor: 'pointer',
  padding: '4px 8px',
};
