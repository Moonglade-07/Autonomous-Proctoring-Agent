/**
 * src/components/StudentNav.tsx — Navigation bar for Student Portal (Phase 5c)
 * ─────────────────────────────────────────────────────────────────────────────
 * Clean top navigation bar for all student pages.
 * Contains: Home, System Check, Help, Privacy, Profile, logged-in name, and Logout.
 * Absolutely NO links to /professor or Live Monitor.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function StudentNav() {
  const location = useLocation();
  const { user, logout } = useAuth();

  const navItems = [
    { label: 'Home', path: '/student', icon: '🏠' },
    { label: 'System Check', path: '/student/system-check', icon: '🩺' },
    { label: 'Help', path: '/student/help', icon: '❓' },
    { label: 'Privacy', path: '/student/privacy', icon: '🔒' },
    { label: 'Profile', path: '/student/profile', icon: '👤' },
  ];

  return (
    <header className="border-b border-white/[0.08] bg-slate-950/80 backdrop-blur-md sticky top-0 z-30">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-4">
        {/* Brand */}
        <Link to="/student" className="flex items-center gap-2.5 text-white no-underline flex-shrink-0">
          <div className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-lg">
            🛡️
          </div>
          <div className="hidden sm:block">
            <span className="text-sm font-bold text-white tracking-tight">Autonomous Proctoring Agent</span>
            <span className="text-[10px] text-indigo-400 block -mt-0.5 font-medium">Student Portal</span>
          </div>
        </Link>

        {/* Navigation Links */}
        <nav className="flex items-center gap-1 sm:gap-2">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path;
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  isActive
                    ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'
                }`}
              >
                <span>{item.icon}</span>
                <span className="hidden md:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* User Info & Logout */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {user && (
            <span className="text-xs text-slate-400 hidden lg:inline">
              <strong className="text-slate-200">{user.name}</strong>
              {user.student_id ? ` (${user.student_id})` : ''}
            </span>
          )}
          <button
            onClick={() => void logout()}
            className="text-xs px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-medium transition-colors"
            title="Sign out of your account"
          >
            Sign Out
          </button>
        </div>
      </div>
    </header>
  );
}
