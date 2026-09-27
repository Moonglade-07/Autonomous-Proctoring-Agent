/**
 * EventLog.tsx
 * ─────────────────────────────────────────────────────────────────
 * Scrollable live event log showing AI-generated warnings and risk
 * updates streamed back from the Durable Object over WebSocket.
 *
 * Features:
 *   • Newest events shown at top with fade-in animation
 *   • Severity badge (LOW / MED / HIGH) color-coded per score
 *   • Trigger icon + full timestamp + score
 *   • "Clear Log" button (clears local view, not backend state)
 * ─────────────────────────────────────────────────────────────────
 */

import type { RiskEvent } from '../types';

interface EventLogProps {
  /** All risk events from the session (oldest first) */
  events: RiskEvent[];
  /** Called when the user clicks "Clear Log" */
  onClear: () => void;
}

/** Returns severity badge label + Tailwind classes based on score */
function severityBadge(score: number): { label: string; cls: string } {
  if (score >= 70) return { label: 'HIGH', cls: 'bg-red-500/20 text-red-300 ring-1 ring-red-500/50' };
  if (score >= 30) return { label: 'MED', cls: 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/50' };
  return { label: 'LOW', cls: 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/50' };
}

/** Returns an emoji icon for each behavioral event type */
function triggerIcon(trigger: string): string {
  const icons: Record<string, string> = {
    tab_switch: '🔀',
    face_not_detected: '👤',
    multiple_faces: '👥',
    normal: '✅',
  };
  return icons[trigger] ?? '⚠️';
}

/** Human-readable label per event type */
function triggerLabel(trigger: string): string {
  const labels: Record<string, string> = {
    tab_switch: 'Tab Switch',
    face_not_detected: 'Face Not Detected',
    multiple_faces: 'Multiple Faces',
    normal: 'Normal Behavior',
  };
  return labels[trigger] ?? trigger;
}

/** Format ISO timestamp to HH:MM:SS */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Format ISO timestamp to full date + time */
function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function EventLog({ events, onClear }: EventLogProps) {
  const reversed = [...events].reverse(); // newest first

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Header row ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold tracking-widest text-gray-300 uppercase">
            Live Event Log
          </h2>
          {events.length > 0 && (
            <span className="text-xs bg-white/8 text-gray-500 px-2 py-0.5 rounded-full font-mono">
              {events.length}
            </span>
          )}
        </div>

        {events.length > 0 && (
          <button
            id="clear-log-btn"
            onClick={onClear}
            className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-400 transition-colors duration-150 px-2 py-1 rounded-lg hover:bg-white/5"
            title="Clear the event log view (does not reset backend session state)"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            Clear view
          </button>
        )}
      </div>

      {/* ── Event list ──────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scroll min-h-0">
        {/* Empty state */}
        {reversed.length === 0 && (
          <div className="flex flex-col items-center justify-center h-40 text-gray-600">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-9 h-9 mb-3 opacity-30"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            <p className="text-sm font-medium">No events recorded yet</p>
            <p className="text-xs mt-1 text-gray-700">Use the simulation buttons to trigger an AI analysis</p>
          </div>
        )}

        {/* Event entries */}
        {reversed.map((event, idx) => {
          const badge = severityBadge(event.score);
          const trigger = event.triggers[0] ?? '';
          return (
            <div
              key={`${event.timestamp}-${idx}`}
              className="flex gap-3 p-3.5 rounded-xl bg-white/[0.04] border border-white/[0.07] hover:bg-white/[0.07] transition-colors duration-200 animate-fade-in group"
            >
              {/* Trigger icon */}
              <div className="flex-shrink-0 text-xl leading-none mt-0.5 select-none" aria-hidden>
                {triggerIcon(trigger)}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                {/* Top row: trigger label + severity + score + time */}
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1.5">
                  <span className="text-xs font-semibold text-gray-200">
                    {triggerLabel(trigger)}
                  </span>
                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded-md ${badge.cls}`}>
                    {badge.label}
                  </span>
                  <span className="text-xs text-gray-600 font-mono ml-auto">
                    score&nbsp;
                    <span className="text-gray-400 font-semibold">{event.score}</span>
                  </span>
                </div>

                {/* AI explanation */}
                <p className="text-xs text-gray-400 leading-relaxed">
                  {event.aiExplanation}
                </p>

                {/* Timestamp */}
                <p
                  className="text-xs text-gray-700 mt-1.5 font-mono"
                  title={formatFullDate(event.timestamp)}
                >
                  {formatTime(event.timestamp)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
