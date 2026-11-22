/**
 * src/pages/StudentHelpPage.tsx — Student Help & Frequently Asked Questions (Phase 5c)
 * ─────────────────────────────────────────────────────────────────────────────
 * Clear answers to common questions about camera issues, network disconnections,
 * behavioral tracking, and result delivery.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Link } from 'react-router-dom';
import { StudentNav } from '../components/StudentNav';

export function StudentHelpPage() {
  const faqs = [
    {
      q: 'What should I do if my camera is not working or says "Access Denied"?',
      a: 'First, check that no other application (Zoom, Teams, Discord) is currently using your webcam. In your browser address bar, click the camera or padlock icon and ensure camera permissions are set to "Allow". You can also run the Pre-Flight System Check to test your video feed before entering the lobby.',
    },
    {
      q: 'What happens if I lose my internet connection during an exam?',
      a: 'Do not panic! Your answers are automatically saved to the server every time you select or type a response, and synchronized at regular intervals. The exam timer is server-authoritative and keeps running. As soon as your internet reconnects, simply refresh or return to your Student Home and click the "Continue Exam" button to resume right where you left off.',
    },
    {
      q: 'Why am I warned when switching tabs or exiting fullscreen?',
      a: 'To guarantee assessment integrity, our proctoring agent monitors window focus, tab switches, and fullscreen status. While brief inadvertent switches may be noted, persistent or repeated exits will flag the attempt for instructor review or trigger automated enforcement.',
    },
    {
      q: 'Is my exam session recorded or stored indefinitely?',
      a: 'No. Video streams are analyzed locally and through Cloudflare Workers AI edge processing. Continuous video is not saved; only timestamps and brief snapshots of confirmed violations are kept. All data is automatically purged after the retention window configured by your instructor (default 90 days).',
    },
    {
      q: 'When and how will I receive my exam score?',
      a: 'For exams with instant results enabled (e.g., all auto-graded multiple choice), scores are visible immediately upon submission. For exams with short-answer, essay, or manual grading questions, your score will appear in your "Past Exams" section on the Student Home as soon as your professor releases final grades.',
    },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <StudentNav />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-10 w-full flex-1 space-y-8">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-950/70 border border-indigo-800/60 text-indigo-300 text-xs font-semibold mb-3">
            <span>❓</span> Student Help Center
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">
            Frequently Asked Questions
          </h1>
          <p className="text-slate-400 text-sm mt-1">
            Troubleshooting guidance and operational details for students taking proctored exams.
          </p>
        </div>

        <div className="space-y-4">
          {faqs.map((faq, idx) => (
            <div
              key={idx}
              className="p-5 rounded-2xl bg-slate-900/70 border border-slate-800/80 space-y-2 hover:border-slate-700/80 transition-colors"
            >
              <h2 className="text-sm font-bold text-white flex items-start gap-2.5">
                <span className="text-indigo-400 font-mono text-xs mt-0.5">Q{idx + 1}.</span>
                <span>{faq.q}</span>
              </h2>
              <p className="text-xs text-slate-300 pl-6 leading-relaxed">
                {faq.a}
              </p>
            </div>
          ))}
        </div>

        <div className="p-6 rounded-2xl bg-indigo-950/30 border border-indigo-800/50 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-bold text-white">Need to test your hardware?</h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Run the pre-flight diagnostic to ensure your camera and browser are ready.
            </p>
          </div>
          <Link
            to="/student/system-check"
            className="px-4 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-600/30 transition-all text-center inline-block"
          >
            Run System Check →
          </Link>
        </div>
      </main>
    </div>
  );
}
