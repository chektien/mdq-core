import { ArchivedAttempt, Question, QuestionTiming, Session, Submission, isSlideType } from "@mdq/shared";
import { isSelfPaced } from "./policy";
import { getQuestionType } from "./scoring";

/** Missing state is the original attempt, without adding fields to legacy sessions. */
export function currentAttempt(session: Session, index: number): number {
  return session.questionAttempts?.[String(index)] ?? 1;
}

/**
 * The only answer projection. Ignore other attempts, then keep the last entry
 * in array order for each seat and question (not the latest timestamp). The
 * surviving entries retain their original array order. Valid engine data has
 * no duplicates; this also makes imported or damaged data deterministic.
 */
export function activeSubmissions(session: Session): Submission[] {
  const rows = session.submissions.filter(sub => isActive(session, sub));
  if (rows.length < 2) return rows;
  const seen = new Map<number, Set<string>>();
  const kept: Submission[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const sub = rows[i];
    let seats = seen.get(sub.questionIndex);
    if (!seats) seen.set(sub.questionIndex, seats = new Set<string>());
    else if (seats.has(sub.studentId)) continue;
    seats.add(sub.studentId); kept.push(sub);
  }
  return kept.length === rows.length ? rows : kept.reverse();
}
/*
 * The narrower readers below give the same rows as filtering `activeSubmissions`,
 * but answer, count and poll updates run them for every accepted answer in a
 * session of up to 500 seats, so they scan once without building whole-session
 * keys.
 */
export function activeSubmissionsFor(session: Session, index: number): Submission[] {
  const attempt = currentAttempt(session, index);
  return lastPerKey(session.submissions.filter(sub => sub.questionIndex === index && (sub.attempt ?? 1) === attempt), sub => sub.studentId);
}
export function activeSubmissionsOf(session: Session, studentId: string): Submission[] {
  return lastPerKey(session.submissions.filter(sub => sub.studentId === studentId && isActive(session, sub)), sub => String(sub.questionIndex));
}
export function activeSubmission(session: Session, studentId: string, index: number): Submission | undefined {
  const attempt = currentAttempt(session, index);
  for (let i = session.submissions.length - 1; i >= 0; i--) {
    const sub = session.submissions[i];
    if (sub.questionIndex === index && sub.studentId === studentId && (sub.attempt ?? 1) === attempt) return sub;
  }
  return undefined;
}
const isActive = (session: Session, sub: Submission): boolean => (sub.attempt ?? 1) === currentAttempt(session, sub.questionIndex);
/** Keep the last row per key, in original order. Rows without duplicates come back as given. */
function lastPerKey(rows: Submission[], key: (sub: Submission) => string): Submission[] {
  if (rows.length < 2) return rows;
  const seen = new Set<string>();
  const kept: Submission[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const k = key(rows[i]);
    if (seen.has(k)) continue;
    seen.add(k); kept.push(rows[i]);
  }
  return kept.length === rows.length ? rows : kept.reverse();
}
/** A sorted copy; reading history never reorders stored history. */
export function archivedAttempts(session: Session, index?: number): ArchivedAttempt[] {
  return (session.attemptArchive ?? []).filter(entry => index === undefined || entry.questionIndex === index)
    .sort((a, b) => a.questionIndex - b.questionIndex || a.attempt - b.attempt);
}
export function hasAnyAnswers(session: Session): boolean {
  return session.submissions.some(sub => isActive(session, sub)) || (session.attemptArchive ?? []).some(entry => entry.submissions.length > 0);
}
/** Remove all answer evidence for a seat, including stray inactive stored entries. */
export function removeSeatAnswers(session: Session, studentId: string): void {
  session.submissions = session.submissions.filter(sub => sub.studentId !== studentId);
  if (session.attemptArchive) session.attemptArchive = session.attemptArchive.map(entry => ({
    ...entry, submissions: entry.submissions.filter(sub => sub.studentId !== studentId),
  }));
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, minimum: number): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const submission = (value: unknown): value is Submission => record(value) && typeof value.studentId === "string"
  && integer(value.questionIndex, 0) && strings(value.selectedOptions) && finite(value.submittedAt) && finite(value.responseTimeMs)
  && (value.responseText === undefined || typeof value.responseText === "string")
  && (value.attempt === undefined || integer(value.attempt, 1));

/**
 * Keep an archived attempt whenever its identity and answers are readable. A
 * bad optional field is dropped on its own, so a damaged snapshot or timing
 * record never takes the answers with it, and fields a later release adds pass
 * through unchanged. Readers of `question` and `timing` must still check them.
 */
