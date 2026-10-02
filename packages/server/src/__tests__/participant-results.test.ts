import { EndSessionAdvisory, Question, Quiz, Session, SocketEvents } from "@mdq/shared";
import { apply, audienceReaches, endSessionAdvisory, participantResultsPayload, type Command } from "../engine";
import { publicResultsHidden, resultMetadata } from "../policy";
import { buildResultsCsv } from "../results-csv";
import { createSession, serializeSession, deserializeSession } from "../session";

const question = (index: number, type: Question["questionType"] = "multiple_choice"): Question => ({
  index, topic: `Synthetic ${index}`, textMd: "Choose", textHtml: "Choose", questionType: type, timeLimitSec: null,
  options: type === "open_response" ? [] : [{ label: "A", textMd: "One", textHtml: "One" }, { label: "B", textMd: "Two", textHtml: "Two" }],
  correctOptions: type === "multiple_choice" ? ["A"] : [], explanation: `EXPLANATION_${index}`, allowsMultiple: false,
  presenterNotes: [{ id: "private", scope: "section", audience: "presenter", bodyMd: "PRIVATE_PRESENTER_NOTE", bodyHtml: "PRIVATE_PRESENTER_NOTE" }],
});
const quiz: Quiz = { week: "synthetic", title: "Synthetic finality", sourceFile: "synthetic.md", questions: [question(0, "cover"), question(1), question(2, "poll"), question(3, "open_response"), question(4)] };
function played(pacing: "presenter-paced" | "self-paced" = "self-paced") {
  let session = createSession("synthetic", "open");
  const step = (command: Command, now = 0) => { const result = apply(session, quiz, command, now); session = result.session; return result; };
  step({ type: "configurePolicy", role: "control", pacing, ranking: "correctness" });
  for (const id of ["one", "two"]) step({ type: "join", payload: { studentId: id }, socketId: id, newToken: `seat-${id}`, newPublicKey: `opaque-${id}` });
  step({ type: "start" });step({ type: "next" });
  step({ type: "answerSubmit", studentId: "one", sessionToken: "seat-one", payload: { questionIndex: 1, selectedOptions: ["A"] } });
  if (pacing === "presenter-paced") { step({ type: "close" });step({ type: "reveal" }); }
  step({ type: "next" });
  step({ type: "answerSubmit", studentId: "one", sessionToken: "seat-one", payload: { questionIndex: 2, selectedOptions: ["B"] } });
  if (pacing === "presenter-paced") { step({ type: "close" });step({ type: "reveal" }); }
  step({ type: "next" });
  step({ type: "answerSubmit", studentId: "one", sessionToken: "seat-one", payload: { questionIndex: 3, responseText: "OWN_RESPONSE" } });
  step({ type: "answerSubmit", studentId: "two", sessionToken: "seat-two", payload: { questionIndex: 3, responseText: "OTHER_RESPONSE_PRIVATE" } });
  return { step, current: () => session };
}
it.each(["presenter-paced", "self-paced"] as const)("%s final results freeze version, scope and zero timestamp across repeated End and serialization", pacing => {
  const { step, current } = played(pacing);
  expect(participantResultsPayload(current(), quiz, "one")).toBeNull();
  const final = step({ type: "end" }, 0).session;
  const scope = final.resultScope;
  expect(scope).toEqual({ schemaVersion: 1, resultVersion: 1, releasedQuestionIndexes: [0, 1, 2, 3], scoredQuestionIndexes: [1], endedAt: 0, disclosed: true });
  const repeated = apply(deserializeSession(serializeSession(final)), quiz, { type: "end", discloseResults: false }, 999999).session;
  expect(repeated.resultScope).toEqual(scope);
  expect(participantResultsPayload(repeated, quiz, "one")).toEqual(participantResultsPayload(final, quiz, "one"));
  const results = participantResultsPayload(final, quiz, "one")!;
  expect(results.questions.map(result => result.question.questionIndex)).toEqual([1, 2, 3]);
  expect(results.questions[0]).toMatchObject({ correct: true, correctOptions: ["A"], explanation: "EXPLANATION_1" });
  expect(results.questions[2].answer?.responseText).toBe("OWN_RESPONSE");
  expect(results.summary).toEqual({ answeredCount: 3, availableQuestionCount: 3, scoredQuestionCount: 1 });
  expect(results.leaderboard?.map(row => Object.keys(row).sort())).toEqual([["label", "publicKey", "rank", "score"], ["label", "publicKey", "rank", "score"]]);
  expect(JSON.stringify(results)).not.toMatch(/OTHER_RESPONSE_PRIVATE|PRIVATE_PRESENTER_NOTE|studentId|displayName|sessionToken|totalTimeMs|Synthetic 4/);
  expect(participantResultsPayload(final, quiz, "not-a-seat")).toBeNull();
  expect(resultMetadata(final, quiz)).toMatchObject({ resultVersion: 1, endedAt: 0 });
  const csv = buildResultsCsv(final, quiz, { now: 999999 });
  expect(csv).toContain("result_version,session_ended_at_iso");expect(csv).toContain("1970-01-01T00:00:00.000Z");
});
it.each(["presenter-paced", "self-paced"] as const)("%s administrative stop never discloses or becomes deliberate via repeated End", pacing => {
  const { current } = played(pacing);
  const stopped = apply(current(), quiz, { type: "end", discloseResults: false }, 10).session;
  const repeated = apply(stopped, quiz, { type: "end" }, 20).session;
  expect(repeated.resultScope).toEqual(stopped.resultScope);expect(publicResultsHidden(repeated)).toBe(true);
  expect(participantResultsPayload(repeated, quiz, "one")).toBeNull();
  const snapshots = apply(repeated, quiz, { type: "snapshot", view: "display" }, 30).messages;
  expect(snapshots.filter(message => message.event === SocketEvents.LEADERBOARD_UPDATE || message.event === SocketEvents.RESULTS_REVEAL)).toEqual([]);
});
it("unscored and content-only releases return participation without an empty board, score or rank", () => {
  const { current } = played(); const session = current();
  session.releasedQuestionIndexes = new Set([0, 2, 3]);
  const results = participantResultsPayload(apply(session, quiz, { type: "end" }, 100).session, quiz, "one")!;
  expect(results.summary).toEqual({ answeredCount: 2, availableQuestionCount: 2 });
  expect(results.leaderboard).toBeUndefined();expect(JSON.stringify(results)).not.toMatch(/"correct"|"correctOptions"|"rank"|"score"/);
  session.releasedQuestionIndexes = new Set([0]);
  const content = participantResultsPayload(apply(session, quiz, { type: "end" }, 100).session, quiz, "one")!;
  expect(content.summary).toEqual({ answeredCount: 0, availableQuestionCount: 0 });expect(content.questions).toEqual([]);expect(content.leaderboard).toBeUndefined();
});
it("End versus Submit follows serialized order and never reopens or accepts a new seat", () => {
  const { current } = played();const session = current();
  const answer: Command = { type: "answerSubmit", studentId: "one", sessionToken: "seat-one", payload: { questionIndex: 3, responseText: "LAST_VALID" } };
  const before = apply(apply(session, quiz, answer, 1).session, quiz, { type: "end" }, 2).session;
  expect(participantResultsPayload(before, quiz, "one")!.questions[2].answer?.responseText).toBe("LAST_VALID");
  const after = apply(apply(session, quiz, { type: "end" }, 1).session, quiz, answer, 2);
  expect(after.messages.some(message => message.event === SocketEvents.ANSWER_REJECTED)).toBe(true);
  expect(participantResultsPayload(after.session, quiz, "one")!.questions[2].answer?.responseText).toBe("OWN_RESPONSE");
  const joined = apply(after.session, quiz, { type: "join", payload: { studentId: "impostor", displayName: "Same name" }, socketId: "new", newToken: "new" }, 3);
  expect(joined.session.participants.size).toBe(2);expect(joined.messages.some(message => message.event === SocketEvents.STUDENT_JOINED)).toBe(false);
  expect(() => apply(after.session, quiz, { type: "start" }, 3)).toThrow("ended");
});
it("End advisory uses the shown set, submitted interactive answers and unreleased interactive items", () => {
  const { current } = played();const session = current();
  expect(endSessionAdvisory(session, quiz)).toEqual<EndSessionAdvisory>({ unfinishedParticipantCount: 1, unshownQuestionCount: 1 });
  session.currentQuestionIndex = 4; // Observing a far-ahead position must not invent releases.
  expect(endSessionAdvisory(session, quiz)).toEqual({ unfinishedParticipantCount: 1, unshownQuestionCount: 1 });
  session.participants.get("two")!.released = true;
  expect(endSessionAdvisory(session, quiz).unfinishedParticipantCount).toBe(0);
});
it("final public messages omit response text/private identity and preserve legacy idempotence", () => {
  const { current } = played();const ended = apply(current(), quiz, { type: "end" }, 10);
  const publicMessages = ended.messages.filter(message => audienceReaches(message.audience, "participant"));
  expect(publicMessages.map(message => message.event)).toContain(SocketEvents.SESSION_STATE);
  expect(JSON.stringify(publicMessages)).not.toMatch(/OWN_RESPONSE|OTHER_RESPONSE_PRIVATE|studentId|displayName|totalTimeMs|PRIVATE_PRESENTER_NOTE/);
  const legacy: Session = { ...current(), policy: undefined, resultScope: undefined };
  const legacyEnded = apply(legacy, quiz, { type: "end" }, 30).session;
  expect(apply(legacyEnded, quiz, { type: "end" }, 50).session.endedAt).toBe(30);
  expect(participantResultsPayload(legacyEnded, quiz, "one")?.resultVersion).toBe(0);
  expect(resultMetadata(legacyEnded, quiz)).toBeUndefined();
});

it("terminal older policy records without a final scope do not invent timestamps or disclosure on retry", () => {
  const { current } = played();const ended: Session = { ...current(), state: "ENDED", resultScope: undefined };
  const retry = apply(ended, quiz, { type: "end" }, 123456).session;
  expect(retry.resultScope).toBeUndefined();expect(retry.endedAt).toBeUndefined();
  expect(participantResultsPayload(retry, quiz, "one")).toBeNull();
});
