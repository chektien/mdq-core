/** Small pieces of presenter-facing wording that more than one view uses. */

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** "2 quiz questions and 1 slide", leaving out any part that is zero. Empty when nothing is left. */
export function formatRemaining(quizQuestions: number, slides: number): string {
  return [
    quizQuestions > 0 ? pluralize(quizQuestions, "quiz question") : null,
    slides > 0 ? pluralize(slides, "slide") : null,
  ].filter(Boolean).join(" and ");
}

/** What a closed question is called: "Time's up" only when the timer ran out, otherwise "Answers closed". */
export function closedLabel(timedOut: boolean): string {
  return timedOut ? "Time's up" : "Answers closed";
}

/** "3/8" from the engine's question numbers (slides are not counted); undefined on a slide or from an older server. */
export function positionLabel(question: { questionNumber?: number; questionTotal?: number } | null | undefined): string | undefined {
  if (!question?.questionNumber || !question.questionTotal) return undefined;
  return `${question.questionNumber}/${question.questionTotal}`;
}
