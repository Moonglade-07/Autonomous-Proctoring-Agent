/**
 * src/pages/AdminAuditPage.tsx — Admin Audit Trail Viewer (Phase 7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspect immutable append-only audit log events with actor resolution,
 * multi-attribute filters, keyset pagination, and safe plain-text metadata expansion.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useState } from 'react';

interface AuditItem {
  id: string;
  ts: string;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  target: string;
  ip: string | null;
  meta_json: string;
}

export function AdminAuditPage() {
  const [logs, setLogs] = useState<AuditItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [actionFilter, setActionFilter] = useState('');
  const [actorFilter, setActorFilter] = useState('');
  const [targetFilter, setTargetFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');

  // Pagination
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);

  // Expanded Row IDs
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const fetchAuditLogs = async (targetCursor: string | null = null) => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (actionFilter.trim()) params.set('action', actionFilter.trim());
      if (actorFilter.trim()) params.set('actor', actorFilter.trim());
      if (targetFilter.trim()) params.set('target', targetFilter.trim());
      if (fromFilter) params.set('from', fromFilter);
      if (toFilter) params.set('to', toFilter);
      if (targetCursor) params.set('cursor', targetCursor);
      params.set('limit', '50');

      const res = await fetch(`/api/admin/audit?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`Failed to load audit logs (HTTP ${res.status})`);
      }
      const data = await res.json();
      setLogs(data.audit_logs || []);
      setNextCursor(data.next_cursor || null);
    } catch (err: any) {
      setError(err?.message || 'Error fetching audit trail');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setCursor(null);
    setCursorHistory([]);
    void fetchAuditLogs(null);
  }, [actionFilter, actorFilter, targetFilter, fromFilter, toFilter]);

  const handleNextPage = () => {
    if (nextCursor) {
      setCursorHistory((prev) => [...prev, cursor || '']);
      setCursor(nextCursor);
      void fetchAuditLogs(nextCursor);
    }
  };

  const handlePrevPage = () => {
    if (cursorHistory.length > 0) {
      const prevList = [...cursorHistory];
      const prevCursor = prevList.pop() || null;
      setCursorHistory(prevList);
      setCursor(prevCursor);
      void fetchAuditLogs(prevCursor);
    }
  };

  const toggleRow = (id: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearFilters = () => {
    setActionFilter('');
    setActorFilter('');
    setTargetFilter('');
    setFromFilter('');
    setToFilter('');
  };

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <span>📜</span> Platform Audit Trail
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Immutable, append-only system record of critical administrative and security events.
          </p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div>
            <label className="text-[11px] font-semibold text-slate-400 block mb-1">Action</label>
            <input
              type="text"
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              placeholder="e.g. deactivate_user"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-red-500"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 block mb-1">Actor (Name/Email/ID)</label>
            <input
              type="text"
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
              placeholder="Filter by actor…"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-red-500"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 block mb-1">Target ID/Email</label>
            <input
              type="text"
              value={targetFilter}
              onChange={(e) => setTargetFilter(e.target.value)}
              placeholder="Filter by target…"
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-red-500"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 block mb-1">From Timestamp</label>
            <input
              type="date"
              value={fromFilter}
              onChange={(e) => setFromFilter(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-red-500"
            />
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-400 block mb-1">To Timestamp</label>
            <input
              type="date"
              value={toFilter}
              onChange={(e) => setToFilter(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-red-500"
            />
          </div>
        </div>

        {(actionFilter || actorFilter || targetFilter || fromFilter || toFilter) && (
          <div className="flex justify-end pt-2 border-t border-slate-800/60">
            <button
              onClick={clearFilters}
              className="text-xs text-slate-400 hover:text-white transition-colors"
            >
              Clear All Filters
            </button>
          </div>
        )}
      </div>

      {/* Audit Log Table */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden shadow-xl">
        {loading ? (
          <div className="py-20 text-center text-slate-400 text-xs">
            <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            Loading audit events...
          </div>
        ) : error ? (
          <div className="p-8 text-center text-xs text-rose-300">
            {error}
            <button
              onClick={() => void fetchAuditLogs(cursor)}
              className="block mx-auto mt-3 px-3 py-1 bg-rose-950 border border-rose-800 rounded text-white"
            >
              Retry
            </button>
          </div>
        ) : logs.length === 0 ? (
          <div className="py-16 text-center text-xs text-slate-400">
            No audit log records found matching the specified filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/60 text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4">Timestamp (UTC)</th>
                  <th className="py-3 px-4">Action</th>
                  <th className="py-3 px-4">Actor</th>
                  <th className="py-3 px-4">Target</th>
                  <th className="py-3 px-4">Client IP</th>
                  <th className="py-3 px-4 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                {logs.map((log) => {
                  const isExpanded = expandedRows.has(log.id);
                  return (
                    <React.Fragment key={log.id}>
                      <tr className="hover:bg-slate-800/30 transition-colors">
                        <td className="py-3 px-4 text-slate-300 font-sans text-xs whitespace-nowrap">
                          {log.ts}
                        </td>
                        <td className="py-3 px-4">
                          <span className="inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-800 text-slate-200 border border-slate-700">
                            {log.action}
                          </span>
                        </td>
                        <td className="py-3 px-4 font-sans text-xs">
                          {log.actor_name ? (
                            <div>
                              <span className="font-semibold text-white">{log.actor_name}</span>
                              <div className="text-slate-400 text-[11px] font-mono">{log.actor_email}</div>
                            </div>
                          ) : (
                            <span className="text-slate-500 font-mono text-[11px]">
                              {log.actor_user_id || 'system'}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-slate-300 text-xs font-mono">{log.target}</td>
                        <td className="py-3 px-4 text-slate-400 text-xs">{log.ip || '—'}</td>
                        <td className="py-3 px-4 text-right font-sans">
                          <button
                            onClick={() => toggleRow(log.id)}
                            className="text-xs px-2.5 py-1 rounded bg-slate-800/60 hover:bg-slate-700 text-slate-300 border border-slate-700/60 transition-all cursor-pointer"
                          >
                            {isExpanded ? 'Hide Details' : 'View Details'}
                          </button>
                        </td>
                      </tr>

                      {/* Expanded Details Row */}
                      {isExpanded && (
                        <tr className="bg-slate-950/70 border-b border-slate-800">
                          <td colSpan={6} className="p-4">
                            <div className="text-[11px] font-sans font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                              Metadata Payload (Raw Uninterpreted String):
                            </div>
                            <pre className="p-3 rounded-lg bg-slate-950 border border-slate-800 text-slate-300 text-[11px] font-mono whitespace-pre-wrap break-all select-all">
                              {log.meta_json || 'null'}
                            </pre>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Keyset Pagination Bar */}
        <div className="p-3 border-t border-slate-800/80 bg-slate-950/40 flex items-center justify-between text-xs text-slate-400">
          <span>Showing {logs.length} audit entries</span>
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
    </div>
  );
}
