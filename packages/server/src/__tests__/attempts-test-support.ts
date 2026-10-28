import { Question, Quiz, Session } from "@mdq/shared";
import { apply, Command, endSessionAdvisory, leaderboardRows, ownAnswers, participantResultsPayload, participantStudyPayload } from "../engine";
import { buildResultsCsv } from "../results-csv";
import { createSession, getAnsweredQuestions, getDistribution, getOpenResponses, getSubmissionCount } from "../session";

// Intentional public smoke content. Captured on 594e341 before any attempt reader changed.
export const goldenQuiz: Quiz = { week: "attempt-smoke", title: "Attempt smoke", sourceFile: "attempt-smoke.md", questions:
  ["multiple_choice", "multiple_choice", "poll", "open_response"].map((type, index): Question => ({
    index, questionType: type as Question["questionType"], topic: `Smoke ${index}`, textMd: "Choose", textHtml: "Choose",
    options: type === "open_response" ? [] : ["A", "B", "C"].map(label => ({ label, textMd: label, textHtml: label })),
    correctOptions: index === 0 ? ["A"] : index === 1 ? ["A", "C"] : [],
    allowsMultiple: index === 1, isPoll: type === "poll", liveResults: type === "poll", timeLimitSec: null, explanation: "Smoke explanation",
  })) };
export const seats = ["one", "two", "three"];
export function goldenSession(pacing: "presenter-paced" | "self-paced", legacy = false) {
  let session = createSession(goldenQuiz.week, "open");
  session.sessionId = "smoke-session"; session.sessionCode = "SMOKE";
  if (legacy) delete session.policy;
  const step = (command: Command, now = 200) => { const result = apply(session, goldenQuiz, command, now); session = result.session; return result; };
  if (!legacy) step({ type: "configurePolicy", role: "control", pacing });
  for (const id of seats) step({ type: "join", payload: { studentId: id, displayName: id }, socketId: id, newToken: `token-${id}`, newPublicKey: `key-${id}` });
  step({ type: "start" }, 300);
  return { step, current: () => session };
}
export function readerOutputs(session: Session) {
  const now = 9000;
  return {
    control: leaderboardRows(session, goldenQuiz, "control", now), public: leaderboardRows(session, goldenQuiz, "public", now),
    results: seats.map(id => participantResultsPayload(session, goldenQuiz, id, now)),
    study: seats.map(id => participantStudyPayload(session, goldenQuiz, id, now)),
    own: seats.map(id => ownAnswers(session, goldenQuiz, id)), answered: seats.map(id => getAnsweredQuestions(session, id)),
    advisory: endSessionAdvisory(session, goldenQuiz), csv: buildResultsCsv(session, goldenQuiz, { now }),
    distribution: goldenQuiz.questions.map((_, i) => getDistribution(session, i)),
    responses: goldenQuiz.questions.map((_, i) => getOpenResponses(session, i)),
    counts: goldenQuiz.questions.map((_, i) => getSubmissionCount(session, i)),
    snapshots: ["control", "display", ...seats].map(view => apply(session, goldenQuiz,
      view === "control" || view === "display" ? { type: "snapshot", view } : { type: "snapshot", participantId: view, isReconnect: true }, now).messages),
  };
}
