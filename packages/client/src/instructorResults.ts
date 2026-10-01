export interface ResultsEvidence {
  sessionId: string;
  hasAnswers: boolean;
}

/** Answers persist through navigation and ending, but belong to one session. */
export function updateResultsEvidence(
  previous: ResultsEvidence | null,
  sessionId: string,
  hasAnswers: boolean,
): ResultsEvidence {
  return { sessionId, hasAnswers: hasAnswers || (previous?.sessionId === sessionId && previous.hasAnswers) };
}

export function hasResultsAnswers(evidence: ResultsEvidence | null, sessionId: string | null): boolean {
  return !!sessionId && evidence?.sessionId === sessionId && evidence.hasAnswers;
}
