/**
 * src/pages/AdminUsersPage.tsx — Admin User Directory & Staff Provisioning (Phase 7)
 * ─────────────────────────────────────────────────────────────────────────────
 * User account directory with role/status filters, keyset pagination,
 * safe staff creation (professor/admin only), and account deactivation/reactivation.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';

interface UserItem {
  id: string;
  email: string;
  name: string;
  role: 'student' | 'professor' | 'admin';
  active: boolean;
  student_id: string | null;
  department: string | null;
  created_at: string;
  last_login_at: string | null;
}

export function AdminUsersPage() {
  const { user: currentUser } = useAuth();
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);

  // Create Staff Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createEmail, setCreateEmail] = useState('');
  const [createName, setCreateName] = useState('');
  const [createRole, setCreateRole] = useState<'professor' | 'admin'>('professor');
  const [createDept, setCreateDept] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSuccess, setCreateSuccess] = useState<string | null>(null);

  // Deactivate / Reactivate Dialog State
  const [confirmTarget, setConfirmTarget] = useState<UserItem | null>(null);
  const [confirmAction, setConfirmAction] = useState<'deactivate' | 'reactivate' | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchUsers = async (targetCursor: string | null = null) => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (search.trim()) params.set('search', search.trim());
      if (roleFilter !== 'all') params.set('role', roleFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (targetCursor) params.set('cursor', targetCursor);
      params.set('limit', '20');

      const res = await fetch(`/api/admin/users?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`Failed to load users (HTTP ${res.status})`);
      }
      const data = await res.json();
      setUsers(data.users || []);
      setNextCursor(data.next_cursor || null);
    } catch (err: any) {
      setError(err?.message || 'Error fetching users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setCursor(null);
    setCursorHistory([]);
    void fetchUsers(null);
  }, [search, roleFilter, statusFilter]);

  const handleNextPage = () => {
    if (nextCursor) {
      setCursorHistory((prev) => [...prev, cursor || '']);
      setCursor(nextCursor);
      void fetchUsers(nextCursor);
    }
  };

  const handlePrevPage = () => {
    if (cursorHistory.length > 0) {
      const prevList = [...cursorHistory];
      const prevCursor = prevList.pop() || null;
      setCursorHistory(prevList);
      setCursor(prevCursor);
      void fetchUsers(prevCursor);
    }
  };

  // Active Admin count check for self-protection
  const activeAdmins = users.filter((u) => u.role === 'admin' && u.active);
  const isLastActiveAdmin = (targetId: string) => {
    const target = users.find((u) => u.id === targetId);
    if (!target || target.role !== 'admin' || !target.active) return false;
    return activeAdmins.length <= 1;
  };

  // Create Staff Account Handler
  const handleCreateStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateError(null);
    setCreateSuccess(null);

    if (!createEmail.trim() || !createName.trim() || !createPassword) {
      setCreateError('Please complete all required fields.');
      return;
    }
    if (createPassword.length < 10) {
      setCreateError('Password must be at least 10 characters long.');
      return;
    }

    try {
      setCreateLoading(true);
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: createEmail.trim(),
          name: createName.trim(),
          password: createPassword,
          role: createRole,
          department: createDept.trim() || null,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || `Failed to create user (HTTP ${res.status})`);
      }

      setCreateSuccess(`Successfully created ${createRole} account for ${createEmail}`);
      setCreateEmail('');
      setCreateName('');
      setCreatePassword('');
      setCreateDept('');
      setTimeout(() => {
        setShowCreateModal(false);
        setCreateSuccess(null);
        void fetchUsers(cursor);
      }, 1500);
    } catch (err: any) {
      setCreateError(err.message || 'Error creating user');
    } finally {
      setCreateLoading(false);
    }
  };

  // Confirm Status Toggle (Deactivate / Reactivate)
  const handleConfirmAction = async () => {
    if (!confirmTarget || !confirmAction) return;
    setActionError(null);

    try {
      setActionLoading(true);
      const endpoint = `/api/admin/users/${encodeURIComponent(confirmTarget.id)}/${confirmAction}`;
      const res = await fetch(endpoint, { method: 'POST' });
      const json = await res.json();

      if (!res.ok) {
        throw new Error(json.error?.message || `Failed to ${confirmAction} user (HTTP ${res.status})`);
      }

      // Update state locally
      setUsers((prev) =>
        prev.map((u) =>
          u.id === confirmTarget.id ? { ...u, active: confirmAction === 'reactivate' } : u,
        ),
      );
      setConfirmTarget(null);
      setConfirmAction(null);
    } catch (err: any) {
      setActionError(err.message || `Error attempting to ${confirmAction} user`);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Actions */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <span>👥</span> User Account Directory
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Search, filter, provision staff accounts, and manage account authorization status.
          </p>
        </div>

        <button
          onClick={() => {
            setCreateError(null);
            setCreateSuccess(null);
            setShowCreateModal(true);
          }}
          className="self-start sm:self-auto px-4 py-2 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20 transition-all flex items-center gap-2 cursor-pointer"
        >
          <span>➕</span> Create Staff Account
        </button>
      </div>

      {/* Filter Toolbar */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-wrap items-center gap-4">
        {/* Search Input */}
        <div className="flex-1 min-w-[240px]">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-red-500 transition-colors"
          />
        </div>

        {/* Role Filter */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 font-medium">Role:</label>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-red-500"
          >
            <option value="all">All Roles</option>
            <option value="student">Student</option>
            <option value="professor">Professor</option>
            <option value="admin">Administrator</option>
          </select>
        </div>

        {/* Status Filter */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 font-medium">Status:</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-red-500"
          >
            <option value="all">All Statuses</option>
            <option value="active">Active Only</option>
            <option value="inactive">Inactive Only</option>
          </select>
        </div>
      </div>

      {/* Users Table */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden shadow-xl">
        {loading ? (
          <div className="py-20 text-center text-slate-400 text-xs">
            <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            Loading accounts...
          </div>
        ) : error ? (
          <div className="p-8 text-center text-xs text-rose-300">
            {error}
            <button
              onClick={() => void fetchUsers(cursor)}
              className="block mx-auto mt-3 px-3 py-1 bg-rose-950 border border-rose-800 rounded text-white"
            >
              Retry
            </button>
          </div>
        ) : users.length === 0 ? (
          <div className="py-16 text-center text-xs text-slate-400">
            No user accounts matched the filter criteria.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4">Name & Email</th>
                  <th className="py-3 px-4">Role</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Dept / Student ID</th>
                  <th className="py-3 px-4">Registered</th>
                  <th className="py-3 px-4">Last Login</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {users.map((u) => {
                  const isSelf = currentUser?.id === u.id;
                  const isLastAdmin = isLastActiveAdmin(u.id);
                  const deactivateDisabled = isSelf || isLastAdmin;
                  const disableReason = isSelf
                    ? 'You cannot deactivate your own account'
                    : isLastAdmin
                    ? 'Cannot deactivate the last active administrator'
                    : '';

                  return (
                    <tr key={u.id} className="hover:bg-slate-800/30 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-semibold text-white">{u.name}</div>
                        <div className="text-slate-400 text-[11px] font-mono">{u.email}</div>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${
                            u.role === 'admin'
                              ? 'bg-red-950 text-red-400 border border-red-800/60'
                              : u.role === 'professor'
                              ? 'bg-indigo-950 text-indigo-400 border border-indigo-800/60'
                              : 'bg-slate-800 text-slate-300 border border-slate-700'
                          }`}
                        >
                          {u.role}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            u.active
                              ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/40'
                              : 'bg-slate-800 text-slate-400 border border-slate-700'
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full ${
                              u.active ? 'bg-emerald-400' : 'bg-slate-500'
                            }`}
                          />
                          {u.active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-slate-300">
                        {u.department || u.student_id || <span className="text-slate-600">—</span>}
                      </td>
                      <td className="py-3 px-4 text-slate-400 text-[11px]">
                        {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                      </td>
                      <td className="py-3 px-4 text-slate-400 text-[11px]">
                        {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'Never'}
                      </td>
                      <td className="py-3 px-4 text-right">
                        {u.active ? (
                          <button
                            disabled={deactivateDisabled}
                            onClick={() => {
                              setConfirmTarget(u);
                              setConfirmAction('deactivate');
                            }}
                            title={disableReason}
                            className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                              deactivateDisabled
                                ? 'bg-slate-800/50 text-slate-600 border border-slate-800 cursor-not-allowed'
                                : 'bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 border border-rose-800/60 cursor-pointer'
                            }`}
                          >
                            Deactivate
                          </button>
                        ) : (
                          <button
                            onClick={() => {
                              setConfirmTarget(u);
                              setConfirmAction('reactivate');
                            }}
                            className="px-2.5 py-1 rounded text-xs font-medium bg-emerald-950/40 hover:bg-emerald-900/60 text-emerald-300 border border-emerald-800/60 transition-all cursor-pointer"
                          >
                            Reactivate
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Keyset Pagination Bar */}
        <div className="p-3 border-t border-slate-800/80 bg-slate-950/40 flex items-center justify-between text-xs text-slate-400">
          <span>Showing {users.length} user records</span>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrevPage}
              disabled={cursorHistory.length === 0}
              className="px-3 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              &larr; Previous
            </button>
            <button
              onClick={handleNextPage}
              disabled={!nextCursor}
              className="px-3 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              Next &rarr;
            </button>
          </div>
        </div>
      </div>

      {/* ── Create Staff Account Modal ────────────────────────────────────── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl relative">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <span>➕</span> Create Staff Account
              </h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-white text-lg font-bold"
              >
                &times;
              </button>
            </div>

            {/* Instruction Warning */}
            <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-800/50 text-xs text-amber-200 mb-4 leading-relaxed">
              <strong>Notice:</strong> Share the temporary password privately and securely with the instructor or administrator. They should change their password immediately after logging in.
            </div>

            {createError && (
              <div className="p-3 rounded-xl bg-rose-950/60 border border-rose-800/60 text-xs text-rose-300 mb-4">
                {createError}
              </div>
            )}
            {createSuccess && (
              <div className="p-3 rounded-xl bg-emerald-950/60 border border-emerald-800/60 text-xs text-emerald-300 mb-4">
                {createSuccess}
              </div>
            )}

            <form onSubmit={handleCreateStaff} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Email Address *</label>
                <input
                  type="email"
                  required
                  value={createEmail}
                  onChange={(e) => setCreateEmail(e.target.value)}
                  placeholder="instructor@institution.edu"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">Full Name *</label>
                <input
                  type="text"
                  required
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="Prof. Jane Doe"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">Role *</label>
                  <select
                    value={createRole}
                    onChange={(e) => setCreateRole(e.target.value as any)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500"
                  >
                    <option value="professor">Professor</option>
                    <option value="admin">Administrator</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-300 block mb-1">Department</label>
                  <input
                    type="text"
                    value={createDept}
                    onChange={(e) => setCreateDept(e.target.value)}
                    placeholder="Computer Science"
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500"
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-300 block mb-1">
                  Temporary Initial Password *
                </label>
                <input
                  type="password"
                  required
                  value={createPassword}
                  onChange={(e) => setCreatePassword(e.target.value)}
                  placeholder="Minimum 10 characters"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-red-500"
                />
                <span className="text-[10px] text-slate-500 block mt-1">
                  Length: {createPassword.length}/10 minimum characters required.
                </span>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createLoading}
                  className="px-4 py-2 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-500 text-white disabled:opacity-50 transition-all cursor-pointer"
                >
                  {createLoading ? 'Provisioning...' : 'Create Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Confirmation Modal (Deactivate / Reactivate) ──────────────────── */}
      {confirmTarget && confirmAction && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-sm w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
            <h3 className="text-sm font-bold text-white mb-2">
              {confirmAction === 'deactivate' ? 'Confirm Deactivation' : 'Confirm Reactivation'}
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed mb-4">
              {confirmAction === 'deactivate' ? (
                <>
                  Are you sure you want to deactivate account <strong>{confirmTarget.name}</strong> ({confirmTarget.email})? All active sessions and tokens will be immediately invalidated.
                </>
              ) : (
                <>
                  Reactivate account <strong>{confirmTarget.name}</strong> ({confirmTarget.email})? They will be permitted to authenticate again.
                </>
              )}
            </p>

            {actionError && (
              <div className="p-2.5 rounded-lg bg-rose-950/60 border border-rose-800 text-xs text-rose-300 mb-4">
                {actionError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setConfirmTarget(null);
                  setConfirmAction(null);
                  setActionError(null);
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actionLoading}
                onClick={handleConfirmAction}
                className={`px-4 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-50 cursor-pointer ${
                  confirmAction === 'deactivate'
                    ? 'bg-rose-600 hover:bg-rose-500'
                    : 'bg-emerald-600 hover:bg-emerald-500'
                }`}
              >
                {actionLoading
                  ? 'Updating...'
                  : confirmAction === 'deactivate'
                  ? 'Yes, Deactivate'
                  : 'Yes, Reactivate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
