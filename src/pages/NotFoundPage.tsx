/**
 * src/pages/NotFoundPage.tsx — 404 Not Found Page (Phase 5c)
 * ─────────────────────────────────────────────────────────────────────────────
 * Clean 404 page for unknown routes.
 * Role-aware navigation: never shows a link to /professor for student accounts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function NotFoundPage() {
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-3xl mb-4 shadow-xl">
        🔍
      </div>
      <h1 className="text-3xl font-black mb-2 tracking-tight">404 - Page Not Found</h1>
      <p className="text-sm text-slate-400 max-w-md mb-8 leading-relaxed">
        The page you are looking for does not exist, has been removed, or may have been moved.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-3">
        {user?.role === 'student' ? (
          <Link
            to="/student"
            className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all shadow-lg shadow-indigo-900/40"
          >
            ← Return to Student Home
          </Link>
        ) : user?.role === 'professor' || user?.role === 'admin' ? (
          <Link
            to="/professor"
            className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all shadow-lg shadow-indigo-900/40"
          >
            ← Return to Dashboard
          </Link>
        ) : (
          <>
            <Link
              to="/"
              className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all shadow-lg shadow-indigo-900/40"
            >
              Return to Home
            </Link>
            <Link
              to="/login"
              className="px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-slate-200 text-xs font-semibold border border-white/10 transition-colors"
            >
              Sign In
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
