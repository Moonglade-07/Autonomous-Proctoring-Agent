/**
 * ExamPage.tsx
 * ─────────────────────────────────────────────────────────────────
 * Main exam interface — Phase 2b of the Autonomous Proctoring Agent.
 *
 * Changes from Phase 2a:
 *   • Added real-time client-side face detection using face-api.js
 *   • Live video feed is processed every 700ms to detect face count and orientation
 *   • Suspicious states (no face, multiple faces, head turned) are flagged locally
 *     and shown in the UI, but NOT yet sent to the backend.
 *
 * Architecture:
 *   - The video feed from WebcamPreview is shared via a React ref.
 *   - useFaceDetection hook runs inference on the video frames.
 *   - useBehavioralDetection still handles tab/fullscreen/clipboard events.
 * ─────────────────────────────────────────────────────────────────
 */

import { useState, useCallback, useRef } from 'react';
import { WebcamPreview } from '../components/WebcamPreview';
import { RiskIndicator } from '../components/RiskIndicator';
import { EventLog } from '../components/EventLog';
import { useWebSocket } from '../hooks/useWebSocket';
import { useBehavioralDetection } from '../hooks/useBehavioralDetection';
import { useFaceDetection } from '../hooks/useFaceDetection';
import type { RiskEvent, Violation, WSOutboundMsg } from '../types';

// ─── Session ID ──────────────────────────────────────────────────────────────
const SESSION_ID = `session-${Math.random().toString(36).slice(2, 10)}`;

// ─── WebSocket status indicators ─────────────────────────────────────────────

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

// ─── Monitoring status indicator row ─────────────────────────────────────────

interface SignalRowProps {
  label: string;
  icon: string;
  value: string | React.ReactNode;
  status: 'ok' | 'warn' | 'off' | 'error';
}

