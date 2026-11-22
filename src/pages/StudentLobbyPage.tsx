/**
 * src/pages/StudentLobbyPage.tsx — Student Exam Lobby & Pre-Flight System Checks (Phase 4c-1)
 *
 * Route: /student/lobby/:examId
 *
 * Features:
 *   • Displays exam title, course code, duration, rules summary
 *   • Countdown timer if start window has not opened yet
 *   • 3 automated system checks with pass/fail marks & fix hints:
 *       1. Camera permission & stream test
 *       2. Fullscreen capability check
 *       3. Browser compatibility check (WebSockets, WebRTC, Canvas)
 *   • "Begin Exam" button: enables ONLY when checks pass and exam window is open
 *   • Continues into /exam?exam=:examId&name=:name (identity capture, proctoring, questions)
 */

import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import type { StudentExamSummary } from '../types';

interface SystemCheck {
  id: 'camera' | 'fullscreen' | 'browser';
  name: string;
  status: 'checking' | 'pass' | 'fail';
  detail: string;
  fixHint?: string;
}

export function StudentLobbyPage() {
  const { examId } = useParams<{ examId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const studentName = user?.name || '';

  const [exam, setExam] = useState<StudentExamSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Video preview element for camera test
  const videoRef = useRef<HTMLVideoElement>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  // System checks state
  const [checks, setChecks] = useState<Record<string, SystemCheck>>({
    camera: {
      id: 'camera',
      name: 'Webcam & Video Feed',
      status: 'checking',
      detail: 'Requesting camera access…',
      fixHint: 'Click the camera/lock icon in your browser URL bar and allow Camera permission.',
    },
    fullscreen: {
      id: 'fullscreen',
      name: 'Fullscreen Capability',
      status: 'checking',
      detail: 'Verifying fullscreen API support…',
      fixHint: 'Ensure you are running the browser in a standard desktop window, not an embedded iframe.',
    },
    browser: {
      id: 'browser',
      name: 'Browser Compatibility',
      status: 'checking',
      detail: 'Checking WebRTC, WebSockets, and Canvas APIs…',
      fixHint: 'Please use an up-to-date Chrome, Edge, Safari, or Firefox browser.',
    },
  });

  // Countdown timer state
  const [secondsUntilStart, setSecondsUntilStart] = useState<number | null>(null);
  const [windowClosed, setWindowClosed] = useState(false);

  // Load Exam Metadata
  useEffect(() => {
    if (!examId) return;
    setLoading(true);
    fetch(`/api/student/exams/${examId}`)
      .then(async (r) => {
        const ct = r.headers.get('content-type');
        if (!r.ok) {
          if (ct && ct.includes('application/json')) {
            const err = (await r.json()) as { error?: string };
            throw new Error(err.error || `HTTP ${r.status}`);
          }
          throw new Error(`HTTP ${r.status}`);
        }
        return r.json() as Promise<{ exam: StudentExamSummary }>;
      })
      .then((data) => {
        setExam(data.exam);
        // Check window
        const now = Date.now();
        if (data.exam.start_time) {
          const startMs = new Date(data.exam.start_time).getTime();
          if (startMs > now) {
            setSecondsUntilStart(Math.ceil((startMs - now) / 1000));
          } else {
            setSecondsUntilStart(0);
          }
        } else {
          setSecondsUntilStart(0);
        }

        if (data.exam.end_time) {
          const endMs = new Date(data.exam.end_time).getTime();
          if (endMs < now) {
            setWindowClosed(true);
          }
        }
      })
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, [examId]);

  // Window Countdown Interval
  useEffect(() => {
    if (secondsUntilStart === null || secondsUntilStart <= 0) return;
    const interval = setInterval(() => {
      setSecondsUntilStart((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [secondsUntilStart]);

  // ── Run System Checks ──────────────────────────────────────────────────────
  const runChecks = async () => {
    // 1. Browser check
    const hasWs = typeof WebSocket !== 'undefined';
    const hasMedia = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const hasCanvas = typeof HTMLCanvasElement !== 'undefined';

    if (hasWs && hasMedia && hasCanvas) {
      setChecks((prev) => ({
        ...prev,
        browser: {
          id: 'browser',
          name: 'Browser Compatibility',
          status: 'pass',
          detail: 'WebSockets, WebRTC, and Canvas APIs supported',
        },
      }));
    } else {
      setChecks((prev) => ({
        ...prev,
        browser: {
          id: 'browser',
          name: 'Browser Compatibility',
          status: 'fail',
          detail: 'Missing required web platform APIs',
          fixHint: 'Please switch to an updated modern browser (Chrome, Edge, Firefox, or Safari).',
        },
      }));
    }

    // 2. Fullscreen check
    const fsEnabled = Boolean(
      document.fullscreenEnabled ||
      (document as unknown as Record<string, boolean>).webkitFullscreenEnabled,
    );
    setChecks((prev) => ({
      ...prev,
      fullscreen: {
        id: 'fullscreen',
        name: 'Fullscreen Capability',
        status: fsEnabled ? 'pass' : 'fail',
        detail: fsEnabled
          ? 'Fullscreen display is supported and allowed'
          : 'Fullscreen mode is blocked or disabled',
        fixHint: 'Ensure you are not taking the test inside a restricted sandboxed iframe.',
      },
    }));

    // 3. Camera check
    try {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      mediaStreamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => { });
      }

      setChecks((prev) => ({
        ...prev,
        camera: {
          id: 'camera',
          name: 'Webcam & Video Feed',
          status: 'pass',
          detail: 'Camera connected and delivering video frames',
        },
      }));
    } catch (err) {
      setChecks((prev) => ({
        ...prev,
        camera: {
          id: 'camera',
          name: 'Webcam & Video Feed',
          status: 'fail',
          detail: err instanceof Error ? err.message : 'Camera permission denied or unavailable',
          fixHint: 'Allow camera access in your browser settings and reconnect your webcam.',
        },
      }));
    }
  };

  useEffect(() => {
    void runChecks();
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const allChecksPass =
    checks.camera?.status === 'pass' &&
    checks.fullscreen?.status === 'pass' &&
    checks.browser?.status === 'pass';

  const windowOpen = (secondsUntilStart === null || secondsUntilStart <= 0) && !windowClosed;
  const canBegin = allChecksPass && windowOpen && !loading && !loadError;

  function handleBegin() {
    if (!canBegin || !exam) return;
    // Stop local lobby stream so ExamPage can acquire its own stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    navigate(`/student/exam/${encodeURIComponent(exam.id)}`);
  }

  function formatCountdown(secs: number): string {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white font-sans flex flex-col">
      {/* Header */}
      <header className="border-b border-white/[0.08] bg-gray-900/60 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center text-lg">
              🎓
            </div>
            <div>
              <h1 className="text-sm font-bold text-white">Student Exam Lobby</h1>
              <p className="text-[11px] text-gray-400">Autonomous Proctoring System</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400">Student:</span>
            <span className="text-xs font-semibold text-indigo-300 bg-indigo-500/10 px-2.5 py-1 rounded-lg border border-indigo-500/20">
              {studentName || 'Anonymous'}
            </span>
            <Link
              to="/student"
              className="text-xs text-gray-400 hover:text-white px-2 py-1 transition-colors"
            >
              Exit
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-6 py-8 flex-1 flex flex-col gap-6 w-full">
        {loadError && (
          <div className="p-4 rounded-xl bg-red-950/40 border border-red-500/40 text-red-200 text-sm">
            ⚠️ {loadError}
          </div>
        )}

        {/* Exam Card */}
        {exam && (
          <div className="bg-gray-900/80 border border-white/10 rounded-2xl p-6 sm:p-8 shadow-xl">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <span className="text-[11px] font-bold text-indigo-400 uppercase tracking-wider">
                  {exam.course_code || 'EXAM'}
                </span>
                <h2 className="text-xl sm:text-2xl font-bold text-white mt-1">{exam.title}</h2>
                {exam.description && (
                  <p className="text-xs sm:text-sm text-gray-400 mt-2 max-w-2xl leading-relaxed">
                    {exam.description}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-4 bg-white/[0.04] border border-white/8 rounded-xl px-4 py-3">
                <div className="text-center">
                  <span className="text-[10px] text-gray-500 uppercase font-semibold block">
                    Duration
                  </span>
                  <span className="text-sm sm:text-base font-bold text-white font-mono">
                    {exam.duration_minutes} min
                  </span>
                </div>
              </div>
            </div>

            {/* Countdown / Window Banner */}
            {secondsUntilStart !== null && secondsUntilStart > 0 && (
              <div className="mt-6 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xl">⏳</span>
                  <div>
                    <h4 className="text-xs font-bold text-amber-300">Exam Window Opens Soon</h4>
                    <p className="text-[11px] text-amber-200/80">
                      You are in the lobby. The Begin Exam button will unlock automatically.
                    </p>
                  </div>
                </div>
                <div className="text-base font-mono font-bold text-amber-300 px-3 py-1 rounded bg-amber-500/20">
                  {formatCountdown(secondsUntilStart)}
                </div>
              </div>
            )}

            {windowClosed && (
              <div className="mt-6 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-xs font-medium">
                ⛔ The scheduled window for this exam has already closed.
              </div>
            )}
          </div>
        )}

        {/* Two-Column Grid: System Readiness & Video Check */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Left Column: System Checks */}
          <div className="bg-gray-900/60 border border-white/10 rounded-2xl p-6 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-gray-200 uppercase tracking-wider">
                  1. System Readiness Checks
                </h3>
                <button
                  onClick={() => void runChecks()}
                  className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer"
                >
                  🔄 Re-check
                </button>
              </div>

              <div className="space-y-4">
                {Object.values(checks).map((chk) => (
                  <div
                    key={chk.id}
                    className="p-3.5 rounded-xl bg-white/[0.02] border border-white/5 space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white">{chk.name}</span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider ${chk.status === 'pass'
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : chk.status === 'fail'
                            ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                            : 'bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse'
                          }`}
                      >
                        {chk.status === 'pass' ? '✓ Passed' : chk.status === 'fail' ? '✗ Failed' : 'Checking…'}
                      </span>
                    </div>

                    <p className="text-[11px] text-gray-400">{chk.detail}</p>

                    {chk.status === 'fail' && chk.fixHint && (
                      <p className="text-[10px] text-amber-300/90 bg-amber-500/10 p-2 rounded-lg border border-amber-500/20 leading-relaxed">
                        💡 <strong>Fix:</strong> {chk.fixHint}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-white/5">
              <span className="text-xs text-gray-400">
                All 3 checks must pass before starting the exam.
              </span>
            </div>
          </div>

          {/* Right Column: Camera Test Preview & Rules */}
          <div className="flex flex-col gap-6">
            {/* Live Camera Preview */}
            <div className="bg-gray-900/60 border border-white/10 rounded-2xl p-6">
              <h3 className="text-sm font-bold text-gray-200 uppercase tracking-wider mb-3">
                2. Live Camera Preview
              </h3>
              <div className="relative aspect-video rounded-xl overflow-hidden bg-black/60 border border-white/10 flex items-center justify-center">
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />
                {checks.camera?.status !== 'pass' && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center bg-black/80">
                    <span className="text-3xl">📷</span>
                    <span className="text-xs text-gray-400 font-medium">
                      Camera preview not active
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Exam Rules Summary */}
            <div className="bg-gray-900/60 border border-white/10 rounded-2xl p-6">
              <h3 className="text-sm font-bold text-gray-200 uppercase tracking-wider mb-3">
                3. Proctoring Guidelines
              </h3>
              <ul className="text-xs text-gray-400 space-y-2 list-disc list-inside leading-relaxed">
                <li>Exam runs in <strong>strict fullscreen mode</strong>.</li>
                <li>Switching browser tabs or applications will trigger AI warnings.</li>
                <li>Your webcam must stay active with your face centered and visible.</li>
                <li>Identity reference is checked periodically during the session.</li>
              </ul>
            </div>
          </div>
        </div>

        {/* Bottom Action Bar */}
        <div className="flex items-center justify-between pt-4 border-t border-white/10 flex-wrap gap-4">
          <Link
            to="/student"
            className="text-xs font-semibold text-gray-400 hover:text-white transition-colors"
          >
            ← Cancel & Return to Portal
          </Link>

          <button
            id="begin-exam-btn"
            onClick={handleBegin}
            disabled={!canBegin}
            className={`px-8 py-3.5 rounded-xl text-sm font-bold transition-all shadow-xl ${canBegin
              ? 'bg-gradient-to-r from-emerald-600 to-indigo-600 hover:from-emerald-500 hover:to-indigo-500 text-white shadow-emerald-900/40 cursor-pointer active:scale-[0.98]'
              : 'bg-gray-800 text-gray-500 cursor-not-allowed border border-white/5'
              }`}
          >
            {!allChecksPass
              ? 'Complete System Checks to Begin'
              : !windowOpen
                ? 'Waiting for Exam Window…'
                : '🚀 Begin Exam Now →'}
          </button>
        </div>
      </main>
    </div>
  );
}

