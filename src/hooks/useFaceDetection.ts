/**
 * useFaceDetection.ts
 * ─────────────────────────────────────────────────────────────────
 * Client-side face detection + identity verification using face-api.js.
 *
 * Phase 2b: Face count, head orientation, suspicious-state tracking
 * Phase 2c: Face recognition model, reference capture, continuous
 *           identity verification via descriptor Euclidean distance
 *
 * All detection runs locally in the browser — no backend calls.
 * ─────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState, useCallback, type RefObject } from 'react';
import * as faceapi from 'face-api.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Model weight files served locally from the public folder */
const MODEL_URL = '/models';

/** Interval between detection passes (ms) — face count + orientation */
const DETECTION_INTERVAL_MS = 700;

/** Interval between identity verification passes (ms) — more expensive */
const IDENTITY_CHECK_INTERVAL_MS = 7000;

/** Euclidean distance threshold for identity match (lower = stricter) */
const IDENTITY_MATCH_THRESHOLD = 0.6;

/** Suspicious-state thresholds (ms) */
const NO_FACE_THRESHOLD_MS = 3000;
const MULTI_FACE_THRESHOLD_MS = 1000;
const HEAD_TURNED_THRESHOLD_MS = 3000;
const IDENTITY_MISMATCH_THRESHOLD_MS = 3000;

// ─── Types ───────────────────────────────────────────────────────────────────

export type HeadOrientation = 'forward' | 'left' | 'right' | 'up' | 'down' | 'unknown';
export type ModelLoadState = 'idle' | 'loading' | 'ready' | 'error';
export type IdentityStatus = 'not_captured' | 'capturing' | 'captured' | 'verified' | 'mismatch' | 'checking';

export interface FaceDetectionState {
  modelState: ModelLoadState;
  faceCount: number;
  orientation: HeadOrientation;
  detecting: boolean;
  /** Identity verification status */
  identityStatus: IdentityStatus;
  /** Last computed Euclidean distance between live face and reference */
  identityDistance: number | null;
}

export interface ActiveFlag {
  type: 'no_face' | 'multiple_faces' | 'head_turned' | 'identity_mismatch';
  startedAt: number;
  durationMs: number;
  orientation?: HeadOrientation;
}

export interface ReferenceCapture {
  /** Base64 data URL of the captured reference thumbnail */
  thumbnailDataUrl: string;
  /** 128-dimensional face descriptor vector */
  descriptor: Float32Array;
  /** Timestamp of capture */
  capturedAt: number;
}

// ─── Head orientation estimation ─────────────────────────────────────────────

function estimateOrientation(landmarks: faceapi.FaceLandmarks68): HeadOrientation {
  const positions = landmarks.positions;
  if (positions.length < 68) return 'unknown';

  const noseTip = positions[30];
  const leftEyeInner = positions[39];
  const rightEyeInner = positions[42];
  const leftEyeOuter = positions[36];
  const rightEyeOuter = positions[45];
  const chin = positions[8];

  const eyeCenterX = (leftEyeInner.x + rightEyeInner.x) / 2;
  const eyeCenterY = (leftEyeInner.y + rightEyeInner.y) / 2;

  const faceWidth = Math.abs(rightEyeOuter.x - leftEyeOuter.x);
  if (faceWidth < 10) return 'unknown';

  const yawRatio = (noseTip.x - eyeCenterX) / faceWidth;
  const eyeToChinDist = chin.y - eyeCenterY;
  const eyeToNoseDist = noseTip.y - eyeCenterY;
  const pitchRatio = eyeToChinDist > 10 ? eyeToNoseDist / eyeToChinDist : 0;

  if (yawRatio < -0.25) return 'right';
  if (yawRatio > 0.25) return 'left';
  if (pitchRatio > 0.65) return 'down';
  if (pitchRatio < 0.35) return 'up';

  return 'forward';
}

// ─── Capture thumbnail from video ────────────────────────────────────────────

