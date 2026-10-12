/**
 * ProfessorDashboard.tsx
 * ─────────────────────────────────────────────────────────────────
 * Phase 3a — Read-only live monitor for professors.
 *
 * Requirements:
 *   • Route /professor in React router
 *   • Header:
 *       - Exam title/ID selector (default exam-1)
 *       - Status pills: Total students, Active, High risk, Disconnected, Submitted
 *       - WebSocket connection status dot
 *   • Filter & Search Bar:
 *       - Filter by risk level / status (All, Active, High Risk, Disconnected, Submitted)
 *       - Sort by risk score (descending by default), name, violation count
 *       - Search by student name or session ID
 *   • Live Grid of Student Cards:
 *       - Sorted by risk score (descending) by default
 *       - Card shows:
 *           - Thumbnail (160x120 aspect, mirrored, fallback avatar if none)
 *           - Student name & sessionId (truncated)
 *           - Risk score badge (green <40, yellow 40-70, red >70 with pulse animation)
 *           - Current status badge (Active, Disconnected, Submitted)
 *           - Violation count
 *           - Last event pill (e.g. "Multiple Faces detected 12s ago")
 *           - Time active
 *   • Detail Drawer (slide-over modal):
 *       - Opens on student card click
 *       - Full session details, high-res preview, RiskIndicator gauge,
 *         and recent violation log / timeline with AI explanations.
 *   • Live Alerts Feed (sidebar) with streaming Workers AI violation reasoning.
 * ─────────────────────────────────────────────────────────────────
 */

import { useState, useMemo, useEffect } from 'react';
import { useHubSocket } from '../hooks/useHubSocket';
import { RiskIndicator } from '../components/RiskIndicator';
import type { SessionSummary, HubAlert, Violation } from '../types';

// ─── Preset Exams ────────────────────────────────────────────────────────────

