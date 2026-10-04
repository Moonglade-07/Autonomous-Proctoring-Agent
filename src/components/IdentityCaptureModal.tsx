/**
 * IdentityCaptureModal.tsx
 * ─────────────────────────────────────────────────────────────────
 * Phase 2c (enhanced): Identity verification modal with live camera
 * feed, oval face guide, and real-time quality feedback.
 *
 * Flow:
 *   1. Live camera view with oval guide overlay
 *   2. Face detection runs continuously — oval border changes color:
 *      🔴 Red: no face / wrong orientation / bad positioning
 *      🟡 Yellow: face roughly OK but borderline
 *      🟢 Green: face well-centered, forward-facing, good distance
 *   3. "Capture" button only enabled when green
 *   4. On capture → shows thumbnail + confirm/retake
 *   5. Retake returns to the live oval-guided view
 * ─────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useRef, useCallback, type RefObject } from 'react';
import * as faceapi from 'face-api.js';
import type { ReferenceCapture } from '../hooks/useFaceDetection';

// ─── Types ───────────────────────────────────────────────────────────────────

type QualityLevel = 'none' | 'poor' | 'borderline' | 'good';

interface QualityState {
  level: QualityLevel;
  hint: string;
}

interface IdentityCaptureModalProps {
  onCapture: () => Promise<{ success: boolean; error?: string; capture?: ReferenceCapture }>;
  onConfirm: () => void;
  onCancel: () => void;
  /** Shared video ref from ExamPage — the live webcam feed */
  videoRef: RefObject<HTMLVideoElement | null>;
}

type ModalStep = 'live' | 'capturing' | 'captured';

// ─── Oval dimensions (relative to the video container) ──────────────────────

const OVAL_WIDTH_RATIO = 0.35;  // 35% of container width (passport-photo style)
const OVAL_HEIGHT_RATIO = 0.65; // 65% of container height

// ─── Quality assessment ─────────────────────────────────────────────────────

function assessQuality(
  detection: faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }> | null,
  videoW: number,
  videoH: number,
): QualityState {
  if (!detection) {
    return { level: 'none', hint: 'No face detected — position your face in the oval' };
  }

  const box = detection.detection.box;
  const landmarks = detection.landmarks;
  const positions = landmarks.positions;

  // Orientation check using landmarks
  if (positions.length >= 68) {
    const noseTip = positions[30];
    const leftEyeInner = positions[39];
    const rightEyeInner = positions[42];
    const leftEyeOuter = positions[36];
    const rightEyeOuter = positions[45];
    const chin = positions[8];

    const eyeCenterX = (leftEyeInner.x + rightEyeInner.x) / 2;
    const eyeCenterY = (leftEyeInner.y + rightEyeInner.y) / 2;
    const faceWidth = Math.abs(rightEyeOuter.x - leftEyeOuter.x);

    if (faceWidth > 10) {
      // NOTE: faceapi processes the unmirrored raw video.
      const yawRatio = (noseTip.x - eyeCenterX) / faceWidth;
      const eyeToChinDist = chin.y - eyeCenterY;
      const eyeToNoseDist = noseTip.y - eyeCenterY;
      const pitchRatio = eyeToChinDist > 10 ? eyeToNoseDist / eyeToChinDist : 0;

      if (Math.abs(yawRatio) > 0.35) {
        return { level: 'poor', hint: 'Look straight at the camera' };
      }
      if (pitchRatio > 0.7 || pitchRatio < 0.3) {
        return { level: 'poor', hint: 'Look straight at the camera' };
      }
      // Borderline yaw (relaxed from 0.18)
      if (Math.abs(yawRatio) > 0.25) {
        return { level: 'borderline', hint: 'Almost — face the camera a bit more' };
      }
    }
  }

  // Normalize face center (0.0 to 1.0) relative to raw video dimensions
  const faceCX = (box.x + box.width / 2) / videoW;
  const faceCY = (box.y + box.height / 2) / videoH;

  // The video is mirrored for the user, so a face on the left side of the raw video (faceCX < 0.5)
  // appears on the right side of the UI. We flip X to match what the user sees.
  const visibleCX = 1 - faceCX;

  // Center check — oval is exactly in the center (0.5, 0.5)
  const offX = Math.abs(visibleCX - 0.5);
  const offY = Math.abs(faceCY - 0.5);

  if (offX > 0.15 || offY > 0.15) {
    return { level: 'poor', hint: 'Center your face in the oval' };
  }
  if (offX > 0.08 || offY > 0.08) {
    return { level: 'borderline', hint: 'Almost centered — adjust slightly' };
  }

  // Size check — using face height relative to video height
  // The oval is 65% of container height. We want the face to fill a good portion of it.
  const faceToVideoHeightRatio = box.height / videoH;

  if (faceToVideoHeightRatio < 0.30) {
    return { level: 'poor', hint: 'Move closer to the camera' };
  }
  if (faceToVideoHeightRatio > 0.75) {
    return { level: 'poor', hint: 'Move further from the camera' };
  }
  if (faceToVideoHeightRatio < 0.40) {
    return { level: 'borderline', hint: 'A little closer would be better' };
  }

  return { level: 'good', hint: 'Perfect — hold still and capture' };
}

