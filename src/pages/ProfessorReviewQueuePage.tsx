/**
 * src/pages/ProfessorReviewQueuePage.tsx — Cross-Exam Integrity Review Queue (Phase 6)
 * ─────────────────────────────────────────────────────────────────────────────
 * Route: /professor/review
 *
 * Requirements:
 * • Displays attempts across all exams accessible to the user (admin sees all,
 *   professor sees only their own exams).
 * • Filter by status: unreviewed, reviewed, all.
 * • Filter by review level: high, medium, low, none, unknown.
 * • Table columns: Exam, Student, Review Level, Final Risk Score, Violations,
 *   Review Decision, Time Ended, Actions.
 * • Legacy attempts with NULL violation count show level 'unknown' labeled 'Not recorded'.
 * • Links to /professor/attempts/:attemptId/report.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ProfessorNav } from '../components/ProfessorNav';

export interface ReviewQueueItem {
  id: string;
  examId: string;
  exam?: {
    id: string;
    title: string;
    course: string;
  };
  studentName: string;
  studentEmail: string;
  status: string;
  finalRiskScore: number | null;
  violationCount: number | null;
  maxSeverity: string | null;
  reviewLevel: 'unknown' | 'none' | 'low' | 'medium' | 'high';
  reviewDecision: 'no_action' | 'warning' | 'escalate' | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  endedAt: string | null;
}

export function ProfessorReviewQueuePage() {
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState<'all' | 'unreviewed' | 'reviewed'>('all');
  const [levelFilter, setLevelFilter] = useState<string>('all');

  const fetchQueue = () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (statusFilter !== 'all') params.set('status', statusFilter);
    if (levelFilter !== 'all') params.set('level', levelFilter);

    fetch(`/api/professor/review?${params.toString()}`)
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || 'Failed to load review queue');
        }
        return res.json() as Promise<{ items: ReviewQueueItem[] }>;
      })
      .then((data) => {
        setItems(data.items || []);
        setLoading(false);
      })
      .catch((e: any) => {
        setError(e.message);
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchQueue();
  }, [statusFilter, levelFilter]);

  const getLevelBadge = (level: string) => {
    switch (level) {
      case 'high':
        return {
          bg: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
          dot: 'bg-rose-500',
          label: 'High',
        };
      case 'medium':
        return {
          bg: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
          dot: 'bg-amber-500',
          label: 'Medium',
        };
      case 'low':
        return {
          bg: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
          dot: 'bg-blue-500',
          label: 'Low',
        };
      case 'none':
        return {
          bg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
          dot: 'bg-emerald-500',
          label: 'None',
        };
      default:
        return {
          bg: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
          dot: 'bg-slate-500',
          label: 'Not recorded',
        };
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans pb-16">
      <ProfessorNav />

      <div className="max-w-6xl mx-auto px-4 pt-6 space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold uppercase tracking-wider text-indigo-400">
                Evaluation Center
              </span>
              <span className="text-xs text-slate-500">• All Exams</span>
            </div>
            <h1 className="text-2xl font-black text-white">Integrity Review Queue</h1>
            <p className="text-sm text-slate-400 mt-0.5">
              Attempts flagged for potential review. Sorted by urgency level and calculated risk.
            </p>
          </div>

          <Link
            to="/professor"
            className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-semibold border border-slate-700 transition"
          >
            ← Professor Dashboard
          </Link>
        </div>

        {/* Filters */}
        <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                Status
              </label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
                className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="all">All Attempts</option>
                <option value="unreviewed">Unreviewed Only</option>
                <option value="reviewed">Reviewed Only</option>
              </select>
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block mb-1">
                Review Priority
              </label>
              <select
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
                className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
              >
                <option value="all">All Priorities</option>
                <option value="high">High Priority</option>
                <option value="medium">Medium Priority</option>
                <option value="low">Low Priority</option>
                <option value="none">None (Clean)</option>
                <option value="unknown">Not Recorded (Legacy)</option>
              </select>
            </div>
          </div>

          <div className="text-xs text-slate-400 font-semibold">
            {loading ? 'Refreshing…' : `${items.length} attempt(s) found`}
          </div>
        </div>

        {/* Queue Table */}
        <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 shadow-xl space-y-4">
          {loading ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
              Loading review queue…
            </div>
          ) : error ? (
            <div className="py-8 text-center text-rose-400 text-sm">
              <p>⚠️ {error}</p>
              <button
                onClick={fetchQueue}
                className="mt-3 px-3 py-1.5 rounded-lg bg-slate-800 text-xs text-white hover:bg-slate-700"
              >
                Retry
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-sm italic">
              No attempts currently match the selected review filters.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border border-slate-800 rounded-xl">
                <thead className="bg-slate-950 text-slate-400 font-bold uppercase tracking-wider">
                  <tr>
                    <th className="py-3 px-4">Exam</th>
                    <th className="py-3 px-4">Student</th>
                    <th className="py-3 px-4">Review Priority</th>
                    <th className="py-3 px-4">Risk Score</th>
                    <th className="py-3 px-4">Violations</th>
                    <th className="py-3 px-4">Decision</th>
                    <th className="py-3 px-4">Ended At</th>
                    <th className="py-3 px-4 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-300">
                  {items.map((it) => {
                    const badge = getLevelBadge(it.reviewLevel);
                    return (
                      <tr key={it.id} className="hover:bg-slate-800/40 transition">
                        <td className="py-3 px-4">
                          <span className="font-semibold text-white block">
                            {it.exam?.title || 'Exam'}
                          </span>
                          {it.exam?.course && (
                            <span className="text-[11px] text-slate-500">{it.exam.course}</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          <span className="font-semibold text-white block">{it.studentName}</span>
                          <span className="text-[11px] text-slate-500">{it.studentEmail || it.id}</span>
                        </td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded border text-[11px] font-bold inline-flex items-center gap-1.5 ${badge.bg}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${badge.dot}`} />
                            {badge.label}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-mono font-bold text-slate-200">
                          {it.finalRiskScore !== null ? `${it.finalRiskScore}` : '—'}
                        </td>
                        <td className="py-3 px-4 text-slate-400">
                          {it.violationCount !== null ? (
                            <span>
                              {it.violationCount}
                              {it.maxSeverity && (
                                <span className="ml-1 text-[10px] uppercase font-semibold text-slate-500">
                                  ({it.maxSeverity})
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="italic text-slate-500">Not recorded</span>
                          )}
                        </td>
                        <td className="py-3 px-4">
                          {it.reviewDecision ? (
                            <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold uppercase">
                              ✓ {it.reviewDecision.replace('_', ' ')}
                            </span>
                          ) : (
                            <span className="text-slate-500 text-[11px] italic">Pending</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-400 font-mono">
                          {it.endedAt ? new Date(it.endedAt).toLocaleDateString() : '—'}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <Link
                            to={`/professor/attempts/${it.id}/report`}
                            className="px-2.5 py-1 rounded bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/40 text-[11px] font-bold transition inline-block"
                          >
                            Open Report →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
