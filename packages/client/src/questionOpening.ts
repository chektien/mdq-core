/** The part of an open question that identifies one opening of it. */
export interface QuestionOpening {
  questionIndex: number;
  startedAt: number;
}

/**
 * True when a question:open repeats the opening already on screen, as the
 * rejoin and reveal snapshots do, rather than moving to another question or
 * opening the same one again. A repeat keeps what the student has chosen but
 * not yet submitted; anything else starts the question fresh.
 */
export function isSameOpening<T extends QuestionOpening>(
  shown: T | null | undefined,
  incoming: QuestionOpening,
): shown is T {
  return !!shown && shown.questionIndex === incoming.questionIndex && shown.startedAt === incoming.startedAt;
}
