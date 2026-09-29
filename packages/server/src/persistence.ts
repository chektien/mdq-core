import * as fs from "fs";
import * as path from "path";
import {
  Session,
  SessionSnapshot,
  WeeklyResult,
  CumulativeLeaderboardEntry,
  Quiz,
  Submission,
  DATA_DIR,
} from "@mdq/shared";
import { computeLeaderboard } from "./session";
import { buildResultsCsv, isSubmissionCorrect, toIso } from "./results-csv";
import { buildScoredCorrectAnswersMap, getQuestionType, getScoredQuestionCount, isScoredQuestion } from "./scoring";

const sessionRevealTimestamps = new Map<string, Map<number, number>>();
const DEFAULT_DATA_DIR = path.resolve(__dirname, "../../../", DATA_DIR);

// ── Directory layout ───────────────────────

function resolveDataDir(baseDir?: string): string {
  if (baseDir && baseDir.trim().length > 0) {
    return path.resolve(baseDir);
  }
  return DEFAULT_DATA_DIR;
}

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function sessionsDir(baseDir?: string): string {
  return path.join(resolveDataDir(baseDir), "sessions");
}

function submissionsDir(baseDir?: string): string {
  return path.join(resolveDataDir(baseDir), "submissions");
}

function formatFileDateTime(timestampMs: number): string {
  const d = new Date(timestampMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function sanitizeFileToken(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned || "session";
}

function sessionArtifactPrefix(session: Session): string {
  return `${sanitizeFileToken(session.sessionCode)}-${formatFileDateTime(session.createdAt)}`;
}

function formatQuizLabelFromKey(quizKey: string): string {
  const normalized = quizKey.trim();
  if (!normalized) {
    return "MDQ";
  }
  if (/\bmdq\b/i.test(normalized)) {
    return normalized;
  }
  return `${normalized} MDQ`;
}

export function getSessionResultsCsvPath(session: Session, baseDir?: string): string {
  return path.join(submissionsDir(baseDir), `${sessionArtifactPrefix(session)}.csv`);
}

export function getSessionSummaryMarkdownPath(session: Session, baseDir?: string): string {
  return path.join(submissionsDir(baseDir), `${sessionArtifactPrefix(session)}-summary.md`);
}

function formatSecondsFromMs(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

function getRevealTimestampMap(sessionId: string): Map<number, number> {
  if (!sessionRevealTimestamps.has(sessionId)) {
    sessionRevealTimestamps.set(sessionId, new Map<number, number>());
  }
  return sessionRevealTimestamps.get(sessionId)!;
}

export function markQuestionRevealed(
  session: Session,
  questionIndex: number,
  revealedAt = Date.now(),
): void {
  if (questionIndex < 0) {
    return;
  }
  getRevealTimestampMap(session.sessionId).set(questionIndex, revealedAt);
}

function clearSessionRevealTracking(sessionId: string): void {
  sessionRevealTimestamps.delete(sessionId);
}

function winnersDir(baseDir?: string): string {
  return path.join(resolveDataDir(baseDir), "winners");
}

// ── Session snapshot persistence ────────────

/**
 * Save a session snapshot to data/sessions/<sessionId>.json.
 * Called on session end.
 */
export function saveSessionSnapshot(session: Session, baseDir?: string): void {
  const dir = sessionsDir(baseDir);
  ensureDir(dir);

  const snapshot: SessionSnapshot = {
    sessionId: session.sessionId,
    sessionCode: session.sessionCode,
    week: session.week,
    mode: session.mode,
    questionCount: session.currentQuestionIndex + 1,
    participantCount: session.participants.size,
    participants: [...session.participants.values()].map((p) => ({
      studentId: p.studentId,
      displayName: p.displayName,
      joinedAt: p.joinedAt,
    })),
    createdAt: session.createdAt,
    endedAt: Date.now(),
  };

  const filePath = path.join(dir, `${session.sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot, null, 2), "utf-8");
}

// ── Submission persistence ──────────────────

/**
 * Save all submissions for a session to data/submissions/<sessionId>.json.
 */
export function saveSubmissions(session: Session, baseDir?: string): void {
  const dir = submissionsDir(baseDir);
  ensureDir(dir);

  const data = {
    sessionId: session.sessionId,
    week: session.week,
    submissionCount: session.submissions.length,
    submissions: session.submissions,
  };

  const filePath = path.join(dir, `${session.sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export interface CsvWriteResult {
  action: "created" | "updated";
  filePath: string;
  rowCount: number;
  questionCount: number;
}

export interface RevealPersistenceResult {
  status: "written" | "skipped";
  reason?: string;
  questionIndex: number;
  csv?: CsvWriteResult;
}

export interface SummaryWriteResult {
  action: "created" | "updated";
  filePath: string;
  lineCount: number;
}

/**
 * Save per-student quiz results as CSV to data/submissions/<sessionId>.csv.
 * Intended for attendance and lightweight spreadsheet workflows.
 */
export function saveResultsCsv(session: Session, quiz: Quiz, baseDir?: string): CsvWriteResult {
  const dir = submissionsDir(baseDir);
  ensureDir(dir);

  const csv = buildResultsCsv(session, quiz, { revealTimestamps: getRevealTimestampMap(session.sessionId) });

  const filePath = getSessionResultsCsvPath(session, baseDir);
  const action: CsvWriteResult["action"] = fs.existsSync(filePath) ? "updated" : "created";
  fs.writeFileSync(filePath, csv, "utf-8");

  return {
    action,
    filePath,
    rowCount: session.participants.size,
    questionCount: quiz.questions.length,
  };
}

export function persistSessionProgressOnReveal(
  session: Session,
  quiz: Quiz,
  baseDir?: string,
  revealedAt = Date.now(),
): RevealPersistenceResult {
  if (session.currentQuestionIndex < 0 || session.currentQuestionIndex >= quiz.questions.length) {
    return {
      status: "skipped",
      reason: `question_index_out_of_range:${session.currentQuestionIndex}`,
      questionIndex: session.currentQuestionIndex,
    };
  }

  markQuestionRevealed(session, session.currentQuestionIndex, revealedAt);
  const csv = saveResultsCsv(session, quiz, baseDir);
  return {
    status: "written",
    questionIndex: session.currentQuestionIndex,
    csv,
  };
}

export function saveSessionSummaryMarkdown(
  session: Session,
  quiz: Quiz,
  baseDir?: string,
  endedAt = Date.now(),
): SummaryWriteResult {
  const dir = submissionsDir(baseDir);
  ensureDir(dir);

  const participants = [...session.participants.values()].sort((a, b) => a.studentId.localeCompare(b.studentId));
  const correctMap = buildScoredCorrectAnswersMap(quiz);
  const scoredQuestionCount = getScoredQuestionCount(quiz);

  const submissionsByQuestion = new Map<number, Submission[]>();
  const submissionsByStudent = new Map<string, Submission[]>();
  for (const sub of session.submissions) {
    if (!submissionsByQuestion.has(sub.questionIndex)) {
      submissionsByQuestion.set(sub.questionIndex, []);
    }
    submissionsByQuestion.get(sub.questionIndex)!.push(sub);

    if (!submissionsByStudent.has(sub.studentId)) {
      submissionsByStudent.set(sub.studentId, []);
    }
    submissionsByStudent.get(sub.studentId)!.push(sub);
  }

  const leaderboard = computeLeaderboard(session, correctMap);
  const activeParticipants = participants.filter((p) => (submissionsByStudent.get(p.studentId)?.length || 0) > 0);
  const avgScore = leaderboard.length > 0
    ? leaderboard.reduce((sum, e) => sum + e.correctCount, 0) / leaderboard.length
    : 0;
  const durationMs = Math.max(0, endedAt - session.createdAt);

  const scoreDist = new Map<number, number>();
  for (const entry of leaderboard) {
    scoreDist.set(entry.correctCount, (scoreDist.get(entry.correctCount) || 0) + 1);
  }
  const sortedScores = [...scoreDist.entries()].sort((a, b) => b[0] - a[0]);

  const lines: string[] = [];
  lines.push(`# Quiz Session Summary`);
  lines.push("");
  lines.push(`- Session ID: ${session.sessionId}`);
  lines.push(`- Session Code: ${session.sessionCode}`);
  lines.push(`- Quiz: ${formatQuizLabelFromKey(session.week)}`);
  lines.push(`- Started At (ISO): ${toIso(session.createdAt)}`);
  lines.push(`- Ended At (ISO): ${toIso(endedAt)}`);
  lines.push(`- Duration: ${(durationMs / 1000).toFixed(1)}s`);
  lines.push(`- Participant Count: ${participants.length}`);
  lines.push(`- Active Responders: ${activeParticipants.length}`);
  lines.push(`- Total Submissions: ${session.submissions.length}`);
  lines.push("");

  lines.push(`## Per-Question Stats`);
  lines.push("");
  lines.push(`| Question | Type | Responses | Response Rate | Correct Rate | Unanswered |`);
  lines.push(`| --- | --- | ---: | ---: | ---: | ---: |`);

  const anomalies: string[] = [];
  for (let i = 0; i < quiz.questions.length; i++) {
    const question = quiz.questions[i];
    const subs = submissionsByQuestion.get(i) || [];
    const responseRate = participants.length > 0 ? subs.length / participants.length : 0;
    const unanswered = Math.max(0, participants.length - subs.length);
    const questionType = getQuestionType(question);
    const typeLabel = questionType === "poll"
      ? (question.allowsMultiple ? "Poll (multi)" : "Poll")
      : questionType === "open_response"
        ? "Open Response"
        : question.allowsMultiple
          ? "Multi"
          : "Single";
    const scoredQuestion = isScoredQuestion(question);
    const correctCount = scoredQuestion ? subs.filter((sub) => isSubmissionCorrect(sub, correctMap.get(i) || [])).length : 0;
    const correctRate = subs.length > 0 ? correctCount / subs.length : 0;
    const correctRateLabel = scoredQuestion ? `${(correctRate * 100).toFixed(1)}%` : "Unscored";
    lines.push(`| Q${i + 1} | ${typeLabel} | ${subs.length}/${participants.length} | ${(responseRate * 100).toFixed(1)}% | ${correctRateLabel} | ${unanswered} |`);
    if (responseRate < 0.8) {
      anomalies.push(`Q${i + 1} response rate is ${(responseRate * 100).toFixed(1)}%`);
    }
    if (scoredQuestion && subs.length > 0 && correctRate < 0.3) {
      anomalies.push(`Q${i + 1} correct rate is ${(correctRate * 100).toFixed(1)}%`);
    }
  }

  lines.push("");
  lines.push(`## Score Summary`);
  lines.push("");
  lines.push(`- Scored Questions: ${scoredQuestionCount}`);
  lines.push(`- Average Score: ${avgScore.toFixed(2)} / ${scoredQuestionCount} (${scoredQuestionCount > 0 ? ((avgScore / scoredQuestionCount) * 100).toFixed(1) : "n/a"}${scoredQuestionCount > 0 ? "%" : ""})`);
  lines.push(`- Highest Score: ${leaderboard[0]?.correctCount ?? 0} / ${scoredQuestionCount}`);
  lines.push(`- Lowest Score: ${leaderboard[leaderboard.length - 1]?.correctCount ?? 0} / ${scoredQuestionCount}`);
  lines.push("");
  lines.push(`### Score Distribution`);
  if (sortedScores.length === 0) {
    lines.push(`- No scores recorded`);
  } else {
    for (const [score, count] of sortedScores) {
      lines.push(`- ${score}/${scoredQuestionCount}: ${count}`);
    }
  }

  lines.push("");
  lines.push("## Leaderboard Summary");
  lines.push("");
  if (leaderboard.length === 0) {
    lines.push("- No leaderboard entries recorded");
  } else {
    const winner = leaderboard[0];
    const winnerName = winner.displayName ? ` (${winner.displayName})` : "";
      lines.push(`- Ranked Participants: ${leaderboard.length}`);
      lines.push(
        `- Winner: ${winner.studentId}${winnerName}, score ${winner.correctCount}/${scoredQuestionCount}, total time ${formatSecondsFromMs(winner.totalTimeMs)}`,
      );
      lines.push("");
      lines.push("| Rank | Student ID | Name | Correct | Total Time (ms) |");
      lines.push("| ---: | --- | --- | ---: | ---: |");
      for (const entry of leaderboard.slice(0, 10)) {
        lines.push(
          `| ${entry.rank} | ${entry.studentId} | ${entry.displayName || "-"} | ${entry.correctCount}/${scoredQuestionCount} | ${entry.totalTimeMs} |`,
        );
      }
    }

  lines.push("");
  lines.push(`## Anomalies`);
  if (anomalies.length === 0) {
    lines.push(`- None detected`);
  } else {
    for (const anomaly of anomalies) {
      lines.push(`- ${anomaly}`);
    }
  }

  const summaryPath = getSessionSummaryMarkdownPath(session, baseDir);
  const action: SummaryWriteResult["action"] = fs.existsSync(summaryPath) ? "updated" : "created";
  fs.writeFileSync(summaryPath, `${lines.join("\n")}\n`, "utf-8");

  return {
    action,
    filePath: summaryPath,
    lineCount: lines.length,
  };
}

// ── Weekly winners persistence ──────────────

/**
 * Save the per-week leaderboard to data/winners/weekNN.json.
 * If a file for this week already exists, it is overwritten
 * (the latest session for a given week wins).
 */
export function saveWeeklyResult(
  session: Session,
  quiz: Quiz,
  baseDir?: string,
): void {
  const dir = winnersDir(baseDir);
  ensureDir(dir);

  const correctMap = buildScoredCorrectAnswersMap(quiz);
  const entries = computeLeaderboard(session, correctMap);

  const result: WeeklyResult = {
    week: session.week,
    sessionId: session.sessionId,
    totalQuestions: getScoredQuestionCount(quiz),
    completedAt: Date.now(),
    entries,
  };

  const filePath = path.join(dir, `${session.week}.json`);
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
}

// ── Weekly result reading ───────────────────

/**
 * Load a single weekly result file.
 * Returns null if the file doesn't exist or is malformed.
 */
export function loadWeeklyResult(week: string, baseDir?: string): WeeklyResult | null {
  const filePath = path.join(winnersDir(baseDir), `${week}.json`);
  return readJsonSafe<WeeklyResult>(filePath);
}

/**
 * Load all weekly result files from data/winners/.
 * Skips malformed files with a warning.
 */
export function loadAllWeeklyResults(baseDir?: string): WeeklyResult[] {
  const dir = winnersDir(baseDir);
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const results: WeeklyResult[] = [];

  for (const file of files) {
    const filePath = path.join(dir, file);
    const result = readJsonSafe<WeeklyResult>(filePath);
    if (
      result &&
      typeof result.week === "string" &&
      result.entries &&
      Array.isArray(result.entries)
    ) {
      // Sanitize entries: ensure numeric fields default to 0
      result.entries = result.entries
        .filter((e) => e && typeof e.studentId === "string")
        .map((e) => ({
          ...e,
          correctCount: typeof e.correctCount === "number" ? e.correctCount : 0,
          totalTimeMs: typeof e.totalTimeMs === "number" ? e.totalTimeMs : 0,
          rank: typeof e.rank === "number" ? e.rank : 0,
        }));
      results.push(result);
    } else {
      console.warn(`Skipping malformed weekly result file: ${file}`);
    }
  }

  return results;
}

// ── Cumulative leaderboard ──────────────────

/**
 * Compute the cumulative leaderboard from all weekly result files.
 * Dynamically derived at read-time, not precomputed.
 *
 * Ranking:
 *   1. Total correct answers (descending)
 *   2. Total response time for correct answers (ascending, lower is better)
 *   3. Deterministic tie-break: studentId lexicographic (ascending)
 */
export function computeCumulativeLeaderboard(
  baseDir?: string,
): CumulativeLeaderboardEntry[] {
  const weeklyResults = loadAllWeeklyResults(baseDir);
  return computeCumulativeFromResults(weeklyResults);
}

/**
 * Core cumulative computation from a list of weekly results.
 * Exported for testability.
 */
export function computeCumulativeFromResults(
  weeklyResults: WeeklyResult[],
): CumulativeLeaderboardEntry[] {
  const statsMap = new Map<
    string,
    {
      totalCorrect: number;
      totalTimeMs: number;
      weeksParticipated: number;
      displayName?: string;
    }
  >();

  for (const result of weeklyResults) {
    for (const entry of result.entries) {
      const existing = statsMap.get(entry.studentId);
      if (existing) {
        existing.totalCorrect += entry.correctCount;
        existing.totalTimeMs += entry.totalTimeMs;
        existing.weeksParticipated++;
        // Use latest displayName if provided
        if (entry.displayName) {
          existing.displayName = entry.displayName;
        }
      } else {
        statsMap.set(entry.studentId, {
          totalCorrect: entry.correctCount,
          totalTimeMs: entry.totalTimeMs,
          weeksParticipated: 1,
          displayName: entry.displayName,
        });
      }
    }
  }

  const entries: CumulativeLeaderboardEntry[] = [...statsMap.entries()]
    .map(([studentId, stats]) => ({
      rank: 0,
      studentId,
      displayName: stats.displayName,
      totalCorrect: stats.totalCorrect,
      totalTimeMs: stats.totalTimeMs,
      weeksParticipated: stats.weeksParticipated,
    }))
    .sort((a, b) => {
      // 1. Total correct descending
      if (b.totalCorrect !== a.totalCorrect) return b.totalCorrect - a.totalCorrect;
      // 2. Total time ascending (lower is better)
      if (a.totalTimeMs !== b.totalTimeMs) return a.totalTimeMs - b.totalTimeMs;
      // 3. Deterministic tie-break: studentId ascending
      return a.studentId.localeCompare(b.studentId);
    });

  // Assign ranks
  entries.forEach((entry, i) => {
    entry.rank = i + 1;
  });

  return entries;
}

// ── Persist all session data on end ─────────

/**
 * Persist all session data: snapshot, submissions, and weekly winners.
 * Called when session transitions to ENDED.
 */
export function persistSessionOnEnd(
  session: Session,
  quiz: Quiz,
  baseDir?: string,
): void {
  const endedAt = Date.now();

  try {
    saveSessionSnapshot(session, baseDir);
  } catch (e) {
    console.error(`Failed to save session snapshot for ${session.sessionId}:`, e);
  }

  try {
    saveSubmissions(session, baseDir);
  } catch (e) {
    console.error(`Failed to save submissions for ${session.sessionId}:`, e);
  }

  try {
    const csvResult = saveResultsCsv(session, quiz, baseDir);
    console.log(
      `[mdq persistence] session=${session.sessionId} code=${session.sessionCode} csv_${csvResult.action} path=${csvResult.filePath} rows=${csvResult.rowCount} questions=${csvResult.questionCount}`,
    );
  } catch (e) {
    console.error(`Failed to save results CSV for ${session.sessionId}:`, e);
  }

  try {
    const summaryResult = saveSessionSummaryMarkdown(session, quiz, baseDir, endedAt);
    console.log(
      `[mdq persistence] session=${session.sessionId} code=${session.sessionCode} summary_markdown_${summaryResult.action} path=${summaryResult.filePath} lines=${summaryResult.lineCount}`,
    );
  } catch (e) {
    console.error(`Failed to save session summary for ${session.sessionId}:`, e);
  }

  try {
    saveWeeklyResult(session, quiz, baseDir);
  } catch (e) {
    console.error(`Failed to save weekly result for ${session.week}:`, e);
  }

  clearSessionRevealTracking(session.sessionId);
}

// ── Utility ─────────────────────────────────

/**
 * Safely read and parse a JSON file. Returns null on any error.
 */
function readJsonSafe<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
