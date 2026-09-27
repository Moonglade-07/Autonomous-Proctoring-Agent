/**
 * WebcamPreview.tsx
 * ─────────────────────────────────────────────────────────────────
 * Requests real browser webcam access via getUserMedia.
 * Falls back to a styled placeholder if:
 *   • The user denies camera permission
 *   • The browser doesn't support getUserMedia
 *
 * Overlays:
 *   • REC indicator (always visible)
 *   • Camera label corner badge
 *   • Scan-line aesthetic overlay
 * ─────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState } from 'react';

type CameraState = 'requesting' | 'active' | 'denied' | 'unsupported';

export function WebcamPreview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraState, setCameraState] = useState<CameraState>('requesting');

  useEffect(() => {
    let cancelled = false;

    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraState('unsupported');
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' },
          audio: false,
        });

        if (cancelled) {
          // Component unmounted while awaiting — stop the stream immediately
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraState('active');
      } catch (err) {
        if (!cancelled) {
          console.warn('[WebcamPreview] Camera access denied:', err);
          setCameraState('denied');
        }
      }
    }

    startCamera();

    return () => {
      cancelled = true;
      // Stop all camera tracks on unmount to release the hardware
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  return (
    <div className="relative w-full aspect-video rounded-2xl overflow-hidden bg-gray-900 border border-gray-700 shadow-inner">

      {/* ── Live video feed ─────────────────────────────────────────── */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
          cameraState === 'active' ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* ── Placeholder overlays (shown when camera not active) ──────── */}
      {cameraState !== 'active' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
          {cameraState === 'requesting' && (
            <>
              <svg className="w-8 h-8 text-gray-500 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9A2.25 2.25 0 0013.5 5.25h-9A2.25 2.25 0 002.25 7.5v9A2.25 2.25 0 004.5 18.75z" />
              </svg>
              <p className="text-gray-500 text-sm font-medium">Requesting camera access…</p>
            </>
          )}
          {cameraState === 'denied' && (
            <>
              <svg className="w-10 h-10 text-red-500/60" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
              <p className="text-red-400 text-sm font-semibold">Camera access denied</p>
              <p className="text-gray-600 text-xs max-w-[180px] leading-relaxed">
                Allow camera access in your browser settings and refresh the page.
              </p>
            </>
          )}
          {cameraState === 'unsupported' && (
            <>
              <svg className="w-10 h-10 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9A2.25 2.25 0 0013.5 5.25h-9A2.25 2.25 0 002.25 7.5v9A2.25 2.25 0 004.5 18.75z" />
              </svg>
              <p className="text-gray-500 text-sm font-medium">Camera not supported</p>
              <p className="text-gray-600 text-xs">Your browser does not support webcam access.</p>
            </>
          )}
        </div>
      )}

      {/* ── REC indicator (always visible) ──────────────────────────── */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5 z-10">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
        </span>
        <span className="text-xs text-red-400 font-semibold tracking-widest uppercase drop-shadow">REC</span>
      </div>

      {/* ── Camera label (bottom-left) ───────────────────────────────── */}
      <div className="absolute bottom-3 left-3 z-10">
        <span className="text-xs text-white/50 font-mono bg-black/40 px-2 py-0.5 rounded-md backdrop-blur-sm">
          CAM-01
        </span>
      </div>

      {/* ── Scan-line aesthetic overlay ──────────────────────────────── */}
      <div
        className="absolute inset-0 pointer-events-none z-10"
        style={{
          background:
            'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)',
        }}
      />
    </div>
  );
}