function captureVideoThumbnail(video: HTMLVideoElement, size = 120): string {
  const canvas = document.createElement('canvas');
  const aspect = video.videoWidth / video.videoHeight;
  canvas.width = size;
  canvas.height = Math.round(size / aspect);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

// ─── Hook ────────────────────────────────────────────────────────────────────

interface UseFaceDetectionOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  monitoringActive: boolean;
}

export function useFaceDetection({ videoRef, monitoringActive }: UseFaceDetectionOptions) {
  const [state, setState] = useState<FaceDetectionState>({
    modelState: 'idle',
    faceCount: 0,
    orientation: 'unknown',
    detecting: false,
    identityStatus: 'not_captured',
    identityDistance: null,
  });

  const [activeFlags, setActiveFlags] = useState<ActiveFlag[]>([]);
  const [referenceCapture, setReferenceCapture] = useState<ReferenceCapture | null>(null);

  // Mutable refs for tracking
  const trackersRef = useRef({
    noFace: null as number | null,
    multiFace: null as number | null,
    headTurned: null as number | null,
    headTurnDir: 'unknown' as HeadOrientation,
    identityMismatch: null as number | null,
  });

  const loopRef = useRef<number | null>(null);
  const identityLoopRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const referenceDescriptorRef = useRef<Float32Array | null>(null);

  // ─── Load models ──────────────────────────────────────────────────────────

  const loadModels = useCallback(async () => {
    if (state.modelState === 'ready' || state.modelState === 'loading') return;

    setState((s) => ({ ...s, modelState: 'loading' }));

    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_URL),
        // Phase 2c: full landmarks + recognition model for descriptor extraction
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      ]);
      setState((s) => ({ ...s, modelState: 'ready' }));
      console.log('[useFaceDetection] All models loaded (detection + recognition)');
    } catch (err) {
      console.error('[useFaceDetection] Failed to load models:', err);
      setState((s) => ({ ...s, modelState: 'error' }));
    }
  }, [state.modelState]);

  // ─── Reference Face Capture ───────────────────────────────────────────────

  const captureReference = useCallback(async (): Promise<{
    success: boolean;
    error?: string;
    capture?: ReferenceCapture;
  }> => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      return { success: false, error: 'Camera not ready. Please wait and try again.' };
    }

    setState((s) => ({ ...s, identityStatus: 'capturing' }));

    try {
      // Use the full pipeline: detect → full landmarks → descriptor
      const detection = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
        .withFaceLandmarks(false) // false = use FULL 68-point model (required for descriptor)
        .withFaceDescriptor();

      if (!detection) {
        setState((s) => ({ ...s, identityStatus: 'not_captured' }));
        return { success: false, error: 'No face detected. Please face the camera directly and try again.' };
      }

      // Check orientation — should be roughly forward-facing
      const orientation = estimateOrientation(detection.landmarks as faceapi.FaceLandmarks68);
      if (orientation !== 'forward' && orientation !== 'unknown') {
        setState((s) => ({ ...s, identityStatus: 'not_captured' }));
        return { success: false, error: `Please look directly at the camera (detected: looking ${orientation}).` };
      }

      const thumbnailDataUrl = captureVideoThumbnail(video);
      const capture: ReferenceCapture = {
        thumbnailDataUrl,
        descriptor: detection.descriptor,
        capturedAt: Date.now(),
      };

      referenceDescriptorRef.current = detection.descriptor;
      setReferenceCapture(capture);
      setState((s) => ({ ...s, identityStatus: 'captured' }));
      console.log('[useFaceDetection] Reference face captured successfully');

      return { success: true, capture };
    } catch (err) {
      console.error('[useFaceDetection] Reference capture error:', err);
      setState((s) => ({ ...s, identityStatus: 'not_captured' }));
      return { success: false, error: 'Face capture failed. Please try again.' };
    }
  }, [videoRef]);

  // ─── Finalize Flag ────────────────────────────────────────────────────────

  const finalizeFlag = useCallback((type: ActiveFlag['type']) => {
    setActiveFlags((prev) => {
      const existing = prev.find((f) => f.type === type);
      if (existing) {
        let eventStr: string = type;
        if (type === 'head_turned' && existing.orientation) {
          eventStr += `_${existing.orientation}`;
        }
        console.log(`[FaceDetection] FINALIZED EVENT: ${eventStr}, duration: ${(existing.durationMs / 1000).toFixed(1)}s`);
      }
      return prev.filter((f) => f.type !== type);
    });
  }, []);

  // ─── Single detection pass (face count + orientation) ─────────────────────

  const runDetection = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;

    try {
      const detections = await faceapi
        .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
        .withFaceLandmarks(true); // true = tiny landmarks (fast, for orientation)

      const faceCount = detections.length;
      let orientation: HeadOrientation = 'unknown';

      if (faceCount > 0) {
        const largest = detections.reduce((a, b) =>
          a.detection.box.area > b.detection.box.area ? a : b
        );
        orientation = estimateOrientation(largest.landmarks as faceapi.FaceLandmarks68);
      }

      setState((s) => ({ ...s, faceCount, orientation }));

      // ── Suspicious state tracking ──────────────────────────────────────────
      const now = Date.now();
      const tr = trackersRef.current;

      const updateFlag = (type: ActiveFlag['type'], startedAt: number, elapsed: number, orient?: HeadOrientation) => {
        setActiveFlags((prev) => {
          const next = [...prev];
          const idx = next.findIndex((f) => f.type === type);
          if (idx >= 0) {
            next[idx] = { ...next[idx], durationMs: elapsed };
          } else {
            next.push({ type, startedAt, durationMs: elapsed, orientation: orient });
          }
          return next;
        });
      };

      // 1. No Face
      if (faceCount === 0) {
        if (tr.noFace === null) tr.noFace = now;
        const elapsed = now - tr.noFace;
        if (elapsed >= NO_FACE_THRESHOLD_MS) {
          updateFlag('no_face', tr.noFace, elapsed);
        }
      } else {
        if (tr.noFace !== null) {
          const elapsed = now - tr.noFace;
          if (elapsed >= NO_FACE_THRESHOLD_MS) finalizeFlag('no_face');
          tr.noFace = null;
        }
      }

      // 2. Multiple Faces
      if (faceCount >= 2) {
        if (tr.multiFace === null) tr.multiFace = now;
        const elapsed = now - tr.multiFace;
        if (elapsed >= MULTI_FACE_THRESHOLD_MS) {
          updateFlag('multiple_faces', tr.multiFace, elapsed);
        }
      } else {
        if (tr.multiFace !== null) {
          const elapsed = now - tr.multiFace;
          if (elapsed >= MULTI_FACE_THRESHOLD_MS) finalizeFlag('multiple_faces');
          tr.multiFace = null;
        }
      }

      // 3. Head Turned
      const isTurned = faceCount > 0 && orientation !== 'forward' && orientation !== 'unknown';
      if (isTurned) {
        if (tr.headTurned === null || tr.headTurnDir !== orientation) {
          if (tr.headTurned !== null && (now - tr.headTurned) >= HEAD_TURNED_THRESHOLD_MS) {
            finalizeFlag('head_turned');
          }
          tr.headTurned = now;
          tr.headTurnDir = orientation;
        }
        const elapsed = now - tr.headTurned;
        if (elapsed >= HEAD_TURNED_THRESHOLD_MS) {
          updateFlag('head_turned', tr.headTurned, elapsed, orientation);
        }
      } else {
        if (tr.headTurned !== null) {
          const elapsed = now - tr.headTurned;
          if (elapsed >= HEAD_TURNED_THRESHOLD_MS) finalizeFlag('head_turned');
          tr.headTurned = null;
          tr.headTurnDir = 'unknown';
        }
      }
    } catch (err) {
      console.error('[useFaceDetection] Detection pass error:', err);
    }
  }, [videoRef, finalizeFlag]);

  // ─── Identity verification pass (runs less frequently) ────────────────────

  const runIdentityCheck = useCallback(async () => {
    const video = videoRef.current;
    const refDescriptor = referenceDescriptorRef.current;
    if (!video || video.readyState < 2 || !refDescriptor) return;

    try {
      // Use full pipeline for descriptor extraction
      const detection = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
        .withFaceLandmarks(false) // full landmarks needed for descriptor
        .withFaceDescriptor();

      const now = Date.now();
      const tr = trackersRef.current;

      if (!detection) {
        // No face detected — don't run identity check (Phase 2b handles no_face)
        setState((s) => ({ ...s, identityDistance: null }));
        return;
      }

      const distance = faceapi.euclideanDistance(
        Array.from(detection.descriptor),
        Array.from(refDescriptor)
      );

      const isMatch = distance < IDENTITY_MATCH_THRESHOLD;

      setState((s) => ({
        ...s,
        identityStatus: isMatch ? 'verified' : 'mismatch',
        identityDistance: distance,
      }));

      // Track identity mismatch duration
      if (!isMatch) {
        if (tr.identityMismatch === null) tr.identityMismatch = now;
        const elapsed = now - tr.identityMismatch;
        if (elapsed >= IDENTITY_MISMATCH_THRESHOLD_MS) {
          console.warn(`[FaceDetection] Identity mismatch: distance=${distance.toFixed(3)}, elapsed=${elapsed}ms`);
          setActiveFlags((prev) => {
            const next = [...prev];
            const idx = next.findIndex((f) => f.type === 'identity_mismatch');
            if (idx >= 0) {
              next[idx] = { ...next[idx], durationMs: elapsed };
            } else {
              next.push({ type: 'identity_mismatch', startedAt: tr.identityMismatch!, durationMs: elapsed });
            }
            return next;
          });
        }
      } else {
        if (tr.identityMismatch !== null) {
          const elapsed = now - tr.identityMismatch;
          if (elapsed >= IDENTITY_MISMATCH_THRESHOLD_MS) {
            finalizeFlag('identity_mismatch');
          }
          tr.identityMismatch = null;
        }
      }
    } catch (err) {
      console.error('[useFaceDetection] Identity check error:', err);
    }
  }, [videoRef, finalizeFlag]);

  // ─── Detection loop (face count + orientation — Phase 2b) ─────────────────

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

    const runIfVisible = () => {
      if (document.hidden) return;
      if (!activeRef.current) return;
      runDetection();
    };

    runIfVisible();
    loopRef.current = window.setInterval(runIfVisible, DETECTION_INTERVAL_MS);

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

      // Finalize any ongoing flags on unmount
      setActiveFlags((prev) => {
        prev.forEach((f) => {
          let eventStr: string = f.type;
          if (f.type === 'head_turned' && f.orientation) eventStr += `_${f.orientation}`;
          console.log(`[FaceDetection] FINALIZED EVENT (exam ended): ${eventStr}, duration: ${(f.durationMs / 1000).toFixed(1)}s`);
        });
        return [];
      });
      trackersRef.current = { noFace: null, multiFace: null, headTurned: null, headTurnDir: 'unknown', identityMismatch: null };
    };
  }, [monitoringActive, state.modelState, runDetection]);

  // ─── Identity verification loop (Phase 2c — runs less frequently) ─────────

  useEffect(() => {
    const shouldRun = monitoringActive && state.modelState === 'ready' && referenceDescriptorRef.current !== null;

    if (!shouldRun) {
      if (identityLoopRef.current !== null) {
        clearInterval(identityLoopRef.current);
        identityLoopRef.current = null;
      }
      return;
    }

    const checkIfVisible = () => {
      if (document.hidden) return;
      if (!activeRef.current) return;
      runIdentityCheck();
    };

    // Run first check after a short delay (let detection loop warm up)
    const timeout = window.setTimeout(checkIfVisible, 2000);
    identityLoopRef.current = window.setInterval(checkIfVisible, IDENTITY_CHECK_INTERVAL_MS);

    return () => {
      clearTimeout(timeout);
      if (identityLoopRef.current !== null) {
        clearInterval(identityLoopRef.current);
        identityLoopRef.current = null;
      }
    };
  }, [monitoringActive, state.modelState, runIdentityCheck, referenceCapture]);

  // ─── Auto-load models ─────────────────────────────────────────────────────

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  return {
    faceState: state,
    activeFlags,
    referenceCapture,
    captureReference,
    loadModels,
  };
}
