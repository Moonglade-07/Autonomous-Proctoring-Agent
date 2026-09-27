/**
 * WebcamPreview.tsx
 * Placeholder webcam preview box — no real camera access in Phase 1.
 * Displays a simulated "camera feed" with an animated indicator.
 */

export function WebcamPreview() {
  return (
    <div className="relative w-full aspect-video rounded-2xl overflow-hidden bg-gray-900 border border-gray-700 shadow-inner">
      {/* Simulated camera noise / placeholder */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        {/* Camera icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="w-16 h-16 text-gray-600"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9A2.25 2.25 0 0013.5 5.25h-9A2.25 2.25 0 002.25 7.5v9A2.25 2.25 0 004.5 18.75z"
          />
        </svg>
        <p className="text-gray-500 text-sm font-medium tracking-wide">Webcam Preview</p>
        <p className="text-gray-600 text-xs">[ Camera access simulated in Phase 1 ]</p>
      </div>

      {/* Recording indicator */}
      <div className="absolute top-3 right-3 flex items-center gap-1.5">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
        </span>
        <span className="text-xs text-red-400 font-semibold tracking-widest uppercase">REC</span>
      </div>

      {/* Subtle scan-line overlay for aesthetic */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.04) 2px, rgba(0,0,0,0.04) 4px)',
        }}
      />
    </div>
  );
}
