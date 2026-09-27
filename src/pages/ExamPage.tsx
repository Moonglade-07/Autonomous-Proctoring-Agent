/**
 * ExamPage.tsx
 * ─────────────────────────────────────────────────────────────────
 * The main exam interface for Phase 1.
 * Renders:
 *   • WebcamPreview     — placeholder camera box
 *   • RiskIndicator     — color-coded risk score gauge
 *   • EventLog          — scrollable AI event log
 *   • Simulation buttons — send behavioral events over WebSocket
 *
 * WebSocket flow:
 *   1. On mount, useWebSocket connects to ws://<host>/api/exam/<sessionId>
 *   2. DO sends a session_snapshot immediately on connect
 *   3. Button click → sendEvent() → JSON over WebSocket → DO
 *   4. DO calls Workers AI → sends risk_update back
 *   5. onMessage() updates local React state → UI re-renders
 * ─────────────────────────────────────────────────────────────────
 */

import { useState, useCallback } from 'react';
import { WebcamPreview } from '../components/WebcamPreview';
import { RiskIndicator } from '../components/RiskIndicator';
import { EventLog } from '../components/EventLog';
import { useWebSocket } from '../hooks/useWebSocket';
import type { RiskEvent, Violation, WSOutboundMsg, BehavioralEventType } from '../types';

// Generate a stable session ID for this browser tab
const SESSION_ID = `session-${Math.random().toString(36).slice(2, 10)}`;

interface SimButton {
  label: string;
  event: BehavioralEventType;
  icon: string;
  colorClass: string;
}

const SIM_BUTTONS: SimButton[] = [
  {
    label: 'Simulate Tab Switch',
    event: 'tab_switch',
    icon: '🔀',
    colorClass:
      'bg-orange-500/15 hover:bg-orange-500/25 text-orange-300 ring-1 ring-orange-500/40 hover:ring-orange-400',
  },
  {
    label: 'Simulate Face Not Detected',
    event: 'face_not_detected',
    icon: '👤',
    colorClass:
      'bg-red-500/15 hover:bg-red-500/25 text-red-300 ring-1 ring-red-500/40 hover:ring-red-400',
  },
  {
    label: 'Simulate Multiple Faces',
    event: 'multiple_faces',
    icon: '👥',
    colorClass:
      'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 ring-1 ring-rose-500/40 hover:ring-rose-400',
  },
  {
    label: 'Simulate Normal Behavior',
    event: 'normal',
    icon: '✅',
    colorClass:
      'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 ring-1 ring-emerald-500/40 hover:ring-emerald-400',
  },
];

