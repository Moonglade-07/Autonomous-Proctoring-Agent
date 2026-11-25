/**
 * src/pages/AdminSecurityPage.tsx — Admin Security & Failed Logins Monitor (Phase 7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time monitoring of failed login attempts, targeted email accounts,
 * abusive source IPs, and accounts currently locked out by brute-force throttling.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState } from 'react';

interface SecurityData {
  hours: number;
  locked_accounts: Array<{
    email: string;
    failure_count: number;
    last_attempt_at: string;
  }>;
  by_email: Array<{
    email: string;
    failure_count: number;
    last_attempt_at: string;
    last_ip: string;
  }>;
  by_ip: Array<{
    ip: string;
    failure_count: number;
    last_attempt_at: string;
    targeted_emails_count: number;
  }>;
}

export function AdminSecurityPage() {
  const [data, setData] = useState<SecurityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hours, setHours] = useState(24);

  const fetchSecurity = async (h: number) => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch(`/api/admin/security/failed-logins?hours=${h}`);
      if (!res.ok) {
        throw new Error(`Failed to load security metrics (HTTP ${res.status})`);
      }
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err?.message || 'Error fetching security data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchSecurity(hours);
  }, [hours]);

  return (
    <div className="space-y-8">
      {/* Top Header & Time Filter */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
            <span>🔒</span> Security & Authentication Monitor
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1">
            Detect credential stuffing, brute force login attempts, and monitor locked accounts.
          </p>
        </div>

        {/* Time Window Buttons */}
        <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-900 border border-slate-800 self-start sm:self-auto">
          {[
            { label: '1 Hour', val: 1 },
            { label: '6 Hours', val: 6 },
            { label: '24 Hours', val: 24 },
            { label: '7 Days', val: 168 },
          ].map((item) => (
            <button
              key={item.val}
              onClick={() => setHours(item.val)}
              className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                hours === item.val
                  ? 'bg-red-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="py-24 text-center text-slate-400 text-xs">
          <div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          Analyzing authentication telemetry...
        </div>
      ) : error || !data ? (
        <div className="p-6 rounded-2xl bg-rose-950/40 border border-rose-800/60 text-xs text-rose-300">
          {error || 'Failed to load telemetry.'}
          <button
            onClick={() => void fetchSecurity(hours)}
            className="block mt-2 px-3 py-1 bg-rose-900 rounded text-white font-medium"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="space-y-8">
          {/* Section 1: Currently Locked Out Accounts */}
          <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <span>🚨</span> Accounts Currently Locked Out
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Accounts with 5 or more failed login attempts in the last 15 minutes.
                </p>
              </div>
              <span
                className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                  data.locked_accounts.length > 0
                    ? 'bg-rose-950 text-rose-400 border border-rose-800'
                    : 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                }`}
              >
                {data.locked_accounts.length} Locked
              </span>
            </div>

            {data.locked_accounts.length === 0 ? (
              <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 text-center text-xs text-slate-400">
                ✅ Zero accounts are currently locked out. All active users have normal access.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-rose-900/60 bg-rose-950/20">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-rose-900/60 text-rose-300 text-[11px] uppercase tracking-wider font-semibold">
                      <th className="py-2.5 px-4">Locked Target Email</th>
                      <th className="py-2.5 px-4 text-center">Failures (Last 15m)</th>
                      <th className="py-2.5 px-4 text-right">Most Recent Attempt</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-rose-900/40 font-mono text-[11px]">
                    {data.locked_accounts.map((acc) => (
                      <tr key={acc.email} className="hover:bg-rose-900/20">
                        <td className="py-2.5 px-4 text-white font-medium">{acc.email}</td>
                        <td className="py-2.5 px-4 text-center font-bold text-rose-400">
                          {acc.failure_count}
                        </td>
                        <td className="py-2.5 px-4 text-right text-slate-300 font-sans text-xs">
                          {new Date(acc.last_attempt_at).toLocaleTimeString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Section 2: Aggregated Failures (Two Columns) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* By Email */}
            <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800">
              <h2 className="text-sm font-bold text-white flex items-center gap-2 mb-1">
                <span>🎯</span> Targeted Accounts (Last {data.hours}h)
              </h2>
              <p className="text-xs text-slate-400 mb-4">
                Top emails experiencing failed authentication attempts.
              </p>

              {data.by_email.length === 0 ? (
                <div className="p-6 rounded-xl bg-slate-950/60 border border-slate-800 text-center text-xs text-slate-400">
                  No failed logins recorded in this timeframe.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 text-[11px] uppercase tracking-wider font-semibold">
                        <th className="py-2.5 px-3">Target Email</th>
                        <th className="py-2.5 px-3 text-center">Failures</th>
                        <th className="py-2.5 px-3">Last Source IP</th>
                        <th className="py-2.5 px-3 text-right">Last Attempt</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                      {data.by_email.map((row) => (
                        <tr key={row.email} className="hover:bg-slate-800/30">
                          <td className="py-2.5 px-3 text-slate-200">{row.email}</td>
                          <td className="py-2.5 px-3 text-center font-bold text-amber-400">
                            {row.failure_count}
                          </td>
                          <td className="py-2.5 px-3 text-slate-400">{row.last_ip || '—'}</td>
                          <td className="py-2.5 px-3 text-right text-slate-400 font-sans text-[11px]">
                            {new Date(row.last_attempt_at).toLocaleTimeString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* By Source IP */}
            <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800">
              <h2 className="text-sm font-bold text-white flex items-center gap-2 mb-1">
                <span>🌐</span> High-Volume Source IPs (Last {data.hours}h)
              </h2>
              <p className="text-xs text-slate-400 mb-4">
                IP addresses generating failed authentication attempts.
              </p>

              {data.by_ip.length === 0 ? (
                <div className="p-6 rounded-xl bg-slate-950/60 border border-slate-800 text-center text-xs text-slate-400">
                  No suspicious IPs recorded in this timeframe.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/60">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 text-[11px] uppercase tracking-wider font-semibold">
                        <th className="py-2.5 px-3">IP Address</th>
                        <th className="py-2.5 px-3 text-center">Failures</th>
                        <th className="py-2.5 px-3 text-center">Emails Targeted</th>
                        <th className="py-2.5 px-3 text-right">Last Attempt</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
                      {data.by_ip.map((row) => (
                        <tr key={row.ip} className="hover:bg-slate-800/30">
                          <td className="py-2.5 px-3 text-slate-200">{row.ip}</td>
                          <td className="py-2.5 px-3 text-center font-bold text-amber-400">
                            {row.failure_count}
                          </td>
                          <td className="py-2.5 px-3 text-center text-slate-300">
                            {row.targeted_emails_count}
                          </td>
                          <td className="py-2.5 px-3 text-right text-slate-400 font-sans text-[11px]">
                            {new Date(row.last_attempt_at).toLocaleTimeString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
