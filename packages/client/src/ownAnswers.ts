import type { StudentAnswer } from "@mdq/shared";

/** What the student view shows as the student's own answer to one question. */
export interface SubmittedAnswer {
  selectedOptions: string[];
  responseText: string | null;
}

type Options = readonly { label: string }[];

export const NO_ANSWER: SubmittedAnswer = { selectedOptions: [], responseText: null };

/** Turn option labels ("A", "C") into option positions for the wire format. */
export function toOptionIndexes(labels: readonly string[], options: Options): number[] {
  return labels.map((label) => options.findIndex((o) => o.label === label)).filter((i) => i >= 0);
}

/** Turn option positions from the wire format back into option labels. */
export function toOptionLabels(indexes: readonly number[], options: Options): string[] {
  return indexes.filter((i) => Number.isInteger(i) && i >= 0 && i < options.length).map((i) => options[i].label);
}

/** Compare ordered server answers. Missing attempts mean 1. */
export function compareAcceptedAnswers(a: Pick<StudentAnswer, "attempt" | "acceptedRevision">, b: Pick<StudentAnswer, "attempt" | "acceptedRevision">): number {
  return (a.attempt ?? 1) - (b.attempt ?? 1) || (a.acceptedRevision ?? 0) - (b.acceptedRevision ?? 0);
}

/** Unordered answers keep the legacy server-wins rule within the same attempt. */
export function shouldReplaceAcceptedAnswer(answer: StudentAnswer, known: StudentAnswer | undefined): boolean {
  return !known || compareAcceptedAnswers(answer, known) > 0
    || ((answer.attempt ?? 1) === (known.attempt ?? 1) && (answer.acceptedRevision === undefined || known.acceptedRevision === undefined));
}

/**
 * Merge answers by question index, comparing attempts before revisions.
 * Within an attempt, the incoming server answer wins if either answer is unordered.
 */
export function mergeOwnAnswers(
  current: ReadonlyMap<number, StudentAnswer>,
  incoming: readonly StudentAnswer[] | undefined,
): Map<number, StudentAnswer> {
  const next = new Map(current);
  for (const answer of incoming ?? []) {
    if (Number.isInteger(answer?.questionIndex) && Array.isArray(answer.selectedOptions)) {
      const known = next.get(answer.questionIndex);
      if (shouldReplaceAcceptedAnswer(answer, known)) next.set(answer.questionIndex, answer);
    }
  }
  return next;
}

/**
 * Record the attempt a question was seen at, and say whether it is later than the one this page saw before. A re-run
 * asks a question again as attempt 2 or more, and this page's answer to the earlier attempt no longer counts. The
 * first sighting only records, because the page then has no earlier answer of its own to forget.
 */
export function isLaterAttempt(seen: Map<number, number>, questionIndex: number, attempt: number): boolean {
  const before = seen.get(questionIndex);
  seen.set(questionIndex, Math.max(before ?? attempt, attempt));
  return before !== undefined && attempt > before;
}

/** A draft made before a re-run asked the question again. Its labels may name other options now, so it is never shown. */
export const isEarlierAttemptDraft = (draft: { attempt?: number }, attempt: number | undefined): boolean => (attempt ?? 1) > (draft.attempt ?? 1);

function hasContent(answer: SubmittedAnswer): boolean {
  return answer.selectedOptions.length > 0 || !!answer.responseText;
}

/**
 * Choose the answer to show when a question is (re)displayed. An answer the
 * page already holds for the same question wins; otherwise a known earlier
 * submission is used, so a reloaded page or a revisited question still shows
 * what the student chose.
 */
export function seedSubmittedAnswer(input: {
  questionIndex: number;
  options: Options;
  alreadyAnswered: boolean;
  isSameQuestion: boolean;
  current: SubmittedAnswer;
  known: ReadonlyMap<number, StudentAnswer>;
}): SubmittedAnswer {
  const { questionIndex, options, alreadyAnswered, isSameQuestion, current, known } = input;
  if (!alreadyAnswered) return NO_ANSWER;
  if (isSameQuestion && hasContent(current)) return current;
  const saved = known.get(questionIndex);
  if (saved) {
    return {
      selectedOptions: toOptionLabels(saved.selectedOptions, options),
      responseText: saved.responseText?.trim() || null,
    };
  }
  return isSameQuestion ? current : NO_ANSWER;
}