function WSStatusDot({ status }: { status: string }) {
  const map: Record<string, { color: string; label: string }> = {
    connecting: { color: 'bg-yellow-400', label: 'Connecting…' },
    open: { color: 'bg-emerald-400', label: 'Live' },
    closed: { color: 'bg-gray-500', label: 'Reconnecting…' },
    error: { color: 'bg-red-500', label: 'Error' },
  };
  const s = map[status] ?? map.closed;
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${s.color} ${status === 'open' ? 'animate-pulse' : ''}`} />
      <span className="text-xs text-gray-500">{s.label}</span>
    </div>
  );
}

export function ExamPage() {
  const [riskScore, setRiskScore] = useState(0);
  const [riskHistory, setRiskHistory] = useState<RiskEvent[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [lastActivity, setLastActivity] = useState<string>('None');
  const [pendingEvent, setPendingEvent] = useState<string | null>(null);

  // Handle incoming WebSocket messages from the Durable Object
  const handleMessage = useCallback((msg: WSOutboundMsg) => {
    if (msg.type === 'session_snapshot') {
      // Initial state hydration on connect
      setRiskScore(msg.session.riskScore);
      setRiskHistory(msg.session.riskHistory);
      setViolations(msg.session.violations);
    } else if (msg.type === 'risk_update') {
      // Real-time update from AI analysis
      setRiskScore(msg.riskScore);
      setRiskHistory((prev) => [...prev, msg.riskEvent]);
      setViolations(msg.violations);
      setLastActivity(msg.riskEvent.triggers[0] ?? 'unknown');
      setPendingEvent(null);
    } else if (msg.type === 'error') {
      console.error('[ExamPage] Server error:', msg.message);
      setPendingEvent(null);
    }
  }, []);

  const { sendEvent, status } = useWebSocket({ sessionId: SESSION_ID, onMessage: handleMessage });

  const handleSimulate = (eventType: BehavioralEventType) => {
    setPendingEvent(eventType);
    sendEvent(eventType);
  };

  // Violation count by severity
  const criticalCount = violations.filter((v) => v.severity === 'critical').length;
  const highCount = violations.filter((v) => v.severity === 'high').length;

  return (
    <div className="min-h-screen bg-gray-950 text-white font-sans">
      {/* ── Top bar ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-white/10 bg-gray-900/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Logo */}
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center text-white font-bold text-sm shadow">
              AP
            </div>
            <div>
              <h1 className="text-sm font-bold text-white tracking-wide">Autonomous Proctoring Agent</h1>
              <p className="text-xs text-gray-500 font-mono">Session: {SESSION_ID}</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {criticalCount > 0 && (
              <span className="text-xs bg-red-500/20 text-red-400 ring-1 ring-red-500/40 px-2 py-0.5 rounded-full font-semibold">
                {criticalCount} Critical
              </span>
            )}
            {highCount > 0 && (
              <span className="text-xs bg-orange-500/20 text-orange-400 ring-1 ring-orange-500/40 px-2 py-0.5 rounded-full font-semibold">
                {highCount} High
              </span>
            )}
            <WSStatusDot status={status} />
          </div>
        </div>
      </header>

      {/* ── Main layout ─────────────────────────────────────────────────────── */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Left column — Webcam + Simulation buttons */}
        <div className="lg:col-span-1 flex flex-col gap-4">
          <WebcamPreview />

          {/* Simulation controls */}
          <div className="rounded-2xl bg-gray-900/60 border border-white/8 p-4">
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
                  className={`
                    flex items-center gap-2.5 px-4 py-2.5 rounded-xl text-sm font-medium
                    transition-all duration-200 cursor-pointer select-none
                    disabled:opacity-40 disabled:cursor-not-allowed
                    ${btn.colorClass}
                  `}
                >
                  <span className="text-base leading-none">{btn.icon}</span>
                  <span className="flex-1 text-left">{btn.label}</span>
                  {pendingEvent === btn.event && (
                    <svg className="w-3.5 h-3.5 animate-spin opacity-70" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
            {status !== 'open' && (
              <p className="text-xs text-yellow-600 mt-3 text-center animate-pulse">
                {status === 'connecting' ? 'Connecting to exam session…' : 'Reconnecting…'}
              </p>
            )}
          </div>

          {/* Stats strip */}
          <div className="rounded-2xl bg-gray-900/60 border border-white/8 p-4 grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-lg font-bold text-white">{violations.length}</p>
              <p className="text-xs text-gray-600 mt-0.5">Violations</p>
            </div>
            <div>
              <p className="text-lg font-bold text-white">{riskHistory.length}</p>
              <p className="text-xs text-gray-600 mt-0.5">Events</p>
            </div>
            <div>
              <p className="text-xs font-semibold text-gray-400 break-all mt-1">{lastActivity}</p>
              <p className="text-xs text-gray-600 mt-0.5">Last event</p>
            </div>
          </div>
        </div>

        {/* Right column — Risk score + Event log */}
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* Risk score card */}
          <div className="rounded-2xl bg-gray-900/60 border border-white/8 p-6">
            <div className="flex flex-col sm:flex-row items-center gap-6">
              <RiskIndicator score={riskScore} />
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-gray-300 mb-1">Real-time AI Risk Analysis</h3>
                <p className="text-xs text-gray-500 leading-relaxed mb-4">
                  This score is computed by Llama 3.3-70B running on Cloudflare Workers AI.
                  Each simulated behavioral event is analyzed against the full session history
                  to produce a contextual risk assessment.
                </p>

                {/* Recent violation list */}
                {violations.length > 0 && (
                  <div className="space-y-1 max-h-32 overflow-y-auto custom-scroll">
                    {[...violations].reverse().slice(0, 5).map((v) => (
                      <div key={v.id} className="flex items-center gap-2 text-xs text-gray-400">
                        <span
                          className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            v.severity === 'critical'
                              ? 'bg-red-500'
                              : v.severity === 'high'
                              ? 'bg-orange-500'
                              : v.severity === 'medium'
                              ? 'bg-yellow-500'
                              : 'bg-emerald-500'
                          }`}
                        />
                        <span className="capitalize">{v.type}</span>
                        <span className="text-gray-600">·</span>
                        <span className="capitalize font-medium text-gray-300">{v.severity}</span>
                        <span className="text-gray-600 ml-auto font-mono">
                          {Math.round(v.aiConfidence * 100)}% conf.
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Event log card */}
          <div className="flex-1 rounded-2xl bg-gray-900/60 border border-white/8 p-4 min-h-[28rem]">
            <EventLog events={riskHistory} />
          </div>
        </div>
      </main>

      {/* ── Footer ────────────────────────────────────────────────────────────── */}
      <footer className="border-t border-white/8 mt-4 py-4 text-center text-xs text-gray-700">
        Autonomous Proctoring Agent · Phase 1 · Powered by Cloudflare Workers AI + Durable Objects
      </footer>
    </div>
  );
}