function SignalRow({ label, icon, value, status }: SignalRowProps) {
  const colors = {
    ok:    'text-emerald-400',
    warn:  'text-amber-400',
    error: 'text-red-400',
    off:   'text-gray-600',
  };
  const dotColors = {
    ok:    'bg-emerald-500',
    warn:  'bg-amber-500 animate-pulse',
    error: 'bg-red-500 animate-pulse',
    off:   'bg-gray-700',
  };
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className="text-base flex-shrink-0 select-none" aria-hidden>{icon}</span>
      <span className="text-xs text-gray-400 min-w-[6.5rem]">{label}</span>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColors[status]}`} />
      <span className={`text-xs font-medium ${colors[status]}`}>{value}</span>
    </div>
  );
}

// ─── Main page component ─────────────────────────────────────────────────────

export function ExamPage() {
  const [riskScore, setRiskScore] = useState(0);
  const [riskHistory, setRiskHistory] = useState<RiskEvent[]>([]);
  const [visibleLog, setVisibleLog] = useState<RiskEvent[]>([]);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [lastActivity, setLastActivity] = useState<string>('—');
  const [serverErrorMsg, setServerErrorMsg] = useState<string | null>(null);

  // Shared ref for the video element (used by WebcamPreview and useFaceDetection)
  const videoRef = useRef<HTMLVideoElement>(null);

  // ── WebSocket ──────────────────────────────────────────────────────────────
  const handleMessage = useCallback((msg: WSOutboundMsg) => {
    if (msg.type === 'session_snapshot') {
      setRiskScore(msg.session.riskScore);
      setRiskHistory(msg.session.riskHistory);
      setVisibleLog(msg.session.riskHistory);
      setViolations(msg.session.violations);
    } else if (msg.type === 'risk_update') {
      setRiskScore(msg.riskScore);
      setRiskHistory((prev) => [...prev, msg.riskEvent]);
      setVisibleLog((prev) => [...prev, msg.riskEvent]);
      setViolations(msg.violations);
      setLastActivity(msg.riskEvent.triggers[0] ?? 'unknown');
      setServerErrorMsg(null);
    } else if (msg.type === 'error') {
      console.error('[ExamPage] Server error:', msg.message);
      setServerErrorMsg(msg.message);
    }
  }, []);

  const { sendEvent, status } = useWebSocket({ sessionId: SESSION_ID, onMessage: handleMessage });

  // ── Behavioral detection (Phase 2a) ────────────────────────────────────────
  const { monitoringState, startMonitoring: startBehavioral, reenterFullscreen } =
    useBehavioralDetection({ sendEvent, wsStatus: status });

  // ── Face detection (Phase 2b) ──────────────────────────────────────────────
  const { faceState, pendingFlags } = useFaceDetection({
    videoRef,
    monitoringActive: monitoringState.active,
  });

  const handleStartExam = useCallback(async () => {
    await startBehavioral();
  }, [startBehavioral]);

  // ── Clear event log ────────────────────────────────────────────────────────
  const handleClearLog = () => setVisibleLog([]);

  // ── Derived stats ──────────────────────────────────────────────────────────
  const criticalCount = violations.filter((v) => v.severity === 'critical').length;
  const highCount     = violations.filter((v) => v.severity === 'high').length;

  const clipboardText = monitoringState.lastClipboard
    ? `${monitoringState.lastClipboard.action} at ${new Date(monitoringState.lastClipboard.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    : 'None';

  // ── Face state formatting ──────────────────────────────────────────────────
  let faceLabel = 'Loading models…';
  let faceStatus: 'ok' | 'warn' | 'error' | 'off' = 'off';

  if (faceState.modelState === 'error') {
    faceLabel = 'Models failed to load';
    faceStatus = 'error';
  } else if (faceState.modelState === 'ready' && !monitoringState.active) {
    faceLabel = 'Ready to monitor';
    faceStatus = 'off';
  } else if (monitoringState.active && faceState.detecting) {
    if (faceState.faceCount === 0) {
      faceLabel = 'No face detected';
      faceStatus = 'error';
    } else if (faceState.faceCount > 1) {
      faceLabel = `${faceState.faceCount} faces detected`;
      faceStatus = 'error';
    } else {
      faceLabel = '1 face detected';
      faceStatus = 'ok';
    }
  }

  let orientationLabel = '—';
  let orientationStatus: 'ok' | 'warn' | 'off' = 'off';

  if (monitoringState.active && faceState.faceCount === 1) {
    orientationLabel = faceState.orientation;
    orientationStatus = faceState.orientation === 'forward' ? 'ok' : 'warn';
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white font-sans">

      {/* ── Sticky header ───────────────────────────────────────────────────── */}
      <header className="border-b border-white/[0.08] bg-gray-900/90 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
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

          <div className="flex items-center gap-3 flex-shrink-0">
            {monitoringState.active && (
              <span className="text-xs bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40 px-2 py-0.5 rounded-full font-semibold animate-pulse">
                Monitoring
              </span>
            )}
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

      {/* ── Reconnect banner ────────────────────────────────────────────────── */}
      <WSStatusBanner status={status} />

      {/* ── Server error banner ─────────────────────────────────────────────── */}
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

      {/* ── Pending Flags (Phase 2b Local Alerts) ─────────────────────────── */}
      {pendingFlags.length > 0 && (
        <div className="mx-4 sm:mx-6 mt-3 rounded-xl border border-rose-700/40 bg-rose-950/40 px-4 py-3 flex items-center gap-3">
          <span className="text-xl flex-shrink-0 animate-pulse">🚨</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-rose-300">Pending Review (Local Only)</p>
            <div className="text-xs text-rose-500 mt-0.5 space-y-1">
              {pendingFlags.map((f, i) => (
                <p key={i}>
                  • {f.type.replace('_', ' ')} ({(f.durationMs / 1000).toFixed(1)}s)
                  {f.orientation ? ` — looking ${f.orientation}` : ''}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Fullscreen exit banner ──────────────────────────────────────────── */}
      {monitoringState.active && !monitoringState.isFullscreen && (
        <div className="mx-4 sm:mx-6 mt-3 rounded-xl border border-amber-700/40 bg-amber-950/50 px-4 py-3 flex items-center gap-3">
          <span className="text-xl flex-shrink-0">⚠️</span>
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-300">Fullscreen Required</p>
            <p className="text-xs text-amber-600 mt-0.5">
              You exited fullscreen mode. This has been recorded. Please re-enter to continue the exam.
            </p>
          </div>
          <button
            id="reenter-fullscreen-btn"
            onClick={reenterFullscreen}
            className="flex-shrink-0 px-4 py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-semibold rounded-lg ring-1 ring-amber-500/40 transition-colors cursor-pointer"
          >
            Re-enter Fullscreen
          </button>
        </div>
      )}

      {/* ── Face Model Error Fallback ──────────────────────────────────────── */}
      {faceState.modelState === 'error' && (
        <div className="mx-4 sm:mx-6 mt-3 rounded-xl border border-gray-700/40 bg-gray-800/40 px-4 py-2 flex items-center gap-3">
          <span className="text-base flex-shrink-0">ℹ️</span>
          <p className="text-xs text-gray-400">
            Face monitoring unavailable (models failed to load). Continuing with other proctoring signals.
          </p>
        </div>
      )}

      {/* ── Hero banner ─────────────────────────────────────────────────────── */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-5 pb-1">
        <div className="rounded-2xl bg-gradient-to-r from-violet-950/60 via-indigo-950/50 to-blue-950/40 border border-violet-700/20 px-5 py-4">
          <p className="text-sm text-gray-300 leading-relaxed">
            <span className="font-semibold text-white">Phase 2b — Local Face Detection — </span>
            The browser now runs <span className="text-emerald-400 font-medium">face-api.js</span>{' '}
            locally on the webcam feed to track face count and head orientation in real time.
            Suspicious states are flagged locally for review (sending to backend AI is coming in Phase 2c).
            Tab/clipboard/fullscreen behaviors continue to flow to the backend.
          </p>
        </div>
      </div>

      {/* ── Main grid ───────────────────────────────────────────────────────── */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 py-5 grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* ── Left column: Webcam + Monitoring + Stats ──────────────────────── */}
        <div className="lg:col-span-1 flex flex-col gap-4">

          {/* Webcam */}
          <WebcamPreview
            videoRef={videoRef}
            faceOverlay={
              monitoringState.active && faceState.detecting && (
                <div className="bg-black/60 backdrop-blur-sm border border-white/10 px-2 py-1 rounded-lg flex items-center gap-2">
                  <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">Face</span>
                  <div className={`w-2 h-2 rounded-full ${faceStatus === 'ok' ? 'bg-emerald-500' : 'bg-rose-500 animate-pulse'}`} />
                  <span className="text-xs font-mono font-medium text-white/90">
                    {faceState.faceCount > 0 ? `${faceState.faceCount}` : '0'}
                  </span>
                </div>
              )
            }
          />

          {/* Start Exam / Monitoring panel */}
          <div className="rounded-2xl bg-gray-900/60 border border-white/[0.07] p-4">
            {!monitoringState.active ? (
              /* ── Pre-exam: Start button ──────────────────────────────── */
              <div className="flex flex-col items-center py-4 gap-4">
                <div className="text-center">
                  <h2 className="text-sm font-bold text-gray-200 mb-1">Ready to Begin?</h2>
                  <p className="text-xs text-gray-500 leading-relaxed max-w-[220px]">
                    Clicking below will enter fullscreen mode and begin monitoring for behavioral violations.
                  </p>
                </div>
                <button
                  id="start-exam-btn"
                  onClick={handleStartExam}
                  disabled={status !== 'open' || faceState.modelState === 'loading'}
                  className="
                    w-full px-6 py-3 rounded-xl text-sm font-bold cursor-pointer select-none
                    bg-gradient-to-r from-violet-600 to-indigo-600
                    hover:from-violet-500 hover:to-indigo-500
                    text-white shadow-lg shadow-violet-900/40
                    transition-all duration-200
                    disabled:opacity-40 disabled:cursor-not-allowed
                    active:scale-[0.98]
                  "
                >
                  {faceState.modelState === 'loading' ? 'Loading AI Models…' : '🛡️ Start Exam'}
                </button>
                {status !== 'open' && (
                  <p className="text-xs text-yellow-600 animate-pulse">
                    Waiting for connection…
                  </p>
                )}
              </div>
            ) : (
              /* ── Active monitoring: signal indicators ────────────── */
              <div>
                <div className="flex items-center gap-2 mb-3 border-b border-white/5 pb-2">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-500 opacity-60" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                  </span>
                  <h2 className="text-xs font-bold tracking-[0.18em] text-emerald-400 uppercase">
                    Monitoring Active
                  </h2>
                </div>

                {/* Face AI Signals */}
                <div className="space-y-0.5 mb-2 border-b border-white/5 pb-2">
                  <h3 className="text-[10px] font-bold tracking-wider text-gray-500 uppercase mb-1.5 px-1">Vision AI (Local)</h3>
                  <SignalRow
                    label="Face Detection"
                    icon="👤"
                    value={faceLabel}
                    status={faceStatus}
                  />
                  <SignalRow
                    label="Orientation"
                    icon="🧭"
                    value={<span className="capitalize">{orientationLabel}</span>}
                    status={orientationStatus}
                  />
                </div>

                {/* Behavioral Signals */}
                <div className="space-y-0.5">
                  <h3 className="text-[10px] font-bold tracking-wider text-gray-500 uppercase mb-1.5 px-1 pt-1">Behavior (Backend)</h3>
                  <SignalRow
                    label="Tab Focus"
                    icon="🔀"
                    value={monitoringState.tabFocused ? 'Focused' : 'Switched Away'}
                    status={monitoringState.tabFocused ? 'ok' : 'warn'}
                  />
                  <SignalRow
                    label="Fullscreen"
                    icon="🖥️"
                    value={monitoringState.isFullscreen ? 'Active' : 'Exited'}
                    status={monitoringState.isFullscreen ? 'ok' : 'warn'}
                  />
                  <SignalRow
                    label="Clipboard"
                    icon="📋"
                    value={clipboardText}
                    status={monitoringState.lastClipboard ? 'warn' : 'ok'}
                  />
                  <SignalRow
                    label="Right-clicks"
                    icon="🚫"
                    value={monitoringState.rightClickCount > 0 ? `${monitoringState.rightClickCount} blocked` : 'None'}
                    status={monitoringState.rightClickCount > 0 ? 'warn' : 'ok'}
                  />
                </div>
              </div>
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
                  Real behavioral signals are analyzed against the full session history to produce
                  contextual risk scores and natural-language explanations.
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
          <span>Autonomous Proctoring Agent · Phase 2b</span>
          <span>Powered by Cloudflare Workers AI · Durable Objects · WebSockets</span>
        </div>
      </footer>
    </div>
  );
}
