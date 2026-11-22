/**
 * src/pages/StudentExamListPage.tsx — Student Home & Exam Portal (Phase 5c)
 * ─────────────────────────────────────────────────────────────────────────────
 * Route: /student
 *
 * Requirements:
 * • Join card: exam code input (case, spaces, and hyphens ignored).
 *   Errors shown ONLY after a failed attempt and cleared when user edits the field.
 * • Privacy Consent Modal: shown before first join if privacy not accepted yet.
 * • Three categorized exam sections populated via GET /api/student/home:
 *   1. "In Progress" with a Continue button
 *   2. "Upcoming and Joined Exams" with countdown and "Enter lobby" button once window opens
 *   3. "Past Exams" with score, percentage, date, and status chips (Submitted, Being graded, Result available).
 * • "View Result" links directly to /student/result/:id.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { StudentNav } from '../components/StudentNav';
import { PrivacyConsentModal } from '../components/PrivacyConsentModal';

interface InProgressExam {
  id: string;
  title: string;
  course_code: string;
  duration_minutes: number;
  attempt_id: string;
  started_at: string;
}

interface UpcomingExam {
  id: string;
  title: string;
  course_code: string;
  duration_minutes: number;
  start_time: string | null;
  end_time: string | null;
  derived_status: 'scheduled' | 'live' | 'ended';
  is_open: boolean;
}

interface PastExam {
  id: string;
  title: string;
  course_code: string;
  duration_minutes: number;
  attempt_id: string;
  attempt_status: string;
  score: number | null;
  max_score: number | null;
  percentage: number | null;
  result_status: 'result_available' | 'being_graded' | 'submitted_pending_release';
  submitted_at: string | null;
}

interface HomeData {
  in_progress: InProgressExam[];
  upcoming: UpcomingExam[];
  past: PastExam[];
}

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatCountdown(targetIso: string): string {
  const diffMs = new Date(targetIso).getTime() - Date.now();
  if (diffMs <= 0) return 'Window is Open!';
  const totalSecs = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSecs / 86400);
  const hours = Math.floor((totalSecs % 86400) / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  if (days > 0) return `Starts in ${days}d ${hours}h`;
  if (hours > 0) return `Starts in ${hours}h ${mins}m`;
  return `Starts in ${mins}m`;
}

export function StudentExamListPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();

  const [code, setCode] = useState(() => searchParams.get('code') || '');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');

  // Dashboard data state
  const [homeData, setHomeData] = useState<HomeData>({
    in_progress: [],
    upcoming: [],
    past: [],
  });
  const [loading, setLoading] = useState(true);

  // Privacy Consent Modal state
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(null);

  const loadHomeData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/student/home');
      if (res.ok) {
        const data = (await res.json()) as HomeData;
        setHomeData({
          in_progress: data.in_progress || [],
          upcoming: data.upcoming || [],
          past: data.past || [],
        });
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadHomeData();
  }, [loadHomeData]);

  // Code input change handler: clears error banner on edit
  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCode(e.target.value);
    if (joinError) {
      setJoinError('');
    }
  };

  const executeJoin = async (cleanCode: string) => {
    setJoining(true);
    setJoinError('');

    try {
      const res = await fetch('/api/student/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: cleanCode }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
        code?: string;
      };

      if (!res.ok) {
        if (res.status === 403 && data.code === 'privacy_required') {
          setPendingJoinCode(cleanCode);
          setShowPrivacyModal(true);
          setJoining(false);
          return;
        }
        if (res.status === 429) {
          throw new Error('Too many failed join attempts. Please wait a few minutes before trying again.');
        }
        throw new Error(data.error || 'Invalid or inactive code');
      }

      if (data.id) {
        navigate(`/student/lobby/${data.id}`);
      }
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Invalid or inactive code');
    } finally {
      setJoining(false);
    }
  };

  const handleJoinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = code.replace(/[\s-]/g, '').trim().toUpperCase();

    if (!cleanCode) {
      setJoinError('Please enter an exam code.');
      return;
    }

    // Check if student has accepted privacy notice
    if (!user?.privacy_accepted) {
      setPendingJoinCode(cleanCode);
      setShowPrivacyModal(true);
      return;
    }

    await executeJoin(cleanCode);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <StudentNav />

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8 w-full flex-1 space-y-10">
        {/* ── Join Exam Card ─────────────────────────────────────────────────── */}
        <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-6 sm:p-8 shadow-2xl relative overflow-hidden">
          <div className="text-center max-w-md mx-auto mb-6">
            <div className="w-12 h-12 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-xl mx-auto mb-3 shadow-inner">
              🔑
            </div>
            <h1 className="text-xl font-bold text-white tracking-tight">Join an Exam</h1>
            <p className="text-xs text-slate-400 mt-1">
              Enter the access code provided by your instructor to join the exam lobby.
            </p>
          </div>

          {joinError && (
            <div className="max-w-md mx-auto mb-5 p-3 rounded-xl bg-rose-950/40 border border-rose-500/40 text-rose-300 text-xs text-center font-medium">
              ⚠️ {joinError}
            </div>
          )}

          <form onSubmit={handleJoinSubmit} className="max-w-md mx-auto space-y-4">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5 text-center">
                Exam Access Code
              </label>
              <input
                id="exam-code-input"
                type="text"
                value={code}
                onChange={handleCodeChange}
                placeholder="e.g. HKP4-7QWM"
                required
                maxLength={12}
                className="w-full bg-slate-800/80 border border-slate-700/80 rounded-xl px-4 py-3 text-lg text-center font-mono font-bold tracking-widest text-indigo-300 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors uppercase"
              />
              <p className="text-[11px] text-slate-500 mt-1.5 text-center">
                Hyphens and spaces are optional. Case does not matter.
              </p>
            </div>

            <button
              id="join-exam-btn"
              type="submit"
              disabled={joining}
              className="w-full py-3.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all cursor-pointer disabled:opacity-50"
            >
              {joining ? 'Connecting to Exam…' : 'Join Exam Lobby →'}
            </button>
          </form>
        </div>

        {/* ── Section 1: In Progress ────────────────────────────────────────── */}
        {homeData.in_progress.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center gap-2 border-b border-amber-500/30 pb-2">
              <span className="text-base animate-pulse">⏳</span>
              <h2 className="text-sm font-bold text-amber-400 uppercase tracking-wider">
                Exams In Progress
              </h2>
            </div>
            <div className="grid grid-cols-1 gap-3">
              {homeData.in_progress.map((ex) => (
                <div
                  key={ex.id}
                  className="p-5 rounded-2xl bg-amber-950/20 border border-amber-500/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-bold text-white">{ex.title}</h3>
                      {ex.course_code && (
                        <span className="text-[10px] text-amber-300 bg-amber-500/20 px-2 py-0.5 rounded font-mono">
                          {ex.course_code}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-amber-200/80 mt-1">
                      Started: {new Date(ex.started_at).toLocaleTimeString()} · Duration: {formatDuration(ex.duration_minutes)}
                    </p>
                  </div>
                  <Link
                    to={`/student/exam/${encodeURIComponent(ex.id)}`}
                    className="px-5 py-2.5 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-md shadow-amber-500/20 transition-all text-center inline-block"
                  >
                    Continue Exam →
                  </Link>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Section 2: Upcoming and Joined Exams ──────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <div className="flex items-center gap-2">
              <span>📅</span>
              <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
                Upcoming & Joined Exams
              </h2>
            </div>
            <span className="text-xs text-slate-500">{homeData.upcoming.length} active</span>
          </div>

          {loading ? (
            <div className="text-center py-6 text-xs text-slate-500">Loading your scheduled exams…</div>
          ) : homeData.upcoming.length === 0 ? (
            <div className="text-center py-6 bg-slate-900/40 border border-dashed border-slate-800 rounded-2xl p-6 text-slate-500 text-xs">
              No upcoming exams currently scheduled. Enter a join code above to enroll.
            </div>
          ) : (
            <div className="space-y-3">
              {homeData.upcoming.map((ex) => (
                <div
                  key={ex.id}
                  className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-slate-700 transition-colors"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-white">{ex.title}</h3>
                      {ex.course_code && (
                        <span className="text-[10px] text-slate-400 bg-white/5 px-2 py-0.5 rounded border border-white/5 font-mono">
                          {ex.course_code}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-400">
                      <span>⏱ {formatDuration(ex.duration_minutes)}</span>
                      {ex.start_time && (
                        <>
                          <span>·</span>
                          <span className={ex.is_open ? 'text-emerald-400 font-semibold' : 'text-slate-400'}>
                            {formatCountdown(ex.start_time)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div>
                    <Link
                      to={`/student/lobby/${encodeURIComponent(ex.id)}`}
                      className={`px-4 py-2 rounded-xl text-xs font-bold transition-all inline-block ${
                        ex.is_open
                          ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/30'
                          : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/30'
                      }`}
                    >
                      {ex.is_open ? 'Enter Lobby →' : 'View Lobby & Readiness →'}
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Section 3: Past Exams ─────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <div className="flex items-center gap-2">
              <span>📚</span>
              <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
                Past Exams
              </h2>
            </div>
            <span className="text-xs text-slate-500">{homeData.past.length} completed</span>
          </div>

          {loading ? (
            <div className="text-center py-6 text-xs text-slate-500">Loading past results…</div>
          ) : homeData.past.length === 0 ? (
            <div className="text-center py-6 bg-slate-900/40 border border-dashed border-slate-800 rounded-2xl p-6 text-slate-500 text-xs">
              No completed exams yet.
            </div>
          ) : (
            <div className="space-y-3">
              {homeData.past.map((ex) => (
                <div
                  key={ex.id}
                  className="p-4 rounded-xl bg-slate-900/70 border border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4 hover:border-slate-700 transition-colors"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-white">{ex.title}</h3>
                      {ex.course_code && (
                        <span className="text-[10px] text-slate-400 bg-white/5 px-2 py-0.5 rounded border border-white/5 font-mono">
                          {ex.course_code}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-slate-400">
                      {ex.submitted_at && (
                        <span>Submitted {new Date(ex.submitted_at).toLocaleDateString()}</span>
                      )}
                      <span>·</span>
                      {ex.result_status === 'result_available' ? (
                        <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                          ✓ Result Available ({ex.score !== null ? `${ex.score}/${ex.max_score}` : 'Ready'}
                          {ex.percentage !== null ? ` · ${ex.percentage}%` : ''})
                        </span>
                      ) : ex.result_status === 'being_graded' ? (
                        <span className="text-[11px] font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30">
                          ⏳ Being Graded
                        </span>
                      ) : (
                        <span className="text-[11px] font-semibold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/30">
                          📥 Submitted — Awaiting Release
                        </span>
                      )}
                    </div>
                  </div>

                  <div>
                    <Link
                      to={`/student/result/${encodeURIComponent(ex.id)}`}
                      className="px-3.5 py-2 rounded-xl bg-white/5 hover:bg-white/10 text-xs font-semibold text-slate-200 border border-white/10 transition-colors inline-block"
                    >
                      View Result →
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>

      {/* ── Privacy Notice Consent Modal ────────────────────────────────────── */}
      <PrivacyConsentModal
        isOpen={showPrivacyModal}
        onConsentSuccess={async () => {
          setShowPrivacyModal(false);
          if (pendingJoinCode) {
            const nextCode = pendingJoinCode;
            setPendingJoinCode(null);
            await executeJoin(nextCode);
          }
        }}
        onCancel={() => {
          setShowPrivacyModal(false);
          setPendingJoinCode(null);
        }}
      />
    </div>
  );
}
