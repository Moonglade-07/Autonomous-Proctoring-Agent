/**
 * src/components/PrivacyConsentModal.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Plain-language consent modal for proctored exams (Phase 5c).
 * Required before joining or starting an exam, or resuming an in-progress attempt.
 */

import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export interface PrivacyConsentModalProps {
  isOpen: boolean;
  onConsentSuccess: () => Promise<void> | void;
  onCancel?: () => void;
  title?: string;
  description?: string;
}

export function PrivacyConsentModal({
  isOpen,
  onConsentSuccess,
  onCancel,
  title = 'Exam Proctoring & Privacy Notice',
  description = 'Before participating in this exam, you must review and consent to the automated proctoring policy:',
}: PrivacyConsentModalProps) {
  const { refresh } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleAccept = async () => {
    if (!agreed) return;
    setSubmitting(true);
    setError('');

    try {
      const res = await fetch('/api/student/accept-privacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) {
        const ct = res.headers.get('content-type');
        let errMsg = 'Failed to record privacy consent.';
        if (ct && ct.includes('application/json')) {
          const errData = (await res.json()) as { error?: string };
          if (errData.error) errMsg = errData.error;
        }
        throw new Error(errMsg);
      }

      await refresh();
      await onConsentSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record consent.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-slate-900 border border-indigo-500/30 rounded-2xl p-6 sm:p-8 max-w-lg w-full shadow-2xl space-y-5 animate-in fade-in duration-200">
        <div className="flex items-center gap-3">
          <span className="text-2xl">🔒</span>
          <h2 className="text-lg font-bold text-white">{title}</h2>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">{description}</p>

        <ul className="text-xs text-slate-300 space-y-1.5 list-disc list-inside bg-slate-950/60 p-3.5 rounded-xl border border-slate-800">
          <li>
            <strong>Monitored:</strong> Webcam frames and face checks, tab switches, fullscreen status, and copy/paste.
          </li>
          <li>
            <strong>Stored:</strong> Timestamps of detected events, answers, scores, and temporary review frames.
          </li>
          <li>
            <strong>Retention:</strong> Automatically purged after the exam retention period (default 90 days).
          </li>
          <li>
            <strong>Audience:</strong> Accessible only to your course instructor and authorized administrators.
          </li>
          <li>
            <strong>AI Engine:</strong> Edge inference powered by Cloudflare Workers AI.
          </li>
        </ul>

        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>Need more details?</span>
          <a
            href="/student/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
          >
            Read full policy in new tab ↗
          </a>
        </div>

        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-400">
            {error}
          </div>
        )}

        <label className="flex items-start gap-2.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500"
          />
          <span className="text-xs text-slate-200">
            I understand and consent to video proctoring and Workers AI processing for this exam.
          </span>
        </label>

        <div className="flex gap-3 pt-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="flex-1 py-2.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            disabled={!agreed || submitting}
            onClick={() => void handleAccept()}
            className="flex-1 py-2.5 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all disabled:opacity-50"
          >
            {submitting ? 'Recording Consent…' : 'Accept & Continue →'}
          </button>
        </div>
      </div>
    </div>
  );
}
