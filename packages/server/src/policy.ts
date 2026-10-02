import { sessionAvailabilityPhase } from "./availability";
import { Quiz, Session, SessionPolicy, SessionResultMetadata } from "@mdq/shared";
import { buildScoredCorrectAnswersMap } from "./scoring";

export const defaultSessionPolicy = (): SessionPolicy => ({ schemaVersion: 1,
  pacing: "presenter-paced", ranking: "correctness", effectiveTiming: "authored" });
/** Missing policy is a legacy record, not a new default or invented release history. */
export const sessionPolicy = (session: Session): SessionPolicy | null => session.policy ?? null;
export const isSelfPaced = (session: Session): boolean => session.policy?.pacing === "self-paced";
/** Result scope only: legacy grading deliberately retains its historical whole deck scope. */
export function releasedQuestionIndexes(session: Session, quiz: Quiz): number[] {
  quiz = session.deckSnapshot ?? quiz;
  return session.policy ? [...(session.resultScope?.releasedQuestionIndexes ?? session.releasedQuestionIndexes ?? [])]
    .filter((i) => Number.isInteger(i) && !!quiz.questions[i]).sort((a, b) => a - b)
    : quiz.questions.map((_, i) => i);
}
export function isQuestionReleased(session: Session, index: number): boolean {
  return Number.isInteger(index) && index >= 0 && (session.policy
    ? (session.resultScope?.releasedQuestionIndexes ?? [...(session.releasedQuestionIndexes ?? [])]).includes(index)
    : index <= session.currentQuestionIndex);
}
export function scoredCorrectAnswersForSession(session: Session, quiz: Quiz): Map<number, string[]> {
  quiz = session.deckSnapshot ?? quiz;
  const all = buildScoredCorrectAnswersMap(quiz);
  const scope = new Set(session.resultScope?.scoredQuestionIndexes ?? releasedQuestionIndexes(session, quiz));
  return new Map([...all].filter(([i]) => scope.has(i)));
}
export const getSessionScoredQuestionCount = (session: Session, quiz: Quiz): number => scoredCorrectAnswersForSession(session, quiz).size;
export function effectiveRanking(session: Session, quiz: Quiz): "correctness" | "speed" | "legacy" {
  quiz = session.deckSnapshot ?? quiz;
  if (!session.policy) return "legacy";
  if (isSelfPaced(session) || session.policy.ranking !== "speed") return "correctness";
  const scored = scoredCorrectAnswersForSession(session, quiz);
  if ([...scored.keys()].some((i) => quiz.questions[i].timeLimitSec === null)
    || Object.values(session.questionTiming ?? {}).some((t) => t.timingFairnessInvalidated || t.restarts.length > 0)) return "correctness";
  return "speed";
}
export const publicResultsHidden = (session: Session, now = Date.now()): boolean => ["expired", "deleted"].includes(sessionAvailabilityPhase(session, now)) || session.resultsDisclosed === false || session.resultScope?.disclosed === false || (isSelfPaced(session) && session.resultScope?.disclosed !== true);
export function resultMetadata(session: Session, quiz: Quiz): SessionResultMetadata | undefined {
  if (!session.policy) return undefined;
  return { schemaVersion: 1, ...(session.resultScope ? { resultVersion: session.resultScope.resultVersion ?? 1, endedAt: session.resultScope.endedAt } : {}), policy: { ...session.policy }, effectiveRanking: effectiveRanking(session, quiz) as "correctness" | "speed",
    releasedQuestionIndexes: releasedQuestionIndexes(session, quiz), scoredQuestionIndexes: [...scoredCorrectAnswersForSession(session, quiz).keys()],
    finality: session.resultScope ? session.resultScope.disclosed ? "ended" : "undisclosed" : "provisional" };
}