const PRESET_EXAMS = [
  { id: 'exam-1', name: 'exam-1 · CS 101 Midterm Examination' },
  { id: 'exam-2', name: 'exam-2 · Data Structures & Algorithms' },
  { id: 'exam-sandbox', name: 'exam-sandbox · Proctoring Testing Session' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getRiskCategory(score: number): 'low' | 'medium' | 'high' {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function riskBadgeStyles(score: number) {
  if (score >= 70) {
    return {
      cardBorder: 'border-red-500/80 ring-1 ring-red-500/50 shadow-lg shadow-red-500/20',
      badge: 'bg-red-500/25 text-red-300 ring-1 ring-red-500/60 animate-pulse',
      pulse: true,
      text: 'text-red-400',
    };
  }
  if (score >= 40) {
    return {
      cardBorder: 'border-amber-500/60 ring-1 ring-amber-500/30 shadow-md shadow-amber-500/10',
      badge: 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40',
      pulse: false,
      text: 'text-amber-400',
    };
  }
  return {
    cardBorder: 'border-emerald-500/40 ring-1 ring-emerald-500/20 shadow-sm shadow-emerald-500/5',
    badge: 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/30',
    pulse: false,
    text: 'text-emerald-400',
  };
}

function statusBadgeStyles(status: SessionSummary['status']) {
  switch (status) {
    case 'active':
      return {
        bg: 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30',
        dot: 'bg-emerald-400 animate-pulse',
        label: 'Active',
      };
    case 'disconnected':
      return {
        bg: 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30',
        dot: 'bg-amber-400',
        label: 'Disconnected',
      };
    case 'submitted':
      return {
        bg: 'bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/30',
        dot: 'bg-blue-400',
        label: 'Submitted',
      };
  }
}

function severityStyles(s: Violation['severity']) {
  const m: Record<string, string> = {
    critical: 'text-red-400 bg-red-500/15 ring-red-500/30',
    high:     'text-orange-400 bg-orange-500/15 ring-orange-500/30',
    medium:   'text-amber-400 bg-amber-400/15 ring-amber-400/30',
    low:      'text-emerald-400 bg-emerald-500/15 ring-emerald-500/30',
  };
  return m[s] ?? m.low;
}

function eventIcon(type: string): string {
  const icons: Record<string, string> = {
    tab_switch: '🔀',
    no_face: '👤',
    multiple_faces: '👥',
    orientation_away: '👀',
    identity_mismatch: '🕵️',
    clipboard_activity: '📋',
    fullscreen_exit: '🖥️',
    right_click_attempt: '🚫',
    normal: '✅',
    submit: '🏁',
    thumbnail: '📷',
  };
  return icons[type] ?? '⚠️';
}

function eventLabel(type: string): string {
  const labels: Record<string, string> = {
    tab_switch: 'Tab Switch',
    no_face: 'No Face Detected',
    multiple_faces: 'Multiple Faces',
    orientation_away: 'Looking Away',
    identity_mismatch: 'Identity Mismatch',
    clipboard_activity: 'Clipboard',
    fullscreen_exit: 'Fullscreen Exit',
    right_click_attempt: 'Right-Click',
    normal: 'Normal Activity',
    submit: 'Exam Submitted',
  };
  return labels[type] ?? type.replace(/_/g, ' ');
}

function relativeTime(iso: string): string {
  if (!iso) return 'Just now';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 5000) return 'Just now';
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

function formatActiveTime(startedAt?: string): string {
  if (!startedAt) return '< 1m';
  const diff = Math.max(0, Date.now() - new Date(startedAt).getTime());
  const mins = Math.floor(diff / 60_000);
  const secs = Math.floor((diff % 60_000) / 1000);
  if (mins === 0) return `${secs}s`;
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

// ─── WS status indicator ─────────────────────────────────────────────────────

function WSStatusIndicator({ status }: { status: string }) {
  const cfg: Record<string, { cls: string; label: string; ping: boolean; dot: string }> = {
    open:       { cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', label: 'Live Hub', ping: true, dot: 'bg-emerald-400' },
    connecting: { cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30',   label: 'Connecting…', ping: true, dot: 'bg-yellow-400' },
    closed:     { cls: 'bg-orange-500/10 text-orange-400 border-orange-500/30',   label: 'Reconnecting…', ping: false, dot: 'bg-orange-400' },
    error:      { cls: 'bg-red-500/10 text-red-400 border-red-500/30',            label: 'Disconnected', ping: false, dot: 'bg-red-500' },
  };
  const c = cfg[status] ?? cfg.closed;
  return (
    <div className={`inline-flex items-center gap-2 text-xs font-semibold px-2.5 py-1 rounded-full border ${c.cls}`}>
      <span className="relative flex h-2 w-2">
        {c.ping && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-60 ${c.dot}`} />}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${c.dot}`} />
      </span>
      <span>{c.label}</span>
    </div>
  );
}

// ─── Student Card ────────────────────────────────────────────────────────────

interface StudentCardProps {
  session: SessionSummary;
  selected: boolean;
  onClick: () => void;
}

function StudentCard({ session, selected, onClick }: StudentCardProps) {
  const rStyles = riskBadgeStyles(session.riskScore);
  const sStyles = statusBadgeStyles(session.status);
  const isHighRisk = session.riskScore >= 70;

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
      className={`
        group relative flex flex-col rounded-2xl border transition-all duration-200 cursor-pointer text-left overflow-hidden
        bg-gray-900/90 hover:bg-gray-900
        ${rStyles.cardBorder}
        ${selected ? 'ring-2 ring-violet-500 ring-offset-2 ring-offset-gray-950 scale-[1.02]' : 'hover:scale-[1.015] hover:shadow-xl'}
        ${isHighRisk ? 'ring-1 ring-red-500/50 shadow-lg shadow-red-500/15' : ''}
      `}
    >
      {/* ── Top Thumbnail Section ─────────────────────────────────────────── */}
      <div className="relative w-full aspect-[4/3] bg-gray-950/80 overflow-hidden border-b border-white/[0.06]">
        {session.thumbnailBase64 ? (
          <img
            src={session.thumbnailBase64}
            alt={session.studentName}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            style={{ transform: 'scaleX(-1)' }}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-gray-600 bg-gradient-to-b from-gray-900 to-gray-950">
            <span className="text-3xl opacity-40">👤</span>
            <span className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Awaiting Feed</span>
          </div>
        )}

        {/* Status dot overlay top-left */}
        <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-[10px] font-semibold text-white">
          <span className={`w-1.5 h-1.5 rounded-full ${sStyles.dot}`} />
          <span>{sStyles.label}</span>
        </div>

        {/* Risk Score badge top-right */}
        <div className={`absolute top-2.5 right-2.5 px-2.5 py-0.5 rounded-full text-xs font-black backdrop-blur-md ${rStyles.badge}`}>
          {session.riskScore}
          <span className="text-[9px] font-normal opacity-80 ml-0.5">/100</span>
        </div>

        {/* Time Active overlay bottom-left */}
        <div className="absolute bottom-2 left-2 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-sm border border-white/10 text-[9px] font-mono text-gray-300">
          ⏱️ {formatActiveTime(session.startedAt)}
        </div>
      </div>

      {/* ── Info Body ────────────────────────────────────────────────────── */}
      <div className="p-3.5 flex flex-col gap-2">
        {/* Name and ID */}
        <div>
          <h3 className="text-sm font-bold text-white truncate group-hover:text-violet-300 transition-colors">
            {session.studentName}
          </h3>
          <p className="text-[10px] font-mono text-gray-400 truncate">
            {session.sessionId}
          </p>
        </div>

        {/* Violations & Risk Level Strip */}
        <div className="flex items-center justify-between text-xs pt-1 border-t border-white/[0.05]">
          <span className="text-gray-400 font-medium">
            <span className={`font-bold ${session.violationCount > 0 ? 'text-amber-400' : 'text-gray-300'}`}>
              {session.violationCount}
            </span> violation{session.violationCount !== 1 ? 's' : ''}
          </span>
          <span className={`text-[10px] font-bold uppercase tracking-wider ${rStyles.text}`}>
            {getRiskCategory(session.riskScore)} Risk
          </span>
        </div>

        {/* Last event pill */}
        {session.lastEventType ? (
          <div className="flex items-center gap-1.5 text-[11px] text-gray-300 bg-white/[0.03] px-2 py-1 rounded-lg border border-white/[0.05] truncate">
            <span className="flex-shrink-0">{eventIcon(session.lastEventType)}</span>
            <span className="truncate font-medium">{eventLabel(session.lastEventType)}</span>
            <span className="text-gray-400 text-[10px] ml-auto flex-shrink-0 font-mono">
              {relativeTime(session.lastEventAt)}
            </span>
          </div>
        ) : (
          <div className="text-[10px] text-gray-400 italic px-2 py-1">
            No events reported yet
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Alert Feed Item ─────────────────────────────────────────────────────────

function AlertFeedItem({ alert }: { alert: HubAlert }) {
  const sc = severityStyles(alert.severity);
  return (
    <div className="group flex gap-2.5 p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] hover:bg-white/[0.05] transition-colors">
      <div className="text-lg leading-none mt-0.5 flex-shrink-0">
        {eventIcon(alert.eventType)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap mb-1">
          <span className="text-xs font-bold text-gray-200 truncate">{alert.studentName}</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded ring-1 ${sc}`}>
            {alert.severity.toUpperCase()}
          </span>
          <span className="text-[10px] text-gray-400 font-mono ml-auto">
            {relativeTime(alert.timestamp)}
          </span>
        </div>
        <p className="text-xs text-gray-300 font-medium truncate">
          {eventLabel(alert.eventType)}
        </p>
        {alert.aiExplanation && (
          <p className="text-[11px] text-gray-400 mt-1 leading-snug line-clamp-2 group-hover:line-clamp-none transition-all">
            {alert.aiExplanation}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Detail Drawer (Slide-Over Modal) ────────────────────────────────────────

interface DetailDrawerProps {
  session: SessionSummary;
  onClose: () => void;
}

function DetailDrawer({ session, onClose }: DetailDrawerProps) {
  const rStyles = riskBadgeStyles(session.riskScore);
  const sStyles = statusBadgeStyles(session.status);

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[460px] bg-gray-900/98 backdrop-blur-xl border-l border-white/10 shadow-2xl flex flex-col">
      {/* Drawer Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 flex-shrink-0 bg-gray-950/60">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`w-3 h-3 rounded-full flex-shrink-0 ${sStyles.dot}`} />
          <div className="min-w-0">
            <h2 className="text-base font-bold text-white truncate">{session.studentName}</h2>
            <p className="text-xs text-gray-400 font-mono truncate">{session.sessionId}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          title="Close details"
        >
          ✕
        </button>
      </div>

      {/* Drawer Body */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scroll">
        {/* Large Thumbnail Preview */}
        <div>
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Live Webcam Feed</h3>
          <div className={`relative rounded-2xl overflow-hidden border-2 bg-gray-950 aspect-video ${rStyles.cardBorder}`}>
            {session.thumbnailBase64 ? (
              <img
                src={session.thumbnailBase64}
                alt={session.studentName}
                className="w-full h-full object-cover"
                style={{ transform: 'scaleX(-1)' }}
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-gray-600">
                <span className="text-4xl opacity-30">👤</span>
                <span className="text-xs text-gray-500">No snapshot received yet</span>
              </div>
            )}
            <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/70 backdrop-blur-md text-[10px] font-mono text-gray-300">
              Exam ID: {session.examId}
            </div>
          </div>
        </div>

        {/* Risk Gauge & Metrics */}
        <div className="p-4 rounded-2xl bg-white/[0.03] border border-white/[0.08] flex flex-col items-center">
          <RiskIndicator score={session.riskScore} />

          {/* Quick Metrics Grid */}
          <div className="grid grid-cols-3 gap-2 w-full mt-4 text-center">
            <div className="p-2.5 rounded-xl bg-gray-800/60 border border-white/5">
              <p className="text-lg font-black text-white">{session.violationCount}</p>
              <p className="text-[10px] uppercase font-semibold text-gray-400">Violations</p>
            </div>
            <div className="p-2.5 rounded-xl bg-gray-800/60 border border-white/5">
              <p className="text-sm font-black text-white mt-1 capitalize">{session.status}</p>
              <p className="text-[10px] uppercase font-semibold text-gray-400">Status</p>
            </div>
            <div className="p-2.5 rounded-xl bg-gray-800/60 border border-white/5">
              <p className="text-sm font-black text-white mt-1 font-mono">{formatActiveTime(session.startedAt)}</p>
              <p className="text-[10px] uppercase font-semibold text-gray-400">Duration</p>
            </div>
          </div>
        </div>

        {/* Violation Log & Timeline */}
        <div>
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
            Recent Violation Timeline
          </h3>
          {session.recentViolations && session.recentViolations.length > 0 ? (
            <div className="space-y-2.5">
              {[...session.recentViolations].reverse().map((v) => {
                const sc = severityStyles(v.severity);
                return (
                  <div
                    key={v.id}
                    className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.07] hover:bg-white/[0.06] transition-colors"
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="text-base">{eventIcon(v.type)}</span>
                      <span className="text-xs font-bold text-white capitalize">{v.type} Violation</span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ring-1 ml-auto ${sc}`}>
                        {v.severity.toUpperCase()}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] text-gray-400 font-mono">
                      <span>Confidence: {Math.round(v.aiConfidence * 100)}%</span>
                      <span>{relativeTime(v.timestamp)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-8 rounded-xl bg-white/[0.01] border border-dashed border-white/10 text-gray-500 text-xs">
              No violations recorded for this student yet.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Professor Dashboard Component ──────────────────────────────────────

export function ProfessorDashboard() {
  const [examId, setExamId] = useState<string>(() => {
    return new URLSearchParams(window.location.search).get('exam') || 'exam-1';
  });

  const { sessions, alerts, status } = useHubSocket({ examId });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'risk_desc' | 'risk_asc' | 'violations' | 'name'>('risk_desc');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Synchronize examId to URL query param
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('exam') !== examId) {
      url.searchParams.set('exam', examId);
      window.history.replaceState({}, '', url.toString());
    }
  }, [examId]);

  // All session objects as an array
  const sessionList = useMemo(() => Object.values(sessions), [sessions]);

  // Status counts
  const totalStudents = sessionList.length;
  const activeStudents = sessionList.filter((s) => s.status === 'active').length;
  const highRiskStudents = sessionList.filter((s) => s.riskScore >= 70).length;
  const disconnectedStudents = sessionList.filter((s) => s.status === 'disconnected').length;
  const submittedStudents = sessionList.filter((s) => s.status === 'submitted').length;

  // Filter and Sort
  const filteredAndSortedSessions = useMemo(() => {
    return sessionList
      .filter((s) => {
        // Search filter
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          const matchesName = s.studentName.toLowerCase().includes(q);
          const matchesId = s.sessionId.toLowerCase().includes(q);
          if (!matchesName && !matchesId) return false;
        }

        // Status filter
        if (filterStatus === 'active') return s.status === 'active';
        if (filterStatus === 'high_risk') return s.riskScore >= 70;
        if (filterStatus === 'disconnected') return s.status === 'disconnected';
        if (filterStatus === 'submitted') return s.status === 'submitted';
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'risk_desc') return b.riskScore - a.riskScore;
        if (sortBy === 'risk_asc') return a.riskScore - b.riskScore;
        if (sortBy === 'violations') return b.violationCount - a.violationCount;
        if (sortBy === 'name') return a.studentName.localeCompare(b.studentName);
        return 0;
      });
  }, [sessionList, searchQuery, filterStatus, sortBy]);

  const selectedSession = selectedId ? sessions[selectedId] : null;

  return (
    <div className="min-h-screen bg-gray-950 text-white font-sans flex flex-col selection:bg-violet-500 selection:text-white">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-white/[0.08] bg-gray-900/95 backdrop-blur-md sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-4">

          {/* Left: Branding & Exam ID Selector */}
          <div className="flex items-center gap-3.5 flex-wrap">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-violet-600 to-indigo-500 flex items-center justify-center text-lg shadow-lg shadow-violet-500/25 border border-violet-400/30">
              🛡️
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-white">Live Proctoring Monitor</h1>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-300 font-mono border border-violet-500/30">
                  Phase 3a
                </span>
              </div>

              {/* Exam ID selector */}
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-gray-400">Exam:</span>
                <select
                  value={examId}
                  onChange={(e) => setExamId(e.target.value)}
                  className="bg-gray-800 text-xs text-violet-300 font-medium px-2 py-1 rounded-md border border-white/10 hover:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors"
                >
                  {PRESET_EXAMS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Right: Status Pills & WebSocket Indicator */}
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            {/* Total students pill */}
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs font-semibold text-gray-300">
              <span>👥</span>
              <span>{totalStudents} Total</span>
            </div>

            {/* Active pill */}
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-xs font-semibold text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>{activeStudents} Active</span>
            </div>

            {/* High risk pill */}
            <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${
              highRiskStudents > 0
                ? 'bg-red-500/15 border-red-500/40 text-red-300 animate-pulse'
                : 'bg-white/[0.04] border-white/[0.08] text-gray-400'
            }`}>
              <span>🚨</span>
              <span>{highRiskStudents} High Risk</span>
            </div>

            {/* Disconnected pill */}
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs font-semibold text-gray-400">
              <span>⚪</span>
              <span>{disconnectedStudents} Offline</span>
            </div>

            {/* Live Hub status dot */}
            <WSStatusIndicator status={status} />
          </div>
        </div>
      </header>

      {/* ── Toolbar: Filter, Search, Sort ─────────────────────────────────── */}
      <div className="border-b border-white/[0.06] bg-gray-900/40 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">

          {/* Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 custom-scroll">
            <button
              onClick={() => setFilterStatus('all')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                filterStatus === 'all'
                  ? 'bg-violet-600 text-white shadow-md shadow-violet-600/30'
                  : 'bg-white/[0.04] text-gray-400 hover:text-white hover:bg-white/[0.08]'
              }`}
            >
              All ({totalStudents})
            </button>
            <button
              onClick={() => setFilterStatus('active')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                filterStatus === 'active'
                  ? 'bg-emerald-600 text-white shadow-md shadow-emerald-600/30'
                  : 'bg-white/[0.04] text-gray-400 hover:text-white hover:bg-white/[0.08]'
              }`}
            >
              Active ({activeStudents})
            </button>
            <button
              onClick={() => setFilterStatus('high_risk')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                filterStatus === 'high_risk'
                  ? 'bg-red-600 text-white shadow-md shadow-red-600/30'
                  : 'bg-white/[0.04] text-gray-400 hover:text-white hover:bg-white/[0.08]'
              }`}
            >
              High Risk ({highRiskStudents})
            </button>
            <button
              onClick={() => setFilterStatus('disconnected')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                filterStatus === 'disconnected'
                  ? 'bg-amber-600 text-white shadow-md shadow-amber-600/30'
                  : 'bg-white/[0.04] text-gray-400 hover:text-white hover:bg-white/[0.08]'
              }`}
            >
              Offline ({disconnectedStudents})
            </button>
            <button
              onClick={() => setFilterStatus('submitted')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${
                filterStatus === 'submitted'
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                  : 'bg-white/[0.04] text-gray-400 hover:text-white hover:bg-white/[0.08]'
              }`}
            >
              Submitted ({submittedStudents})
            </button>
          </div>

          {/* Search & Sort Controls */}
          <div className="flex items-center gap-3">
            {/* Search Input */}
            <div className="relative flex-1 md:w-56">
              <span className="absolute left-2.5 top-2 text-gray-500 text-xs">🔍</span>
              <input
                type="text"
                placeholder="Search student or ID…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-gray-800/80 border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1.5 text-gray-400 hover:text-white text-xs"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Sort Dropdown */}
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="bg-gray-800/80 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-gray-300 font-medium focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors"
            >
              <option value="risk_desc">Sort: Highest Risk</option>
              <option value="risk_asc">Sort: Lowest Risk</option>
              <option value="violations">Sort: Violations</option>
              <option value="name">Sort: Name (A-Z)</option>
            </select>
          </div>
        </div>
      </div>

      {/* ── Main Workspace ─────────────────────────────────────────────────── */}
      <div className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6 flex flex-col lg:flex-row gap-6">

        {/* ── Left: Student Cards Grid ─────────────────────────────────────── */}
        <main className="flex-1 min-w-0">
          {filteredAndSortedSessions.length === 0 ? (
            <div className="h-96 rounded-2xl border border-dashed border-white/10 flex flex-col items-center justify-center p-8 text-center bg-gray-900/30">
              <span className="text-5xl opacity-40 mb-3">🎓</span>
              <h2 className="text-base font-bold text-gray-300 mb-1">
                {totalStudents === 0 ? 'No Students in this Exam Yet' : 'No Students Match Current Filter'}
              </h2>
              <p className="text-xs text-gray-400 max-w-md leading-relaxed">
                {totalStudents === 0 ? (
                  <>
                    Students who join the exam with <code className="text-violet-400 bg-gray-800 px-1 py-0.5 rounded">?exam={examId}</code> will
                    appear here live with their webcam snapshots and risk scores.
                  </>
                ) : (
                  'Try selecting a different filter pill or clearing the search query.'
                )}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filteredAndSortedSessions.map((session) => (
                <StudentCard
                  key={session.sessionId}
                  session={session}
                  selected={selectedId === session.sessionId}
                  onClick={() => setSelectedId(selectedId === session.sessionId ? null : session.sessionId)}
                />
              ))}
            </div>
          )}
        </main>

        {/* ── Right: Live Violation Alerts Sidebar ─────────────────────────── */}
        <aside className="w-full lg:w-80 flex-shrink-0 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-gray-400">
              Live Alert Stream
            </h2>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/[0.05] text-gray-400 border border-white/[0.08]">
              {alerts.length} event{alerts.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="flex-1 max-h-[700px] overflow-y-auto space-y-2 custom-scroll pr-1">
            {alerts.length === 0 ? (
              <div className="p-6 rounded-2xl bg-gray-900/40 border border-dashed border-white/10 text-center text-gray-500 text-xs">
                No behavioral violation alerts recorded yet.
              </div>
            ) : (
              alerts.map((alert, index) => (
                <AlertFeedItem
                  key={`${alert.sessionId}-${alert.timestamp}-${index}`}
                  alert={alert}
                />
              ))
            )}
          </div>
        </aside>
      </div>

      {/* ── Detail Drawer (Slide-Over) ─────────────────────────────────────── */}
      {selectedSession && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity"
            onClick={() => setSelectedId(null)}
          />
          <DetailDrawer
            session={selectedSession}
            onClose={() => setSelectedId(null)}
          />
        </>
      )}

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.06] py-3.5 px-4 sm:px-6 text-center text-xs text-gray-400">
        Autonomous Proctoring Agent · Phase 3a Live Monitor · Cloudflare Workers AI & Durable Objects
      </footer>
    </div>
  );
}
