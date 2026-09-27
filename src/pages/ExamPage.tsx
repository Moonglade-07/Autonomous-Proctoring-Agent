/**
 * ExamPage.tsx
 * ─────────────────────────────────────────────────────────────────
 * Main exam interface — Phase 1 of the Autonomous Proctoring Agent.
 *
 * This page demonstrates real-time AI-powered exam proctoring using:
 *   • Cloudflare Workers AI (Llama 3.3-70B) for risk reasoning
 *   • Durable Objects for per-session state persistence
 *   • WebSockets for real-time bidirectional communication
 *   • React frontend served from Cloudflare Workers Static Assets
 *
 * WebSocket flow:
 *   1. On mount, useWebSocket connects to ws://<host>/api/exam/<sessionId>
 *   2. Durable Object sends a session_snapshot immediately on connect
 *   3. Button click → sendEvent() → JSON over WebSocket → Durable Object
 *   4. DO calls Workers AI (Llama 3.3-70B) → sends risk_update back
 *   5. onMessage() updates local React state → UI re-renders
 * ─────────────────────────────────────────────────────────────────
 */

import { useState, useCallback } from 'react';
import { WebcamPreview } from '../components/WebcamPreview';
import { RiskIndicator } from '../components/RiskIndicator';
import { EventLog } from '../components/EventLog';
import { useWebSocket } from '../hooks/useWebSocket';
import type { RiskEvent, Violation, WSOutboundMsg, BehavioralEventType } from '../types';

// ─── Session ID ──────────────────────────────────────────────────────────────
// Stable per browser tab — each new tab creates an independent proctoring session.
const SESSION_ID = `session-${Math.random().toString(36).slice(2, 10)}`;

// ─── Simulation button configuration ────────────────────────────────────────
interface SimButton {
  label: string;
  event: BehavioralEventType;
  icon: string;
  colorClass: string;
  description: string;
}

const SIM_BUTTONS: SimButton[] = [
  {
    label: 'Tab Switch',
    event: 'tab_switch',
    icon: '🔀',
    colorClass: 'bg-orange-500/15 hover:bg-orange-500/25 text-orange-300 ring-1 ring-orange-500/40 hover:ring-orange-400',
    description: 'Simulates the student switching to another browser tab',
  },
  {
    label: 'Face Not Detected',
    event: 'face_not_detected',
    icon: '👤',
    colorClass: 'bg-red-500/15 hover:bg-red-500/25 text-red-300 ring-1 ring-red-500/40 hover:ring-red-400',
    description: 'Simulates the student moving out of the camera frame',
  },
  {
    label: 'Multiple Faces',
    event: 'multiple_faces',
    icon: '👥',
    colorClass: 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 ring-1 ring-rose-500/40 hover:ring-rose-400',
    description: 'Simulates another person appearing in the camera view',
  },
  {
    label: 'Normal Behavior',
    event: 'normal',
    icon: '✅',
    colorClass: 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-500/40 hover:ring-emerald-400',
    description: 'Simulates compliant exam behavior (reduces risk score)',
  },
];

// ─── WebSocket status indicator ──────────────────────────────────────────────
function WSStatusBanner({ status }: { status: string }) {
  if (status === 'open') return null;

  const config: Record<string, { bg: string; text: string; msg: string; icon: string }> = {
    connecting: {
      bg: 'bg-yellow-950/60 border-yellow-700/40',
      text: 'text-yellow-400',
      icon: '⏳',
      msg: 'Connecting to exam session…',
    },
    closed: {
      bg: 'bg-orange-950/60 border-orange-700/40',
      text: 'text-orange-400',
      icon: '🔄',
      msg: 'Connection lost — reconnecting automatically…',
    },
    error: {
      bg: 'bg-red-950/60 border-red-700/40',
      text: 'text-red-400',
      icon: '⚠️',
      msg: 'WebSocket error — attempting to reconnect…',
    },
  };

  const c = config[status] ?? config.closed;
  return (
    <div className={`mx-4 sm:mx-6 mt-4 rounded-xl border px-4 py-2.5 flex items-center gap-2 ${c.bg}`}>
      <span className="text-base">{c.icon}</span>
      <span className={`text-xs font-medium ${c.text}`}>{c.msg}</span>
      <span className="ml-auto">
        <svg className="w-3.5 h-3.5 animate-spin text-gray-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      </span>
    </div>
  );
}

function WSStatusDot({ status }: { status: string }) {
  const map: Record<string, { color: string; ping: boolean; label: string }> = {
    connecting: { color: 'bg-yellow-400', ping: true, label: 'Connecting…' },
    open:       { color: 'bg-emerald-400', ping: true, label: 'Live' },
    closed:     { color: 'bg-orange-400', ping: false, label: 'Reconnecting…' },
    error:      { color: 'bg-red-500', ping: false, label: 'Error' },
  };
  const s = map[status] ?? map.closed;
  return (
    <div className="flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        {s.ping && <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${s.color} opacity-60`} />}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${s.color}`} />
      </span>
      <span className="text-xs text-gray-500">{s.label}</span>
    </div>
  );
}

