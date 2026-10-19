import { Session, SessionMode } from "@mdq/shared";
import { createSession } from "../../session";

/** Explicit pre-policy fixture: do not weaken historical scope/time-rank expectations. */
export function createLegacySession(week: string, mode: SessionMode): Session {
  const session = createSession(week, mode);
  delete session.openResponsesHiddenByDefault;
  delete session.policy;
  delete session.policyFrozen;
  delete session.releasedQuestionIndexes;
  return session;
}