// ─── Component ───────────────────────────────────────────────────────────────

export function IdentityCaptureModal({ onCapture, onConfirm, onCancel, videoRef }: IdentityCaptureModalProps) {
  const [step, setStep] = useState<ModalStep>('live');
  const [thumbnail, setThumbnail] = useState<string>('');
  const [quality, setQuality] = useState<QualityState>({ level: 'none', hint: 'Initializing camera…' });
  const [captureError, setCaptureError] = useState<string>('');

  const containerRef = useRef<HTMLDivElement>(null);
  const loopRef = useRef<number | null>(null);
  const activeRef = useRef(true);

  // ── Live quality detection loop ────────────────────────────────────────────

  const runQualityCheck = useCallback(async () => {
    const video = videoRef.current;
    const container = containerRef.current;
    if (!video || video.readyState < 2 || !container) return;

    try {
      const detection = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
        .withFaceLandmarks(true); // tiny landmarks — fast

      const q = assessQuality(
        detection ?? null,
        video.videoWidth,
        video.videoHeight,
      );
      if (activeRef.current) {
        setQuality(q);
      }
    } catch {
      // Silently ignore detection errors during quality feedback
    }
  }, [videoRef]);

  useEffect(() => {
    if (step !== 'live') {
      if (loopRef.current !== null) {
        clearInterval(loopRef.current);
        loopRef.current = null;
      }
      return;
    }

    activeRef.current = true;

    // Start quality check loop
    const timer = window.setInterval(() => {
      if (activeRef.current && !document.hidden) {
        runQualityCheck();
      }
    }, 500);
    loopRef.current = timer;

    // Run immediately
    runQualityCheck();

    return () => {
      activeRef.current = false;
      if (loopRef.current !== null) {
        clearInterval(loopRef.current);
        loopRef.current = null;
      }
    };
  }, [step, runQualityCheck]);

  // ── Capture handler ────────────────────────────────────────────────────────

  const handleCapture = async () => {
    setStep('capturing');
    setCaptureError('');

    const result = await onCapture();

    if (result.success && result.capture) {
      setThumbnail(result.capture.thumbnailDataUrl);
      setStep('captured');
    } else {
      setCaptureError(result.error ?? 'Capture failed');
      setStep('live'); // Go back to live view to retry
    }
  };

  const handleRetake = () => {
    setThumbnail('');
    setCaptureError('');
    setStep('live');
  };

  // ── Oval border color ──────────────────────────────────────────────────────

  const ovalColors: Record<QualityLevel, { border: string; shadow: string; text: string }> = {
    none:       { border: 'border-red-500/70',    shadow: 'shadow-red-500/20',    text: 'text-red-400' },
    poor:       { border: 'border-red-500/70',    shadow: 'shadow-red-500/20',    text: 'text-red-400' },
    borderline: { border: 'border-amber-400/70',  shadow: 'shadow-amber-400/20',  text: 'text-amber-400' },
    good:       { border: 'border-emerald-400/70', shadow: 'shadow-emerald-400/20', text: 'text-emerald-400' },
  };

  const oc = ovalColors[quality.level];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md">
      <div className="bg-gray-900 border border-white/10 rounded-3xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden">

        {/* Header */}
        <div className="px-6 pt-5 pb-3 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white text-base shadow-lg shadow-cyan-900/30">
              🔐
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Identity Verification</h2>
              <p className="text-[11px] text-gray-500">Position your face in the oval below</p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5">

          {/* ── Live view / Capturing ──────────────────────────────── */}
          {(step === 'live' || step === 'capturing') && (
            <div className="space-y-4">

              {/* Video container with oval overlay */}
              <div
                ref={containerRef}
                className="relative w-full aspect-[4/3] rounded-2xl overflow-hidden bg-black border border-gray-800"
              >
              {/* Mirror the video feed using a canvas — the actual <video> is 
                   managed by WebcamPreview; we draw from it here */}
                <canvas
                  ref={(canvas) => {
                    if (!canvas) return;
                    const video = videoRef.current;
                    if (!video) return;
                    let raf: number;
                    const draw = () => {
                      if (!canvas.parentElement) return; // unmounted
                      const ctx = canvas.getContext('2d');
                      if (ctx && video.readyState >= 2) {
                        canvas.width = canvas.clientWidth;
                        canvas.height = canvas.clientHeight;
                        // Mirror horizontally
                        ctx.save();
                        ctx.scale(-1, 1);
                        ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
                        ctx.restore();
                      }
                      raf = requestAnimationFrame(draw);
                    };
                    draw();
                    // Cleanup via MutationObserver — when canvas is removed from DOM, stop
                    const obs = new MutationObserver(() => {
                      if (!canvas.parentElement) {
                        cancelAnimationFrame(raf);
                        obs.disconnect();
                      }
                    });
                    if (canvas.parentElement) {
                      obs.observe(canvas.parentElement, { childList: true });
                    }
                  }}
                  className="absolute inset-0 w-full h-full object-cover"
                />

                {/* Dim overlay with oval cutout using SVG mask */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 400 300" preserveAspectRatio="none">
                  <defs>
                    <mask id="oval-mask">
                      <rect width="400" height="300" fill="white" />
                      <ellipse
                        cx="200"
                        cy="150"
                        rx={200 * OVAL_WIDTH_RATIO / 2}
                        ry={150 * OVAL_HEIGHT_RATIO / 2}
                        fill="black"
                      />
                    </mask>
                  </defs>
                  <rect width="400" height="300" fill="rgba(0,0,0,0.5)" mask="url(#oval-mask)" />
                </svg>

                {/* Oval border ring */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <div
                    className={`border-[3px] rounded-[50%] transition-colors duration-300 ${oc.border} shadow-lg ${oc.shadow}`}
                    style={{
                      width: `${OVAL_WIDTH_RATIO * 100}%`,
                      height: `${OVAL_HEIGHT_RATIO * 100}%`,
                    }}
                  />
                </div>

                {/* Corner brackets for aesthetics */}
                <div className="absolute top-3 left-3 w-5 h-5 border-t-2 border-l-2 border-white/20 rounded-tl-md" />
                <div className="absolute top-3 right-3 w-5 h-5 border-t-2 border-r-2 border-white/20 rounded-tr-md" />
                <div className="absolute bottom-3 left-3 w-5 h-5 border-b-2 border-l-2 border-white/20 rounded-bl-md" />
                <div className="absolute bottom-3 right-3 w-5 h-5 border-b-2 border-r-2 border-white/20 rounded-br-md" />

                {/* Capturing spinner overlay */}
                {step === 'capturing' && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <div className="text-center">
                      <svg className="w-8 h-8 mx-auto animate-spin text-cyan-400" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      <p className="text-xs text-white/80 mt-2 font-medium">Analyzing…</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Quality hint */}
              <div className="text-center">
                <p className={`text-sm font-medium ${oc.text} transition-colors duration-300`}>
                  {step === 'capturing' ? 'Computing face descriptor…' : quality.hint}
                </p>
                {captureError && (
                  <p className="text-xs text-red-400 mt-1">{captureError}</p>
                )}
              </div>

              {/* Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={onCancel}
                  disabled={step === 'capturing'}
                  className="flex-1 px-4 py-2.5 rounded-xl text-xs font-semibold text-gray-400 bg-gray-800 hover:bg-gray-750 border border-gray-700 transition-colors cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCapture}
                  disabled={quality.level !== 'good' || step === 'capturing'}
                  className={`
                    flex-1 px-4 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer active:scale-[0.98]
                    ${quality.level === 'good' && step !== 'capturing'
                      ? 'text-white bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 shadow-lg shadow-cyan-900/30'
                      : 'text-gray-500 bg-gray-800 border border-gray-700 cursor-not-allowed opacity-60'
                    }
                  `}
                >
                  {step === 'capturing' ? 'Analyzing…' : '📸 Capture Face'}
                </button>
              </div>
            </div>
          )}

          {/* ── Captured — show thumbnail + confirm ────────────────── */}
          {step === 'captured' && (
            <div className="text-center space-y-4">
              <div className="relative w-28 h-28 mx-auto rounded-2xl overflow-hidden border-2 border-emerald-500/50 shadow-lg shadow-emerald-900/20">
                <img
                  src={thumbnail}
                  alt="Reference face capture"
                  className="w-full h-full object-cover"
                />
                <div className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center shadow-md">
                  <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
              <div>
                <p className="text-sm text-emerald-400 font-bold">Identity Captured ✅</p>
                <p className="text-xs text-gray-500 mt-1">
                  Your face will be continuously verified throughout the exam.
                </p>
              </div>
              <div className="flex gap-3 pt-1">
                <button
                  onClick={handleRetake}
                  className="flex-1 px-4 py-2.5 rounded-xl text-xs font-semibold text-gray-400 bg-gray-800 hover:bg-gray-750 border border-gray-700 transition-colors cursor-pointer"
                >
                  🔄 Retake
                </button>
                <button
                  onClick={onConfirm}
                  className="flex-1 px-4 py-2.5 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-500 hover:to-green-500 shadow-lg shadow-emerald-900/30 transition-all cursor-pointer active:scale-[0.98]"
                >
                  ✅ Confirm & Start Exam
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
