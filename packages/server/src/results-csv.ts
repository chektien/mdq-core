// Pure results CSV builder. Keep this module free of Node fs/path imports so it
// can be bundled for runtimes that have no filesystem.
import { isSlideType, Session, Quiz, Submission } from "@mdq/shared";
import { computeLeaderboard, isExactOptionMatch } from "./session";
import { buildScoredCorrectAnswersMap, isScoredQuestion } from "./scoring";

export interface BuildResultsCsvOptions {
  /** Reveal time (epoch ms) per question index. Missing entries leave the cell empty. */
  revealTimestamps?: ReadonlyMap<number, number>;
  /** Value for the snapshot_written_at_iso column (epoch ms). Defaults to now. */
  now?: number;
}

export function toIso(ts?: number): string {
  return typeof ts === "number" ? new Date(ts).toISOString() : "";
}

export function isSubmissionCorrect(submission: Submission, correctOptions: string[]): boolean {
  return isExactOptionMatch(submission.selectedOptions, correctOptions);
}

function getSubmissionValue(submission: Submission): string {
  if (submission.responseText) {
    return submission.responseText;
  }
  return submission.selectedOptions.join("|");
}

/**
 * Escape one CSV cell. Text that starts with =, +, -, @, tab or carriage return
 * is prefixed with a single quote so spreadsheets do not run it as a formula
 * (OWASP CSV injection rule). Numbers and booleans are written as they are.
 */
export function csvEscape(value: string | number | boolean): string {
  let raw = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(raw)) {
    raw = `'${raw}`;
  }
  if (raw.includes(",") || raw.includes("\n") || raw.includes("\r") || raw.includes('"')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Build the per-student results CSV text (with trailing newline) for a session.
 */
export function buildResultsCsv(session: Session, quiz: Quiz, options: BuildResultsCsvOptions = {}): string {
  const revealTimestamps = options.revealTimestamps ?? new Map<number, number>();
  const now = options.now ?? Date.now();

  const correctMap = buildScoredCorrectAnswersMap(quiz);
  const leaderboard = computeLeaderboard(session, correctMap);
  const boardMap = new Map(leaderboard.map((entry) => [entry.studentId, entry]));

  // Keep item indexes in column names, but content-only items have no results.
  const resultIndexes = quiz.questions.flatMap((question, index) =>
    isSlideType(question.questionType) ? [] : [index]);
  const resultIndexSet = new Set(resultIndexes);

  const submissionsByStudent = new Map<string, Map<number, Submission>>();
  for (const sub of session.submissions) {
    if (!resultIndexSet.has(sub.questionIndex)) continue;
    if (!submissionsByStudent.has(sub.studentId)) {
      submissionsByStudent.set(sub.studentId, new Map<number, Submission>());
    }
    submissionsByStudent.get(sub.studentId)!.set(sub.questionIndex, sub);
  }

  const headers = [
    "session_id",
    "session_code",
    "week",
    "session_created_at_iso",
    "snapshot_written_at_iso",
    "student_id",
    "display_name",
    "joined_at_iso",
    "connected_at_end",
    "questions_answered",
    "correct_count",
    "total_time_ms",
    "attendance",
  ];

  for (const i of resultIndexes) {
    headers.push(`q${i + 1}_revealed_at_iso`);
    headers.push(`q${i + 1}_selected`);
    headers.push(`q${i + 1}_correct`);
    headers.push(`q${i + 1}_response_ms`);
    headers.push(`q${i + 1}_answered_at_iso`);
  }

  const rows: string[] = [headers.join(",")];

  const participants = [...session.participants.values()].sort((a, b) => a.studentId.localeCompare(b.studentId));
  for (const participant of participants) {
    const subs = submissionsByStudent.get(participant.studentId) || new Map<number, Submission>();
    const stats = boardMap.get(participant.studentId);

    const row: (string | number | boolean)[] = [
      session.sessionId,
      session.sessionCode,
      session.week,
      toIso(session.createdAt),
      new Date(now).toISOString(),
      participant.studentId,
      participant.displayName || "",
      new Date(participant.joinedAt).toISOString(),
      participant.connected,
      subs.size,
      stats?.correctCount ?? 0,
      stats?.totalTimeMs ?? 0,
      "present",
    ];

    for (const i of resultIndexes) {
      const sub = subs.get(i);
      const revealedAtIso = toIso(revealTimestamps.get(i));
      const isScored = isScoredQuestion(quiz.questions[i]);
      if (!sub) {
        row.push(revealedAtIso, "", "", "", "");
        continue;
      }
      row.push(revealedAtIso);
      row.push(getSubmissionValue(sub));
      row.push(isScored ? (isSubmissionCorrect(sub, correctMap.get(i) || []) ? 1 : 0) : "");
      row.push(sub.responseTimeMs);
      row.push(toIso(sub.submittedAt));
    }

    rows.push(row.map(csvEscape).join(","));
  }

  return `${rows.join("\n")}\n`;
}
