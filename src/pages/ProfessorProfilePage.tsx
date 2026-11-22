/**
 * src/pages/ProfessorProfilePage.tsx — Professor Profile & Password Management (Phase 5c)
 * ─────────────────────────────────────────────────────────────────────────────
 * View instructor profile and manage credentials.
 * Change password increments token_version and logs out other devices.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export function ProfessorProfilePage() {
  const { user } = useAuth();

  // Change password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg(null);

    if (newPassword.length < 10 || newPassword.length > 128) {
      setPwMsg({ type: 'error', text: 'New password must be between 10 and 128 characters long.' });
      return;
    }

    if (newPassword !== confirmPassword) {
      setPwMsg({ type: 'error', text: 'New passwords do not match.' });
      return;
    }

    setPwSaving(true);

    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });

      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };

      if (!res.ok || !body.ok) {
        if (res.status === 429) {
          throw new Error('Too many failed password change attempts. Please wait 15 minutes.');
        }
        throw new Error(body.error || 'Invalid current password or new password does not meet requirements.');
      }

      setPwMsg({
        type: 'success',
        text: 'Password changed successfully. All other active sessions have been invalidated.',
      });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setPwMsg({ type: 'error', text: err instanceof Error ? err.message : 'Failed to change password.' });
    } finally {
      setPwSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-10 w-full flex-1 space-y-8">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-950/70 border border-indigo-800/60 text-indigo-300 text-xs font-semibold mb-3">
            <span>👤</span> Instructor Profile
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">Account & Security</h1>
          <p className="text-slate-400 text-sm mt-1">
            Manage your account credentials and security settings.
          </p>
        </div>

        {/* Profile Information View */}
        <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 space-y-4">
          <h2 className="text-base font-bold text-white border-b border-slate-800 pb-3">
            Profile Information
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <span className="text-slate-500 font-semibold uppercase tracking-wider block mb-1">
                Full Name
              </span>
              <p className="text-sm font-bold text-white">{user?.name}</p>
            </div>

            <div>
              <span className="text-slate-500 font-semibold uppercase tracking-wider block mb-1">
                Email Address
              </span>
              <p className="text-sm font-bold text-white">{user?.email}</p>
            </div>

            <div>
              <span className="text-slate-500 font-semibold uppercase tracking-wider block mb-1">
                Role
              </span>
              <span className="inline-block px-2.5 py-0.5 rounded font-bold uppercase text-[10px] bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                {user?.role}
              </span>
            </div>

            {user?.department && (
              <div>
                <span className="text-slate-500 font-semibold uppercase tracking-wider block mb-1">
                  Department
                </span>
                <p className="text-sm font-bold text-white">{user.department}</p>
              </div>
            )}
          </div>
        </div>

        {/* Change Password Form */}
        <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 space-y-6">
          <h2 className="text-base font-bold text-white border-b border-slate-800 pb-3">
            Change Password
          </h2>

          <form onSubmit={handleChangePassword} className="space-y-4">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                Current Password *
              </label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                className="w-full bg-slate-800/80 border border-slate-700/80 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                  New Password *
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={10}
                  maxLength={128}
                  required
                  placeholder="Min 10 characters"
                  className="w-full bg-slate-800/80 border border-slate-700/80 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                  Confirm New Password *
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={10}
                  maxLength={128}
                  required
                  placeholder="Re-type new password"
                  className="w-full bg-slate-800/80 border border-slate-700/80 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
            </div>

            <p className="text-[11px] text-slate-500">
              Your new password must be at least 10 characters long. Changing your password increments your token version, revoking all existing sessions on other devices.
            </p>

            {pwMsg && (
              <div
                className={`p-3 rounded-xl text-xs font-medium ${
                  pwMsg.type === 'success'
                    ? 'bg-emerald-950/40 border border-emerald-500/40 text-emerald-300'
                    : 'bg-rose-950/40 border border-rose-500/40 text-rose-300'
                }`}
              >
                {pwMsg.text}
              </div>
            )}

            <button
              type="submit"
              disabled={pwSaving}
              className="py-2.5 px-5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all disabled:opacity-50"
            >
              {pwSaving ? 'Updating Password…' : 'Update Password'}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
