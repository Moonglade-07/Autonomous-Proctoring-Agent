/**
 * RiskIndicator.tsx
 * Displays the current risk score with color-coded levels:
 *   GREEN  — score < 30  (low risk)
 *   YELLOW — score 30–70 (medium risk)
 *   RED    — score > 70  (high risk)
 */

interface RiskIndicatorProps {
  score: number;
}

function getRiskLevel(score: number): { label: string; color: string; bg: string; ring: string; glow: string } {
  if (score >= 70) {
    return {
      label: 'HIGH RISK',
      color: 'text-red-400',
      bg: 'bg-red-950/60',
      ring: 'ring-red-500/60',
      glow: 'shadow-red-500/30',
    };
  }
  if (score >= 30) {
    return {
      label: 'MEDIUM RISK',
      color: 'text-yellow-400',
      bg: 'bg-yellow-950/60',
      ring: 'ring-yellow-500/60',
      glow: 'shadow-yellow-500/30',
    };
  }
  return {
    label: 'LOW RISK',
    color: 'text-emerald-400',
    bg: 'bg-emerald-950/60',
    ring: 'ring-emerald-500/60',
    glow: 'shadow-emerald-500/30',
  };
}

/** Arc-style radial progress gauge */
function ScoreGauge({ score }: { score: number }) {
  // SVG circle gauge parameters
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  const strokeColor =
    score >= 70 ? '#f87171' : score >= 30 ? '#facc15' : '#34d399';

  return (
    <svg className="w-40 h-40 -rotate-90" viewBox="0 0 120 120">
      {/* Background track */}
      <circle
        cx="60"
        cy="60"
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.06)"
        strokeWidth="10"
      />
      {/* Progress arc */}
      <circle
        cx="60"
        cy="60"
        r={radius}
        fill="none"
        stroke={strokeColor}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 0.6s ease, stroke 0.4s ease' }}
      />
      {/* Score text (counter-rotate to be readable) */}
      <text
        x="60"
        y="60"
        textAnchor="middle"
        dominantBaseline="middle"
        className="text-3xl font-bold"
        fill={strokeColor}
        fontSize="26"
        fontWeight="700"
        style={{ transform: 'rotate(90deg)', transformOrigin: '60px 60px' }}
      >
        {score}
      </text>
    </svg>
  );
}

export function RiskIndicator({ score }: RiskIndicatorProps) {
  const level = getRiskLevel(score);

  return (
    <div
      className={`
        flex flex-col items-center gap-3 p-6 rounded-2xl
        ring-1 ${level.ring} ${level.bg}
        shadow-lg ${level.glow}
        transition-all duration-500
      `}
    >
      <h2 className="text-xs font-bold tracking-[0.2em] text-gray-400 uppercase">Risk Score</h2>
      <ScoreGauge score={score} />
      <span className={`text-xs font-bold tracking-widest ${level.color} uppercase`}>
        {level.label}
      </span>

      {/* Score bar */}
      <div className="w-full h-2 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${score}%`,
            backgroundColor: score >= 70 ? '#f87171' : score >= 30 ? '#facc15' : '#34d399',
          }}
        />
      </div>
    </div>
  );
}
