/**
 * src/pages/AdminExamsPage.tsx — Admin Global Exam Oversight & Reassignment (Phase 7)
 * ─────────────────────────────────────────────────────────────────────────────
 * View all exams across all professors, filter by status and owner,
 * inspect enrollment and attempt statistics, and reassign ownership safely.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useState } from 'react';

interface ExamItem {
  id: string;
  title: string;
  course_code: string;
  status: string;
  join_code: string;
  join_code_active: number;
  duration_minutes: number;
  created_at: string;
  created_by: string;
  archived: number;
  owner_name: string | null;
  owner_email: string | null;
  enrolled_count: number;
  submitted_count: number;
  in_progress_count: number;
}

interface StaffUser {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
}

export function AdminExamsPage() {
  const [exams, setExams] = useState<ExamItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);

  // Reassign Modal State
  const [reassignExam, setReassignExam] = useState<ExamItem | null>(null);
  const [staffList, setStaffList] = useState<StaffUser[]>([]);
  const [selectedStaffId, setSelectedStaffId] = useState('');
  const [reassignLoading, setReassignLoading] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);
  const [reassignSuccess, setReassignSuccess] = useState<string | null>(null);

  const fetchExams = async (targetCursor: string | null = null) => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (ownerFilter.trim()) params.set('owner', ownerFilter.trim());
      if (targetCursor) params.set('cursor', targetCursor);
      params.set('limit', '20');

      const res = await fetch(`/api/admin/exams?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`Failed to load exams (HTTP ${res.status})`);
      }
      const data = await res.json();
      setExams(data.exams || []);
      setNextCursor(data.next_cursor || null);
    } catch (err: any) {
      setError(err?.message || 'Error fetching exams');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setCursor(null);
    setCursorHistory([]);
    void fetchExams(null);
  }, [search, statusFilter, ownerFilter]);

  const handleNextPage = () => {
    if (nextCursor) {
      setCursorHistory((prev) => [...prev, cursor || '']);
      setCursor(nextCursor);
      void fetchExams(nextCursor);
    }
  };

  const handlePrevPage = () => {
    if (cursorHistory.length > 0) {
      const prevList = [...cursorHistory];
      const prevCursor = prevList.pop() || null;
      setCursorHistory(prevList);
      setCursor(prevCursor);
      void fetchExams(prevCursor);
    }
  };

  // Open Reassign Dialog and load active staff members
  const openReassignDialog = async (exam: ExamItem) => {
    setReassignExam(exam);
    setSelectedStaffId('');
    setReassignError(null);
    setReassignSuccess(null);

    try {
      // Fetch active professors and admins
      const res = await fetch('/api/admin/users?status=active&limit=50');
      if (res.ok) {
        const json = await res.json();
        const eligible = (json.users || []).filter(
          (u: StaffUser) => (u.role === 'professor' || u.role === 'admin') && u.active,
        );
        setStaffList(eligible);
        if (eligible.length > 0) {
          // Default to first eligible that isn't the current owner
          const other = eligible.find((s: StaffUser) => s.id !== exam.created_by);
          setSelectedStaffId(other ? other.id : eligible[0].id);
        }
      }
    } catch {
      // Ignore staff fetch error; user can still see message
    }
  };

  const handleReassignSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reassignExam || !selectedStaffId) return;

    if (reassignExam.in_progress_count > 0) {
      setReassignError('Cannot reassign an exam with student attempts currently in progress.');
      return;
    }

    try {
      setReassignLoading(true);
      setReassignError(null);
      const res = await fetch(`/api/admin/exams/${encodeURIComponent(reassignExam.id)}/reassign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newOwnerId: selectedStaffId }),
      });
      const json = await res.json();

      if (!res.ok) {
        throw new Error(json.error?.message || `Failed to reassign exam (HTTP ${res.status})`);
      }

      setReassignSuccess('Exam ownership successfully reassigned.');
      setTimeout(() => {
        setReassignExam(null);
        setReassignSuccess(null);
        void fetchExams(cursor);
      }, 1200);
    } catch (err: any) {
      setReassignError(err.message || 'Error reassigning exam');
    } finally {
      setReassignLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <span>📋</span> Global Exam Oversight
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Browse all exams on the platform, audit student attempt counts, and manage exam ownership.
          </p>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-wrap items-center gap-4">
        {/* Search Input */}
        <div className="flex-1 min-w-[240px]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title or course code…"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-red-500 transition-colors"
          />
        </div>

        {/* Status Filter */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 font-medium">Status:</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-red-500"
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="completed">Completed</option>
            <option value="closed">Closed</option>
            <option value="archived">Archived</option>
          </select>
        </div>

        {/* Owner Filter */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 font-medium">Owner Email:</label>
          <input
            type="text"
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            placeholder="Filter by owner email…"
            className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-red-500"
          />
        </div>
      </div>

      {/* Exams Table */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden shadow-xl">
        {loading ? (
          <div className="py-20 text-center text-slate-400 text-xs">
            <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            Loading exams...
          </div>
        ) : error ? (
          <div className="p-8 text-center text-xs text-rose-300">
            {error}
            <button
              onClick={() => void fetchExams(cursor)}
              className="block mx-auto mt-3 px-3 py-1 bg-rose-950 border border-rose-800 rounded text-white"
            >
              Retry
            </button>
          </div>
        ) : exams.length === 0 ? (
          <div className="py-16 text-center text-xs text-slate-400">
            No exams found matching your filter criteria.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4">Exam & Course</th>
                  <th className="py-3 px-4">Owner</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Join Code</th>
                  <th className="py-3 px-4 text-center">Enrolled</th>
                  <th className="py-3 px-4 text-center">Submitted</th>
                  <th className="py-3 px-4 text-center">In-Progress</th>
                  <th className="py-3 px-4">Created</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {exams.map((e) => {
                  const hasInProgress = e.in_progress_count > 0;
                  return (
                    <tr key={e.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-white">{e.title}</div>
                        <div className="text-slate-400 text-[11px] font-mono">{e.course_code}</div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="text-slate-200 font-medium">
                          {e.owner_name || <span className="text-slate-500">Unassigned</span>}
                        </div>
                        {e.owner_email && (
                          <div className="text-slate-400 text-[11px] font-mono">{e.owner_email}</div>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                              e.status === 'active'
                                ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/60'
                                : e.status === 'completed'
                                ? 'bg-indigo-950 text-indigo-400 border border-indigo-800/60'
                                : 'bg-slate-800 text-slate-300 border border-slate-700'
                            }`}
                          >
                            {e.status}
                          </span>
                          {e.archived === 1 && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-950 text-amber-400 border border-amber-800/60">
                              Archived
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-mono text-slate-300 text-xs">{e.join_code}</span>
                        {e.join_code_active === 1 ? (
                          <span className="ml-1.5 text-[10px] text-emerald-400 font-medium">●</span>
                        ) : (
                          <span className="ml-1.5 text-[10px] text-slate-600 font-medium">○</span>
                        )}
                      </td>
                      <td className="py-3 px-4 text-center font-medium text-slate-300">
                        {e.enrolled_count}
                      </td>
                      <td className="py-3 px-4 text-center font-medium text-slate-300">
                        {e.submitted_count}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span
                          className={`font-semibold ${
                            hasInProgress ? 'text-amber-400' : 'text-slate-500'
                          }`}
                        >
                          {e.in_progress_count}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-400 text-[11px]">
                        {e.created_at ? new Date(e.created_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={() => void openReassignDialog(e)}
                          className="px-2.5 py-1 rounded text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-all cursor-pointer"
                        >
                          Reassign Owner
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Keyset Pagination Bar */}
        <div className="p-3 border-t border-slate-800/80 bg-slate-950/40 flex items-center justify-between text-xs text-slate-400">
          <span>Showing {exams.length} exams</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrevPage}
              disabled={cursorHistory.length === 0}
              className="px-3 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              &larr; Previous
            </button>
            <button
              onClick={handleNextPage}
              disabled={!nextCursor}
              className="px-3 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Next &rarr;
            </button>
          </div>
        </div>
      </div>

      {/* ── Reassign Owner Modal ─────────────────────────────────────────── */}
      {reassignExam && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <span>🔄</span> Reassign Exam Ownership
              </h2>
              <button
                onClick={() => setReassignExam(null)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                &times;
              </button>
            </div>

            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-xs text-slate-300 mb-4 space-y-1">
              <div>
                <strong>Exam:</strong> {reassignExam.title} ({reassignExam.course_code})
              </div>
              <div>
                <strong>Current Owner:</strong>{' '}
                {reassignExam.owner_name
                  ? `${reassignExam.owner_name} (${reassignExam.owner_email})`
                  : 'Unassigned'}
              </div>
            </div>

            {/* In-progress Warning: locks reassign button */}
            {reassignExam.in_progress_count > 0 && (
              <div className="p-3 rounded-xl bg-rose-950/50 border border-rose-800 text-xs text-rose-300 mb-4 leading-relaxed">
                ⚠️ <strong>Reassignment Blocked:</strong> There are currently{' '}
                <strong>{reassignExam.in_progress_count}</strong> active student attempts in progress for this exam. Reassignment cannot occur during live testing.
              </div>
            )}

            {reassignError && (
              <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800 text-xs text-rose-300 mb-4">
                {reassignError}
              </div>
            )}

            {reassignSuccess && (
              <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-800 text-xs text-emerald-300 mb-4">
                {reassignSuccess}
              </div>
            )}

            <form onSubmit={handleReassignSubmit} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Assign To Active Staff Member *
                </label>
                <select
                  required
                  value={selectedStaffId}
                  onChange={(e) => setSelectedStaffId(e.target.value)}
                  disabled={reassignExam.in_progress_count > 0}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500 disabled:opacity-40"
                >
                  <option value="">Select a professor or administrator…</option>
                  {staffList.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.email}) — {s.role.toUpperCase()}
                    </option>
                  ))}
                </select>
              </div>

              <p className="text-[11px] text-slate-500 leading-relaxed">
                Reassigning transfers exclusive editing, live monitoring, and report access to the new instructor. Existing student attempts, answers, and grading history remain completely untouched.
              </p>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setReassignExam(null)}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={
                    reassignLoading ||
                    reassignExam.in_progress_count > 0 ||
                    !selectedStaffId ||
                    selectedStaffId === reassignExam.created_by
                  }
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer"
                >
                  {reassignLoading ? 'Reassigning...' : 'Confirm Reassignment'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
