/**
 * src/pages/ProfessorReportPage.tsx — Integrity Report & Human Decision View (Phase 6)
 * ─────────────────────────────────────────────────────────────────────────────
 * Route: /professor/attempts/:attemptId/report
 *
 * Requirements:
 * • Header: Exam title/course, student name/email, attempt status, started/ended,
 *   duration, ended reason, final risk score, review level & reasons.
 * • Pure human decision aid: no words like "cheating" or "guilty".
 * • Risk timeline: inline SVG chart (time on x, score 0-100 on y) with violation
 *   and intervention markers and dashed threshold line, plus accessible table fallback.
 * • Violations table: time, type, severity, duration, AI confidence, plain-text
 *   AI explanation, and Confirm / Dismiss toggles (dismissed rows struck through).
 * • Interventions table: warnings, pauses, resumes, force-submits with timestamps.
 * • Review decision panel: No action / Warning / Escalate, note (max 2000 chars), save/clear.
 * • Purged notice if detailed evidence was removed by retention policy.
 * • Print / save as PDF button (calls window.print()) with dedicated @media print CSS
 *   and authoritative decision-aid footer.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ProfessorNav } from '../components/ProfessorNav';

export interface ReportData {
  header: {
    attemptId: string;
    examId: string;
    examTitle: string;
    examCourse: string;
    studentName: string;
    studentEmail: string;
    status: string;
    startedAt: string | null;
    endedAt: string | null;
    durationSeconds: number | null;
    endedReason: string | null;
    finalRiskScore: number;
    maxRiskScore: number;
    violationCount: number | null;
    maxSeverity: string | null;
    reviewLevel: 'unknown' | 'none' | 'low' | 'medium' | 'high';
    reviewReasons: string[];
    purged: boolean;
  };
  riskTimeline: Array<{
    timestamp: string;
    score: number;
    triggers: string[];
    aiExplanation: string;
  }>;
  violations: Array<{
    id: string;
    type: string;
    severity: string;
    timestamp: string;
    duration?: number;
    aiConfidence: number;
    aiExplanation?: string;
    reviewDecision: 'confirmed' | 'dismissed' | null;
    reviewedBy?: string | null;
    reviewedAt?: string | null;
  }>;
  interventions: Array<{
    id: string;
    action: string;
    message: string;
    issuedAt: string;
    acknowledgedAt?: string | null;
  }>;
  review: {
    decision: 'no_action' | 'warning' | 'escalate' | null;
    note: string | null;
    reviewedAt: string | null;
    reviewedBy: string | null;
  };
}

export function ProfessorReportPage() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const { user } = useAuth();

  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Decision panel state
  const [selectedDecision, setSelectedDecision] = useState<'no_action' | 'warning' | 'escalate' | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [savingDecision, setSavingDecision] = useState(false);
  const [decisionFeedback, setDecisionFeedback] = useState<string | null>(null);

  // Accessible table toggle for timeline
  const [showTimelineTable, setShowTimelineTable] = useState(false);

  // Violation action loading map
  const [updatingViolations, setUpdatingViolations] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!attemptId) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    fetch(`/api/professor/attempts/${encodeURIComponent(attemptId)}/report`)
      .then(async (res) => {
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `Error ${res.status}: Failed to load report`);
        }
        return res.json() as Promise<ReportData>;
      })
      .then((rep) => {
        if (!isMounted) return;
        setData(rep);
        setSelectedDecision(rep.review.decision);
        setDecisionNote(rep.review.note || '');
        setLoading(false);
      })
      .catch((e: any) => {
        if (!isMounted) return;
        setError(e.message);
        setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [attemptId]);

  // Handle saving the overall review decision
  const handleSaveDecision = async (decisionToSave: 'no_action' | 'warning' | 'escalate' | null) => {
    if (!attemptId) return;
    setSavingDecision(true);
    setDecisionFeedback(null);

    try {
      const res = await fetch(`/api/professor/attempts/${encodeURIComponent(attemptId)}/review`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: decisionToSave,
          note: decisionNote.trim().length > 0 ? decisionNote.trim() : null,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to save review decision');
      }

      const resData = (await res.json()) as any;
      setData((prev) =>
        prev
          ? {
              ...prev,
              review: {
                decision: resData.review.decision,
                note: resData.review.note,
                reviewedAt: resData.review.reviewedAt,
                reviewedBy: resData.review.reviewedBy || user?.name || null,
              },
            }
          : prev,
      );
      setSelectedDecision(decisionToSave);
      setDecisionFeedback('Review decision updated successfully.');
    } catch (e: any) {
      setDecisionFeedback(`Error: ${e.message}`);
    } finally {
      setSavingDecision(false);
    }
  };

  // Handle confirming or dismissing an individual violation
  const handleViolationDecision = async (
    violationId: string,
    decision: 'confirmed' | 'dismissed' | null,
  ) => {
    if (!attemptId) return;
    setUpdatingViolations((prev) => ({ ...prev, [violationId]: true }));

    try {
      const res = await fetch(
        `/api/professor/attempts/${encodeURIComponent(attemptId)}/violations/${encodeURIComponent(violationId)}/review`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        },
      );

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || 'Failed to update violation review');
      }

      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          violations: prev.violations.map((v) =>
            v.id === violationId
              ? {
                  ...v,
                  reviewDecision: decision,
                  reviewedBy: decision ? user?.name || null : null,
                  reviewedAt: decision ? new Date().toISOString() : null,
                }
              : v,
          ),
        };
      });
    } catch (e: any) {
      alert(`Could not update violation: ${e.message}`);
    } finally {
      setUpdatingViolations((prev) => ({ ...prev, [violationId]: false }));
    }
  };

  // Compute SVG chart coordinates for Risk Timeline
  const chartDetails = useMemo(() => {
    if (!data || !data.riskTimeline || data.riskTimeline.length === 0) return null;

    const width = 800;
    const height = 220;
    const padX = 50;
    const padY = 30;
    const plotW = width - padX * 2;
    const plotH = height - padY * 2;

    const timeline = data.riskTimeline;
    const times = timeline.map((pt) => new Date(pt.timestamp).getTime());
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const timeSpan = maxTime === minTime ? 1 : maxTime - minTime;

    const points = timeline.map((pt) => {
      const t = new Date(pt.timestamp).getTime();
      const x = padX + ((t - minTime) / timeSpan) * plotW;
      const y = padY + (1 - Math.max(0, Math.min(100, pt.score)) / 100) * plotH;
      return { x, y, pt };
    });

    const polylineStr = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    const thresholdY = padY + (1 - Math.max(0, Math.min(100, data.header.maxRiskScore)) / 100) * plotH;

    // Map violations to x-coordinates
    const violationMarkers = data.violations.map((v) => {
      const vt = new Date(v.timestamp).getTime();
      const clampedT = Math.max(minTime, Math.min(maxTime, vt));
      const x = padX + ((clampedT - minTime) / timeSpan) * plotW;
      return { x, v };
    });

    // Map interventions to x-coordinates
    const interventionMarkers = data.interventions.map((iv) => {
      const it = new Date(iv.issuedAt).getTime();
      const clampedT = Math.max(minTime, Math.min(maxTime, it));
      const x = padX + ((clampedT - minTime) / timeSpan) * plotW;
      return { x, iv };
    });

    return { width, height, padX, padY, plotW, plotH, points, polylineStr, thresholdY, violationMarkers, interventionMarkers, minTime, maxTime };
  }, [data]);

  const formatDuration = (seconds: number | null | undefined) => {
    if (seconds === null || seconds === undefined) return '—';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  const getLevelBadge = (level: string) => {
    switch (level) {
      case 'high':
        return {
          bg: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
          dot: 'bg-rose-500',
          label: 'High Review Priority',
        };
      case 'medium':
        return {
          bg: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
          dot: 'bg-amber-500',
          label: 'Medium Review Priority',
        };
      case 'low':
        return {
          bg: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
          dot: 'bg-blue-500',
          label: 'Low Review Priority',
        };
      case 'none':
        return {
          bg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
          dot: 'bg-emerald-500',
          label: 'No Flagged Triggers',
        };
      default:
        return {
          bg: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
          dot: 'bg-slate-500',
          label: 'Not Recorded (Legacy)',
        };
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <ProfessorNav />
        <div className="max-w-6xl mx-auto px-4 py-16 text-center">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400 text-sm">Loading integrity report…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <ProfessorNav />
        <div className="max-w-2xl mx-auto px-4 py-16 text-center space-y-4">
          <div className="text-4xl">⚠️</div>
          <h1 className="text-xl font-bold text-white">Report Unavailable</h1>
          <p className="text-slate-400 text-sm">{error || 'Attempt could not be found or you lack permission to view it.'}</p>
          <div className="pt-4">
            <Link
              to="/professor"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-sm font-semibold transition"
            >
              ← Back to Professor Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const badge = getLevelBadge(data.header.reviewLevel);
  const isEnded = data.header.status !== 'in_progress';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans pb-16 report-root">
      {/* Print Stylesheet */}
      <style>{`
        @media print {
          nav, .no-print { display: none !important; }
          body, .report-root { background: #ffffff !important; color: #000000 !important; }
          .print-card { background: #ffffff !important; border: 1px solid #cbd5e1 !important; color: #000000 !important; box-shadow: none !important; }
          .print-text-dark { color: #0f172a !important; }
          .print-text-muted { color: #475569 !important; }
          table { width: 100% !important; border-collapse: collapse !important; }
          th, td { border: 1px solid #cbd5e1 !important; padding: 6px 10px !important; color: #000000 !important; page-break-inside: avoid !important; }
          tr { page-break-inside: avoid !important; }
          .print-footer { display: block !important; margin-top: 2rem !important; border-top: 1px solid #94a3b8 !important; padding-top: 1rem !important; font-size: 11px !important; color: #334155 !important; }
        }
        @media screen {
          .print-footer { display: none; }
        }
      `}</style>

      <div className="no-print">
        <ProfessorNav />
      </div>

      <div className="max-w-6xl mx-auto px-4 pt-6 space-y-6">
        {/* Navigation & Print Bar */}
        <div className="flex flex-wrap items-center justify-between gap-4 no-print border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <Link
              to={`/professor/exams/${data.header.examId}`}
              className="text-xs font-semibold text-slate-400 hover:text-white transition flex items-center gap-1"
            >
              ← Back to Exam
            </Link>
            <span className="text-slate-600">/</span>
            <Link
              to="/professor/review"
              className="text-xs font-semibold text-slate-400 hover:text-white transition"
            >
              Review Queue
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => window.print()}
              className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold border border-slate-700 transition flex items-center gap-2 shadow"
              title="Print or save as PDF"
            >
              <span>🖨️</span> Print / Save as PDF
            </button>
          </div>
        </div>

        {/* ── Section 1: Summary Header ────────────────────────────────────── */}
        <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800/80 shadow-xl print-card space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-bold uppercase tracking-wider text-indigo-400">
                  Integrity Assessment Report
                </span>
                <span className="text-xs text-slate-500 font-mono">#{data.header.attemptId}</span>
              </div>
              <h1 className="text-2xl font-black text-white print-text-dark">{data.header.studentName}</h1>
              <p className="text-sm text-slate-400 print-text-muted mt-0.5">
                {data.header.studentEmail ? `${data.header.studentEmail} • ` : ''}
                Exam: <span className="text-slate-200 font-semibold">{data.header.examTitle}</span>
                {data.header.examCourse ? ` (${data.header.examCourse})` : ''}
              </p>
            </div>

            <div className="flex items-center gap-4">
              <div className="text-right">
                <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block">
                  Final Risk Score
                </span>
                <span className="text-3xl font-black font-mono text-white print-text-dark">
                  {data.header.finalRiskScore}
                  <span className="text-sm font-normal text-slate-500"> / 100</span>
                </span>
              </div>
              <div className={`px-3 py-2 rounded-xl border flex items-center gap-2 font-bold text-xs ${badge.bg}`}>
                <span className={`w-2 h-2 rounded-full ${badge.dot}`} />
                <span>{badge.label}</span>
              </div>
            </div>
          </div>

          {/* Quick Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-slate-800/80 print-card">
            <div className="p-3 rounded-xl bg-slate-950/50 border border-slate-800/50">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">Status</span>
              <span className="text-sm font-bold text-slate-200 capitalize">{data.header.status.replace('_', ' ')}</span>
            </div>
            <div className="p-3 rounded-xl bg-slate-950/50 border border-slate-800/50">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">Duration</span>
              <span className="text-sm font-bold text-slate-200">{formatDuration(data.header.durationSeconds)}</span>
            </div>
            <div className="p-3 rounded-xl bg-slate-950/50 border border-slate-800/50">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">Ended Reason</span>
              <span className="text-sm font-bold text-slate-200 capitalize">
                {data.header.endedReason?.replace('_', ' ') || 'In progress'}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-slate-950/50 border border-slate-800/50">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block">Violations Flagged</span>
              <span className="text-sm font-bold text-slate-200">
                {data.header.violationCount !== null ? data.header.violationCount : 'Not recorded'}
              </span>
            </div>
          </div>
        </div>

        {/* ── Section 2: Why Flagged & Decision Aid Notice ─────────────────── */}
        <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 print-card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-wider text-slate-400 flex items-center gap-2">
              <span>🔍</span> Why Flagged for Review
            </h2>
            <span className="text-[11px] text-slate-500 italic">Prompt for human review — not an automated verdict</span>
          </div>

          <ul className="space-y-1.5 text-xs text-slate-300 print-text-dark">
            {data.header.reviewReasons.map((reason, idx) => (
              <li key={idx} className="flex items-start gap-2">
                <span className="text-indigo-400 font-bold">•</span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* ── Retention Notice (if purged) ─────────────────────────────────── */}
        {data.header.purged && (
          <div className="p-4 rounded-2xl bg-amber-950/30 border border-amber-500/40 text-amber-200 text-xs flex items-center gap-3 print-card">
            <span className="text-xl">🛡️</span>
            <div>
              <p className="font-bold">Detailed evidence was removed by the retention policy.</p>
              <p className="text-amber-300/80 text-[11px] mt-0.5">
                Only the summary score and violation counts above are preserved. Timeline snapshots and frame evidence are unavailable.
              </p>
            </div>
          </div>
        )}

        {/* ── Section 3: Risk Timeline Chart ──────────────────────────────── */}
        {!data.header.purged && chartDetails && (
          <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800 print-card space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-bold text-white print-text-dark">Risk Timeline</h2>
                <p className="text-xs text-slate-400 print-text-muted">
                  Progression of calculated risk score over time. Dashed line denotes exam review threshold ({data.header.maxRiskScore}).
                </p>
              </div>

              <button
                onClick={() => setShowTimelineTable(!showTimelineTable)}
                className="no-print text-xs text-indigo-400 hover:text-indigo-300 underline font-medium"
              >
                {showTimelineTable ? 'Hide data table' : 'Show accessible table fallback'}
              </button>
            </div>

            {/* Inline SVG Chart */}
            <div className="w-full overflow-x-auto">
              <svg
                viewBox={`0 0 ${chartDetails.width} ${chartDetails.height}`}
                className="w-full h-56 min-w-[600px] select-none"
              >
                {/* Background grid */}
                <rect x="0" y="0" width={chartDetails.width} height={chartDetails.height} fill="#020617" rx="12" />

                {/* Y-axis gridlines */}
                {[0, 25, 50, 75, 100].map((val) => {
                  const y = chartDetails.padY + (1 - val / 100) * chartDetails.plotH;
                  return (
                    <g key={val}>
                      <line
                        x1={chartDetails.padX}
                        y1={y}
                        x2={chartDetails.width - chartDetails.padX}
                        y2={y}
                        stroke="#1e293b"
                        strokeDasharray={val === 0 ? 'none' : '2,2'}
                      />
                      <text x={chartDetails.padX - 8} y={y + 4} fill="#64748b" fontSize="10" textAnchor="end">
                        {val}
                      </text>
                    </g>
                  );
                })}

                {/* Exam Maximum Risk Threshold Line */}
                <line
                  x1={chartDetails.padX}
                  y1={chartDetails.thresholdY}
                  x2={chartDetails.width - chartDetails.padX}
                  y2={chartDetails.thresholdY}
                  stroke="#ef4444"
                  strokeWidth="1.5"
                  strokeDasharray="4,4"
                />
                <text
                  x={chartDetails.width - chartDetails.padX - 4}
                  y={chartDetails.thresholdY - 6}
                  fill="#ef4444"
                  fontSize="10"
                  textAnchor="end"
                  fontWeight="bold"
                >
                  Threshold ({data.header.maxRiskScore})
                </text>

                {/* Risk Score Path */}
                {chartDetails.points.length > 1 && (
                  <polyline
                    fill="none"
                    stroke="#818cf8"
                    strokeWidth="2.5"
                    points={chartDetails.polylineStr}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}

                {/* Points */}
                {chartDetails.points.map((pt, i) => (
                  <circle
                    key={i}
                    cx={pt.x}
                    cy={pt.y}
                    r="4"
                    fill="#818cf8"
                    stroke="#020617"
                    strokeWidth="1.5"
                  >
                    <title>{`${new Date(pt.pt.timestamp).toLocaleTimeString()}: Score ${pt.pt.score}\n${pt.pt.aiExplanation}`}</title>
                  </circle>
                ))}

                {/* Violation Markers (Red Triangles) */}
                {chartDetails.violationMarkers.map((vm, i) => (
                  <g key={`vm-${i}`} transform={`translate(${vm.x}, 20)`}>
                    <polygon points="0,-6 6,6 -6,6" fill="#f43f5e" />
                    <title>{`Violation flagged at ${new Date(vm.v.timestamp).toLocaleTimeString()}: ${vm.v.type} (${vm.v.severity})`}</title>
                  </g>
                ))}

                {/* Intervention Markers (Blue Diamonds) */}
                {chartDetails.interventionMarkers.map((im, i) => (
                  <g key={`im-${i}`} transform={`translate(${im.x}, ${chartDetails.height - 15})`}>
                    <polygon points="0,-5 5,0 0,5 -5,0" fill="#38bdf8" />
                    <title>{`Intervention (${im.iv.action}) at ${new Date(im.iv.issuedAt).toLocaleTimeString()}`}</title>
                  </g>
                ))}
              </svg>
            </div>

            {/* Accessible Table Fallback */}
            {showTimelineTable && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-xs border border-slate-800 rounded-xl">
                  <thead className="bg-slate-950 text-slate-400 font-bold uppercase tracking-wider">
                    <tr>
                      <th className="py-2 px-3">Time</th>
                      <th className="py-2 px-3">Score</th>
                      <th className="py-2 px-3">Triggers</th>
                      <th className="py-2 px-3">Explanation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 text-slate-300">
                    {data.riskTimeline.map((item, idx) => (
                      <tr key={idx} className="hover:bg-slate-800/40">
                        <td className="py-2 px-3 font-mono">{new Date(item.timestamp).toLocaleTimeString()}</td>
                        <td className="py-2 px-3 font-mono font-bold">{item.score}</td>
                        <td className="py-2 px-3">
                          {item.triggers.map((trig, tIdx) => (
                            <span key={tIdx} className="mr-1 px-1.5 py-0.5 rounded bg-slate-800 text-[10px]">
                              {trig}
                            </span>
                          ))}
                        </td>
                        <td className="py-2 px-3">{item.aiExplanation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Section 4: Violations Table ─────────────────────────────────── */}
        {!data.header.purged && (
          <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800 print-card space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-white print-text-dark">Flagged Violations</h2>
                <p className="text-xs text-slate-400 print-text-muted">
                  Events detected during the attempt. Confirm or dismiss events to record your evaluation.
                </p>
              </div>
              <span className="text-xs font-semibold text-slate-400">Total: {data.violations.length}</span>
            </div>

            {data.violations.length === 0 ? (
              <p className="text-xs text-slate-500 py-3 italic">No violations recorded for this attempt.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border border-slate-800 rounded-xl">
                  <thead className="bg-slate-950/80 text-slate-400 font-bold uppercase tracking-wider">
                    <tr>
                      <th className="py-2.5 px-3">Time</th>
                      <th className="py-2.5 px-3">Type</th>
                      <th className="py-2.5 px-3">Severity</th>
                      <th className="py-2.5 px-3">Duration</th>
                      <th className="py-2.5 px-3">Confidence</th>
                      <th className="py-2.5 px-3">Explanation</th>
                      <th className="py-2.5 px-3">Human Review</th>
                      <th className="py-2.5 px-3 text-right no-print">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800 text-slate-300">
                    {data.violations.map((v) => {
                      const isDismissed = v.reviewDecision === 'dismissed';
                      const isConfirmed = v.reviewDecision === 'confirmed';
                      const isBusy = Boolean(updatingViolations[v.id]);

                      return (
                        <tr
                          key={v.id}
                          className={`hover:bg-slate-800/40 transition ${
                            isDismissed ? 'line-through opacity-60 bg-slate-950/40' : ''
                          }`}
                        >
                          <td className="py-2.5 px-3 font-mono">{new Date(v.timestamp).toLocaleTimeString()}</td>
                          <td className="py-2.5 px-3 capitalize font-semibold">{v.type}</td>
                          <td className="py-2.5 px-3">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${
                                v.severity === 'critical'
                                  ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                                  : v.severity === 'high'
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                  : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                              }`}
                            >
                              {v.severity}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 font-mono text-slate-400">
                            {typeof v.duration === 'number' ? `${v.duration}s` : '—'}
                          </td>
                          <td className="py-2.5 px-3 font-mono text-slate-400">
                            {Math.round(v.aiConfidence * 100)}%
                          </td>
                          <td className="py-2.5 px-3 max-w-xs">{v.aiExplanation || '—'}</td>
                          <td className="py-2.5 px-3">
                            {isConfirmed && (
                              <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-bold">
                                ✓ Confirmed
                              </span>
                            )}
                            {isDismissed && (
                              <span className="px-2 py-0.5 rounded bg-slate-700/60 text-slate-400 border border-slate-600 text-[10px] font-bold">
                                ✗ Dismissed
                              </span>
                            )}
                            {!v.reviewDecision && (
                              <span className="text-slate-500 text-[11px] italic">Pending</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right space-x-1 whitespace-nowrap no-print">
                            <button
                              disabled={isBusy}
                              onClick={() => handleViolationDecision(v.id, isConfirmed ? null : 'confirmed')}
                              className={`px-2 py-1 rounded text-[11px] font-bold transition border ${
                                isConfirmed
                                  ? 'bg-emerald-600 text-white border-emerald-500'
                                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                              }`}
                              title={isConfirmed ? 'Click to unconfirm' : 'Confirm violation'}
                            >
                              Confirm
                            </button>
                            <button
                              disabled={isBusy}
                              onClick={() => handleViolationDecision(v.id, isDismissed ? null : 'dismissed')}
                              className={`px-2 py-1 rounded text-[11px] font-bold transition border ${
                                isDismissed
                                  ? 'bg-slate-700 text-slate-200 border-slate-600'
                                  : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'
                              }`}
                              title={isDismissed ? 'Click to undis-miss' : 'Dismiss violation'}
                            >
                              Dismiss
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Section 5: Interventions Table ──────────────────────────────── */}
        {!data.header.purged && data.interventions.length > 0 && (
          <div className="p-6 rounded-2xl bg-slate-900/80 border border-slate-800 print-card space-y-4">
            <h2 className="text-sm font-bold text-white print-text-dark">Proctor Interventions</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border border-slate-800 rounded-xl">
                <thead className="bg-slate-950/80 text-slate-400 font-bold uppercase tracking-wider">
                  <tr>
                    <th className="py-2.5 px-3">Issued At</th>
                    <th className="py-2.5 px-3">Action</th>
                    <th className="py-2.5 px-3">Message</th>
                    <th className="py-2.5 px-3">Acknowledged</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 text-slate-300">
                  {data.interventions.map((iv) => (
                    <tr key={iv.id} className="hover:bg-slate-800/40">
                      <td className="py-2.5 px-3 font-mono">{new Date(iv.issuedAt).toLocaleTimeString()}</td>
                      <td className="py-2.5 px-3 font-bold uppercase text-indigo-400">{iv.action}</td>
                      <td className="py-2.5 px-3">{iv.message}</td>
                      <td className="py-2.5 px-3 font-mono text-slate-400">
                        {iv.acknowledgedAt ? new Date(iv.acknowledgedAt).toLocaleTimeString() : 'No'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── Section 6: Review Decision Panel ─────────────────────────────── */}
        <div className="p-6 rounded-2xl bg-slate-900/90 border border-slate-800 shadow-xl print-card space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-white print-text-dark">Professor Review Decision</h2>
              <p className="text-xs text-slate-400 print-text-muted">
                Record your formal human evaluation for this attempt.
              </p>
            </div>

            {data.review.decision && (
              <div className="text-right">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">
                  Current Status
                </span>
                <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider">
                  ✓ {data.review.decision.replace('_', ' ')}
                </span>
                {data.review.reviewedBy && (
                  <p className="text-[10px] text-slate-500 font-mono mt-0.5">
                    by {data.review.reviewedBy} on {new Date(data.review.reviewedAt || '').toLocaleDateString()}
                  </p>
                )}
              </div>
            )}
          </div>

          {!isEnded ? (
            <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs">
              ⚠️ <strong>Attempt In Progress:</strong> Review decisions can only be recorded once the attempt has ended.
            </div>
          ) : (
            <div className="space-y-4 no-print">
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-slate-400 block mb-2">
                  Select Decision
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {[
                    { val: 'no_action', label: 'No Action', desc: 'No breach found / cleared' },
                    { val: 'warning', label: 'Warning', desc: 'Issue informal warning' },
                    { val: 'escalate', label: 'Escalate', desc: 'Refer to honor committee' },
                  ].map((opt) => {
                    const isSelected = selectedDecision === opt.val;
                    return (
                      <button
                        key={opt.val}
                        type="button"
                        onClick={() => setSelectedDecision(opt.val as any)}
                        className={`p-3 rounded-xl border text-left transition ${
                          isSelected
                            ? 'bg-indigo-600/20 border-indigo-500 text-white shadow-lg shadow-indigo-500/10'
                            : 'bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-700'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-xs">{opt.label}</span>
                          {isSelected && <span className="text-indigo-400 text-xs">●</span>}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-1">{opt.desc}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Review Notes (Optional)
                  </label>
                  <span className="text-[11px] text-slate-500 font-mono">{decisionNote.length} / 2000</span>
                </div>
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={decisionNote}
                  onChange={(e) => setDecisionNote(e.target.value)}
                  placeholder="Add context, conversation notes, or justification for your decision…"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
                />
              </div>

              {decisionFeedback && (
                <p className="text-xs font-semibold text-indigo-400">{decisionFeedback}</p>
              )}

              <div className="flex items-center gap-3 pt-1">
                <button
                  type="button"
                  disabled={savingDecision || !selectedDecision}
                  onClick={() => handleSaveDecision(selectedDecision)}
                  className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold transition shadow"
                >
                  {savingDecision ? 'Saving…' : 'Save Decision'}
                </button>

                {data.review.decision && (
                  <button
                    type="button"
                    disabled={savingDecision}
                    onClick={() => handleSaveDecision(null)}
                    className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold border border-slate-700 transition"
                  >
                    Clear Decision
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Print View of Decision Notes */}
          {data.review.decision && (
            <div className="print-only hidden space-y-2 border-t border-slate-300 pt-3">
              <p className="text-xs font-bold text-slate-800">
                Decision: <span className="uppercase">{data.review.decision.replace('_', ' ')}</span>
              </p>
              {data.review.note && (
                <p className="text-xs text-slate-700 italic">Notes: {data.review.note}</p>
              )}
            </div>
          )}
        </div>

        {/* ── Print Footer (Visible ONLY when printed to PDF) ─────────────── */}
        <div className="print-footer text-center space-y-1">
          <p className="font-bold">
            Autonomous Proctoring Agent · Exam: {data.header.examTitle} · Student: {data.header.studentName}
          </p>
          <p>
            Report generated by {user?.name || 'Authorized Proctor'} on {new Date().toUTCString()}
          </p>
          <p className="font-semibold text-slate-800 mt-2">
            This report is a decision aid. Flags are generated automatically and require human review.
          </p>
        </div>
      </div>
    </div>
  );
}