// ─── Main page component ─────────────────────────────────────────────────────
export function ExamPage() {
  const [riskScore, setRiskScore] = useState(0);
  const [riskHistory, setRiskHistory] = useState<RiskEvent[]>([]);
  const [visibleLog, setVisibleLog] = useState<RiskEvent[]>([]); // local view (clearable)
  const [violations, setViolations] = useState<Violation[]>([]);
  const [lastActivity, setLastActivity] = useState<string>('—');
  const [pendingEvent, setPendingEvent] = useState<string | null>(null);
  const [serverErrorMsg, setServerErrorMsg] = useState<string | null>(null);

  // ── Handle incoming WebSocket messages from the Durable Object ────────────
  const handleMessage = useCallback((msg: WSOutboundMsg) => {
    if (msg.type === 'session_snapshot') {
      // Initial state hydration sent by the DO immediately on WebSocket connect
      setRiskScore(msg.session.riskScore);
      setRiskHistory(msg.session.riskHistory);
      setVisibleLog(msg.session.riskHistory);
      setViolations(msg.session.violations);

    } else if (msg.type === 'risk_update') {
      // Real-time update after the DO has called Workers AI and persisted state
      setRiskScore(msg.riskScore);
      setRiskHistory((prev) => [...prev, msg.riskEvent]);
      setVisibleLog((prev) => [...prev, msg.riskEvent]);
      setViolations(msg.violations);
      setLastActivity(msg.riskEvent.triggers[0] ?? 'unknown');
      setPendingEvent(null);
      setServerErrorMsg(null);

    } else if (msg.type === 'error') {
      // Workers AI or server-side error — surface it in the UI
      console.error('[ExamPage] Server error:', msg.message);
      setServerErrorMsg(msg.message);
      setPendingEvent(null);
    }
  }, []);

  const { sendEvent, status } = useWebSocket({ sessionId: SESSION_ID, onMessage: handleMessage });

  // ── Send a behavioral event over WebSocket ────────────────────────────────
  const handleSimulate = (eventType: BehavioralEventType) => {
    setPendingEvent(eventType);
    setServerErrorMsg(null);
    sendEvent(eventType);
  };

  // ── Clear event log view (does not reset backend session) ─────────────────
  const handleClearLog = () => setVisibleLog([]);

  // ── Derived stats ─────────────────────────────────────────────────────────
  const criticalCount = violations.filter((v) => v.severity === 'critical').length;
  const highCount     = violations.filter((v) => v.severity === 'high').length;

  return (
    <div className="min-h-screen bg-gray-950 text-white font-sans">

      {/* ── Sticky header ───────────────────────────────────────────────────── */}
      <header className="border-b border-white/[0.08] bg-gray-900/90 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          {/* Branding */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white font-bold text-sm shadow-lg shadow-violet-900/30">
              AP
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-white tracking-wide truncate">
                Autonomous Proctoring Agent
              </h1>
              <p className="text-xs text-gray-600 font-mono truncate">Session: {SESSION_ID}</p>
            </div>
          </div>

          {/* Right side: violation badges + WS status */}
          <div className="flex items-center gap-3 flex-shrink-0">
            {criticalCount > 0 && (
              <span className="text-xs bg-red-500/15 text-red-400 ring-1 ring-red-500/40 px-2 py-0.5 rounded-full font-semibold">
                {criticalCount} Critical
              </span>
            )}
            {highCount > 0 && (
              <span className="text-xs bg-orange-500/15 text-orange-400 ring-1 ring-orange-500/40 px-2 py-0.5 rounded-full font-semibold">
                {highCount} High
              </span>
            )}
            <WSStatusDot status={status} />
          </div>
        </div>
      </header>

      {/* ── Reconnect / error banner (shown when WS is not open) ────────────── */}
      <WSStatusBanner status={status} />

      {/* ── Server-side error banner ─────────────────────────────────────────── */}
      {serverErrorMsg && (
        <div className="mx-4 sm:mx-6 mt-3 rounded-xl border border-red-700/30 bg-red-950/40 px-4 py-2.5 flex items-start gap-2">
          <span className="text-base flex-shrink-0">⚠️</span>
          <div>
            <p className="text-xs font-semibold text-red-400">AI Response Error</p>
            <p className="text-xs text-red-600 mt-0.5">{serverErrorMsg}</p>
          </div>
          <button
            onClick={() => setServerErrorMsg(null)}
            className="ml-auto text-red-700 hover:text-red-500 transition-colors text-lg leading-none"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* ── Hero description banner ──────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-5 pb-1">
        <div className="rounded-2xl bg-gradient-to-r from-violet-950/60 via-indigo-950/50 to-blue-950/40 border border-violet-700/20 px-5 py-4">
          <p className="text-sm text-gray-300 leading-relaxed">
            <span className="font-semibold text-white">Phase 1 Demo — </span>
            This interface demonstrates real-time AI-powered exam proctoring.
            Click a simulation button to send a behavioral event over{' '}
            <span className="text-violet-400 font-medium">WebSocket</span> to a{' '}
            <span className="text-indigo-400 font-medium">Cloudflare Durable Object</span>,
            which calls{' '}
            <span className="text-blue-400 font-medium">Workers AI (Llama 3.3-70B)</span>{' '}
            to reason about risk, persist session memory, and stream the result back in real time.
          </p>
        </div>
      </div>

      {/* ── Main 3-column grid ───────────────────────────────────────────────── */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-5 grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* ── Left column: Webcam + Controls + Stats ───────────────────────── */}
        <div className="lg:col-span-1 flex flex-col gap-4">

          {/* Webcam */}
          <WebcamPreview />

          {/* Simulation controls */}
          <div className="rounded-2xl bg-gray-900/60 border border-white/[0.07] p-4">
            <h2 className="text-xs font-bold tracking-[0.18em] text-gray-500 uppercase mb-3">
              Simulate Behavioral Event
            </h2>
            <div className="grid grid-cols-1 gap-2">
              {SIM_BUTTONS.map((btn) => (
                <button
                  key={btn.event}
                  id={`sim-btn-${btn.event}`}
                  onClick={() => handleSimulate(btn.event)}
                  disabled={status !== 'open' || pendingEvent !== null}
                  title={btn.description}
                  className={`
                    flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm font-medium
                    transition-all duration-200 cursor-pointer select-none text-left
                    disabled:opacity-40 disabled:cursor-not-allowed
                    ${btn.colorClass}
                  `}
                >
                  <span className="text-base leading-none flex-shrink-0">{btn.icon}</span>
                  <span className="flex-1">{btn.label}</span>
                  {pendingEvent === btn.event && (
                    <svg className="w-3.5 h-3.5 animate-spin opacity-70 flex-shrink-0" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
            {pendingEvent && (
              <p className="text-xs text-gray-600 mt-3 text-center">
                Waiting for AI analysis…
              </p>
            )}
          </div>

          {/* Session stats strip */}
          <div className="rounded-2xl bg-gray-900/60 border border-white/[0.07] p-4 grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-xl font-bold text-white tabular-nums">{violations.length}</p>
              <p className="text-xs text-gray-600 mt-0.5 uppercase tracking-wide">Violations</p>
            </div>
            <div>
              <p className="text-xl font-bold text-white tabular-nums">{riskHistory.length}</p>
              <p className="text-xs text-gray-600 mt-0.5 uppercase tracking-wide">Events</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-300 break-words leading-tight mt-1 capitalize">
                {lastActivity.replace(/_/g, ' ')}
              </p>
              <p className="text-xs text-gray-600 mt-0.5 uppercase tracking-wide">Last</p>
            </div>
          </div>
        </div>

        {/* ── Right column: Risk score + Event log ─────────────────────────── */}
        <div className="lg:col-span-2 flex flex-col gap-4">

          {/* Risk analysis card */}
          <div className="rounded-2xl bg-gray-900/60 border border-white/[0.07] p-5">
            <div className="flex flex-col sm:flex-row items-center gap-6">
              <RiskIndicator score={riskScore} />
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-semibold text-gray-200 mb-1.5">
                  Real-time AI Risk Analysis
                </h3>
                <p className="text-xs text-gray-500 leading-relaxed mb-4">
                  Computed by <span className="text-violet-400">Llama 3.3-70B</span> on Cloudflare Workers AI.
                  Each event is analyzed against the full session history to produce a contextual
                  risk score and natural-language explanation.
                </p>

                {/* Recent violations */}
                {violations.length > 0 ? (
                  <div className="space-y-1.5 max-h-36 overflow-y-auto custom-scroll">
                    {[...violations].reverse().slice(0, 6).map((v) => (
                      <div key={v.id} className="flex items-center gap-2 text-xs">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            v.severity === 'critical' ? 'bg-red-500'
                            : v.severity === 'high'   ? 'bg-orange-500'
                            : v.severity === 'medium' ? 'bg-yellow-500'
                            : 'bg-emerald-500'
                          }`}
                        />
                        <span className="capitalize text-gray-500">{v.type}</span>
                        <span className="text-gray-700">·</span>
                        <span className={`capitalize font-semibold ${
                          v.severity === 'critical' ? 'text-red-400'
                          : v.severity === 'high'   ? 'text-orange-400'
                          : v.severity === 'medium' ? 'text-yellow-400'
                          : 'text-emerald-400'
                        }`}>
                          {v.severity}
                        </span>
                        <span className="text-gray-700 ml-auto font-mono">
                          {Math.round(v.aiConfidence * 100)}% conf.
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-700 italic">No violations recorded yet.</p>
                )}
              </div>
            </div>
          </div>

          {/* Event log card */}
          <div className="flex-1 rounded-2xl bg-gray-900/60 border border-white/[0.07] p-4 min-h-[26rem] flex flex-col">
            <EventLog events={visibleLog} onClear={handleClearLog} />
          </div>
        </div>
      </main>

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.07] mt-4 py-4 px-4 sm:px-6">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-gray-700">
          <span>Autonomous Proctoring Agent · Phase 1</span>
          <span>Powered by Cloudflare Workers AI · Durable Objects · WebSockets</span>
        </div>
      </footer>
    </div>
  );
}
