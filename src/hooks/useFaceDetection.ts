/**
 * useFaceDetection.ts
 * ─────────────────────────────────────────────────────────────────
 * Client-side face detection using face-api.js.
 *
 * Runs entirely in the browser — no backend calls.
 * Uses the TinyFaceDetector model for performance and the 68-point
 * face landmark model for head orientation estimation.
 *
 * Detection loop:
 *   Runs every ~700ms when monitoring is active and the tab is visible.
 *   Pauses via Page Visibility API when the tab is hidden.
 *
 * Suspicious state tracking:
 *   - No face detected for >3 consecutive seconds → flagged
 *   - Multiple faces (2+) for >1 consecutive second → flagged
 *   - Head turned away from forward for >3 consecutive seconds → flagged
 *   These are logged to console and surfaced in the UI as "Pending Review"
 *   but are NOT sent to the backend yet (that's Phase 2c).
 *
 * Models are loaded from jsDelivr CDN on first call to `loadModels()`.
 * ─────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';
import * as faceapi from 'face-api.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Model weight files served from jsDelivr CDN */
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights';

/** Interval between detection passes (ms) */
const DETECTION_INTERVAL_MS = 700;

/** Suspicious-state thresholds (ms) */
const NO_FACE_THRESHOLD_MS = 3000;
const MULTI_FACE_THRESHOLD_MS = 1000;
const HEAD_TURNED_THRESHOLD_MS = 3000;

// ─── Types ───────────────────────────────────────────────────────────────────

export type HeadOrientation = 'forward' | 'left' | 'right' | 'down' | 'unknown';
export type ModelLoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface FaceDetectionState {
  /** Whether face-api.js models have been loaded successfully */
  modelState: ModelLoadState;
  /** Number of faces currently detected in the frame */
  faceCount: number;
  /** Estimated head orientation of the primary (largest) face */
  orientation: HeadOrientation;
  /** Whether the detection loop is currently running */
  detecting: boolean;
}

export interface PendingFlag {
  type: 'no_face' | 'multiple_faces' | 'head_turned';
  startedAt: number;
  durationMs: number;
  orientation?: HeadOrientation;
}

// ─── Head orientation estimation ─────────────────────────────────────────────

/**
 * Estimates head orientation from 68-point facial landmarks.
 *
 * Strategy:
 *   - Yaw: Compare nose tip (point 30) x-position to the midpoint
 *     between left eye center and right eye center. If nose is
 *     significantly left or right of center → turned.
 *   - Pitch (down): Compare nose tip y to the eye line y.
 *     If nose is significantly below the expected ratio → looking down.
 *
 * These are rough heuristics — not precise head pose estimation,
 * but sufficient for proctoring flagging.
 */
function estimateOrientation(landmarks: faceapi.FaceLandmarks68): HeadOrientation {
  const positions = landmarks.positions;
  if (positions.length < 68) return 'unknown';

  // Key landmark points (0-indexed)
  const noseTip = positions[30];
  const leftEyeInner = positions[39];
  const rightEyeInner = positions[42];
  const leftEyeOuter = positions[36];
  const rightEyeOuter = positions[45];
  const chin = positions[8];

  // Eye center (midpoint between inner corners)
  const eyeCenterX = (leftEyeInner.x + rightEyeInner.x) / 2;
  const eyeCenterY = (leftEyeInner.y + rightEyeInner.y) / 2;

  // Face width (outer eye to outer eye)
  const faceWidth = Math.abs(rightEyeOuter.x - leftEyeOuter.x);
  if (faceWidth < 10) return 'unknown'; // face too small to measure

  // Yaw: horizontal offset of nose tip from eye center, normalized by face width
  const yawRatio = (noseTip.x - eyeCenterX) / faceWidth;

  // Pitch: vertical distance from eye center to nose, compared to eye-to-chin distance
  const eyeToChinDist = chin.y - eyeCenterY;
  const eyeToNoseDist = noseTip.y - eyeCenterY;
  const pitchRatio = eyeToChinDist > 10 ? eyeToNoseDist / eyeToChinDist : 0;

  // Thresholds (tuned for typical webcam selfie distance)
  if (yawRatio < -0.25) return 'right'; // Nose is to the left of center → face turned right (mirrored camera)
  if (yawRatio > 0.25) return 'left';   // Nose is to the right → face turned left (mirrored camera)
  if (pitchRatio > 0.65) return 'down';  // Nose is far below eye line → looking down

  return 'forward';
}

// ─── Hook ────────────────────────────────────────────────────────────────────

interface UseFaceDetectionOptions {
  /** Ref to the <video> element rendering the webcam feed */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Whether monitoring is active (from useBehavioralDetection) */
  monitoringActive: boolean;
}

