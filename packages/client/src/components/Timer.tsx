import { timerFontSize, timerLabel } from "./timerLabel";

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

  const label = timerLabel(remainingSec);
  const labelFontSize = timerFontSize(size, label);

  // Color transitions: green -> yellow -> red. The theme and palette set
  // these tokens (theme.css, index.css) so the ring and count keep contrast.
  const state = remainingSec > totalSec * 0.5 ? "ok" : remainingSec > totalSec * 0.2 ? "warn" : "urgent";
  const color = `var(--mdq-timer-${state}, ${state === "ok" ? "#22c55e" : state === "warn" ? "#eab308" : "#ef4444"})`;

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
        className="timer-label absolute font-mono font-bold"
        data-timer-state={state}
        style={{ fontSize: labelFontSize, color }}
      >
        {label}
      </span>
    </div>
  );
}
