/**
 * ProfessorDashboard.tsx
 * ─────────────────────────────────────────────────────────────────
 * Phase 3a — Read-only live monitor for professors.
 * Phase 3b — Professor intervention panel with warn/pause/force-submit.
 *
 * Requirements:
 *   • Route /professor in React router
 *   • Header:
 *       - Exam title/ID selector (default exam-1)
 *       - Status pills: Total students, Active, High risk, Disconnected, Submitted
 *       - WebSocket connection status dot
 *   • Filter & Search Bar
 *   • Live Grid of Student Cards (sorted by risk score, with paused/terminated badges)
 *   • Detail Drawer:
 *       - Live webcam feed
 *       - Risk gauge + quick metrics
 *       - Violation timeline
 *       - Phase 3b Intervention Panel:
 *           a) Text box + "Send Warning" button with 3 quick-pick templates
 *           b) Pause / Resume toggle
 *           c) "Force Submit" behind name-confirm dialog
 *       - Intervention history with ack status
 *   • Live Alerts Feed sidebar
 *   • Real-time exam monitoring and interventions (Phase 3b & 5a)
 * ─────────────────────────────────────────────────────────────────
 */

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useHubSocket } from '../hooks/useHubSocket';
import type { CommandResult } from '../hooks/useHubSocket';
import { RiskIndicator } from '../components/RiskIndicator';
import type { SessionSummary, HubAlert, Violation, Intervention, InterventionAction, SessionView, SessionViewCounts, ProfessorAttempt } from '../types';
import { fetchExamSessions } from '../hooks/useProfessorApi';
import { SessionsView } from '../components/SessionsView';

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
      return { bg: 'bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30', dot: 'bg-emerald-400 animate-pulse', label: 'Active' };
    case 'disconnected':
      return { bg: 'bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30', dot: 'bg-amber-400', label: 'Disconnected' };
    case 'submitted':
      return { bg: 'bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/30', dot: 'bg-blue-400', label: 'Submitted' };
    case 'paused':
      return { bg: 'bg-indigo-500/15 text-indigo-400 ring-1 ring-indigo-500/30', dot: 'bg-indigo-400 animate-pulse', label: 'Paused' };
    case 'terminated':
      return { bg: 'bg-red-500/15 text-red-400 ring-1 ring-red-500/30', dot: 'bg-red-500', label: 'Terminated' };
  }
}

