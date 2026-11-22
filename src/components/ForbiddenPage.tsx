/**
 * src/components/ForbiddenPage.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * 403 Forbidden display when a user accesses a route not allowed for their role.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function ForbiddenPage() {
  const { user, logout } = useAuth();

  const destination = user?.role === 'student' ? '/student' : '/professor';

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-center text-slate-100">
      <div className="w-16 h-16 rounded-2xl bg-red-950/80 border border-red-800/80 text-red-400 flex items-center justify-center text-3xl mb-6 shadow-xl shadow-red-950/50">
        🚫
      </div>
      <h1 className="text-3xl font-extrabold text-white mb-2">Access Denied</h1>
      <p className="text-slate-400 text-sm max-w-md mb-8">
        You do not have permission to access this page ({user ? `signed in as ${user.role}` : 'not signed in'}).
      </p>

      <div className="flex gap-4">
        <Link
          to={destination}
          className="px-6 py-2.5 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all"
        >
          Go to Dashboard
        </Link>
        <button
          onClick={() => void logout()}
          className="px-6 py-2.5 rounded-xl text-sm font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-all"
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}
