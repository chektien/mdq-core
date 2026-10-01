import { hasResultsAnswers, updateResultsEvidence } from "../../../client/src/instructorResults";
import { SocketEvents, type Quiz, type Session, type SessionStatePayload, type AnswerCountPayload } from "@mdq/shared";
import { apply } from "../engine";

const quiz: Quiz = { week: "sample", title: "Sample", sourceFile: "sample.md", questions: [0, 1].map(index => ({
  index, topic: "Sample", textMd: "Question", textHtml: "<p>Question</p>",
  options: [{ label: "A", textMd: "One", textHtml: "One" }], correctOptions: ["A"],
  allowsMultiple: false, explanation: "", timeLimitSec: 20,
})) };
const session = (): Session => ({ sessionId: "sample", sessionCode: "SAMPLE", week: "sample", mode: "open",
  state: "QUESTION_OPEN", currentQuestionIndex: 0, questionStartedAt: 1000, createdAt: 0, participants: new Map(),
  submissions: [], revealedQuestionIndexes: new Set(),
});
const answered = (current = session()) => {
  current.submissions.push({ studentId: "sample", questionIndex: 1, selectedOptions: ["A"], responseTimeMs: 100, submittedAt: 1000 });
  return current;
};
const snapshotEvidence = (current: Session) => {
  const result = apply(current, quiz, { type: "snapshot", view: "control" }, 2000);
  const state = result.messages.find(message => message.event === SocketEvents.SESSION_STATE)!.payload as SessionStatePayload;
  return updateResultsEvidence(null, current.sessionId, state.hasAnswers === true);
};

describe("instructor results visibility", () => {
  it("hides a new session and a reveal without submissions", () => {
    expect(hasResultsAnswers(null, "sample")).toBe(false);
    const current = session();
    current.state = "REVEAL";
    expect(hasResultsAnswers(snapshotEvidence(current), current.sessionId)).toBe(false);
  });
  it("recovers earlier and later answers after reload, independent of the current question", () => {
    const current = answered();
    expect(hasResultsAnswers(snapshotEvidence(current), current.sessionId)).toBe(true);
    const next = updateResultsEvidence(snapshotEvidence(current), current.sessionId, false);
    expect(hasResultsAnswers(next, current.sessionId)).toBe(true);
  });
  it.each(["QUESTION_OPEN", "QUESTION_CLOSED", "REVEAL", "LEADERBOARD", "ENDED"] as const)("restores answer evidence in %s", state => {
    const current = answered();
    current.state = state;
    expect(hasResultsAnswers(snapshotEvidence(current), current.sessionId)).toBe(true);
  });
  it("does not leak stale counts into a new session", () => {
    const old = snapshotEvidence(answered());
    expect(hasResultsAnswers(old, "new")).toBe(false);
    expect(hasResultsAnswers(updateResultsEvidence(old, "new", false), "new")).toBe(false);
  });
  it("publishes live and ended evidence before an answer is revealed", () => {
    const current = session();
    current.participants.set("sample", { studentId: "sample", socketId: "socket", publicKey: "sample", label: "Sample", sessionToken: "token", connected: true, joinedAt: 0 });
    const submitted = apply(current, quiz, { type: "answerSubmit", studentId: "sample", payload: { questionIndex: 0, selectedOptions: ["A"] } }, 1100);
    const count = submitted.messages.find(message => message.event === SocketEvents.ANSWER_COUNT)!.payload as AnswerCountPayload;
    expect(count.hasAnswers).toBe(true);
    const ended = apply(submitted.session, quiz, { type: "end" }, 1200);
    const state = ended.messages.find(message => message.event === SocketEvents.SESSION_STATE)!.payload as SessionStatePayload;
    expect(state.hasAnswers).toBe(true);
  });
});
