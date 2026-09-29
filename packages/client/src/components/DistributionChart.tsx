import { useLayoutEffect, useRef, useState } from "react";
import { labelFitsInBar } from "./distributionLabel";

/** Horizontal bar chart for answer distribution */
export default function DistributionChart({
  distribution,
  correctOptions,
  labels,
  showCorrect = false,
  totalResponses,
}: {
  distribution: Record<string, number>;
  correctOptions?: string[];
  labels?: string[];
  showCorrect?: boolean;
  totalResponses?: number;
}) {
  const entries = labels
    ? labels.map((l) => [l, distribution[l] || 0] as [string, number])
    : Object.entries(distribution).sort(([a], [b]) => a.localeCompare(b));

  const max = Math.max(1, ...entries.map(([, v]) => v));
  const totalSelections = entries.reduce((sum, [, v]) => sum + v, 0);
  const percentageBase = totalResponses && totalResponses > 0 ? totalResponses : totalSelections;

  return (
    <div className="space-y-3 w-full">
      {entries.map(([label, count]) => {
        const pct = max > 0 ? (count / max) * 100 : 0;
        const isCorrect = showCorrect && correctOptions?.includes(label);
        const barColor = showCorrect
          ? isCorrect
            ? "dist-bar-correct bg-emerald-500"
            : "dist-bar-muted bg-zinc-600"
          : "bg-indigo-500";

        return (
          <div key={label} className="dist-row-shell flex items-center gap-3">
            <span
              className={`
                w-10 text-center font-mono font-bold text-lg shrink-0 rounded-lg py-1
                ${isCorrect ? "bg-emerald-500/20 text-emerald-400" : "text-zinc-300"}
              `}
            >
              {label}
            </span>
            <DistributionBar
              widthPct={count > 0 ? Math.max(pct, 2) : 0}
              barColor={barColor}
              text={`${count} (${percentageBase > 0 ? Math.round((count / percentageBase) * 100) : 0}%)`}
            />
          </div>
        );
      })}
    </div>
  );
}

/** One bar drawn at its true share; its count sits inside when it fits and just after the bar when it does not. */
function DistributionBar({ widthPct, barColor, text }: { widthPct: number; barColor: string; text: string | null }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const [inside, setInside] = useState(true);

  useLayoutEffect(() => {
    const track = trackRef.current;
    const measure = () => {
      if (!track || !labelRef.current) return;
      // The bar animates its width, so measure against the share it is heading to.
      setInside(labelFitsInBar(track.clientWidth, widthPct, labelRef.current.offsetWidth));
    };
    measure();
    if (!track || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [widthPct, text]);

  // Padding only surrounds a label drawn inside, so an empty or narrow bar keeps its true width.
  const labelNode = text !== null && (
    <span
      ref={labelRef}
      className={`dist-bar-label whitespace-nowrap text-sm font-semibold tabular-nums ${inside ? "text-white" : "dist-bar-label-outside ml-2 text-zinc-200"}`}
    >
      {text}
    </span>
  );

  return (
    <div ref={trackRef} className="dist-bar-track flex flex-1 items-center bg-zinc-800 rounded-full h-8 overflow-hidden">
      <div
        className={`dist-bar bar-fill h-full shrink-0 rounded-full ${barColor} flex items-center justify-end ${inside && text !== null ? "pr-3" : ""}`}
        style={{ width: `${widthPct}%` }}
      >
        {inside && labelNode}
      </div>
      {!inside && labelNode}
    </div>
  );
}
