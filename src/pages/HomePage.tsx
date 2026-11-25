/**
 * src/pages/HomePage.tsx — Landing Page (Phase 5c)
 * ─────────────────────────────────────────────────────────────────────────────
 * App overview, "How It Works" for students and professors, and auth actions.
 * If user is already logged in, automatically redirects to role home (/student or /professor).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function HomePage() {
  const { user, loading } = useAuth();

  // Redirect authenticated users to their respective role homes
  if (!loading && user) {
    if (user.role === 'student') {
      return <Navigate to="/student" replace />;
    }
    if (user.role === 'admin') {
      return <Navigate to="/admin" replace />;
    }
    return <Navigate to="/professor" replace />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-indigo-500 selection:text-white">
      {/* Top Header */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex items-center justify-center text-xl shadow-lg shadow-indigo-600/10">
            🛡️
          </div>
          <div>
            <span className="font-bold text-white tracking-tight text-base sm:text-lg block">
              Autonomous Proctoring Agent
            </span>
            <span className="text-[10px] text-indigo-400 font-medium block -mt-0.5">
              Next-Gen Assessment Integrity
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link
            to="/login"
            className="px-4 py-2 rounded-xl text-xs font-bold bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-all"
          >
            Sign In
          </Link>
          <Link
            to="/signup"
            className="px-4 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all"
          >
            Student Sign Up
          </Link>
        </div>
      </header>

      {/* Hero Section */}
      <main className="max-w-5xl mx-auto px-6 py-16 flex flex-col items-center justify-center flex-1 space-y-16">
        <div className="text-center max-w-3xl space-y-6">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-indigo-950/70 border border-indigo-800/60 text-indigo-300 text-xs font-semibold uppercase tracking-wider">
            <span>⚡</span> Edge AI · Real-Time Computer Vision · Cloudflare Durable Objects
          </div>

          <h1 className="text-4xl sm:text-6xl font-extrabold text-white tracking-tight leading-tight">
            Integrity-First Autonomous Exam Proctoring
          </h1>

          <p className="text-slate-400 text-base sm:text-lg max-w-2xl mx-auto leading-relaxed">
            Scalable, privacy-preserving remote exam proctoring with client-side face verification,
            behavioral anomaly detection, and automated grading.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center pt-2 max-w-md mx-auto">
            <Link
              to="/login"
              className="w-full py-3.5 px-6 rounded-xl text-xs sm:text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-xl shadow-indigo-600/40 transition-all text-center"
            >
              Sign In to Portal →
            </Link>
            <Link
              to="/signup"
              className="w-full py-3.5 px-6 rounded-xl text-xs sm:text-sm font-bold bg-slate-800 hover:bg-slate-700 text-white border border-slate-700 shadow-lg transition-all text-center"
            >
              Create Student Account
            </Link>
          </div>
        </div>

        {/* ── How It Works Grid ──────────────────────────────────────────────── */}
        <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-8 pt-6">
          {/* For Students */}
          <div className="p-8 rounded-3xl bg-slate-900/60 border border-slate-800/80 shadow-xl space-y-5">
            <div className="flex items-center gap-3">
              <span className="text-2xl p-2.5 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                🎓
              </span>
              <div>
                <h2 className="text-lg font-bold text-white">How It Works for Students</h2>
                <p className="text-xs text-slate-400">Frictionless, privacy-preserving testing</p>
              </div>
            </div>

            <ol className="space-y-3.5 text-xs text-slate-300">
              <li className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 font-bold flex items-center justify-center text-[10px]">
                  1
                </span>
                <span>
                  <strong>Sign in & consent:</strong> Log in and review the plain-language privacy policy explaining edge AI processing and temporary retention.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 font-bold flex items-center justify-center text-[10px]">
                  2
                </span>
                <span>
                  <strong>Join by code:</strong> Enter your 8-character exam code to enroll and access the pre-flight readiness lobby.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 font-bold flex items-center justify-center text-[10px]">
                  3
                </span>
                <span>
                  <strong>Pre-flight system check:</strong> Test camera stream, fullscreen lock, and network latency before the timer begins.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 font-bold flex items-center justify-center text-[10px]">
                  4
                </span>
                <span>
                  <strong>Continuous autosave & results:</strong> Progress is synchronized in real time. Submit to receive instant scoring or released feedback.
                </span>
              </li>
            </ol>
          </div>

          {/* For Professors */}
          <div className="p-8 rounded-3xl bg-slate-900/60 border border-slate-800/80 shadow-xl space-y-5">
            <div className="flex items-center gap-3">
              <span className="text-2xl p-2.5 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
                👩‍🏫
              </span>
              <div>
                <h2 className="text-lg font-bold text-white">How It Works for Professors</h2>
                <p className="text-xs text-slate-400">Complete assessment control & integrity insights</p>
              </div>
            </div>

            <ol className="space-y-3.5 text-xs text-slate-300">
              <li className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 font-bold flex items-center justify-center text-[10px]">
                  1
                </span>
                <span>
                  <strong>Create & configure:</strong> Build multi-type question exams (multiple choice, code, short answer) with custom strictness and schedules.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 font-bold flex items-center justify-center text-[10px]">
                  2
                </span>
                <span>
                  <strong>Live monitor hub:</strong> Observe live candidate tiles, pause or warn students, and track high-severity violations in real time.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 font-bold flex items-center justify-center text-[10px]">
                  3
                </span>
                <span>
                  <strong>AI-assisted grading:</strong> Grade subjective answers with AI rubric suggestions, apply curve overrides, and release finalized results.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-600/20 text-indigo-400 font-bold flex items-center justify-center text-[10px]">
                  4
                </span>
                <span>
                  <strong>Analytics & CSV export:</strong> View score distributions, review auto-graded accuracy, archive ended exams, and export CSVs.
                </span>
              </li>
            </ol>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/60 py-6 text-center text-xs text-slate-500">
        Autonomous Proctoring Agent · Cloudflare Workers AI · Durable Objects · WebSockets
      </footer>
    </div>
  );
}
