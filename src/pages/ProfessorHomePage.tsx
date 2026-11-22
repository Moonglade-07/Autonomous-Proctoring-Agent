/**
 * src/pages/ProfessorHomePage.tsx — Professor Command Center & Dashboard (Phase 5c)
 * ─────────────────────────────────────────────────────────────────────────────
 * Route: /professor
 *
 * Requirements:
 * • Admin and professor land here after login.
 * • Admin sees all exams with an Owner column; professor sees only their own.
 * • Calls GET /api/professor/home:
 *   - Summary cards: live now, upcoming, needs grading, flagged attempts to review
 *   - "Needs attention" list (ungraded submissions, 24h start with 0 questions, disabled codes, unreleased results)
 * • Exam list with tabs: All, Draft, Scheduled, Live, Ended, Archived
 * • Search and sort controls
 * • Archive and Unarchive actions (409 if live, updates join code)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

interface EnrichedExam {
  id: string;
  title: string;
  course_code: string;
  description: string;
  join_code: string;
  join_code_active: number;
  status: string;
  derived_status: 'draft' | 'scheduled' | 'live' | 'ended';
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number;
  archived: number;
  archived_at: string | null;
  created_by: string;
  owner_name?: string | null;
  question_count: number;
  student_count: number;
  submitted_count: number;
  graded_count: number;
  needs_grading_count: number;
  average_score: number | null;
  flagged_count: number;
  results_released?: number;
}

interface NeedsAttentionItem {
  type: 'ungraded_submissions' | 'starting_soon_no_questions' | 'published_code_disabled' | 'results_not_released';
  exam_id: string;
  exam_title: string;
  details?: Record<string, unknown>;
}

interface ProfessorHomeData {
  summary: {
    live_now: number;
    upcoming: number;
    needs_grading: number;
    flagged_exams: number;
  };
  needs_attention: NeedsAttentionItem[];
  exams: EnrichedExam[];
}

export function ProfessorHomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [data, setData] = useState<ProfessorHomeData>({
    summary: { live_now: 0, upcoming: 0, needs_grading: 0, flagged_exams: 0 },
    needs_attention: [],
    exams: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filtering & Search
  const [activeTab, setActiveTab] = useState<'all' | 'draft' | 'scheduled' | 'live' | 'ended' | 'archived'>('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'created_desc' | 'created_asc' | 'title_asc' | 'schedule_asc'>('created_desc');

  // Action status
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/professor/home');
      if (!res.ok) {
        throw new Error(`Failed to load dashboard data (HTTP ${res.status})`);
      }
      const json = (await res.json()) as ProfessorHomeData;
      setData({
        summary: json.summary || { live_now: 0, upcoming: 0, needs_grading: 0, flagged_exams: 0 },
        needs_attention: json.needs_attention || [],
        exams: json.exams || [],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleArchive = async (examId: string) => {
    setActionInProgress(examId);
    try {
      const res = await fetch(`/api/professor/exams/${encodeURIComponent(examId)}/archive`, {
        method: 'POST',
      });
      const resJson = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(resJson.error || 'Failed to archive exam');
      }
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to archive exam');
    } finally {
      setActionInProgress(null);
    }
  };

  const handleUnarchive = async (examId: string) => {
    setActionInProgress(examId);
    try {
      const res = await fetch(`/api/professor/exams/${encodeURIComponent(examId)}/unarchive`, {
        method: 'POST',
      });
      const resJson = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(resJson.error || 'Failed to unarchive exam');
      }
      await loadData();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to unarchive exam');
    } finally {
      setActionInProgress(null);
    }
  };

  // Filter exams by tab
  const filteredExams = data.exams.filter((ex) => {
    const isArchived = ex.archived === 1;

    // Tab filter
    if (activeTab === 'archived') {
      if (!isArchived) return false;
    } else {
      if (isArchived) return false;
      if (activeTab === 'draft' && ex.status !== 'draft') return false;
      if (activeTab === 'scheduled' && ex.derived_status !== 'scheduled') return false;
      if (activeTab === 'live' && ex.derived_status !== 'live') return false;
      if (activeTab === 'ended' && ex.derived_status !== 'ended') return false;
    }

    // Search filter
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      const matchTitle = (ex.title || '').toLowerCase().includes(term);
      const matchCourse = (ex.course_code || '').toLowerCase().includes(term);
      const matchCode = (ex.join_code || '').toLowerCase().includes(term);
      const matchOwner = (ex.owner_name || '').toLowerCase().includes(term);
      if (!matchTitle && !matchCourse && !matchCode && !matchOwner) return false;
    }

    return true;
  });

  // Sort exams
  filteredExams.sort((a, b) => {
    if (sortBy === 'created_desc') {
      return (b.id || '').localeCompare(a.id || '');
    }
    if (sortBy === 'created_asc') {
      return (a.id || '').localeCompare(b.id || '');
    }
    if (sortBy === 'title_asc') {
      return (a.title || '').localeCompare(b.title || '');
    }
    if (sortBy === 'schedule_asc') {
      const timeA = a.start_time ? new Date(a.start_time).getTime() : 0;
      const timeB = b.start_time ? new Date(b.start_time).getTime() : 0;
      return timeA - timeB;
    }
    return 0;
  });

  const isAdmin = user?.role === 'admin';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 w-full flex-1 space-y-8">
        {/* Header Bar */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-950/70 border border-indigo-800/60 text-indigo-300 text-xs font-semibold mb-2">
              <span>🎓</span> {isAdmin ? 'System Administrator Portal' : 'Instructor Command Center'}
            </div>
            <h1 className="text-3xl font-extrabold text-white tracking-tight">
              {isAdmin ? 'All Institutional Examinations' : 'My Examinations'}
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 mt-1">
              {isAdmin
                ? 'Managing all assessment sessions, integrity telemetry, and instructor workloads.'
                : 'Manage exam questions, monitor live testing sessions, and grade student submissions.'}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/professor/exams/new')}
              className="px-4 py-2.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all flex items-center gap-2 cursor-pointer"
            >
              <span>➕</span>
              <span>Create New Exam</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="p-4 rounded-xl bg-rose-950/40 border border-rose-500/40 text-rose-300 text-xs font-medium">
            ⚠️ {error}
          </div>
        )}

        {/* ── Summary Metric Cards ─────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Live Now</span>
              <span className="text-emerald-400 animate-pulse">●</span>
            </div>
            <p className="text-3xl font-black text-white mt-2">{data.summary.live_now}</p>
            <p className="text-[11px] text-slate-500 mt-1">In active session window</p>
          </div>

          <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Upcoming</span>
              <span>📅</span>
            </div>
            <p className="text-3xl font-black text-white mt-2">{data.summary.upcoming}</p>
            <p className="text-[11px] text-slate-500 mt-1">Scheduled for future delivery</p>
          </div>

          <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Needs Grading</span>
              <span className={data.summary.needs_grading > 0 ? 'text-amber-400' : 'text-slate-500'}>📝</span>
            </div>
            <p className="text-3xl font-black text-white mt-2">{data.summary.needs_grading}</p>
            <p className="text-[11px] text-slate-500 mt-1">Ungraded non-test attempts</p>
          </div>

          <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800/80 shadow-lg">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Flagged Exams</span>
              <span className={data.summary.flagged_exams > 0 ? 'text-rose-400' : 'text-slate-500'}>🚨</span>
            </div>
            <p className="text-3xl font-black text-white mt-2">{data.summary.flagged_exams}</p>
            <p className="text-[11px] text-slate-500 mt-1">Exams with integrity violations</p>
          </div>
        </div>

        {/* ── Needs Attention Section ──────────────────────────────────────── */}
        {data.needs_attention.length > 0 && (
          <div className="p-5 rounded-2xl bg-amber-950/20 border border-amber-500/30 space-y-3">
            <h2 className="text-xs font-bold text-amber-400 uppercase tracking-wider flex items-center gap-2">
              <span>⚠️</span> Items Needing Attention ({data.needs_attention.length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {data.needs_attention.map((item, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-xl bg-slate-950/60 border border-amber-500/20 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-white truncate">{item.exam_title}</p>
                    <p className="text-[11px] text-amber-300/80">
                      {item.type === 'ungraded_submissions' &&
                        `${Number(item.details?.count) || 0} submission(s) awaiting manual grading`}
                      {item.type === 'starting_soon_no_questions' &&
                        'Starts in < 24 hours but has 0 questions added'}
                      {item.type === 'published_code_disabled' &&
                        'Published exam but student join code is deactivated'}
                      {item.type === 'results_not_released' &&
                        'Exam has ended but grades are not yet released'}
                    </p>
                  </div>
                  <Link
                    to={`/professor/exams/${encodeURIComponent(item.exam_id)}`}
                    className="text-xs px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 font-semibold border border-amber-500/30 flex-shrink-0"
                  >
                    Open →
                  </Link>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Tabs, Search & Sort Bar ───────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
            {/* Tabs */}
            <div className="flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0">
              {(
                [
                  { id: 'all', label: 'All Active' },
                  { id: 'live', label: 'Live' },
                  { id: 'scheduled', label: 'Scheduled' },
                  { id: 'draft', label: 'Draft' },
                  { id: 'ended', label: 'Ended' },
                  { id: 'archived', label: 'Archived' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                    activeTab === tab.id
                      ? 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/40'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Search and Sort */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search exams…"
                className="bg-slate-900/80 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
              />

              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                className="bg-slate-900/80 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-indigo-500"
              >
                <option value="created_desc">Newest First</option>
                <option value="created_asc">Oldest First</option>
                <option value="title_asc">Title A-Z</option>
                <option value="schedule_asc">Schedule</option>
              </select>
            </div>
          </div>

          {/* ── Exam Cards List ───────────────────────────────────────────────── */}
          {loading ? (
            <div className="text-center py-12 text-xs text-slate-500">Loading exams…</div>
          ) : filteredExams.length === 0 ? (
            <div className="text-center py-12 bg-slate-900/40 border border-dashed border-slate-800 rounded-2xl p-6 text-slate-500 text-xs">
              No exams found matching your current filter.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {filteredExams.map((ex) => (
                <div
                  key={ex.id}
                  className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800 hover:border-slate-700 transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  <div className="space-y-2 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold text-white tracking-tight">{ex.title}</h3>
                      {ex.course_code && (
                        <span className="text-[10px] text-slate-400 bg-white/5 px-2 py-0.5 rounded border border-white/5 font-mono">
                          {ex.course_code}
                        </span>
                      )}
                      {isAdmin && ex.owner_name && (
                        <span className="text-[10px] text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20 font-medium">
                          👤 {ex.owner_name}
                        </span>
                      )}
                      {ex.archived === 1 ? (
                        <span className="text-[10px] font-semibold text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700">
                          📦 Archived
                        </span>
                      ) : ex.derived_status === 'live' ? (
                        <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30 animate-pulse">
                          ● Live
                        </span>
                      ) : ex.derived_status === 'scheduled' ? (
                        <span className="text-[10px] font-semibold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/30">
                          📅 Scheduled
                        </span>
                      ) : ex.status === 'draft' ? (
                        <span className="text-[10px] font-semibold text-slate-400 bg-white/5 px-2 py-0.5 rounded border border-white/10">
                          📝 Draft
                        </span>
                      ) : (
                        <span className="text-[10px] font-semibold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/30">
                          ✓ Ended
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
                      <span>🔑 Code: <strong className="font-mono text-indigo-300">{ex.join_code}</strong></span>
                      <span>·</span>
                      <span>⏱ {ex.duration_minutes}m</span>
                      <span>·</span>
                      <span>❓ {ex.question_count} questions</span>
                      <span>·</span>
                      <span>👥 {ex.student_count} joined</span>
                      <span>·</span>
                      <span>📥 {ex.submitted_count} submitted</span>
                      {ex.average_score !== null && (
                        <>
                          <span>·</span>
                          <span className="text-emerald-400 font-semibold">
                            Avg Score: {ex.average_score} pts
                          </span>
                        </>
                      )}
                      {ex.flagged_count > 0 && (
                        <>
                          <span>·</span>
                          <span className="text-rose-400 font-semibold">
                            🚨 {ex.flagged_count} violations
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
                    <Link
                      to={`/professor/exams/${encodeURIComponent(ex.id)}`}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-white/5 hover:bg-white/10 text-slate-200 border border-white/10 transition-colors"
                    >
                      Open / Edit
                    </Link>

                    {ex.derived_status === 'live' && (
                      <Link
                        to={`/professor/exams/${encodeURIComponent(ex.id)}/live`}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/30 transition-colors"
                      >
                        Live Monitor →
                      </Link>
                    )}

                    <a
                      href={`/api/professor/exams/${encodeURIComponent(ex.id)}/results.csv`}
                      download={`${ex.title || 'results'}.csv`}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-indigo-300 border border-slate-700 transition-colors"
                      title="Download results as CSV"
                    >
                      CSV 📥
                    </a>

                    {ex.archived === 1 ? (
                      <button
                        onClick={() => void handleUnarchive(ex.id)}
                        disabled={actionInProgress === ex.id}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        {actionInProgress === ex.id ? 'Restoring…' : 'Unarchive'}
                      </button>
                    ) : (
                      <button
                        onClick={() => void handleArchive(ex.id)}
                        disabled={actionInProgress === ex.id || ex.derived_status === 'live'}
                        title={ex.derived_status === 'live' ? 'Cannot archive a live exam' : 'Archive this exam'}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-400 border border-slate-700 transition-colors cursor-pointer disabled:opacity-40"
                      >
                        {actionInProgress === ex.id ? 'Archiving…' : 'Archive'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
