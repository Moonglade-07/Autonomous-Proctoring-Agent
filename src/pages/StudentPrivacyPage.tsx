/**
 * src/pages/StudentPrivacyPage.tsx — Privacy Notice & Consent Policy (Phase 5c)
 * ─────────────────────────────────────────────────────────────────────────────
 * Transparent, plain-language privacy notice for students taking monitored exams.
 * Details monitoring scope, storage, retention, access controls, and AI processing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { StudentNav } from '../components/StudentNav';

export function StudentPrivacyPage() {
  const { user, refresh } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const isAccepted = !!user?.privacy_accepted || !!user?.privacy_accepted_at;

  const handleAccept = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreed) {
      setErrorMsg('Please check the confirmation box to agree to the privacy policy.');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    setSuccessMsg('');

    try {
      const res = await fetch('/api/student/accept-privacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };

      if (!res.ok || !body.ok) {
        throw new Error(body.error || 'Failed to record privacy consent.');
      }

      setSuccessMsg('Thank you. Your privacy consent has been recorded successfully.');
      await refresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to record consent.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <StudentNav />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10 w-full flex-1 space-y-8">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-950/70 border border-indigo-800/60 text-indigo-300 text-xs font-semibold mb-3">
            <span>🛡️</span> Privacy & Integrity Notice
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">
            Proctoring & Data Privacy Policy
          </h1>
          <p className="text-slate-400 text-sm mt-2 leading-relaxed">
            We are committed to preserving your privacy while ensuring academic integrity during remote assessments.
            Please review how your data is collected, processed, and safeguarded.
          </p>
        </div>

        {/* Status Banner */}
        {isAccepted ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-4 flex items-center gap-3">
            <span className="text-2xl">✅</span>
            <div>
              <p className="text-sm font-bold text-emerald-300">Privacy Notice Accepted</p>
              <p className="text-xs text-emerald-400/80">
                You have consented to exam proctoring. You can join and take scheduled exams.
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-4 flex items-center gap-3">
            <span className="text-2xl">⚠️</span>
            <div>
              <p className="text-sm font-bold text-amber-300">Consent Required</p>
              <p className="text-xs text-amber-400/80">
                You must accept this privacy policy before joining or starting an exam lobby.
              </p>
            </div>
          </div>
        )}

        {/* Policy Details Cards */}
        <div className="space-y-4">
          <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span>👁️</span> What is Monitored
            </h2>
            <ul className="mt-3 space-y-2 text-xs text-slate-300 list-disc list-inside leading-relaxed">
              <li>
                <strong>Webcam & Face Checks:</strong> Video frames are analyzed in real time for presence, looking away from screen, multiple people in view, or absence.
              </li>
              <li>
                <strong>Browser Environment:</strong> Tab switching, opening other windows, exiting fullscreen mode, and losing window focus.
              </li>
              <li>
                <strong>Clipboard & Keyboard:</strong> Copy, paste, and disallowed keyboard shortcuts are tracked to ensure integrity.
              </li>
            </ul>
          </div>

          <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span>💾</span> What is Stored
            </h2>
            <ul className="mt-3 space-y-2 text-xs text-slate-300 list-disc list-inside leading-relaxed">
              <li>
                <strong>Violation Telemetry:</strong> An event log of timestamps, flag types (e.g., tab switch, missing face), and AI confidence levels.
              </li>
              <li>
                <strong>Flagged Frames:</strong> Small snapshots captured only when a violation is actively detected, kept strictly for review.
              </li>
              <li>
                <strong>Responses & Grades:</strong> Your submitted answers, autosave drafts, question scores, and instructor feedback.
              </li>
            </ul>
          </div>

          <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span>⏳</span> Retention Period
            </h2>
            <p className="mt-2 text-xs text-slate-300 leading-relaxed">
              Exam data is stored only for the duration configured by the instructor (default 90 days).
              After this retention window expires, violation logs, telemetry, and flagged frames are permanently deleted by automated daily background sweeps.
            </p>
          </div>

          <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span>🔒</span> Access Controls & Security
            </h2>
            <p className="mt-2 text-xs text-slate-300 leading-relaxed">
              Only the <strong>course instructor (exam owner)</strong> and system administrators can view session telemetry and violation logs.
              Other students can never see your video, responses, or flags.
            </p>
          </div>

          <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800/80">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span>⚡</span> Cloudflare Workers AI Edge Processing
            </h2>
            <p className="mt-2 text-xs text-slate-300 leading-relaxed">
              All facial detection and behavioral verification algorithms run on privacy-centric, SOC-2 compliant
              <strong> Cloudflare Workers AI</strong> edge nodes. No biometrics or images are ever sold, trained upon, or shared with third parties.
            </p>
          </div>
        </div>

        {/* Consent Form */}
        {!isAccepted && (
          <form onSubmit={handleAccept} className="p-6 rounded-2xl bg-slate-900/90 border border-indigo-500/30 shadow-xl space-y-4">
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500"
              />
              <span className="text-xs text-slate-200 leading-relaxed">
                I have read and understand the Autonomous Proctoring Agent Privacy Policy.
                I explicitly consent to real-time webcam analysis, behavioral monitoring, and Workers AI processing during my examinations.
              </span>
            </label>

            {errorMsg && (
              <p className="text-xs font-semibold text-rose-400">{errorMsg}</p>
            )}
            {successMsg && (
              <p className="text-xs font-semibold text-emerald-400">{successMsg}</p>
            )}

            <button
              type="submit"
              disabled={loading || !agreed}
              className="w-full py-3 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all disabled:opacity-50"
            >
              {loading ? 'Recording Consent…' : 'I Agree & Accept Proctoring Policy'}
            </button>
          </form>
        )}
      </main>
    </div>
  );
}
