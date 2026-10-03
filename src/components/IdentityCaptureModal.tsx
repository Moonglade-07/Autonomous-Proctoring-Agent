/**
 * IdentityCaptureModal.tsx
 * ─────────────────────────────────────────────────────────────────
 * Phase 2c: Full-screen modal shown after "Start Exam" is clicked.
 * Captures a reference face descriptor for identity verification
 * before allowing the exam to proceed.
 *
 * Flow:
 *   1. "Please look at the camera" prompt
 *   2. User clicks "Capture" → detects single forward-facing face
 *   3. On success → shows thumbnail + confirmation with Retake / Confirm
 *   4. On confirm → closes modal, exam monitoring begins
 * ─────────────────────────────────────────────────────────────────
 */

import { useState } from 'react';
import type { ReferenceCapture } from '../hooks/useFaceDetection';

interface IdentityCaptureModalProps {
  /** Function from useFaceDetection to capture a reference face */
  onCapture: () => Promise<{ success: boolean; error?: string; capture?: ReferenceCapture }>;
  /** Called when identity is confirmed — proceed to start monitoring */
  onConfirm: () => void;
  /** Called when user wants to skip/cancel (go back to pre-exam state) */
  onCancel: () => void;
}

type ModalStep = 'prompt' | 'capturing' | 'captured' | 'error';

export function IdentityCaptureModal({ onCapture, onConfirm, onCancel }: IdentityCaptureModalProps) {
  const [step, setStep] = useState<ModalStep>('prompt');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [thumbnail, setThumbnail] = useState<string>('');

  const handleCapture = async () => {
    setStep('capturing');
    setErrorMsg('');

    const result = await onCapture();

    if (result.success && result.capture) {
      setThumbnail(result.capture.thumbnailDataUrl);
      setStep('captured');
    } else {
      setErrorMsg(result.error ?? 'Unknown error');
      setStep('error');
    }
  };

  const handleRetake = () => {
    setThumbnail('');
    setStep('prompt');
    setErrorMsg('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="bg-gray-900 border border-white/10 rounded-3xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">

        {/* Header */}
        <div className="px-6 pt-6 pb-4 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white text-lg shadow-lg shadow-cyan-900/30">
              🔐
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Identity Verification</h2>
              <p className="text-xs text-gray-500">Phase 2c · Local Only</p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-6">

          {/* Step: Prompt */}
          {step === 'prompt' && (
            <div className="text-center space-y-4">
              <div className="w-20 h-20 mx-auto rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center">
                <svg className="w-10 h-10 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                </svg>
              </div>
              <div>
                <p className="text-sm text-gray-200 font-medium">
                  Please look directly at the camera
                </p>
                <p className="text-xs text-gray-500 mt-1 leading-relaxed max-w-[280px] mx-auto">
                  We'll capture a reference photo of your face to verify your identity throughout the exam.
                  Ensure only your face is visible and you're facing forward.
                </p>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={onCancel}
                  className="flex-1 px-4 py-2.5 rounded-xl text-xs font-semibold text-gray-400 bg-gray-800 hover:bg-gray-750 border border-gray-700 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCapture}
                  className="flex-1 px-4 py-2.5 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 shadow-lg shadow-cyan-900/30 transition-all cursor-pointer active:scale-[0.98]"
                >
                  📸 Capture Face
                </button>
              </div>
            </div>
          )}

          {/* Step: Capturing */}
          {step === 'capturing' && (
            <div className="text-center space-y-4 py-4">
              <svg className="w-10 h-10 mx-auto animate-spin text-cyan-400" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              <p className="text-sm text-gray-300 font-medium">Analyzing face…</p>
              <p className="text-xs text-gray-600">Computing face descriptor for identity verification</p>
            </div>
          )}

          {/* Step: Captured — show thumbnail + confirm */}
          {step === 'captured' && (
            <div className="text-center space-y-4">
              <div className="relative w-24 h-24 mx-auto rounded-2xl overflow-hidden border-2 border-emerald-500/50 shadow-lg shadow-emerald-900/20">
                <img
                  src={thumbnail}
                  alt="Reference face capture"
                  className="w-full h-full object-cover"
                />
                <div className="absolute top-1 right-1 w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center">
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
              <div>
                <p className="text-sm text-emerald-400 font-bold">Identity Captured ✅</p>
                <p className="text-xs text-gray-500 mt-1">
                  Your face will be continuously verified during the exam.
                </p>
              </div>
              <div className="flex gap-3 pt-2">
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

          {/* Step: Error — retry */}
          {step === 'error' && (
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-red-950/50 border border-red-700/30 flex items-center justify-center">
                <svg className="w-8 h-8 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                </svg>
              </div>
              <div>
                <p className="text-sm text-red-400 font-semibold">Capture Failed</p>
                <p className="text-xs text-gray-500 mt-1 max-w-[280px] mx-auto leading-relaxed">
                  {errorMsg}
                </p>
              </div>
              <div className="flex gap-3 pt-2">
                <button
                  onClick={onCancel}
                  className="flex-1 px-4 py-2.5 rounded-xl text-xs font-semibold text-gray-400 bg-gray-800 hover:bg-gray-750 border border-gray-700 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCapture}
                  className="flex-1 px-4 py-2.5 rounded-xl text-xs font-bold text-white bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 shadow-lg shadow-cyan-900/30 transition-all cursor-pointer active:scale-[0.98]"
                >
                  🔄 Try Again
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