function archiveEntry(value: unknown): ArchivedAttempt | null {
  if (!record(value) || !integer(value.questionIndex, 0) || !integer(value.attempt, 1) || !finite(value.archivedAt)
    || !Array.isArray(value.submissions)) return null;
  const entry: Record<string, unknown> = { ...value, submissions: value.submissions.filter(submission) };
  for (const field of ["question", "timing"] as const) if (entry[field] !== undefined && !record(entry[field])) delete entry[field];
  for (const field of ["revealed", "liveResultsOverride"] as const) if (entry[field] !== undefined && typeof entry[field] !== "boolean") delete entry[field];
  for (const field of ["hiddenResponses", "shownResponses"] as const) if (entry[field] !== undefined && !strings(entry[field])) delete entry[field];
  return entry as unknown as ArchivedAttempt;
}

/** Sanitize optional attempt state at the storage boundary; never invent it. */
export function normalizeAttemptState(session: Session): void {
  if (Object.prototype.hasOwnProperty.call(session, "questionAttempts")) {
    const entries = record(session.questionAttempts) ? Object.entries(session.questionAttempts)
      .filter(([key, value]) => /^(0|[1-9]\d*)$/.test(key) && integer(Number(key), 0) && integer(value, 2)) : [];
    if (entries.length) session.questionAttempts = Object.fromEntries(entries);
    else delete session.questionAttempts;
  }
  if (Object.prototype.hasOwnProperty.call(session, "attemptArchive")) {
    const entries = Array.isArray(session.attemptArchive)
      ? session.attemptArchive.map(archiveEntry).filter((entry): entry is ArchivedAttempt => entry !== null) : [];
    if (entries.length) session.attemptArchive = entries;
    else delete session.attemptArchive;
  }
}

/**
 * The attempt's clock. Sessions from before per-item timing keep the current
 * item's clock only in `questionStartedAt` and `questionDeadlineAt`, so read it
 * from there as the engine's `timingFor` does, without inventing `firstOpenedAt`.
 */
function attemptTiming(session: Session, index: number, question?: Question): QuestionTiming | undefined {
  const saved = session.questionTiming?.[String(index)];
  if (saved) return saved;
  if (index !== session.currentQuestionIndex || session.questionStartedAt === undefined) return undefined;
  const startedAt = session.questionStartedAt;
  // Untimed first, as in `timingFor`: a stale stored deadline never applies to an untimed item.
  // Without the question (the caller may omit it) only the stored deadline is known.
  const untimed = isSelfPaced(session) || (question !== undefined && (question.timeLimitSec === null || isSlideType(getQuestionType(question))));
  return { startedAt, restarts: [],
    deadlineAt: untimed ? null : session.questionDeadlineAt !== undefined ? session.questionDeadlineAt
      : question ? startedAt + question.timeLimitSec! * 1000 : null };
}

/**
 * Future re-run transition: return one independent next session, without clocks,
 * IO or input mutation. The caller supplies the old question snapshot. Releases
 * and browsing position stay intact; all per-item attempt state moves to history.
 * No engine command calls this helper in stage 0.
 */
export function archiveActiveAttempt(session: Session, index: number, now: number, question?: Question): Session {
  const next: Session = {
    ...structuredClone(session),
    participants: new Map([...session.participants].map(([id, seat]) => [id, { ...seat }])),
    ...(session.releasedQuestionIndexes ? { releasedQuestionIndexes: new Set(session.releasedQuestionIndexes) } : {}),
    ...(session.revealedQuestionIndexes ? { revealedQuestionIndexes: new Set(session.revealedQuestionIndexes) } : {}),
  };
  const key = String(index);
  const attempt = currentAttempt(session, index);
  const entry: ArchivedAttempt = { questionIndex: index, attempt, archivedAt: now, submissions: activeSubmissionsFor(next, index),
    ...(question !== undefined ? { question: structuredClone(question) } : {}),
    ...(attemptTiming(next, index, question) ? { timing: attemptTiming(next, index, question) } : {}),
    ...(next.revealedQuestionIndexes?.has(index) ? { revealed: true } : {}),
    ...(next.hiddenResponses?.[key] !== undefined ? { hiddenResponses: next.hiddenResponses[key] } : {}),
    ...(next.shownResponses?.[key] !== undefined ? { shownResponses: next.shownResponses[key] } : {}),
    ...(next.liveResultsOverrides?.[key] !== undefined ? { liveResultsOverride: next.liveResultsOverrides[key] } : {}),
  };
  next.submissions = next.submissions.filter(sub => sub.questionIndex !== index);
  next.attemptArchive = [...(next.attemptArchive ?? []), entry];
  next.questionAttempts = { ...next.questionAttempts, [key]: attempt + 1 };
  next.revealedQuestionIndexes?.delete(index);
  for (const field of ["questionTiming", "hiddenResponses", "shownResponses", "liveResultsOverrides"] as const) {
    if (next[field]) {
      delete next[field]![key];
      if (!Object.keys(next[field]!).length) delete next[field];
    }
  }
  if (index === next.currentQuestionIndex) {
    delete next.questionStartedAt; delete next.questionDeadlineAt; delete next.closedByTimer;
  }
  return next;
}
