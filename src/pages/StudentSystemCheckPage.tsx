/**
 * src/pages/StudentSystemCheckPage.tsx — Pre-Flight System Readiness Check (Phase 5c)
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates camera access, fullscreen capability, browser features, and network latency.
 * Stores non-sensitive check outcome in localStorage and provides troubleshooting hints.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useRef } from 'react';
import { StudentNav } from '../components/StudentNav';

interface CheckItem {
  id: string;
  name: string;
  status: 'pending' | 'checking' | 'passed' | 'failed';
  detail: string;
  fixHint?: string;
}

const STORAGE_KEY = 'apa_last_system_check';

export function StudentSystemCheckPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [lastCheckTime, setLastCheckTime] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const [checks, setChecks] = useState<CheckItem[]>([
    {
      id: 'camera',
      name: 'Webcam & Video Feed',
      status: 'pending',
      detail: 'Checks camera availability and video capture permissions.',
      fixHint: 'Ensure your webcam is connected and browser permissions are set to "Allow".',
    },
    {
      id: 'fullscreen',
      name: 'Fullscreen Support',
      status: 'pending',
      detail: 'Verifies browser supports window locking and fullscreen API.',
      fixHint: 'Ensure you are using a standard desktop browser without kiosk blockers.',
    },
    {
      id: 'browser',
      name: 'Browser Compatibility & WebSockets',
      status: 'pending',
      detail: 'Checks WebSocket, local storage, and real-time streaming features.',
      fixHint: 'Update to the latest version of Chrome, Edge, Firefox, or Safari.',
    },
    {
      id: 'network',
      name: 'Server Connectivity & Latency',
      status: 'pending',
      detail: 'Measures round-trip latency to the proctoring API.',
      fixHint: 'Check your internet connection or switch from VPN/cellular to Wi-Fi/Ethernet.',
    },
  ]);

  // Load last check on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { time: string; passed: boolean };
        setLastCheckTime(parsed.time);
      }
    } catch {}
  }, []);

  // Cleanup camera stream on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const runAllChecks = async () => {
    setRunning(true);

    const updated = [...checks];

    // 1. Camera check
    updated[0].status = 'checking';
    setChecks([...updated]);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera API not supported in this browser');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      updated[0].status = 'passed';
      updated[0].detail = 'Camera feed active and permission granted.';
    } catch (err) {
      updated[0].status = 'failed';
      updated[0].detail = err instanceof Error ? err.message : 'Camera access denied or device unavailable.';
    }
    setChecks([...updated]);

    // 2. Fullscreen check
    updated[1].status = 'checking';
    setChecks([...updated]);

    const isFullscreenSupported =
      document.fullscreenEnabled ||
      (document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled ||
      false;

    if (isFullscreenSupported) {
      updated[1].status = 'passed';
      updated[1].detail = 'Fullscreen mode is fully supported by your browser.';
    } else {
      updated[1].status = 'failed';
      updated[1].detail = 'Browser does not permit entering fullscreen mode.';
    }
    setChecks([...updated]);

    // 3. Browser & WebSocket check
    updated[2].status = 'checking';
    setChecks([...updated]);

    const hasWebSocket = typeof window.WebSocket !== 'undefined';
    const hasLocalStorage = typeof window.localStorage !== 'undefined';
    const hasCrypto = typeof window.crypto !== 'undefined';

    if (hasWebSocket && hasLocalStorage && hasCrypto) {
      updated[2].status = 'passed';
      updated[2].detail = 'WebSockets, Storage, and modern Web APIs available.';
    } else {
      updated[2].status = 'failed';
      updated[2].detail = 'Missing required browser APIs (WebSockets or Crypto).';
    }
    setChecks([...updated]);

    // 4. Latency check: 3 sequential timed pings to /api/health
    updated[3].status = 'checking';
    setChecks([...updated]);

    try {
      const latencies: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const res = await fetch('/api/health', { cache: 'no-store' });
        const end = performance.now();
        if (!res.ok) throw new Error(`Health check returned HTTP ${res.status}`);
        latencies.push(end - start);
      }
      const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
      updated[3].status = avgLatency < 500 ? 'passed' : 'failed';
      updated[3].detail = `Average server latency: ${avgLatency}ms (Min: ${Math.round(Math.min(...latencies))}ms, Max: ${Math.round(Math.max(...latencies))}ms)`;
    } catch (err) {
      updated[3].status = 'failed';
      updated[3].detail = err instanceof Error ? err.message : 'Failed to reach API server.';
    }
    setChecks([...updated]);

    // Record result in localStorage
    const nowIso = new Date().toISOString();
    setLastCheckTime(nowIso);
    try {
      const allPassed = updated.every((c) => c.status === 'passed');
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ time: nowIso, passed: allPassed }),
      );
    } catch {}

    setRunning(false);
  };

  const allPassed = checks.every((c) => c.status === 'passed');
  const hasFailed = checks.some((c) => c.status === 'failed');

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <StudentNav />

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-10 w-full flex-1 space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-950/70 border border-indigo-800/60 text-indigo-300 text-xs font-semibold mb-3">
              <span>🩺</span> System Diagnostics
            </div>
            <h1 className="text-3xl font-extrabold text-white tracking-tight">
              Pre-Flight System Check
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              Verify your camera, browser features, and network connection before entering an exam.
            </p>
          </div>

          <button
            onClick={() => void runAllChecks()}
            disabled={running}
            className="px-5 py-2.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {running ? (
              <>
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                <span>Running Checks…</span>
              </>
            ) : (
              <span>Start System Check</span>
            )}
          </button>
        </div>

        {/* Last check timestamp indicator */}
        {lastCheckTime && (
          <div className="text-xs text-slate-400 flex items-center gap-2">
            <span>⏱️ Last checked: {new Date(lastCheckTime).toLocaleString()}</span>
          </div>
        )}

        {/* Overall Status Banner */}
        {allPassed && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/30 p-4 flex items-center gap-3">
            <span className="text-2xl">🎉</span>
            <div>
              <p className="text-sm font-bold text-emerald-300">Your system is ready for testing!</p>
              <p className="text-xs text-emerald-400/80">
                All pre-flight hardware, browser, and network checks passed successfully.
              </p>
            </div>
          </div>
        )}

        {hasFailed && (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/30 p-4 flex items-center gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <p className="text-sm font-bold text-rose-300">One or more checks failed</p>
              <p className="text-xs text-rose-400/80">
                Review the issues below and apply the fix hints before joining your exam.
              </p>
            </div>
          </div>
        )}

        {/* Checks Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            {checks.map((item) => (
              <div
                key={item.id}
                className={`p-4 rounded-xl border transition-all ${
                  item.status === 'passed'
                    ? 'bg-slate-900/80 border-emerald-500/30'
                    : item.status === 'failed'
                    ? 'bg-rose-950/20 border-rose-500/40'
                    : item.status === 'checking'
                    ? 'bg-indigo-950/20 border-indigo-500/40 animate-pulse'
                    : 'bg-slate-900/40 border-slate-800'
                }`}
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-white">{item.name}</h2>
                  <div>
                    {item.status === 'passed' && (
                      <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                        ✓ Passed
                      </span>
                    )}
                    {item.status === 'failed' && (
                      <span className="text-[11px] font-semibold text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/30">
                        ✕ Failed
                      </span>
                    )}
                    {item.status === 'checking' && (
                      <span className="text-[11px] font-semibold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/30">
                        ⏳ Checking…
                      </span>
                    )}
                    {item.status === 'pending' && (
                      <span className="text-[11px] font-medium text-slate-500 bg-white/5 px-2 py-0.5 rounded">
                        Not checked
                      </span>
                    )}
                  </div>
                </div>

                <p className="text-xs text-slate-300 mt-2">{item.detail}</p>

                {item.status === 'failed' && item.fixHint && (
                  <div className="mt-3 p-2.5 rounded-lg bg-rose-950/40 border border-rose-800/40 text-[11px] text-rose-300">
                    <strong>💡 Fix hint:</strong> {item.fixHint}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Video Preview Panel */}
          <div className="rounded-2xl bg-slate-900/60 border border-slate-800 p-5 flex flex-col items-center justify-center min-h-[300px]">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 self-start">
              Camera Live Preview
            </h3>
            <div className="w-full aspect-video rounded-xl bg-slate-950 border border-slate-800 overflow-hidden flex items-center justify-center relative">
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover mirror"
              />
              {!streamRef.current && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-500 p-4 text-center">
                  <span className="text-3xl mb-2">📷</span>
                  <span className="text-xs">
                    Click &quot;Start System Check&quot; to test your camera.
                  </span>
                </div>
              )}
            </div>
            <p className="text-[11px] text-slate-500 mt-3 text-center">
              Video is analyzed locally and via Workers AI. Video streams are never recorded or stored continuously.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
