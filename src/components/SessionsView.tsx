import { useState, useMemo } from 'react';
import type { ProfessorAttempt } from '../types';
import {
  archiveSessions,
  unarchiveSessions,
  clearSessions,
  deleteSessions,
  holdSession,
  clearUnlinkedSessions,
} from '../hooks/useProfessorApi';

interface SessionsViewProps {
  view: 'ended' | 'archived' | 'test' | 'unlinked';
  sessions: ProfessorAttempt[];
  unlinked?: any[];
  examId: string;
  onSelectSession: (sessionId: string, attempt?: ProfessorAttempt) => void;
  onRefresh: () => void;
  examResultsReleased?: boolean;
}

export function SessionsView({
  view,
  sessions,
  unlinked = [],
  examId,
  onSelectSession,
  onRefresh,
  examResultsReleased = false,
}: SessionsViewProps) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{
    message: string;
    type: 'success' | 'warn' | 'error';
    details?: string[];
  } | null>(null);

  // Single delete modal state
  const [deleteTarget, setDeleteTarget] = useState<ProfessorAttempt | null>(null);
  const [typedConfirmName, setTypedConfirmName] = useState('');

  // Bulk selection helpers
  const allIds = useMemo(() => sessions.map((s) => s.id), [sessions]);
  const isAllSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id));

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allIds));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ── Actions ─────────────────────────────────────────────────────────────────

  const handleArchive = async (ids: string[]) => {
    setBusy(true);
    setActionFeedback(null);
    try {
      const res = await archiveSessions(examId, ids);
      setSelectedIds(new Set());
      const failed = res.results.filter((r) => !r.success);
      if (failed.length > 0) {
        setActionFeedback({
          message: `Archived ${res.succeededCount} attempt(s); ${res.refusedCount} refused.`,
          type: 'warn',
          details: failed.map((f) => `${f.id}: ${f.reason || 'Refused'}`),
        });
      } else {
        setActionFeedback({
          message: `Successfully archived ${res.succeededCount} attempt(s).`,
          type: 'success',
        });
      }
      onRefresh();
    } catch (err: any) {
      setActionFeedback({ message: err.message || 'Archive failed', type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleUnarchive = async (ids: string[]) => {
    setBusy(true);
    setActionFeedback(null);
    try {
      const res = await unarchiveSessions(examId, ids);
      setSelectedIds(new Set());
      setActionFeedback({
        message: `Successfully unarchived ${res.succeededCount} attempt(s).`,
        type: 'success',
      });
      onRefresh();
    } catch (err: any) {
      setActionFeedback({ message: err.message || 'Unarchive failed', type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleHoldToggle = async (att: ProfessorAttempt) => {
    setBusy(true);
    try {
      const newHold = att.evidence_hold !== 1;
      await holdSession(examId, att.id, newHold);
      onRefresh();
    } catch (err: any) {
      setActionFeedback({ message: err.message || 'Failed to toggle evidence hold', type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleClearData = async (ids: string[]) => {
    setBusy(true);
    setActionFeedback(null);
    try {
      const res = await clearSessions(examId, ids);
      setSelectedIds(new Set());
      const failed = res.results.filter((r) => !r.success);
      if (failed.length > 0) {
        setActionFeedback({
          message: `Cleared telemetry for ${res.succeededCount} attempt(s); ${res.refusedCount} refused.`,
          type: 'warn',
          details: failed.map((f) => `${f.id}: ${f.reason || 'Refused'}`),
        });
      } else {
        setActionFeedback({
          message: `Successfully cleared telemetry for ${res.succeededCount} attempt(s). Scores and answers preserved.`,
          type: 'success',
        });
      }
      onRefresh();
    } catch (err: any) {
      setActionFeedback({ message: err.message || 'Clear telemetry failed', type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    setActionFeedback(null);
    try {
      const res = await deleteSessions(examId, [deleteTarget.id], typedConfirmName);
      setDeleteTarget(null);
      setTypedConfirmName('');
      const failed = res.results.filter((r) => !r.success);
      if (failed.length > 0) {
        setActionFeedback({
          message: `Deletion refused: ${failed[0].reason}`,
          type: 'error',
        });
      } else {
        setActionFeedback({
          message: 'Attempt permanently deleted.',
          type: 'success',
        });
      }
      onRefresh();
    } catch (err: any) {
      setActionFeedback({ message: err.message || 'Delete failed', type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleBulkDelete = async (ids: string[]) => {
    if (!confirm(`Are you sure you want to permanently delete ${ids.length} selected attempt(s)?`)) {
      return;
    }
    setBusy(true);
    setActionFeedback(null);
    try {
      const res = await deleteSessions(examId, ids);
      setSelectedIds(new Set());
      const failed = res.results.filter((r) => !r.success);
      if (failed.length > 0) {
        setActionFeedback({
          message: `Deleted ${res.succeededCount} attempt(s); ${res.refusedCount} refused.`,
          type: 'warn',
          details: failed.map((f) => `${f.id}: ${f.reason || 'Refused'}`),
        });
      } else {
        setActionFeedback({
          message: `Successfully deleted ${res.succeededCount} attempt(s).`,
          type: 'success',
        });
      }
      onRefresh();
    } catch (err: any) {
      setActionFeedback({ message: err.message || 'Bulk delete failed', type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const handleClearUnlinked = async (sessionIds?: string[]) => {
    const isAll = !sessionIds;
    if (
      !confirm(
        isAll
          ? 'Clear all unlinked hub sessions? These are orphaned sessions with no student attempt record.'
          : 'Clear this unlinked session?',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await clearUnlinkedSessions(examId, sessionIds);
      setActionFeedback({
        message: `Cleared ${res.clearedCount} unlinked session(s).`,
        type: 'success',
      });
      onRefresh();
    } catch (err: any) {
      setActionFeedback({ message: err.message || 'Failed to clear unlinked', type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const formatDuration = (secs?: number) => {
    if (!secs || secs <= 0) return '—';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${s}s`;
  };

  return (
    <div className="space-y-4">
      {/* Feedback banner */}
      {actionFeedback && (
        <div
          className={`p-3.5 rounded-xl border text-xs flex items-start justify-between gap-3 ${
            actionFeedback.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
              : actionFeedback.type === 'warn'
              ? 'bg-amber-950/40 border-amber-500/40 text-amber-300'
              : 'bg-rose-950/40 border-rose-500/40 text-rose-300'
          }`}
        >
          <div>
            <p className="font-semibold">{actionFeedback.message}</p>
            {actionFeedback.details && actionFeedback.details.length > 0 && (
              <ul className="mt-1 list-disc list-inside space-y-0.5 text-[11px] opacity-90">
                {actionFeedback.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
          </div>
          <button
            onClick={() => setActionFeedback(null)}
            className="text-gray-400 hover:text-white text-xs px-1"
          >
            ✕
          </button>
        </div>
      )}

      {/* Bulk & Top Action Bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap bg-gray-900/40 border border-white/5 rounded-xl px-4 py-2.5">
        <div className="flex items-center gap-2">
          {view !== 'unlinked' && (
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={isAllSelected}
                onChange={toggleSelectAll}
                className="rounded border-white/20 bg-gray-800 text-indigo-600 focus:ring-0"
              />
              <span>Select All ({sessions.length})</span>
            </label>
          )}

          {selectedIds.size > 0 && (
            <span className="text-xs text-indigo-400 font-semibold ml-2">
              {selectedIds.size} selected
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {selectedIds.size > 0 && view === 'ended' && (
            <>
              <button
                onClick={() => void handleArchive(Array.from(selectedIds))}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 text-xs font-semibold transition"
              >
                Archive Selected
              </button>
              <button
                onClick={() => void handleClearData(Array.from(selectedIds))}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-200 border border-amber-500/40 text-xs font-semibold transition"
                title="Only applies to attempts with 0 violations"
              >
                Clear Telemetry Selected
              </button>
              <button
                onClick={() => void handleBulkDelete(Array.from(selectedIds))}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-200 border border-rose-500/40 text-xs font-semibold transition"
                title="Only applies to clean attempts with no evidence hold"
              >
                Delete Clean Selected
              </button>
            </>
          )}

          {selectedIds.size > 0 && view === 'archived' && (
            <button
              onClick={() => void handleUnarchive(Array.from(selectedIds))}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 text-xs font-semibold transition"
            >
              Unarchive Selected
            </button>
          )}

          {view === 'test' && (
            <>
              {selectedIds.size > 0 && (
                <button
                  onClick={() => void handleBulkDelete(Array.from(selectedIds))}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-200 border border-rose-500/40 text-xs font-semibold transition"
                >
                  Delete Selected ({selectedIds.size})
                </button>
              )}
              {sessions.length > 0 && (
                <button
                  onClick={() => void handleBulkDelete(sessions.map((s) => s.id))}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition shadow-sm"
                >
                  🗑️ Delete All Test Attempts
                </button>
              )}
            </>
          )}

          {view === 'unlinked' && unlinked.length > 0 && (
            <button
              onClick={() => void handleClearUnlinked()}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition shadow-sm"
            >
              🧹 Clear All Unlinked Sessions
            </button>
          )}
        </div>
      </div>

      {/* Main Table / List */}
      {view === 'unlinked' ? (
        unlinked.length === 0 ? (
          <div className="p-12 text-center text-gray-500 bg-gray-900/30 border border-white/5 rounded-2xl">
            <span className="text-3xl block mb-2">🔗</span>
            <p className="text-sm font-medium">No unlinked sessions found.</p>
            <p className="text-xs text-gray-600 mt-1">All active proctoring sessions match database records.</p>
          </div>
        ) : (
          <div className="border border-white/10 rounded-xl overflow-hidden bg-gray-900/50">
            <table className="w-full text-left text-xs text-gray-300">
              <thead className="bg-gray-950/80 text-gray-400 uppercase text-[10px] tracking-wider border-b border-white/10">
                <tr>
                  <th className="py-3 px-4">Session ID</th>
                  <th className="py-3 px-4">Student Label</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Violations</th>
                  <th className="py-3 px-4 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {unlinked.map((u) => (
                  <tr key={u.sessionId} className="hover:bg-white/[0.02] transition">
                    <td className="py-3 px-4 font-mono text-gray-400">{u.sessionId}</td>
                    <td className="py-3 px-4 text-white font-medium">{u.studentName || 'Orphan'}</td>
                    <td className="py-3 px-4 capitalize">{u.status || 'unknown'}</td>
                    <td className="py-3 px-4">{u.violationCount ?? 0}</td>
                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={() => void handleClearUnlinked([u.sessionId])}
                        disabled={busy}
                        className="px-2.5 py-1 rounded bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border border-rose-500/30 text-[11px] font-semibold transition"
                      >
                        Clear
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : sessions.length === 0 ? (
        <div className="p-12 text-center text-gray-500 bg-gray-900/30 border border-white/5 rounded-2xl">
          <span className="text-3xl block mb-2">
            {view === 'ended' ? '📥' : view === 'archived' ? '📦' : '🧪'}
          </span>
          <p className="text-sm font-medium">No {view} sessions.</p>
          <p className="text-xs text-gray-600 mt-1">
            {view === 'ended'
              ? 'Finished student attempts will appear here.'
              : view === 'archived'
              ? 'Archived attempts are kept here.'
              : 'Preview test attempts appear here.'}
          </p>
        </div>
      ) : (
        <div className="border border-white/10 rounded-xl overflow-hidden bg-gray-900/50">
          <table className="w-full text-left text-xs text-gray-300">
            <thead className="bg-gray-950/80 text-gray-400 uppercase text-[10px] tracking-wider border-b border-white/10">
              <tr>
                <th className="py-3 px-3 w-8"></th>
                <th className="py-3 px-4">Student</th>
                <th className="py-3 px-4">Ended Reason</th>
                <th className="py-3 px-4">Risk & Violations</th>
                <th className="py-3 px-4">Duration</th>
                <th className="py-3 px-4">Ended At</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {sessions.map((att) => {
                const isSelected = selectedIds.has(att.id);
                const hasViolations = att.violation_count === null || Number(att.violation_count) > 0;
                const canClearOrDelete = !hasViolations && att.evidence_hold !== 1;

                return (
                  <tr
                    key={att.id}
                    className={`hover:bg-white/[0.03] transition cursor-pointer ${
                      isSelected ? 'bg-indigo-950/20' : ''
                    }`}
                    onClick={(e) => {
                      // Don't trigger drawer if clicking action button or checkbox
                      if ((e.target as HTMLElement).closest('button, input')) return;
                      onSelectSession(att.session_id, att);
                    }}
                  >
                    <td className="py-3 px-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(att.id)}
                        className="rounded border-white/20 bg-gray-800 text-indigo-600 focus:ring-0"
                      />
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white">{att.student_name}</span>
                        {att.is_test === 1 && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40">
                            TEST
                          </span>
                        )}
                        {att.is_purged && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 border border-white/10">
                            🛡️ Evidence Purged
                          </span>
                        )}
                        {att.evidence_hold === 1 && (
                          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                            🔒 Held
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-500 font-mono mt-0.5">{att.id}</p>
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded border capitalize ${
                          att.ended_reason === 'terminated'
                            ? 'bg-red-500/15 border-red-500/30 text-red-300'
                            : att.ended_reason === 'auto_submitted'
                            ? 'bg-blue-500/15 border-blue-500/30 text-blue-300'
                            : 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                        }`}
                      >
                        {att.ended_reason?.replace('_', ' ') || att.status}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono text-xs font-bold ${
                            (att.final_risk_score ?? 0) >= 70
                              ? 'text-red-400'
                              : (att.final_risk_score ?? 0) >= 40
                              ? 'text-amber-400'
                              : 'text-emerald-400'
                          }`}
                        >
                          Risk {att.final_risk_score ?? 0}
                        </span>
                        <span className="text-gray-500">·</span>
                        <span className="text-gray-400">
                          {att.violation_count === null
                            ? 'Violations: ?'
                            : `${att.violation_count} violations`}
                        </span>
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono text-gray-400">
                      {formatDuration(att.duration_seconds)}
                    </td>
                    <td className="py-3 px-4 text-gray-400">
                      {att.submitted_at
                        ? new Date(att.submitted_at).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '—'}
                    </td>
                    <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                      {view === 'ended' && (
                        <>
                          <button
                            onClick={() => void handleArchive([att.id])}
                            disabled={busy}
                            className="px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-gray-300 border border-white/10 text-[11px] font-semibold transition"
                            title="Hide from ended list while keeping all data"
                          >
                            Archive
                          </button>
                          <button
                            onClick={() => void handleClearData([att.id])}
                            disabled={busy || !canClearOrDelete}
                            className={`px-2 py-1 rounded text-[11px] font-semibold border transition ${
                              canClearOrDelete
                                ? 'bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border-amber-500/30'
                                : 'bg-gray-800/40 text-gray-600 border-white/5 cursor-not-allowed'
                            }`}
                            title={
                              canClearOrDelete
                                ? 'Purge proctoring telemetry (keeps score & answers)'
                                : hasViolations
                                ? `Has violations (${att.violation_count ?? 'unknown'}), archive instead`
                                : 'Evidence hold active'
                            }
                          >
                            Clear Telemetry
                          </button>
                          <button
                            onClick={() => {
                              setDeleteTarget(att);
                              setTypedConfirmName('');
                            }}
                            disabled={busy || !canClearOrDelete}
                            className={`px-2 py-1 rounded text-[11px] font-semibold border transition ${
                              canClearOrDelete
                                ? 'bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border-rose-500/30'
                                : 'bg-gray-800/40 text-gray-600 border-white/5 cursor-not-allowed'
                            }`}
                            title={
                              canClearOrDelete
                                ? 'Permanently delete attempt'
                                : hasViolations
                                ? 'Has violations, archive instead'
                                : 'Evidence hold active'
                            }
                          >
                            Delete
                          </button>
                        </>
                      )}

                      {view === 'archived' && (
                        <>
                          <button
                            onClick={() => void handleUnarchive([att.id])}
                            disabled={busy}
                            className="px-2 py-1 rounded bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 text-[11px] font-semibold transition"
                          >
                            Unarchive
                          </button>
                          <button
                            onClick={() => void handleHoldToggle(att)}
                            disabled={busy}
                            className={`px-2 py-1 rounded text-[11px] font-semibold border transition ${
                              att.evidence_hold === 1
                                ? 'bg-indigo-600/40 text-indigo-200 border-indigo-500/60'
                                : 'bg-white/5 hover:bg-white/10 text-gray-300 border-white/10'
                            }`}
                            title="Evidence hold prevents the automated retention sweep from purging data"
                          >
                            {att.evidence_hold === 1 ? '🔒 Held' : 'Hold Evidence'}
                          </button>
                          <button
                            onClick={() => {
                              setDeleteTarget(att);
                              setTypedConfirmName('');
                            }}
                            disabled={busy || !canClearOrDelete}
                            className={`px-2 py-1 rounded text-[11px] font-semibold border transition ${
                              canClearOrDelete
                                ? 'bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border-rose-500/30'
                                : 'bg-gray-800/40 text-gray-600 border-white/5 cursor-not-allowed'
                            }`}
                            title={
                              canClearOrDelete
                                ? 'Permanently delete attempt'
                                : hasViolations
                                ? 'Has violations, archive instead'
                                : 'Evidence hold active'
                            }
                          >
                            Delete
                          </button>
                        </>
                      )}

                      {view === 'test' && (
                        <button
                          onClick={() => void handleBulkDelete([att.id])}
                          disabled={busy}
                          className="px-2 py-1 rounded bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/30 text-[11px] font-semibold transition"
                        >
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-gray-900 border border-rose-500/40 rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-rose-400">
              <span className="text-2xl">⚠️</span>
              <h3 className="text-base font-bold text-white">Permanently Delete Attempt</h3>
            </div>

            <p className="text-xs text-gray-300 leading-relaxed">
              This action permanently deletes the student's submission, proctoring telemetry, and recorded answers.
              The student's enrollment will stay, allowing them to take a fresh attempt if the exam is active.
            </p>

            {(examResultsReleased || deleteTarget.fully_graded === 1 || deleteTarget.score !== null) && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs">
                ⚠️ <strong>Warning:</strong> Results for this exam have already been graded or released.
                Deleting this attempt will remove their official score record.
              </div>
            )}

            <div>
              <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1">
                Type the student's name to confirm: <span className="text-white font-mono">{deleteTarget.student_name}</span>
              </label>
              <input
                type="text"
                value={typedConfirmName}
                onChange={(e) => setTypedConfirmName(e.target.value)}
                placeholder="Type student name exactly"
                className="w-full bg-gray-950 border border-white/10 rounded-xl px-3.5 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-rose-500"
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/15 text-gray-300 text-xs font-semibold transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteConfirmed()}
                disabled={
                  busy ||
                  typedConfirmName.trim().toLowerCase() !== deleteTarget.student_name.trim().toLowerCase()
                }
                className={`px-4 py-2 rounded-xl text-xs font-bold text-white transition ${
                  typedConfirmName.trim().toLowerCase() === deleteTarget.student_name.trim().toLowerCase()
                    ? 'bg-rose-600 hover:bg-rose-500 cursor-pointer shadow-lg shadow-rose-900/40'
                    : 'bg-rose-900/40 text-gray-500 cursor-not-allowed border border-rose-500/20'
                }`}
              >
                Permanently Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
