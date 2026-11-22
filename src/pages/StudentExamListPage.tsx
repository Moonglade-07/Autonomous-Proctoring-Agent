/**
 * src/pages/StudentExamListPage.tsx — Student Exam Portal & Join by Code (Phase 4c-1 & 5a)
 *
 * Route: /student
 *
 * Features:
 *   • Bound to authenticated student account (name & ID from AuthContext)
 *   • "Enter exam code" input (XXXX-XXXX format supported, auto-capitalizes)
 *   • "Join Exam" button calling POST /api/student/join { code }
 *   • On successful join, navigates to /student/lobby/:examId
 *   • Anti-probing compliant error display
 *   • Rate limit (HTTP 429) friendly error display
 *   • "My Exams" list populated via GET /api/student/my-exams
 *   • Shows logged-in user and Sign Out button
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import type { MyExamEntry } from '../types';

function formatDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function StudentExamListPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, logout } = useAuth();

  const [code, setCode] = useState(
    () => searchParams.get('code') || '',
  );

  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');

  // My Exams state
  const [myExams, setMyExams] = useState<MyExamEntry[]>([]);
  const [loadingMyExams, setLoadingMyExams] = useState(false);

  // Fetch enrolled exams for this student
  const loadMyExams = useCallback(async () => {
    setLoadingMyExams(true);
    try {
      const res = await fetch('/api/student/my-exams');
      if (res.ok) {
        const data = (await res.json()) as { exams: MyExamEntry[] };
        setMyExams(data.exams || []);
      }
    } catch { }
    finally {
      setLoadingMyExams(false);
    }
  }, []);

  useEffect(() => {
    void loadMyExams();
  }, [loadMyExams]);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    const cleanCode = code.trim();

    if (!cleanCode) {
      setJoinError('Please enter an exam code');
      return;
    }

    setJoining(true);
    setJoinError('');

    try {
      const res = await fetch('/api/student/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: cleanCode,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };

      if (!res.ok) {
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
      setJoining(false);
    }
  }

  function getAttemptStatusBadge(exam: MyExamEntry) {
    if (exam.result_status === 'result_available') {
      return (
        <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
          ✓ Result Available: {exam.score !== null ? `${exam.score}/${exam.max_score}` : 'Ready'}
        </span>
      );
    }
    if (exam.result_status === 'being_graded') {
      return (
        <span className="text-[11px] font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30">
          ⏳ Being Graded
        </span>
      );
    }
    if (exam.result_status === 'submitted_pending_release') {
      return (
        <span className="text-[11px] font-semibold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/30">
          📥 Submitted — Awaiting Results
        </span>
      );
    }
    if (exam.attempt_status === 'submitted') {
      return (
        <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
          ✓ Completed ({exam.score !== null ? `${exam.score}/${exam.max_score}` : 'Submitted'})
        </span>
      );
    }
    if (exam.attempt_status === 'auto_submitted') {
      return (
        <span className="text-[11px] font-semibold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/30">
          ✓ Auto-Submitted ({exam.score !== null ? `${exam.score}/${exam.max_score}` : 'Submitted'})
        </span>
      );
    }
    if (exam.attempt_status === 'terminated') {
      return (
        <span className="text-[11px] font-semibold text-red-400 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/30">
          🛑 Terminated
        </span>
      );
    }
    if (exam.attempt_status === 'in_progress') {
      return (
        <span className="text-[11px] font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/30 animate-pulse">
          ⏳ In Progress
        </span>
      );
    }
    return (
      <span className="text-[11px] font-semibold text-gray-400 bg-white/5 px-2 py-0.5 rounded border border-white/10">
        Ready to start
      </span>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white font-sans flex flex-col">
      {/* Header */}
      <header className="border-b border-white/[0.08] bg-gray-900/60 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-lg">
              🎓
            </div>
            <div>
              <h1 className="text-sm font-bold text-white">Student Exam Portal</h1>
              <p className="text-[11px] text-gray-400">Autonomous Proctoring System</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {user && (
              <span className="text-xs text-slate-400 hidden sm:inline">
                Signed in as <strong className="text-white">{user.name}</strong>
                {user.student_id ? ` (${user.student_id})` : ''}
              </span>
            )}
            <button
              onClick={() => void logout()}
              className="text-xs px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-2xl mx-auto px-6 py-10 w-full space-y-10">
        {/* Join by Code Card */}
        <div className="bg-gray-900/80 border border-white/10 rounded-2xl p-6 sm:p-8 shadow-2xl">
          <div className="text-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-2xl mx-auto mb-3 shadow-inner">
              🔑
            </div>
            <h2 className="text-xl font-bold text-white">Join an Exam</h2>
            <p className="text-xs sm:text-sm text-gray-400 mt-1">
              Enter the 8-character exam code provided by your instructor.
            </p>
          </div>

          {joinError && (
            <div className="mb-5 p-3.5 rounded-xl bg-red-950/40 border border-red-500/40 text-red-300 text-xs text-center font-medium">
              ⚠️ {joinError}
            </div>
          )}

          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="text-[11px] font-bold text-gray-400 uppercase tracking-wider block mb-1.5">
                Exam Access Code *
              </label>
              <input
                id="exam-code-input"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. HKP4-7QWM"
                required
                maxLength={10}
                className="w-full bg-gray-800/80 border border-white/10 rounded-xl px-4 py-3 text-base text-center font-mono font-bold tracking-widest text-indigo-300 placeholder-gray-600 focus:outline-none focus:border-indigo-500 transition-colors uppercase"
              />
              <p className="text-[11px] text-gray-500 mt-1">
                Hyphens and spaces are optional. Case does not matter.
              </p>
            </div>

            <button
              id="join-exam-btn"
              type="submit"
              disabled={joining}
              className="w-full py-3.5 rounded-xl text-sm font-bold bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white shadow-lg shadow-indigo-900/40 transition-all cursor-pointer active:scale-[0.98] disabled:opacity-50"
            >
              {joining ? 'Joining Exam…' : 'Join Exam Lobby →'}
            </button>
          </form>
        </div>

        {/* My Exams Section */}
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-white/10 pb-3">
            <h3 className="text-sm font-bold text-gray-300 uppercase tracking-wider">
              📚 My Joined Exams
            </h3>
            <span className="text-xs text-gray-500">
              {myExams.length} enrolled
            </span>
          </div>

          {loadingMyExams ? (
            <div className="text-center py-6 text-xs text-gray-500">Loading your exams…</div>
          ) : myExams.length === 0 ? (
            <div className="text-center py-8 bg-gray-900/40 border border-dashed border-white/10 rounded-2xl p-6 text-gray-500 text-xs">
              You haven't joined any exams yet. Enter an exam code above to join.
            </div>
          ) : (
            <div className="space-y-3">
              {myExams.map((ex) => (
                <div
                  key={ex.id}
                  className="p-4 rounded-xl bg-gray-900/70 border border-white/10 flex items-center justify-between gap-4 hover:border-white/20 transition-colors"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{ex.title}</span>
                      {ex.course_code && (
                        <span className="text-[10px] text-gray-400 bg-white/5 px-2 py-0.5 rounded border border-white/5">
                          {ex.course_code}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
                      <span>⏱ {formatDuration(ex.duration_minutes)}</span>
                      <span>·</span>
                      {getAttemptStatusBadge(ex)}
                    </div>
                  </div>

                  <div>
                    {ex.attempt_status === 'submitted' || ex.attempt_status === 'auto_submitted' || ex.attempt_status === 'terminated' ? (
                      <Link
                        to={`/student/result/${encodeURIComponent(ex.id)}`}
                        className="px-3.5 py-2 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-semibold text-gray-200 border border-white/10 transition-colors inline-block"
                      >
                        View Result →
                      </Link>
                    ) : (
                      <Link
                        to={`/student/lobby/${encodeURIComponent(ex.id)}`}
                        className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-bold text-white shadow-md shadow-indigo-900/40 transition-colors inline-block"
                      >
                        Go to Lobby →
                      </Link>
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
