/** Countdown timer ring for projector display */
export default function Timer({
  remainingSec,
  totalSec,
  size = 120,
}: {
  remainingSec: number;
  totalSec: number;
  size?: number;
}) {
  const radius = (size - 12) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = totalSec > 0 ? remainingSec / totalSec : 0;
  const offset = circumference * (1 - progress);
  const urgent = remainingSec <= 5 && remainingSec > 0;

  // Show m:ss for a minute or more (e.g. a 5-minute prompt), raw seconds below 60.
  const label =
    remainingSec >= 60
      ? `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")}`
      : `${remainingSec}`;
  const labelFontSize = label.length >= 4 ? size * 0.26 : size * 0.32;

  // Color transitions: green -> yellow -> red. The theme and palette set
  // these tokens (theme.css, index.css) so the ring and count keep contrast.
  const color =
    remainingSec > totalSec * 0.5
      ? "var(--mdq-timer-ok, #22c55e)"
      : remainingSec > totalSec * 0.2
        ? "var(--mdq-timer-warn, #eab308)"
        : "var(--mdq-timer-urgent, #ef4444)";

  return (
    <div
      className={`relative inline-flex items-center justify-center ${urgent ? "timer-urgent" : ""}`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        {/* Background track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          style={{ stroke: "var(--mdq-timer-track, #e7d9c4)" }}
          strokeWidth="8"
        />
        {/* Progress arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ stroke: color, transition: "stroke-dashoffset 0.3s linear, stroke 0.5s" }}
        />
      </svg>
      <span
        className="absolute font-mono font-bold"
        style={{ fontSize: labelFontSize, color }}
      >
        {label}
      </span>
    </div>
  );
}
