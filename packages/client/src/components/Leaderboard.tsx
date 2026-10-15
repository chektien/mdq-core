import type { LeaderboardRow } from "@mdq/shared";

/**
 * Flat leaderboard list. Rows are named by label; a row
 * that carries a Student ID (the instructor's) shows it under the label when
 * `showStudentIds` is on. `highlightPublicKey` marks the viewer's own row.
 * `compact` is for a phone or tablet held in the hand: rows stay a readable
 * width and centred, and the small text is not shrunk.
 */
export default function Leaderboard({
  entries,
  totalQuestions,
  highlightPublicKey,
  maxRows = 10,
  showStudentIds = true,
  compact = false,
}: {
  entries: LeaderboardRow[];
  totalQuestions: number;
  highlightPublicKey?: string;
  maxRows?: number;
  showStudentIds?: boolean;
  compact?: boolean;
}) {
  const visible = entries.slice(0, maxRows);
  const hasScoredQuestions = totalQuestions > 0;
  const getParticipantLabel = (entry: LeaderboardRow) => entry.label || entry.displayName || "Participant";

  return (
    <div className={compact ? "leaderboard-board leaderboard-board-compact" : "leaderboard-board"}>
      {visible.length > 0 ? (
        <ol className="leaderboard-list" aria-label="Leaderboard rankings">
          {visible.map((entry) => {
            const isHighlighted = !!highlightPublicKey && entry.publicKey === highlightPublicKey;
            const rankTone = entry.rank === 1
              ? "rank-first"
              : entry.rank === 2
                ? "rank-second"
                : entry.rank === 3
                  ? "rank-third"
                  : "rank-standard";
            return (
              <li
                key={entry.publicKey}
                className={`leaderboard-row ${rankTone} ${isHighlighted ? "leaderboard-row-highlight" : ""}`}
              >
                <span
                  className="leaderboard-rank"
                  aria-label={`Rank ${entry.rank}`}
                >
                  {entry.rank}
                </span>

                <div className="leaderboard-person">
                  <div className="leaderboard-name-line">
                    <span className="leaderboard-name">{getParticipantLabel(entry)}</span>
                    {isHighlighted && <span className="leaderboard-you">You</span>}
                  </div>
                  {showStudentIds && entry.studentId && entry.studentId !== getParticipantLabel(entry) && (
                    <span className="leaderboard-id">{entry.studentId}</span>
                  )}
                </div>

                <div className="leaderboard-score">
                  <span>
                    {hasScoredQuestions ? `${entry.correctCount} of ${totalQuestions} correct` : "Poll only"}
                  </span>
                  <small>
                    {hasScoredQuestions && entry.totalTimeMs !== undefined
                      ? <>{(entry.totalTimeMs / 1000).toFixed(1)} s<span className="sr-only"> total time</span></>
                      : hasScoredQuestions ? "" : "No scored questions"}
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