function severityStyles(s: Violation['severity']) {
  const m: Record<string, string> = {
    critical: 'text-red-400 bg-red-500/15 ring-red-500/30',
    high: 'text-orange-400 bg-orange-500/15 ring-orange-500/30',
    medium: 'text-amber-400 bg-amber-400/15 ring-amber-400/30',
    low: 'text-emerald-400 bg-emerald-500/15 ring-emerald-500/30',
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
    normal: '✅',
    submit: '🏁',
    thumbnail: '📷',
    intervention_warn: '⚠️',
    intervention_pause: '⏸️',
    intervention_resume: '▶️',
    intervention_force_submit: '🛑',
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
    normal: 'Normal Activity',
    submit: 'Exam Submitted',
    intervention_warn: 'Warning Sent',
    intervention_pause: 'Exam Paused',
    intervention_resume: 'Exam Resumed',
    intervention_force_submit: 'Force Submitted',
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

function actionLabel(action: InterventionAction): string {
  const m: Record<InterventionAction, string> = {
    warn: 'Warning',
    pause: 'Paused',
    resume: 'Resumed',
    force_submit: 'Force Submitted',
  };
  return m[action];
}

// ─── WS status indicator ─────────────────────────────────────────────────────

function WSStatusIndicator({ status }: { status: string }) {
  const cfg: Record<string, { cls: string; label: string; ping: boolean; dot: string }> = {
    open: { cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', label: 'Live Hub', ping: true, dot: 'bg-emerald-400' },
    connecting: { cls: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/30', label: 'Connecting…', ping: true, dot: 'bg-yellow-400' },
    closed: { cls: 'bg-orange-500/10 text-orange-400 border-orange-500/30', label: 'Reconnecting…', ping: false, dot: 'bg-orange-400' },
    error: { cls: 'bg-red-500/10 text-red-400 border-red-500/30', label: 'Disconnected', ping: false, dot: 'bg-red-500' },
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
  const isPaused = session.status === 'paused';
  const isTerminated = session.status === 'terminated';

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

        {/* Phase 3b: paused/terminated overlay tint */}
        {isPaused && (
          <div className="absolute inset-0 bg-indigo-900/60 flex items-center justify-center">
            <span className="text-3xl">⏸️</span>
          </div>
        )}
        {isTerminated && (
          <div className="absolute inset-0 bg-red-950/60 flex items-center justify-center">
            <span className="text-3xl">🛑</span>
          </div>
        )}

        {/* Status dot overlay top-left */}
        <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/60 backdrop-blur-md border border-white/10 text-[10px] font-semibold text-white">
          <span className={`w-1.5 h-1.5 rounded-full ${sStyles.dot}`} />
          <span>{sStyles.label}</span>
          {Boolean((session as any).is_test || (session as any).isTest) && (
            <span className="px-1.5 py-0.2 rounded bg-pink-500/30 text-pink-300 border border-pink-500/50 text-[9px] font-bold">
              TEST
            </span>
          )}
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
  const isIntervention = alert.kind === 'intervention';
  return (
    <div className={`group flex gap-2.5 p-3 rounded-xl border hover:bg-white/[0.05] transition-colors ${isIntervention ? 'bg-violet-500/[0.05] border-violet-500/20' : 'bg-white/[0.02] border-white/[0.06]'}`}>
      <div className="text-lg leading-none mt-0.5 flex-shrink-0">
        {eventIcon(alert.eventType)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap mb-1">
          <span className="text-xs font-bold text-gray-200 truncate">{alert.studentName}</span>
          <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded ring-1 ${sc}`}>
            {alert.severity.toUpperCase()}
          </span>
          {isIntervention && (
            <span className="text-[9px] font-bold px-1.5 py-0.2 rounded ring-1 text-violet-300 bg-violet-500/15 ring-violet-500/30">
              INTERVENTION
            </span>
          )}
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

// ─── Phase 3b: Intervention Panel ────────────────────────────────────────────

const WARN_TEMPLATES = [
  'Please look at your screen.',
  'Remove other people from view.',
  'Return to the exam tab.',
];

interface InterventionPanelProps {
  session: SessionSummary;
  onSendCommand: (action: InterventionAction, message?: string) => void;
  lastResult?: CommandResult;
}

function InterventionPanel({ session, onSendCommand, lastResult }: InterventionPanelProps) {
  const [warnMessage, setWarnMessage] = useState('');
  const [showForceConfirm, setShowForceConfirm] = useState(false);
  const [forceConfirmName, setForceConfirmName] = useState('');
  const [isSending, setIsSending] = useState(false);

  const isPaused = session.status === 'paused';
  const isTerminated = session.status === 'terminated';
  const isSubmitted = session.status === 'submitted';

  const handleSend = useCallback(async (action: InterventionAction, msg?: string) => {
    setIsSending(true);
    onSendCommand(action, msg);
    setTimeout(() => setIsSending(false), 1000);
  }, [onSendCommand]);

  const handleWarn = useCallback(() => {
    const text = warnMessage.trim() || WARN_TEMPLATES[0];
    handleSend('warn', text);
    setWarnMessage('');
  }, [warnMessage, handleSend]);

  const handleForceSubmit = useCallback(() => {
    if (forceConfirmName.trim().toLowerCase() === session.studentName.toLowerCase()) {
      handleSend('force_submit');
      setShowForceConfirm(false);
      setForceConfirmName('');
    }
  }, [forceConfirmName, session.studentName, handleSend]);

  if (isTerminated) {
    return (
      <div className="p-4 rounded-2xl bg-red-950/30 border border-red-700/40 text-center">
        <span className="text-2xl block mb-2">🛑</span>
        <p className="text-xs font-bold text-red-400">Session Terminated</p>
        <p className="text-[11px] text-gray-500 mt-1">No further interventions can be issued.</p>
      </div>
    );
  }

  if (isSubmitted) {
    return (
      <div className="p-4 rounded-2xl bg-blue-950/30 border border-blue-700/40 text-center">
        <span className="text-2xl block mb-2">🏁</span>
        <p className="text-xs font-bold text-blue-400">Exam Submitted</p>
        <p className="text-[11px] text-gray-500 mt-1">Student has completed the exam.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Command result toast */}
      {lastResult && (
        <div className={`text-[11px] px-3 py-2 rounded-xl border font-medium flex items-center gap-2 ${lastResult.status === 'delivered' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
          : lastResult.status === 'queued' ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
            : lastResult.status === 'noop' ? 'bg-gray-500/10 border-gray-500/30 text-gray-400'
              : 'bg-red-500/10 border-red-500/30 text-red-300'
          }`}>
          <span>{lastResult.status === 'delivered' ? '✓' : lastResult.status === 'queued' ? '⏳' : lastResult.status === 'noop' ? 'ℹ' : '✗'}</span>
          <span className="truncate">{lastResult.message}</span>
        </div>
      )}

      {/* Warning */}
      <div className="space-y-2">
        <label className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">
          ⚠️ Send Warning
        </label>
        <div className="flex gap-2 flex-wrap">
          {WARN_TEMPLATES.map((t) => (
            <button
              key={t}
              onClick={() => setWarnMessage(t)}
              className="text-[10px] px-2 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 transition-colors cursor-pointer"
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={warnMessage}
            onChange={(e) => setWarnMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleWarn(); }}
            placeholder="Custom warning message…"
            className="flex-1 bg-gray-800 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-amber-500 transition-colors"
          />
          <button
            onClick={handleWarn}
            disabled={isSending}
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500 hover:bg-amber-400 text-gray-900 transition-colors cursor-pointer disabled:opacity-50 flex-shrink-0"
          >
            Warn
          </button>
        </div>
      </div>

      {/* Pause / Resume */}
      <div className="flex gap-2">
        {!isPaused ? (
          <button
            onClick={() => handleSend('pause')}
            disabled={isSending}
            className="flex-1 py-2 rounded-xl text-xs font-bold bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/40 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            <span>⏸️</span><span>Pause Exam</span>
          </button>
        ) : (
          <button
            onClick={() => handleSend('resume')}
            disabled={isSending}
            className="flex-1 py-2 rounded-xl text-xs font-bold bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            <span>▶️</span><span>Resume Exam</span>
          </button>
        )}
      </div>

      {/* Force Submit */}
      {!showForceConfirm ? (
        <button
          onClick={() => setShowForceConfirm(true)}
          className="w-full py-2 rounded-xl text-xs font-bold bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/40 transition-colors cursor-pointer flex items-center justify-center gap-1.5"
        >
          <span>🛑</span><span>Force Submit</span>
        </button>
      ) : (
        <div className="p-3 rounded-xl bg-red-950/40 border border-red-700/50 space-y-2">
          <p className="text-[11px] text-red-300 font-semibold">
            Type <span className="font-black text-red-200">"{session.studentName}"</span> to confirm force-submit:
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={forceConfirmName}
              onChange={(e) => setForceConfirmName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleForceSubmit(); if (e.key === 'Escape') setShowForceConfirm(false); }}
              placeholder="Student name…"
              className="flex-1 bg-gray-800 border border-red-500/40 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-red-500"
              autoFocus
            />
            <button
              onClick={handleForceSubmit}
              disabled={forceConfirmName.trim().toLowerCase() !== session.studentName.toLowerCase()}
              className="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-red-600 hover:bg-red-500 text-white transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            >
              Confirm
            </button>
            <button
              onClick={() => { setShowForceConfirm(false); setForceConfirmName(''); }}
              className="px-2.5 py-1.5 rounded-lg text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 transition-colors cursor-pointer flex-shrink-0"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Detail Drawer (Slide-Over Modal) ────────────────────────────────────────

interface DetailDrawerProps {
  session: SessionSummary;
  onClose: () => void;
  onSendCommand: (action: InterventionAction, message?: string) => void;
  lastResult?: CommandResult;
}

function DetailDrawer({ session, onClose, onSendCommand, lastResult }: DetailDrawerProps) {
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
    <div className="fixed inset-y-0 right-0 z-50 w-full sm:w-[480px] bg-gray-900/98 backdrop-blur-xl border-l border-white/10 shadow-2xl flex flex-col">
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
        {/* Large Thumbnail Preview / Evidence Purged Notice */}
        <div>
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-2">Live Webcam Feed</h3>
          {(session as any).data_purged_at ? (
            <div className="p-6 rounded-2xl bg-amber-500/10 border border-amber-500/30 text-amber-300 flex flex-col items-center justify-center gap-2 text-center aspect-video">
              <span className="text-3xl">🛡️</span>
              <p className="font-bold text-sm">Evidence removed by retention policy</p>
              <p className="text-[11px] text-amber-300/80 max-w-xs">
                Webcam snapshots and proctoring telemetry for this session were purged on{' '}
                {new Date((session as any).data_purged_at).toLocaleDateString()}. The attempt score and submission record are preserved.
              </p>
            </div>
          ) : (
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
          )}
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

        {/* Phase 6: Open Full Integrity Report */}
        {((session as any).attemptId || (session as any).id) && (
          <a
            href={`/professor/attempts/${(session as any).attemptId || (session as any).id}/report`}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full py-2.5 px-4 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-200 border border-indigo-500/30 text-xs font-bold text-center block transition shadow"
          >
            🛡️ Open Full Integrity Report →
          </a>
        )}

        {/* Phase 3b: Intervention Panel */}
        <div>
          <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
            🎛️ Professor Interventions
          </h3>
          <InterventionPanel
            session={session}
            onSendCommand={onSendCommand}
            lastResult={lastResult}
          />
        </div>

        {/* Phase 3b: Intervention History */}
        {session.interventions && session.interventions.length > 0 && (
          <div>
            <h3 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">
              Intervention History
            </h3>
            <div className="space-y-2">
              {[...session.interventions].reverse().map((inv: Intervention) => (
                <div
                  key={inv.id}
                  className="p-3 rounded-xl bg-white/[0.02] border border-white/[0.06] flex items-start gap-2.5"
                >
                  <span className="text-base flex-shrink-0 mt-0.5">
                    {eventIcon(`intervention_${inv.action}`)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-xs font-bold text-gray-200">{actionLabel(inv.action)}</span>
                      {inv.acknowledgedAt ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30 font-semibold">
                          Acknowledged
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/30 font-semibold">
                          Pending
                        </span>
                      )}
                      <span className="text-[10px] text-gray-500 font-mono ml-auto">
                        {relativeTime(inv.issuedAt)}
                      </span>
                    </div>
                    {inv.message && (
                      <p className="text-[11px] text-gray-400 truncate">{inv.message}</p>
                    )}
                    {inv.acknowledgedAt && (
                      <p className="text-[10px] text-gray-600 mt-0.5">
                        Ack: {new Date(inv.acknowledgedAt).toLocaleTimeString()}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

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

export function ProfessorDashboard({ fixedExamId }: { fixedExamId?: string } = {}) {
  const [examId, setExamId] = useState<string>(() => {
    return fixedExamId || new URLSearchParams(window.location.search).get('exam') || 'exam-1';
  });

  useEffect(() => {
    if (fixedExamId && fixedExamId !== examId) {
      setExamId(fixedExamId);
    }
  }, [fixedExamId, examId]);

  const { sessions, alerts, status, sendCommand, commandResults } = useHubSocket({ examId });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedAttempt, setSelectedAttempt] = useState<ProfessorAttempt | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'risk_desc' | 'risk_asc' | 'violations' | 'name'>('risk_desc');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Phase 4c-2b: Session Views & Counts
  const [currentSegment, setCurrentSegment] = useState<SessionView>('live');
  const [counts, setCounts] = useState<SessionViewCounts>({
    live: 0,
    ended: 0,
    archived: 0,
    test: 0,
    unlinked: 0,
  });
  const [tableSessions, setTableSessions] = useState<ProfessorAttempt[]>([]);
  const [unlinkedList, setUnlinkedList] = useState<any[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);

  const refreshSessionsData = useCallback(async () => {
    if (!examId) return;
    setIsLoadingSessions(true);
    try {
      const data = await fetchExamSessions(examId, currentSegment);
      setCounts(data.counts);
      setTableSessions(data.sessions || []);
      if (data.unlinked) setUnlinkedList(data.unlinked);
    } catch (err) {
      console.error('Failed to load session data:', err);
    } finally {
      setIsLoadingSessions(false);
    }
  }, [examId, currentSegment]);

  useEffect(() => {
    void refreshSessionsData();
  }, [refreshSessionsData]);

  // Synchronize examId to URL query param
  useEffect(() => {
    if (fixedExamId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('exam') !== examId) {
      url.searchParams.set('exam', examId);
      window.history.replaceState({}, '', url.toString());
    }
  }, [examId, fixedExamId]);

  // Live sessions only: in_progress attempts (active, paused, disconnected) and not test
  const liveSessionList = useMemo(() => {
    return Object.values(sessions).filter((s) => {
      const isLive = s.status === 'active' || s.status === 'paused' || s.status === 'disconnected';
      const isTest = Boolean((s as any).is_test || (s as any).isTest);
      return isLive && !isTest;
    });
  }, [sessions]);

  // Status counts for live monitor
  const totalLiveStudents = liveSessionList.length;
  const activeStudents = liveSessionList.filter((s) => s.status === 'active').length;
  const highRiskStudents = liveSessionList.filter((s) => s.riskScore >= 70).length;
  const disconnectedStudents = liveSessionList.filter((s) => s.status === 'disconnected').length;
  const pausedStudents = liveSessionList.filter((s) => s.status === 'paused').length;

  // Filter and Sort for live grid
  const filteredAndSortedSessions = useMemo(() => {
    return liveSessionList
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
        if (filterStatus === 'paused') return s.status === 'paused';
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'risk_desc') return b.riskScore - a.riskScore;
        if (sortBy === 'risk_asc') return a.riskScore - b.riskScore;
        if (sortBy === 'violations') return b.violationCount - a.violationCount;
        if (sortBy === 'name') return a.studentName.localeCompare(b.studentName);
        return 0;
      });
  }, [liveSessionList, searchQuery, filterStatus, sortBy]);

  const liveSelectedSession = selectedId ? sessions[selectedId] : null;
  const displaySession: SessionSummary | null = useMemo(() => {
    if (liveSelectedSession) {
      if (selectedAttempt?.data_purged_at) {
        return { ...liveSelectedSession, data_purged_at: selectedAttempt.data_purged_at };
      }
      return liveSelectedSession;
    }
    if (selectedAttempt) {
      return {
        sessionId: selectedAttempt.id,
        examId: selectedAttempt.exam_id,
        studentName: selectedAttempt.student_name,
        startedAt: selectedAttempt.started_at ? new Date(selectedAttempt.started_at).getTime() : Date.now(),
        lastHeartbeat: selectedAttempt.submitted_at ? new Date(selectedAttempt.submitted_at).getTime() : Date.now(),
        riskScore: selectedAttempt.final_risk_score ?? 0,
        violationCount: selectedAttempt.violation_count ?? 0,
        status: (selectedAttempt.ended_reason || (selectedAttempt.status === 'in_progress' ? 'active' : selectedAttempt.status)) as any,
        interventions: [],
        data_purged_at: selectedAttempt.data_purged_at,
        is_test: selectedAttempt.is_test === 1,
      } as any;
    }
    return null;
  }, [liveSelectedSession, selectedAttempt]);

  // Get last command result for the selected session
  const lastResult = selectedId
    ? commandResults.find((r) => r.sessionId === selectedId)
    : undefined;

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
                  Phase 3b
                </span>
              </div>

              {/* Exam ID selector */}
              {!fixedExamId ? (
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
              ) : (
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-xs text-gray-400">Exam:</span>
                  <span className="text-xs font-mono font-bold text-violet-300 bg-violet-500/10 px-2 py-0.5 rounded border border-violet-500/20">
                    {fixedExamId}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Right: Status Pills & WebSocket Indicator */}
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs font-semibold text-gray-300">
              <span>👥</span>
              <span>{totalLiveStudents} Live</span>
            </div>

            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-xs font-semibold text-emerald-400">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span>{activeStudents} Active</span>
            </div>

            <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border ${highRiskStudents > 0
              ? 'bg-red-500/15 border-red-500/40 text-red-300 animate-pulse'
              : 'bg-white/[0.04] border-white/[0.08] text-gray-400'
              }`}>
              <span>🚨</span>
              <span>{highRiskStudents} High Risk</span>
            </div>

            <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs font-semibold text-gray-400">
              <span>⚪</span>
              <span>{disconnectedStudents} Offline</span>
            </div>

            {pausedStudents > 0 && (
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-xs font-semibold text-indigo-400">
                <span>⏸️</span>
                <span>{pausedStudents} Paused</span>
              </div>
            )}

            {/* Live Hub status dot */}
            <WSStatusIndicator status={status} />
          </div>
        </div>
      </header>

      {/* ── Hub Error Banner ────────────────────────────────────────── */}
      {status === 'error' && (
        <div className="bg-red-950/80 border-b border-red-500/30 px-4 py-2.5 text-xs text-red-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span>⚠️</span>
            <span>Live monitor connection disconnected or unauthorized.</span>
          </div>
        </div>
      )}

      {/* ── Segmented Control Bar (Phase 4c-2b) ───────────────────────────── */}
      <div className="border-b border-white/[0.08] bg-gray-950/70 backdrop-blur-md px-4 sm:px-6 py-2.5">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-1.5 p-1 rounded-xl bg-white/[0.04] border border-white/[0.08] flex-wrap">
            {[
              { id: 'live', label: 'Live Grid', count: counts.live, icon: '📡' },
              { id: 'ended', label: 'Ended', count: counts.ended, icon: '🏁' },
              { id: 'archived', label: 'Archived', count: counts.archived, icon: '📦' },
              { id: 'test', label: 'Test Attempts', count: counts.test, icon: '🧪' },
              { id: 'unlinked', label: 'Unlinked', count: counts.unlinked, icon: '🔗' },
            ].map((seg) => (
              <button
                key={seg.id}
                onClick={() => {
                  setCurrentSegment(seg.id as SessionView);
                  setSelectedId(null);
                  setSelectedAttempt(null);
                }}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  currentSegment === seg.id
                    ? 'bg-violet-600 text-white shadow-md shadow-violet-600/30'
                    : 'text-gray-400 hover:text-white hover:bg-white/[0.06]'
                }`}
              >
                <span>{seg.icon}</span>
                <span>{seg.label}</span>
                <span
                  className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono ${
                    currentSegment === seg.id ? 'bg-white/20 text-white' : 'bg-white/[0.08] text-gray-300'
                  }`}
                >
                  {seg.count}
                </span>
              </button>
            ))}
          </div>

          <button
            onClick={() => void refreshSessionsData()}
            disabled={isLoadingSessions}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/[0.05] hover:bg-white/[0.1] text-gray-300 hover:text-white text-xs font-medium border border-white/[0.08] transition cursor-pointer"
            title="Refresh sessions list"
          >
            <span className={isLoadingSessions ? 'animate-spin' : ''}>🔄</span>
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* ── Main View Content ────────────────────────────────────────────── */}
      {currentSegment === 'live' ? (
        <>
          {/* ── Toolbar: Filter, Search, Sort ─────────────────────────────────── */}
          <div className="border-b border-white/[0.06] bg-gray-900/40 backdrop-blur-sm">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">

              {/* Filter Pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 custom-scroll">
                {[
                  { key: 'all', label: `All (${totalLiveStudents})`, activeClass: 'bg-violet-600 text-white' },
                  { key: 'active', label: `Active (${activeStudents})`, activeClass: 'bg-emerald-600 text-white' },
                  { key: 'high_risk', label: `High Risk (${highRiskStudents})`, activeClass: 'bg-red-600 text-white' },
                  { key: 'disconnected', label: `Offline (${disconnectedStudents})`, activeClass: 'bg-amber-600 text-white' },
                  { key: 'paused', label: `Paused (${pausedStudents})`, activeClass: 'bg-indigo-600 text-white' },
                ].map(({ key, label, activeClass }) => (
                  <button
                    key={key}
                    onClick={() => setFilterStatus(key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap cursor-pointer ${filterStatus === key
                      ? `${activeClass} shadow-md`
                      : 'bg-white/[0.04] text-gray-400 hover:text-white hover:bg-white/[0.08]'
                      }`}
                  >
                    {label}
                  </button>
                ))}
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
                    {totalLiveStudents === 0 ? 'No Active Students in this Exam' : 'No Students Match Current Filter'}
                  </h2>
                  <p className="text-xs text-gray-400 max-w-md leading-relaxed">
                    {totalLiveStudents === 0 ? (
                      <>
                        Students who join the exam with <code className="text-violet-400 bg-gray-800 px-1 py-0.5 rounded">?exam={examId}</code> will
                        appear here live with their webcam snapshots and risk scores. Finished sessions appear in the <strong>Ended</strong> tab.
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
                      onClick={() => {
                        if (selectedId === session.sessionId) {
                          setSelectedId(null);
                          setSelectedAttempt(null);
                        } else {
                          setSelectedId(session.sessionId);
                          setSelectedAttempt(null);
                        }
                      }}
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
        </>
      ) : (
        <div className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6">
          <SessionsView
            view={currentSegment as 'ended' | 'archived' | 'test' | 'unlinked'}
            sessions={tableSessions}
            unlinked={unlinkedList}
            examId={examId}
            onSelectSession={(sessionId, attempt) => {
              setSelectedId(sessionId);
              setSelectedAttempt(attempt || null);
            }}
            onRefresh={() => void refreshSessionsData()}
          />
        </div>
      )}

      {/* ── Detail Drawer (Slide-Over) ─────────────────────────────────────── */}
      {displaySession && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity"
            onClick={() => {
              setSelectedId(null);
              setSelectedAttempt(null);
            }}
          />
          <DetailDrawer
            session={displaySession}
            onClose={() => {
              setSelectedId(null);
              setSelectedAttempt(null);
            }}
            onSendCommand={(action, message) => sendCommand(displaySession.sessionId, action, message)}
            lastResult={lastResult}
          />
        </>
      )}

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.06] py-3.5 px-4 sm:px-6 text-center text-xs text-gray-400">
        Autonomous Proctoring Agent · Phase 4c-2b Session Lifecycle · Cloudflare Workers AI & Durable Objects
      </footer>
    </div>
  );
}
