import { apply, Command, ownAnswers, participantStudyPayload } from "../engine";
import { createSession, deserializeSession, recordSubmission, serializeSession } from "../session";
import { goldenQuiz } from "./attempts-test-support";

it.each(["presenter-paced", "self-paced"] as const)("keeps never-rerun %s edits revisionless on storage and every participant projection", pacing => {
  const quiz = { ...goldenQuiz, questions: [{ ...goldenQuiz.questions[3], index: 0 }] };
  let session = createSession(quiz.week, "open");
  const step = (command: Command, now = 200) => {
    const result = apply(session, quiz, command, now); session = result.session; return result;
  };
  step({ type: "configurePolicy", role: "control", pacing });
  step({ type: "join", socketId: "tab-a", newToken: "seat", payload: { studentId: "sample" } });
  step({ type: "start" });
  for (const [index, now] of [300, 300, 250].entries()) {
    const responseText = `Sample ${index}`;
    const result = step({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex: 0, responseText } }, now);
    expect(result.messages[0]).toEqual({ audience: "participant:sample", event: "answer:accepted", payload: { questionIndex: 0 } });
    expect(JSON.stringify(session.submissions)).toBe(JSON.stringify([{ studentId: "sample", questionIndex: 0, selectedOptions: [], responseText, submittedAt: now, responseTimeMs: now - 200 }]));
    const expected = [{ questionIndex: 0, selectedOptions: [], responseText }];
    expect(ownAnswers(session, quiz, "sample")).toEqual(expected);
    expect(participantStudyPayload(session, quiz, "sample", now).answers).toEqual(expected);
    const joined = step({ type: "join", socketId: "tab-b", newToken: "unused", payload: { studentId: "sample", sessionToken: "seat" } }, now);
    expect((joined.messages[0].payload as { answers: unknown }).answers).toEqual(expected);
    expect(joined.messages[0].payload).not.toHaveProperty("questionAttempts");
    const snapshot = step({ type: "snapshot", participantId: "sample", isReconnect: true }, now);
    expect(snapshot.messages.filter(message => message.event === "session:state")).toEqual([]);
    const bytes = serializeSession(session);
    session = deserializeSession(bytes);
    expect(serializeSession(session)).toBe(bytes);
  }
  const original = JSON.stringify(session.submissions);
  step({ type: "rerun", role: "control", questionIndex: 0 }, 400);
  expect(JSON.stringify(session.attemptArchive?.[0].submissions)).toBe(original);
  const accepted = step({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex: 0, attempt: 2, responseText: "New attempt" } }, 450);
  expect(accepted.messages[0].payload).toEqual({ questionIndex: 0, attempt: 2, acceptedRevision: 1 });
});

it.each([1, 2])("orders acceptance independently of the clock and restores the counter at attempt %s", attempt => {
  const quiz = { ...goldenQuiz, questions: [{ ...goldenQuiz.questions[3], index: 0 }, { ...goldenQuiz.questions[3], index: 1 }] };
  let session = createSession(quiz.week, "open");
  const step = (command: Command, now = 200) => {
    const result = apply(session, quiz, command, now); session = result.session; return result;
  };
  step({ type: "join", socketId: "tab-a", newToken: "seat", payload: { studentId: "sample" } });
  step({ type: "start" });
  step({ type: "rerun", role: "control", questionIndex: 0 });
  if (attempt === 1) { step({ type: "close" }); step({ type: "reveal" }); step({ type: "next" }); }
  const questionIndex = attempt === 1 ? 1 : 0;
  const submit = (responseText: string): Extract<Command, { type: "answerSubmit" }> => ({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex, responseText, ...(attempt > 1 ? { attempt } : {}) } });
  for (const [index, now] of [300, 300, 250].entries()) {
    const before = serializeSession(session);
    const result = apply(session, quiz, submit(`Sample ${index}`), now);
    expect(serializeSession(session)).toBe(before);
    session = result.session;
    const order = { ...(attempt > 1 ? { attempt } : {}), acceptedRevision: index + 1 };
    expect(result.messages[0]).toEqual({ audience: "participant:sample", event: "answer:accepted", payload: { questionIndex, ...order } });
    const expected = [{ questionIndex, ...order, selectedOptions: [], responseText: `Sample ${index}` }];
    expect(ownAnswers(session, quiz, "sample")).toEqual(expected);
    expect(participantStudyPayload(session, quiz, "sample", now).answers).toEqual(expected);
    const joined = step({ type: "join", socketId: "tab-b", newToken: "unused", payload: { studentId: "sample", sessionToken: "seat" } }, now);
    expect((joined.messages[0].payload as { answers: unknown }).answers).toEqual(expected);
    {
      const snapshot = step({ type: "snapshot", participantId: "sample", isReconnect: true }, now);
      expect((snapshot.messages.find(message => message.event === "session:state")!.payload as { answers: unknown }).answers).toEqual(expected);
    }
    const stored = serializeSession(session);
    session = deserializeSession(stored);
    expect(serializeSession(session)).toBe(stored);
  }
  const before = serializeSession(session);
  const refused = apply(session, quiz, submit("   "), 400);
  expect(refused.messages[0].event).toBe("answer:rejected");
  expect(serializeSession(refused.session)).toBe(before);
  if (attempt === 1) {
    step({ type: "rerun", role: "control", questionIndex }, 500);
    const next = step({ ...submit("New attempt"), payload: { questionIndex, attempt: 2, responseText: "New attempt" } }, 600);
    expect(next.session.submissions[0].acceptedRevision).toBe(1);
    expect(next.session.attemptArchive?.at(-1)?.submissions[0].acceptedRevision).toBe(3);
  }
});

