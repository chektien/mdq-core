/** The deck id as a label, with MDQ after it unless it already says so. */
export function formatQuizLabel(quizKey: string): string {
  const normalized = quizKey.trim();
  if (!normalized) return "MDQ";
  if (/\bmdq\b/i.test(normalized)) return normalized;
  return `${normalized} MDQ`;
}

/**
 * The name a leaderboard or final results screen uses for its deck: the deck's
 * title when it has one, else its id (a host may set the id to something
 * generic, so the title is the better name).
 */
export function deckLabel(title: string | null | undefined, week: string): string {
  const named = (title ?? "").trim();
  return named || formatQuizLabel(week).toUpperCase();
}

/** "Leaderboard for X" or "Final Results for X", plain when there is no label. */
export function resultsHeading(kind: "leaderboard" | "final", label: string): string {
  const base = kind === "final" ? "Final Results" : "Leaderboard";
  return label ? `${base} for ${label}` : base;
}
