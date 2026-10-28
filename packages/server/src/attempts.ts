import { ArchivedAttempt, Question, QuestionTiming, Session, Submission } from "@mdq/shared";

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
  const seen = new Map<number, Set<string>>();
  const active: Submission[] = [];
  for (let i = session.submissions.length - 1; i >= 0; i--) {
    const sub = session.submissions[i];
    if ((sub.attempt ?? 1) !== currentAttempt(session, sub.questionIndex)) continue;
    const seats = seen.get(sub.questionIndex) ?? new Set<string>();
    if (seats.has(sub.studentId)) continue;
    seats.add(sub.studentId); seen.set(sub.questionIndex, seats); active.push(sub);
  }
  return active.reverse();
}
export function activeSubmissionsFor(session: Session, index: number): Submission[] {
  return activeSubmissions(session).filter(sub => sub.questionIndex === index);
}
export function activeSubmission(session: Session, studentId: string, index: number): Submission | undefined {
  return activeSubmissionsFor(session, index).find(sub => sub.studentId === studentId);
}
/** A sorted copy; reading history never reorders stored history. */
export function archivedAttempts(session: Session, index?: number): ArchivedAttempt[] {
  return (session.attemptArchive ?? []).filter(entry => index === undefined || entry.questionIndex === index)
    .sort((a, b) => a.questionIndex - b.questionIndex || a.attempt - b.attempt);
}
export function hasAnyAnswers(session: Session): boolean {
  return activeSubmissions(session).length > 0 || archivedAttempts(session).some(entry => entry.submissions.length > 0);
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
const timing = (value: unknown): value is QuestionTiming => record(value) && finite(value.startedAt)
  && (value.deadlineAt === null || finite(value.deadlineAt))
  && (value.firstOpenedAt === undefined || finite(value.firstOpenedAt))
  && (value.timingFairnessInvalidated === undefined || value.timingFairnessInvalidated === true)
  && Array.isArray(value.restarts) && value.restarts.every(restart => record(restart) && finite(restart.restartedAt)
    && finite(restart.previousStartedAt) && (restart.previousDeadlineAt === null || finite(restart.previousDeadlineAt)));
const submission = (value: unknown): value is Submission => record(value) && typeof value.studentId === "string"
  && integer(value.questionIndex, 0) && strings(value.selectedOptions) && finite(value.submittedAt) && finite(value.responseTimeMs)
  && (value.responseText === undefined || typeof value.responseText === "string")
  && (value.attempt === undefined || integer(value.attempt, 1));
const question = (value: unknown): value is Question => record(value) && integer(value.index, 0)
  && typeof value.topic === "string" && typeof value.textMd === "string" && typeof value.textHtml === "string"
  && Array.isArray(value.options) && value.options.every(option => record(option) && typeof option.label === "string"
    && typeof option.textMd === "string" && typeof option.textHtml === "string")
  && strings(value.correctOptions) && typeof value.explanation === "string" && typeof value.allowsMultiple === "boolean"
  && (value.timeLimitSec === null || finite(value.timeLimitSec));
const archive = (value: unknown): value is ArchivedAttempt => record(value) && integer(value.questionIndex, 0)
  && integer(value.attempt, 1) && finite(value.archivedAt) && Array.isArray(value.submissions) && value.submissions.every(submission)
  && (value.question === undefined || question(value.question)) && (value.timing === undefined || timing(value.timing))
  && (value.revealed === undefined || typeof value.revealed === "boolean")
  && (value.hiddenResponses === undefined || strings(value.hiddenResponses))
  && (value.shownResponses === undefined || strings(value.shownResponses))
  && (value.liveResultsOverride === undefined || typeof value.liveResultsOverride === "boolean");

/** Sanitize optional attempt state at the storage boundary; never invent it. */
export function normalizeAttemptState(session: Session): void {
  if (Object.prototype.hasOwnProperty.call(session, "questionAttempts")) {
    const entries = record(session.questionAttempts) ? Object.entries(session.questionAttempts)
      .filter(([key, value]) => /^(0|[1-9]\d*)$/.test(key) && integer(Number(key), 0) && integer(value, 2)) : [];
    if (entries.length) session.questionAttempts = Object.fromEntries(entries);
    else delete session.questionAttempts;
  }
  if (Object.prototype.hasOwnProperty.call(session, "attemptArchive")) {
    const entries = Array.isArray(session.attemptArchive) ? session.attemptArchive.filter(archive) : [];
    if (entries.length) session.attemptArchive = entries;
    else delete session.attemptArchive;
  }
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
    ...(next.questionTiming?.[key] !== undefined ? { timing: next.questionTiming[key] } : {}),
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
