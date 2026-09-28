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
            <div className="dist-bar-track flex-1 bg-zinc-800 rounded-full h-8 overflow-hidden">
              <div
                className={`dist-bar bar-fill h-full rounded-full ${barColor} flex items-center justify-end pr-3`}
                style={{ width: `${Math.max(pct, 2)}%` }}
              >
                {count > 0 && (
                  <span className="dist-bar-label text-white text-sm font-semibold tabular-nums">
                    {count} ({percentageBase > 0 ? Math.round((count / percentageBase) * 100) : 0}%)
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
