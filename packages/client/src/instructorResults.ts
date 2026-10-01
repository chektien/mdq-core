/** Evidence of an answer from the counts and reveals the instructor already holds. */
export function hasResultsAnswers(
  answerCount: { submitted: number } | null,
  reveals: readonly { distribution: Record<string, number>; openResponses: readonly unknown[] }[],
): boolean {
  return (answerCount?.submitted ?? 0) > 0 || reveals.some((reveal) =>
    reveal.openResponses.length > 0 || Object.values(reveal.distribution).some((count) => count > 0),
  );
}
