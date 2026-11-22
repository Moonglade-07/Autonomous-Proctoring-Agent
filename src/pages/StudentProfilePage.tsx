/**
 * src/pages/StudentProfilePage.tsx — Student Profile & Password Management (Phase 5c)
 * ─────────────────────────────────────────────────────────────────────────────
 * View and update student name and student ID.
 * Change account password with multi-device session revocation.
 * Link to data privacy policy.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { StudentNav } from '../components/StudentNav';

export function StudentProfilePage() {
  const { user, refresh } = useAuth();

  // Profile edit state
  const [name, setName] = useState(user?.name || '');
  const [studentId, setStudentId] = useState(user?.student_id || '');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Change password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleUpdateProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileSaving(true);
    setProfileMsg(null);

    try {
      const res = await fetch('/api/student/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), student_id: studentId.trim() }),
      });

      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (!res.ok || !body.ok) {
        throw new Error(body.error || 'Failed to update profile.');
      }

      setProfileMsg({ type: 'success', text: 'Profile updated successfully.' });
      await refresh();
    } catch (err) {
      setProfileMsg({ type: 'error', text: err instanceof Error ? err.message : 'Error updating profile.' });
    } finally {
      setProfileSaving(false);
    }
  };

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
        text: 'Password changed successfully. All other devices have been logged out.',
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
      <StudentNav />

      <main className="max-w-2xl mx-auto px-4 sm:px-6 py-10 w-full flex-1 space-y-8">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-950/70 border border-indigo-800/60 text-indigo-300 text-xs font-semibold mb-3">
            <span>👤</span> Account Settings
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">Student Profile</h1>
          <p className="text-slate-400 text-sm mt-1">
            Manage your personal identity details and account credentials.
          </p>
        </div>

        {/* Profile Information Form */}
        <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800/80 space-y-6">
          <h2 className="text-base font-bold text-white border-b border-slate-800 pb-3">
            Profile Details
          </h2>

          <form onSubmit={handleUpdateProfile} className="space-y-4">
            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                Email Address
              </label>
              <input
                type="email"
                value={user?.email || ''}
                disabled
                className="w-full bg-slate-800/40 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-400 cursor-not-allowed"
              />
              <p className="text-[11px] text-slate-500 mt-1">Your registered email address cannot be changed.</p>
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                Full Name *
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full bg-slate-800/80 border border-slate-700/80 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-1.5">
                Student ID / Roll Number
              </label>
              <input
                type="text"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                placeholder="e.g. S-2024-8831"
                className="w-full bg-slate-800/80 border border-slate-700/80 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Used by instructors to map your exam grades into institutional rosters.
              </p>
            </div>

            {profileMsg && (
              <div
                className={`p-3 rounded-xl text-xs font-medium ${
                  profileMsg.type === 'success'
                    ? 'bg-emerald-950/40 border border-emerald-500/40 text-emerald-300'
                    : 'bg-rose-950/40 border border-rose-500/40 text-rose-300'
                }`}
              >
                {profileMsg.text}
              </div>
            )}

            <button
              type="submit"
              disabled={profileSaving}
              className="py-2.5 px-5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all disabled:opacity-50"
            >
              {profileSaving ? 'Saving Changes…' : 'Save Profile Details'}
            </button>
          </form>
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
              Changing your password increments your account security token, immediately revoking any other open sessions.
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

        {/* Privacy Policy Link Card */}
        <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl">🔒</span>
            <div>
              <p className="text-xs font-bold text-white">Proctoring Privacy Notice</p>
              <p className="text-[11px] text-slate-400">
                Review data collection policies, retention schedules, and Workers AI processing.
              </p>
            </div>
          </div>
          <Link
            to="/student/privacy"
            className="text-xs px-3.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-indigo-300 border border-white/10 font-semibold transition-colors"
          >
            View Policy →
          </Link>
        </div>
      </main>
    </div>
  );
}
