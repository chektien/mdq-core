import type { AnswerSubmitPayload, QuestionOpenPayload } from "@mdq/shared";

/** Capture provenance once. Prepared answers must never acquire a newer displayed pair. */
export function answerForQuestion(
  payload: AnswerSubmitPayload,
  question: Pick<QuestionOpenPayload, "attempt" | "contentVersion">,
): AnswerSubmitPayload {
  if (payload.attempt !== undefined || payload.contentVersion !== undefined) return payload;
  return {
    ...payload,
    attempt: question.attempt ?? 1,
    ...(question.contentVersion !== undefined ? { contentVersion: question.contentVersion } : {}),
  };
}