it.each([false, true])("loads a stored answer without revision unchanged and orders replacement only after re-run %s", rerun => {
  const quiz = { ...goldenQuiz, questions: [{ ...goldenQuiz.questions[3], index: 0 }, { ...goldenQuiz.questions[3], index: 1 }] };
  let session = createSession(quiz.week, "open");
  session = apply(session, quiz, { type: "join", socketId: "sample", newToken: "seat", payload: { studentId: "sample" } }, 100).session;
  session = apply(session, quiz, { type: "start" }, 200).session;
  if (rerun) session = apply(session, quiz, { type: "rerun", role: "control", questionIndex: 0 }, 200).session;
  session.submissions.push({ ...(rerun ? { attempt: 2 } : {}), studentId: "sample", questionIndex: 0, selectedOptions: [], responseText: "Old stored text", submittedAt: 250, responseTimeMs: 50 });
  const stored = serializeSession(session);
  session = deserializeSession(stored);
  expect(serializeSession(session)).toBe(stored);
  expect(ownAnswers(session, quiz, "sample")).toEqual([{ questionIndex: 0, ...(rerun ? { attempt: 2 } : {}), selectedOptions: [], responseText: "Old stored text" }]);
  const result = apply(session, quiz, { type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex: 0, ...(rerun ? { attempt: 2 } : {}), responseText: "New text" } }, 250);
  expect(result.session.submissions[0]).toEqual({ studentId: "sample", questionIndex: 0, ...(rerun ? { attempt: 2, acceptedRevision: 1 } : {}), selectedOptions: [], responseText: "New text", submittedAt: 250, responseTimeMs: 50 });
  expect(result.messages[0].payload).toEqual({ questionIndex: 0, ...(rerun ? { attempt: 2, acceptedRevision: 1 } : {}) });
});

it("keeps legacy recordSubmission acceptance revisionless across restore", () => {
  jest.spyOn(Date, "now").mockReturnValue(300);
  try {
    const session = createSession(goldenQuiz.week, "open");
    delete session.policy;
    session.state = "QUESTION_OPEN"; session.currentQuestionIndex = 0;
    session.participants.set("sample", { studentId: "sample", socketId: "sample", sessionToken: "seat", connected: true, joinedAt: 0, publicKey: "sample-key", label: "Sample" });
    expect(recordSubmission(session, "sample", 0, { responseText: "First" })).toEqual({ studentId: "sample", questionIndex: 0, selectedOptions: [], responseText: "First", submittedAt: 300, responseTimeMs: 0 });
    const stored = serializeSession(session);
    const restored = deserializeSession(stored);
    expect(serializeSession(restored)).toBe(stored);
    expect(recordSubmission(restored, "sample", 0, { responseText: "Second" })).toEqual({ studentId: "sample", questionIndex: 0, selectedOptions: [], responseText: "Second", submittedAt: 300, responseTimeMs: 0 });
  } finally { jest.restoreAllMocks(); }
});
