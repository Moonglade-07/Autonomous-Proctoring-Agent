/**
 * EventLog.tsx
 * Scrollable live event log showing AI-generated warnings and risk updates.
 * New entries animate in from the top.
 */

import type { RiskEvent } from '../types';

interface EventLogProps {
  events: RiskEvent[];
}

function severityBadge(score: number) {
  if (score >= 70) return { label: 'HIGH', cls: 'bg-red-500/20 text-red-400 ring-1 ring-red-500/40' };
  if (score >= 30) return { label: 'MED', cls: 'bg-yellow-500/20 text-yellow-400 ring-1 ring-yellow-500/40' };
  return { label: 'LOW', cls: 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40' };
}

function triggerIcon(trigger: string) {
  const icons: Record<string, string> = {
    tab_switch: '🔀',
    face_not_detected: '👤',
    multiple_faces: '👥',
    normal: '✅',
  };
  return icons[trigger] ?? '⚠️';
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function EventLog({ events }: EventLogProps) {
  const reversed = [...events].reverse(); // newest first

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold tracking-widest text-gray-400 uppercase">Live Event Log</h2>
        <span className="text-xs text-gray-600 font-mono">{events.length} event{events.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 pr-1 custom-scroll">
        {reversed.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-gray-600">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-8 h-8 mb-2 opacity-40"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <p className="text-sm">No events yet. Simulate one below.</p>
          </div>
        )}

        {reversed.map((event, idx) => {
          const badge = severityBadge(event.score);
          const trigger = event.triggers[0] ?? '';
          return (
            <div
              key={`${event.timestamp}-${idx}`}
              className="flex gap-3 p-3 rounded-xl bg-white/5 border border-white/8 hover:bg-white/8 transition-colors duration-200 animate-fade-in"
            >
              {/* Icon */}
              <div className="flex-shrink-0 text-xl leading-none mt-0.5">
                {triggerIcon(trigger)}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded-md ${badge.cls}`}>
                    {badge.label}
                  </span>
                  <span className="text-xs text-gray-500 font-mono">{formatTime(event.timestamp)}</span>
                  <span className="text-xs text-gray-600 ml-auto font-mono">score: {event.score}</span>
                </div>
                <p className="text-xs text-gray-300 leading-relaxed line-clamp-3">
                  {event.aiExplanation}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
