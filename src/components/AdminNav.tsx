/**
 * src/components/AdminNav.tsx — Top Navigation Bar for Admin Area (Phase 7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides navigation between Overview, Users, Exams, Audit Log, Security,
 * and a direct link to the Professor Portal.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function AdminNav() {
  const location = useLocation();
  const { user, logout } = useAuth();

  const navLinks = [
    { to: '/admin', label: '📊 Overview', exact: true },
    { to: '/admin/users', label: '👥 Users', exact: false },
    { to: '/admin/exams', label: '📋 Exams', exact: false },
    { to: '/admin/audit', label: '📜 Audit Log', exact: false },
    { to: '/admin/security', label: '🔒 Security', exact: false },
  ];

  const isActive = (to: string, exact: boolean) => {
    if (exact) return location.pathname === to;
    return location.pathname.startsWith(to);
  };

  return (
    <nav className="bg-slate-900/90 border-b border-slate-800 backdrop-blur sticky top-0 z-40 px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-4">
      {/* Brand & Area Title */}
      <div className="flex items-center gap-3">
        <Link to="/admin" className="flex items-center gap-2 text-white font-bold tracking-tight hover:opacity-90">
          <span className="w-8 h-8 rounded-lg bg-red-500/20 border border-red-500/40 flex items-center justify-center text-lg shadow-sm shadow-red-500/20">
            🛡️
          </span>
          <span className="text-base font-bold text-white">APA Admin</span>
        </Link>
        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-red-950/80 text-red-400 border border-red-800/60">
          Platform Governance
        </span>
      </div>

      {/* Primary Navigation Links */}
      <div className="flex items-center gap-1 sm:gap-2 flex-wrap">
        {navLinks.map((link) => {
          const active = isActive(link.to, link.exact);
          return (
            <Link
              key={link.to}
              to={link.to}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                active
                  ? 'bg-red-500/15 text-red-400 border border-red-500/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {link.label}
            </Link>
          );
        })}

        {/* Link to Professor Portal */}
        <Link
          to="/professor"
          className="ml-2 px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-400 hover:text-indigo-300 hover:bg-indigo-950/40 border border-indigo-900/40 transition-all flex items-center gap-1.5"
          title="Switch to Professor Dashboard"
        >
          <span>🎓</span> Professor Portal &rarr;
        </Link>
      </div>

      {/* User Info & Sign Out */}
      <div className="flex items-center gap-3 ml-auto">
        {user && (
          <div className="hidden sm:flex flex-col text-right">
            <span className="text-xs font-medium text-slate-200">{user.name}</span>
            <span className="text-[10px] text-red-400 font-bold uppercase tracking-wider">
              Administrator
            </span>
          </div>
        )}
        <button
          onClick={() => void logout()}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-red-400 hover:bg-red-950/30 border border-slate-800 hover:border-red-900/40 transition-all cursor-pointer"
          title="Sign out of administrative session"
        >
          Sign Out
        </button>
      </div>
    </nav>
  );
}

export function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col selection:bg-red-500/30 selection:text-white">
      <AdminNav />
      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">{children}</main>
    </div>
  );
}
