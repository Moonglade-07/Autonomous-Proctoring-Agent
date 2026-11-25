/**
 * src/pages/AdminOverviewPage.tsx — Admin Overview Dashboard (Phase 7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time platform metrics, role distribution, attention counters,
 * and scheduled cron job execution health checks.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

interface OverviewData {
  users: {
    total: number;
    students: { active: number; inactive: number };
    professors: { active: number; inactive: number };
    admins: { active: number; inactive: number };
  };
  exams: {
    draft: number;
    scheduled: number;
    active: number;
    completed: number;
    closed: number;
    archived: number;
    total: number;
  };
  attempts: {
    started_last_24h: number;
    started_last_7d: number;
    in_progress_now: number;
    needs_grading: number;
    unreviewed_flagged: number;
  };
  cron_runs: Array<{
    job: string;
    last_run_at: string | null;
    last_ok: number;
    last_count: number;
    last_error: string | null;
    age_seconds: number | null;
  }>;
}

export function AdminOverviewPage() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchOverview = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/admin/overview');
      if (!res.ok) {
        throw new Error(`Failed to load admin overview (HTTP ${res.status})`);
      }
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err?.message || 'Failed to fetch overview data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchOverview();
  }, []);

  function formatRelativeAge(seconds: number | null): string {
    if (seconds === null || seconds === undefined) return 'Never executed';
    if (seconds < 10) return 'Just now';
    if (seconds < 60) return `${seconds} seconds ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  function isCronStale(job: string, ageSeconds: number | null, lastOk: number): boolean {
    if (lastOk !== 1) return true;
    if (ageSeconds === null) return true;
    if (job === 'auto_end_sweep') {
      // 5 minutes threshold for every-minute job
      return ageSeconds > 300;
    }
    if (job === 'retention_sweep') {
      // 26 hours threshold for daily job
      return ageSeconds > 93600;
    }
    return false;
  }

  function formatJobTitle(job: string): string {
    if (job === 'auto_end_sweep') return 'Auto-End Expiration Sweep (Every Minute)';
    if (job === 'retention_sweep') return 'Daily Retention & Evidence Purge (3:00 AM UTC)';
    return job;
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-slate-400">
        <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin mb-4" />
        <span className="text-xs uppercase tracking-widest font-semibold">Loading platform overview...</span>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 rounded-2xl bg-red-950/40 border border-red-800/60 text-red-200">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-sm">Error Loading Overview</span>
          <button
            onClick={() => void fetchOverview()}
            className="text-xs px-3 py-1 bg-red-900/60 hover:bg-red-800 rounded-lg text-white font-medium"
          >
            Retry
          </button>
        </div>
        <p className="text-xs text-red-300 mt-2">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <span>🛡️</span> Platform Overview
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Real-time status of users, exams, student attempts, and automated background jobs.
          </p>
        </div>
        <button
          onClick={() => void fetchOverview()}
          className="self-start sm:self-auto px-3.5 py-1.5 rounded-xl text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-700/80 transition-all flex items-center gap-2"
        >
          <span>🔄</span> Refresh Data
        </button>
      </div>

      {/* Top Level Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Users Card */}
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800/80 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-400 mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider">User Accounts</span>
            <span className="text-lg">👥</span>
          </div>
          <div className="text-3xl font-extrabold text-white mb-3">{data.users.total}</div>
          <div className="space-y-1 text-xs text-slate-400 border-t border-slate-800/60 pt-3">
            <div className="flex justify-between">
              <span>Students:</span>
              <span className="font-medium text-slate-200">
                {data.users.students.active} active
                {data.users.students.inactive > 0 && ` (${data.users.students.inactive} inactive)`}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Professors:</span>
              <span className="font-medium text-slate-200">
                {data.users.professors.active} active
                {data.users.professors.inactive > 0 && ` (${data.users.professors.inactive} inactive)`}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Administrators:</span>
              <span className="font-medium text-red-400 font-semibold">{data.users.admins.active}</span>
            </div>
          </div>
        </div>

        {/* Exams Card */}
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800/80 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-400 mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider">Total Exams</span>
            <span className="text-lg">📋</span>
          </div>
          <div className="text-3xl font-extrabold text-white mb-3">{data.exams.total}</div>
          <div className="space-y-1 text-xs text-slate-400 border-t border-slate-800/60 pt-3">
            <div className="flex justify-between">
              <span>Active Now:</span>
              <span className="font-medium text-emerald-400">{data.exams.active}</span>
            </div>
            <div className="flex justify-between">
              <span>Draft / Scheduled:</span>
              <span className="font-medium text-slate-200">{data.exams.draft + data.exams.scheduled}</span>
            </div>
            <div className="flex justify-between">
              <span>Completed / Closed:</span>
              <span className="font-medium text-slate-200">{data.exams.completed + data.exams.closed}</span>
            </div>
          </div>
        </div>

        {/* Exam Activity Card */}
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800/80 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-400 mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider">Student Activity</span>
            <span className="text-lg">⚡</span>
          </div>
          <div className="text-3xl font-extrabold text-indigo-400 mb-3">{data.attempts.in_progress_now}</div>
          <div className="space-y-1 text-xs text-slate-400 border-t border-slate-800/60 pt-3">
            <div className="flex justify-between">
              <span>In-Progress Right Now:</span>
              <span className="font-medium text-indigo-300 font-semibold">{data.attempts.in_progress_now}</span>
            </div>
            <div className="flex justify-between">
              <span>Started Last 24 Hours:</span>
              <span className="font-medium text-slate-200">{data.attempts.started_last_24h}</span>
            </div>
            <div className="flex justify-between">
              <span>Started Last 7 Days:</span>
              <span className="font-medium text-slate-200">{data.attempts.started_last_7d}</span>
            </div>
          </div>
        </div>

        {/* Attention Items Card */}
        <div className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800/80 flex flex-col justify-between">
          <div className="flex items-center justify-between text-slate-400 mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider">Attention Needed</span>
            <span className="text-lg">⚠️</span>
          </div>
          <div className="text-3xl font-extrabold text-amber-400 mb-3">
            {data.attempts.needs_grading + data.attempts.unreviewed_flagged}
          </div>
          <div className="space-y-2 text-xs text-slate-400 border-t border-slate-800/60 pt-3">
            <div className="flex items-center justify-between">
              <span>Unreviewed Flags:</span>
              <Link
                to="/professor/review"
                className="font-semibold text-rose-400 hover:text-rose-300 transition-colors"
              >
                {data.attempts.unreviewed_flagged} flagged &rarr;
              </Link>
            </div>
            <div className="flex items-center justify-between">
              <span>Needs Manual Grading:</span>
              <Link
                to="/admin/exams"
                className="font-semibold text-amber-400 hover:text-amber-300 transition-colors"
              >
                {data.attempts.needs_grading} pending &rarr;
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Scheduled Cron Health Section */}
      <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-6">
          <div>
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <span>⚙️</span> Automated Background Jobs Health
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Cloudflare Workers cron sweeps execution logs, latency status, and error states.
            </p>
          </div>
        </div>

        {data.cron_runs.length === 0 ? (
          <div className="p-6 rounded-xl bg-slate-950/60 border border-slate-800 text-center text-xs text-slate-400">
            No scheduled runs recorded in D1 yet. Jobs run automatically according to the Worker cron schedule.
          </div>
        ) : (
          <div className="space-y-4">
            {data.cron_runs.map((cr) => {
              const stale = isCronStale(cr.job, cr.age_seconds, cr.last_ok);
              return (
                <div
                  key={cr.job}
                  className={`p-4 rounded-xl border transition-all ${
                    stale
                      ? 'bg-rose-950/20 border-rose-800/60'
                      : 'bg-slate-950/60 border-slate-800/80'
                  }`}
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-white">{formatJobTitle(cr.job)}</span>
                        <span
                          className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                            stale
                              ? 'bg-rose-900/80 text-rose-300 border border-rose-700'
                              : 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/60'
                          }`}
                        >
                          {stale ? '⚠️ ATTENTION / STALE' : '✅ HEALTHY'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400">
                        Last ran: <span className="text-slate-300 font-medium">{formatRelativeAge(cr.age_seconds)}</span>
                        {cr.last_run_at && (
                          <span className="text-slate-500 text-[11px] ml-2">({cr.last_run_at})</span>
                        )}
                      </p>
                    </div>

                    <div className="flex items-center gap-4 text-xs">
                      <div className="text-right">
                        <span className="text-slate-400 block text-[11px]">Items Processed</span>
                        <span className="font-bold text-white text-sm">{cr.last_count}</span>
                      </div>
                    </div>
                  </div>

                  {cr.last_error && (
                    <div className="mt-3 p-3 rounded-lg bg-rose-950/60 border border-rose-900/50 text-xs text-rose-300">
                      <span className="font-semibold block mb-0.5">Last Error:</span>
                      <span className="font-mono text-[11px]">{cr.last_error}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