export function useFaceDetection({ videoRef, monitoringActive }: UseFaceDetectionOptions) {
  const [state, setState] = useState<FaceDetectionState>({
    modelState: 'idle',
    faceCount: 0,
    orientation: 'unknown',
    detecting: false,
  });

  const [pendingFlags, setPendingFlags] = useState<PendingFlag[]>([]);

  // Refs for suspicious-state tracking (mutable, non-reactive)
  const noFaceSinceRef = useRef<number | null>(null);
  const multiFaceSinceRef = useRef<number | null>(null);
  const headTurnedSinceRef = useRef<number | null>(null);
  const headTurnDirRef = useRef<HeadOrientation>('unknown');
  const loopRef = useRef<number | null>(null);
  const activeRef = useRef(false);

  // ─── Load models ──────────────────────────────────────────────────────────

  const loadModels = useCallback(async () => {
    if (state.modelState === 'ready' || state.modelState === 'loading') return;

    setState((s) => ({ ...s, modelState: 'loading' }));

    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
      ]);
      setState((s) => ({ ...s, modelState: 'ready' }));
      console.log('[useFaceDetection] Models loaded successfully');
    } catch (err) {
      console.error('[useFaceDetection] Failed to load models:', err);
      setState((s) => ({ ...s, modelState: 'error' }));
    }
  }, [state.modelState]);

  // ─── Single detection pass ────────────────────────────────────────────────

  const runDetection = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return; // video not ready yet

    try {
      const detections = await faceapi
        .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
        .withFaceLandmarks(true); // true = use tiny landmarks model

      const faceCount = detections.length;

      // Estimate orientation from the largest (most prominent) face
      let orientation: HeadOrientation = 'unknown';
      if (faceCount > 0) {
        // Pick the detection with the largest bounding box area
        const largest = detections.reduce((a, b) =>
          a.detection.box.area > b.detection.box.area ? a : b
        );
        orientation = estimateOrientation(largest.landmarks as faceapi.FaceLandmarks68);
      }

      setState((s) => ({ ...s, faceCount, orientation }));

      // ── Suspicious state tracking ──────────────────────────────────

      const now = Date.now();

      // No face
      if (faceCount === 0) {
        if (noFaceSinceRef.current === null) noFaceSinceRef.current = now;
        const elapsed = now - noFaceSinceRef.current;
        if (elapsed >= NO_FACE_THRESHOLD_MS) {
          const flag: PendingFlag = { type: 'no_face', startedAt: noFaceSinceRef.current, durationMs: elapsed };
          console.warn('[FaceDetection] FLAG: No face detected for', elapsed, 'ms', flag);
          setPendingFlags((prev) => {
            // Update existing or add new
            const existing = prev.findIndex((f) => f.type === 'no_face');
            if (existing >= 0) {
              const next = [...prev];
              next[existing] = flag;
              return next;
            }
            return [...prev, flag];
          });
        }
      } else {
        noFaceSinceRef.current = null;
        setPendingFlags((prev) => prev.filter((f) => f.type !== 'no_face'));
      }

      // Multiple faces
      if (faceCount >= 2) {
        if (multiFaceSinceRef.current === null) multiFaceSinceRef.current = now;
        const elapsed = now - multiFaceSinceRef.current;
        if (elapsed >= MULTI_FACE_THRESHOLD_MS) {
          const flag: PendingFlag = { type: 'multiple_faces', startedAt: multiFaceSinceRef.current, durationMs: elapsed };
          console.warn('[FaceDetection] FLAG: Multiple faces for', elapsed, 'ms', flag);
          setPendingFlags((prev) => {
            const existing = prev.findIndex((f) => f.type === 'multiple_faces');
            if (existing >= 0) {
              const next = [...prev];
              next[existing] = flag;
              return next;
            }
            return [...prev, flag];
          });
        }
      } else {
        multiFaceSinceRef.current = null;
        setPendingFlags((prev) => prev.filter((f) => f.type !== 'multiple_faces'));
      }

      // Head turned
      if (faceCount > 0 && orientation !== 'forward' && orientation !== 'unknown') {
        if (headTurnedSinceRef.current === null || headTurnDirRef.current !== orientation) {
          headTurnedSinceRef.current = now;
          headTurnDirRef.current = orientation;
        }
        const elapsed = now - headTurnedSinceRef.current;
        if (elapsed >= HEAD_TURNED_THRESHOLD_MS) {
          const flag: PendingFlag = { type: 'head_turned', startedAt: headTurnedSinceRef.current, durationMs: elapsed, orientation };
          console.warn('[FaceDetection] FLAG: Head turned', orientation, 'for', elapsed, 'ms', flag);
          setPendingFlags((prev) => {
            const existing = prev.findIndex((f) => f.type === 'head_turned');
            if (existing >= 0) {
              const next = [...prev];
              next[existing] = flag;
              return next;
            }
            return [...prev, flag];
          });
        }
      } else {
        headTurnedSinceRef.current = null;
        headTurnDirRef.current = 'unknown';
        setPendingFlags((prev) => prev.filter((f) => f.type !== 'head_turned'));
      }
    } catch (err) {
      console.error('[useFaceDetection] Detection pass error:', err);
    }
  }, [videoRef]);

  // ─── Detection loop ───────────────────────────────────────────────────────

  useEffect(() => {
    const shouldRun = monitoringActive && state.modelState === 'ready';
    activeRef.current = shouldRun;

    if (!shouldRun) {
      setState((s) => ({ ...s, detecting: false }));
      if (loopRef.current !== null) {
        clearInterval(loopRef.current);
        loopRef.current = null;
      }
      return;
    }

    setState((s) => ({ ...s, detecting: true }));

    // Throttled detection loop using setInterval
    // Each pass is async and non-blocking — if one pass is still running
    // when the next interval fires, the video.readyState check prevents overlap.
    const runIfVisible = () => {
      if (document.hidden) return; // Pause when tab is not visible
      if (!activeRef.current) return;
      runDetection();
    };

    // Run immediately, then on interval
    runIfVisible();
    loopRef.current = window.setInterval(runIfVisible, DETECTION_INTERVAL_MS);

    // Also listen for visibility changes to resume/pause
    const onVisibility = () => {
      if (!document.hidden && activeRef.current) {
        runDetection();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (loopRef.current !== null) {
        clearInterval(loopRef.current);
        loopRef.current = null;
      }
      document.removeEventListener('visibilitychange', onVisibility);
      setState((s) => ({ ...s, detecting: false }));
    };
  }, [monitoringActive, state.modelState, runDetection]);

  // ─── Auto-load models when component mounts ───────────────────────────────

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  return {
    faceState: state,
    pendingFlags,
    loadModels,
  };
}
