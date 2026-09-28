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

/** Record answers by question index. Later entries replace earlier ones for the same question. */
export function mergeOwnAnswers(
  current: ReadonlyMap<number, StudentAnswer>,
  incoming: readonly StudentAnswer[] | undefined,
): Map<number, StudentAnswer> {
  const next = new Map(current);
  for (const answer of incoming ?? []) {
    if (Number.isInteger(answer?.questionIndex) && Array.isArray(answer.selectedOptions)) {
      next.set(answer.questionIndex, answer);
    }
  }
  return next;
}

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
