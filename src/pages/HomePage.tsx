/**
 * src/pages/HomePage.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Minimal landing page with Login & Signup links (Phase 5a).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function HomePage() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between">
      {/* Top bar */}
      <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🛡️</span>
          <span className="font-bold text-white tracking-tight">Autonomous Proctoring Agent</span>
        </div>
        <div className="flex items-center gap-3">
          {user ? (
            <div className="flex items-center gap-4">
              <span className="text-sm text-slate-400">
                Signed in as <strong className="text-white">{user.name}</strong> ({user.role})
              </span>
              <Link
                to={user.role === 'student' ? '/student' : '/professor/exams'}
                className="px-4 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all"
              >
                Go to Dashboard
              </Link>
              <button
                onClick={() => void logout()}
                className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-all"
              >
                Sign Out
              </button>
            </div>
          ) : (
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
                Create Account
              </Link>
            </div>
          )}
        </div>
      </header>

      {/* Hero content */}
      <main className="max-w-4xl mx-auto px-6 py-20 text-center flex flex-col items-center justify-center flex-1">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-indigo-950/70 border border-indigo-800/60 text-indigo-300 text-xs font-semibold uppercase tracking-wider mb-8">
          <span>⚡</span> Next-Gen Autonomous Exam Proctoring
        </div>

        <h1 className="text-5xl sm:text-6xl font-extrabold text-white tracking-tight leading-tight mb-6">
          Integrity-First Remote Assessments
        </h1>

        <p className="text-slate-400 text-lg sm:text-xl max-w-2xl mb-10 leading-relaxed">
          AI-driven real-time computer vision, audio monitoring, and behavioral tracking
          built with Cloudflare Durable Objects.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center w-full max-w-md">
          {user ? (
            <Link
              to={user.role === 'student' ? '/student' : '/professor/exams'}
              className="w-full py-4 px-6 rounded-xl text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-xl shadow-indigo-600/40 transition-all"
            >
              Open Your Portal ({user.role})
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="w-full py-4 px-6 rounded-xl text-sm font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-xl shadow-indigo-600/40 transition-all"
              >
                Sign In to Start
              </Link>
              <Link
                to="/signup"
                className="w-full py-4 px-6 rounded-xl text-sm font-bold bg-slate-800/90 hover:bg-slate-700 text-white border border-slate-700 shadow-lg transition-all"
              >
                Student Sign Up
              </Link>
            </>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/60 py-6 text-center text-xs text-slate-500">
        Autonomous Proctoring Agent &bull; Powered by Cloudflare Workers & Durable Objects
      </footer>
    </div>
  );
}
