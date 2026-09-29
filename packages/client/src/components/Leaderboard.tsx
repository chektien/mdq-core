import type { LeaderboardRow } from "@mdq/shared";

/**
 * Leaderboard table with staggered animation. Rows are named by label; a row
 * that carries a Student ID (the instructor's) shows it under the label when
 * `showStudentIds` is on. `highlightPublicKey` marks the viewer's own row.
 */
export default function Leaderboard({
  entries,
  totalQuestions,
  highlightPublicKey,
  maxRows = 10,
  showStudentIds = true,
}: {
  entries: LeaderboardRow[];
  totalQuestions: number;
  highlightPublicKey?: string;
  maxRows?: number;
  showStudentIds?: boolean;
}) {
  const visible = entries.slice(0, maxRows);
  const hasScoredQuestions = totalQuestions > 0;
  const getParticipantLabel = (entry: LeaderboardRow) => entry.label || entry.displayName || "Participant";

  const rankLabel = (rank: number) => {
    if (rank === 1) return "1st";
    if (rank === 2) return "2nd";
    if (rank === 3) return "3rd";
    return `#${rank}`;
  };

  return (
    <div className="leaderboard-board">
      {visible.length > 0 ? (
        <ol className="leaderboard-list" aria-label="Leaderboard rankings">
          {visible.map((entry, i) => {
            const isHighlighted = !!highlightPublicKey && entry.publicKey === highlightPublicKey;
            const medalTone = entry.rank === 1
              ? "rank-first"
              : entry.rank === 2
                ? "rank-second"
                : entry.rank === 3
                  ? "rank-third"
                  : "rank-standard";
            return (
              <li
                key={entry.publicKey}
                className={`leaderboard-row ${medalTone} ${isHighlighted ? "leaderboard-row-highlight" : ""}`}
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <span
                  className="leaderboard-rank"
                  aria-label={`Rank ${entry.rank}`}
                >
                  {rankLabel(entry.rank)}
                </span>

                <div className="leaderboard-person">
                  <span className="leaderboard-name">
                    {getParticipantLabel(entry)}
                  </span>
                  {showStudentIds && entry.studentId && entry.studentId !== getParticipantLabel(entry) && (
                    <span className="leaderboard-id">{entry.studentId}</span>
                  )}
                </div>

                <div className="leaderboard-score">
                  <span>
                    {hasScoredQuestions ? `${entry.correctCount}/${totalQuestions}` : "Poll only"}
                  </span>
                  <small>
                    {hasScoredQuestions ? `${(entry.totalTimeMs / 1000).toFixed(1)}s` : "No scored questions"}
                  </small>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="leaderboard-empty">No ranked participants yet.</p>
      )}
      {entries.length > maxRows && (
        <p className="leaderboard-overflow">
          +{entries.length - maxRows} more participants
        </p>
      )}
    </div>
  );
}
