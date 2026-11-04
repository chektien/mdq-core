import { Question, Quiz, Session } from "@mdq/shared";
import { activeSubmissions, archivedAttempts, currentAttempt } from "../attempts";
import { apply, Command, EngineCommandError, leaderboardRows, ownAnswers, participantStudyPayload, publicQuestionPayload } from "../engine";
import { effectiveRanking } from "../policy";
import { createSession, deserializeSession, serializeSession } from "../session";
import { goldenQuiz, seats } from "./attempts-test-support";

// This intentional public smoke content has a timed graded question, so a re-run's clock and ranking are visible.
const timedQuiz: Quiz = { ...goldenQuiz, questions: goldenQuiz.questions.map((q, i) => i === 0 ? { ...q, timeLimitSec: 30 } : q) };
/** As the golden session, but started on `quiz`, which a policy session freezes as its snapshot. */
function started(pacing: "presenter-paced" | "self-paced", quiz: Quiz) {
  let session = createSession(quiz.week, "open");
  session.sessionId = "smoke-session"; session.sessionCode = "SMOKE";
  const step = (command: Command, now = 200) => { const result = apply(session, quiz, command, now); session = result.session; return result; };
  step({ type: "configurePolicy", role: "control", pacing });
  for (const id of seats) step({ type: "join", payload: { studentId: id, displayName: id }, socketId: id, newToken: `token-${id}`, newPublicKey: `key-${id}` });
  step({ type: "start" }, 300);
  return { step, current: () => session };
}
const answerCommand = (studentId: string, questionIndex: number, selectedOptions = ["A"], attempt?: number): Command =>
  ({ type: "answerSubmit", studentId, sessionToken: `token-${studentId}`, payload: { questionIndex, selectedOptions, ...(attempt !== undefined ? { attempt } : {}) } } as Command);

function presenterPaced(stateAfter: "open" | "closed" | "reveal" | "leaderboard", quiz: Quiz = timedQuiz) {
  const run = started("presenter-paced", quiz), step = run.step, session = run.current;
  if (session().state !== "QUESTION_OPEN") step({ type: "open" }, 300);
  for (const id of seats) step(answerCommand(id, 0, id === "one" ? ["A"] : ["B"]), 400);
  if (stateAfter !== "open") step({ type: "close" }, 500);
  if (stateAfter === "reveal" || stateAfter === "leaderboard") step({ type: "reveal" }, 600);
  if (stateAfter === "leaderboard") step({ type: "leaderboardShow" }, 700);
  return { session, step, quiz };
}

describe("rerun", () => {
  beforeEach(() => { jest.spyOn(Date, "now").mockReturnValue(100); });
  afterEach(() => jest.restoreAllMocks());

  it.each(["open", "closed", "reveal", "leaderboard"] as const)("reopens the current presenter-paced item from %s as attempt 2", stateAfter => {
    const run = presenterPaced(stateAfter), before = run.session();
    expect(activeSubmissions(before).filter(sub => sub.questionIndex === 0)).toHaveLength(3);
    const result = run.step({ type: "rerun", role: "control", questionIndex: 0 }, 10_000);
    const after = result.session;
    expect(after.state).toBe("QUESTION_OPEN");
    expect(after.currentQuestionIndex).toBe(0);
    expect(currentAttempt(after, 0)).toBe(2);
    expect(activeSubmissions(after).filter(sub => sub.questionIndex === 0)).toEqual([]);
    const [entry] = archivedAttempts(after, 0);
    expect(entry.attempt).toBe(1);
    expect(entry.submissions.map(sub => sub.studentId).sort()).toEqual([...seats].sort());
    expect(entry.question).toEqual(timedQuiz.questions[0]);
    expect(after.revealedQuestionIndexes?.has(0) ?? false).toBe(false);
    // The re-run creates a fresh opening and deadline and invalidates timing fairness, so a speed session ranks by correctness.
    expect(after.questionStartedAt).toBe(10_000);
    expect(after.questionDeadlineAt).toBe(10_000 + 30_000);
    expect(after.questionTiming?.["0"]).toMatchObject({ firstOpenedAt: 10_000, startedAt: 10_000, deadlineAt: 40_000, restarts: [], timingFairnessInvalidated: true });
    expect(after.closedByTimer).toBe(false);
    expect(effectiveRanking(before, timedQuiz)).toBe("speed");
    expect(effectiveRanking(after, timedQuiz)).toBe("correctness");
    // The same events as opening, in the same order.
    const events = result.messages.map(message => message.event);
    expect(events.indexOf("question:open")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("question:open")).toBeLessThan(events.indexOf("session:state"));
    expect(events).toContain("answer:count");
    // Phones learn which time the question is asked, so a page forgets its answer to the earlier attempt.
    const opened = result.messages.find(message => message.event === "question:open")!.payload as { attempt?: number };
    expect(opened.attempt).toBe(2);
    const snapshot = run.step({ type: "snapshot", view: "control" }, 10_100);
    expect(snapshot.messages.find(message => message.event === "session:state")?.payload).toMatchObject({ questionAttempts: { "0": 2 } });
  });

  it("names the attempt only after a re-run, so first openings keep their bytes", () => {
    const run = presenterPaced("reveal");
    expect(Object.prototype.hasOwnProperty.call(publicQuestionPayload(run.session(), timedQuiz, 0, 900), "attempt")).toBe(false);
    run.step({ type: "rerun", role: "control", questionIndex: 0 }, 1_000);
    expect(publicQuestionPayload(run.session(), timedQuiz, 0, 1_100)?.attempt).toBe(2);
    const third = run.step({ type: "rerun", role: "control", questionIndex: 0 }, 2_000);
    expect((third.messages.find(message => message.event === "question:open")!.payload as { attempt?: number }).attempt).toBe(3);
    // Another question that was never re-run keeps no attempt field.
    expect(Object.prototype.hasOwnProperty.call(publicQuestionPayload(run.session(), timedQuiz, 1, 2_100) ?? {}, "attempt")).toBe(false);
  });

  it("a self-paced item list names a re-run item's attempt", () => {
    const run = started("self-paced", goldenQuiz), step = run.step;
    for (const id of seats) step(answerCommand(id, 0), 400);
    step({ type: "rerun", role: "control", questionIndex: 0 }, 1_000);
    const study = participantStudyPayload(run.current(), goldenQuiz, seats[0], 1_100);
    expect(study.items.find(item => item.questionIndex === 0)?.attempt).toBe(2);
    expect(study.answeredQuestions).not.toContain(0);
  });

  it("accepts answers for the new attempt and counts only them", () => {
    const run = presenterPaced("reveal");
    run.step({ type: "rerun", role: "control", questionIndex: 0 }, 10_000);
    const accepted = run.step(answerCommand("two", 0, ["A"], 2), 11_000);
    expect(accepted.messages.some(message => message.event === "answer:accepted")).toBe(true);
    const active = activeSubmissions(run.session()).filter(sub => sub.questionIndex === 0);
    expect(active.map(sub => [sub.studentId, sub.attempt])).toEqual([["two", 2]]);
    expect(ownAnswers(run.session(), timedQuiz, "two")).toEqual([{ questionIndex: 0, selectedOptions: [0], attempt: 2, acceptedRevision: 1 }]);
    expect(participantStudyPayload(run.session(), timedQuiz, "two", 11_100).answers).toEqual(ownAnswers(run.session(), timedQuiz, "two"));
    const joined = run.step({ type: "join", payload: { studentId: "two", sessionToken: "token-two" }, socketId: "rejoin", newToken: "unused" }, 11_200);
    expect((joined.messages.find(message => message.event === "student:joined")!.payload as { answers: unknown }).answers).toEqual(ownAnswers(run.session(), timedQuiz, "two"));
    const rows = leaderboardRows(run.session(), timedQuiz, "control", 12_000);
    expect(rows.find(row => row.studentId === "one")?.correctCount ?? 0).toBe(0);
    expect(rows.find(row => row.studentId === "two")?.correctCount).toBe(1);
  });


  it.each([undefined, 1, 3, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, null, "2"])("refuses an invalid or earlier submitted attempt %s without changing answers", attempt => {
    const run = presenterPaced("open");
    run.step({ type: "rerun", role: "control", questionIndex: 0 }, 1_000);
    const before = serializeSession(run.session());
    const command = answerCommand("one", 0);
    if (command.type !== "answerSubmit") throw new Error("Expected answer command");
    command.payload = { ...command.payload, attempt: attempt as number | undefined };
    const result = run.step(command, 1_100);
    expect(result.messages.find(message => message.event === "answer:rejected")?.payload).toEqual({ questionIndex: 0, reason: "This question is on a different attempt. Refresh it and answer again." });
    expect(serializeSession(run.session())).toBe(before);
  });

  it("accepts omitted or explicit attempt 1 before any re-run without adding attempt fields", () => {
    const run = started("presenter-paced", timedQuiz);
    for (const [id, attempt] of [["one", undefined], ["two", 1]] as const) {
      expect(run.step(answerCommand(id, 0, ["A"], attempt), 400).messages.some(message => message.event === "answer:accepted")).toBe(true);
      expect(ownAnswers(run.current(), timedQuiz, id)).toEqual([{ questionIndex: 0, selectedOptions: [0] }]);
    }
    const states = run.step({ type: "close" }, 500).messages.filter(message => message.event === "session:state");
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) expect(state.payload).not.toHaveProperty("questionAttempts");
  });

  it("broadcasts self-paced attempt changes without availability or a state transition", () => {
    const run = started("self-paced", goldenQuiz);
    delete run.current().availability;
    const state = run.current().state;
    const result = run.step({ type: "rerun", role: "control", questionIndex: 0 }, 1_000);
    expect(result.messages.find(message => message.event === "session:state" && message.audience === "all")?.payload).toMatchObject({ state, questionAttempts: { "0": 2 } });
    expect(result.messages.some(message => message.event === "question:open")).toBe(false);
  });

  it.each(["snapshot", "reconnect", "rejoin", "join"] as const)("includes unviewed attempts in a participant %s only after a re-run", recovery => {
    const run = started("self-paced", goldenQuiz);
    const snapshot = (studentId = recovery === "join" ? "new" : "one") => run.step(recovery === "join" || recovery === "rejoin"
      ? { type: "join", payload: { studentId, sessionToken: recovery === "join" ? "new-token" : "token-one" }, socketId: "recovered", newToken: "new-token" }
      : { type: "snapshot", participantId: "one", isReconnect: recovery === "reconnect" }, 1_100);
    const beforeId = recovery === "join" ? "before" : "one";
    const before = snapshot(beforeId).messages.filter(message => message.audience === `participant:${beforeId}`);
    expect(before.some(message => message.event === "session:state")).toBe(false);
    expect(JSON.stringify(before)).not.toContain("questionAttempts");
    run.step({ type: "next" }, 300);
    run.step({ type: "rerun", role: "control", questionIndex: 0 }, 1_000);
    const messages = snapshot().messages.filter(message => message.audience === `participant:${recovery === "join" ? "new" : "one"}`);
    expect(messages.find(message => message.event === "session:state")?.payload).toMatchObject({ questionIndex: 1, questionAttempts: { "0": 2 } });
    expect(messages.find(message => message.event === "question:open")?.payload).toMatchObject({ questionIndex: 1 });
  });

  it("snapshot own answers are current and private to the named participant after a re-run", () => {
    const run = started("self-paced", goldenQuiz);
    run.step(answerCommand("one", 0, ["A"]), 400);
    run.step({ type: "next" }, 500);
    run.step({ type: "rerun", role: "control", questionIndex: 0 }, 1_000);
    run.step(answerCommand("one", 0, ["B"], 2), 1_050);
    run.step(answerCommand("two", 0, ["C"], 2), 1_060);
    const state = (participantId: string) => run.step({ type: "snapshot", participantId, isReconnect: true }, 1_100).messages
      .find(message => message.event === "session:state");
    expect(state("one")).toMatchObject({ audience: "participant:one", payload: { answers: [{ questionIndex: 0, selectedOptions: [1], attempt: 2 }] } });
    expect(state("two")).toMatchObject({ audience: "participant:two", payload: { answers: [{ questionIndex: 0, selectedOptions: [2], attempt: 2 }] } });
    expect(state("three")).toMatchObject({ audience: "participant:three", payload: { answers: [] } });
    for (const view of ["control", "display"] as const) {
      const messages = run.step({ type: "snapshot", view, isReconnect: true }, 1_100).messages;
      expect(messages.find(message => message.event === "session:state")?.payload).not.toHaveProperty("answers");
    }
    const broadcast = run.step({ type: "rerun", role: "control", questionIndex: 0 }, 1_200).messages;
    expect(broadcast.find(message => message.event === "session:state" && message.audience === "all")?.payload).not.toHaveProperty("answers");
  });

  it("archives the question the host passes, which is what people answered", () => {
    const run = presenterPaced("closed");
    const archived: Question = { ...timedQuiz.questions[0], textMd: "What people saw", textHtml: "What people saw" };
    const after = run.step({ type: "rerun", role: "control", questionIndex: 0, archived }, 10_000).session;
    expect(archivedAttempts(after, 0)[0].question).toEqual(archived);
  });

  it("a second re-run makes attempt 3 with two archived attempts", () => {
    const run = presenterPaced("reveal");
    run.step({ type: "rerun", role: "control", questionIndex: 0 }, 10_000);
    run.step(answerCommand("one", 0, ["A"], 2), 11_000);
    run.step({ type: "close" }, 12_000);
    const after = run.step({ type: "rerun", role: "control", questionIndex: 0 }, 13_000).session;
    expect(currentAttempt(after, 0)).toBe(3);
    expect(archivedAttempts(after, 0).map(entry => [entry.attempt, entry.submissions.length])).toEqual([[1, 3], [2, 1]]);
  });

  it("re-runs a released self-paced item in place, without moving anyone", () => {
    const run = started("self-paced", goldenQuiz), step = run.step;
    step({ type: "next" }, 300);
    for (const id of seats) step(answerCommand(id, 0), 400);
    let session: Session = run.current();
    const before = { index: session.currentQuestionIndex, state: session.state, released: [...(session.releasedQuestionIndexes ?? [])] };
    step({ type: "rerun", role: "control", questionIndex: 0 }, 10_000);
    session = run.current();
    expect({ index: session.currentQuestionIndex, state: session.state, released: [...(session.releasedQuestionIndexes ?? [])] }).toEqual(before);
    expect(currentAttempt(session, 0)).toBe(2);
    expect(activeSubmissions(session).filter(sub => sub.questionIndex === 0)).toEqual([]);
    expect(archivedAttempts(session, 0)[0].submissions).toHaveLength(3);
  });

  it("survives serialization with its attempt and archive", () => {
    const run = presenterPaced("reveal");
    const after = run.step({ type: "rerun", role: "control", questionIndex: 0 }, 10_000).session;
    const read = deserializeSession(serializeSession(after));
    expect(currentAttempt(read, 0)).toBe(2);
    expect(archivedAttempts(read, 0)).toEqual(archivedAttempts(after, 0));
    expect(read.questionTiming?.["0"]?.timingFairnessInvalidated).toBe(true);
  });

  describe("refusals change nothing", () => {
    const refused = (session: Session, command: Command, reason: RegExp, quiz: Quiz = timedQuiz, now = 10_000) => {
      const snapshot = serializeSession(session);
      expect(() => apply(session, quiz, command, now)).toThrow(EngineCommandError);
      expect(() => apply(session, quiz, command, now)).toThrow(reason);
      expect(serializeSession(session)).toBe(snapshot);
    };
    it("a participant or display cannot re-run", () => {
      for (const role of ["display", "participant"] as const) refused(presenterPaced("reveal").session(), { type: "rerun", role, questionIndex: 0 }, /Only the presenter/);
    });
    it("a presenter-paced item that is not current is refused", () => {
      const run = presenterPaced("reveal");
      run.step({ type: "next" }, 800);
      refused(run.session(), { type: "rerun", role: "control", questionIndex: 0 }, /Go back to this question/);
    });
    it("a missing question, a negative index and a lobby are refused", () => {
      for (const questionIndex of [9, -1, 0.5]) refused(presenterPaced("reveal").session(), { type: "rerun", role: "control", questionIndex }, /Question not found/);
      let lobby = started("presenter-paced", timedQuiz).current();
      lobby = { ...lobby, state: "LOBBY" } as Session;
      refused(lobby, { type: "rerun", role: "control", questionIndex: 0 }, /Start the session/);
    });
    it("a slide is refused", () => {
      const slideQuiz: Quiz = { ...timedQuiz, questions: timedQuiz.questions.map((q, i) => i === 0 ? { ...q, questionType: "slide" as Question["questionType"] } : q) };
      const session = started("presenter-paced", slideQuiz).current();
      refused(session, { type: "rerun", role: "control", questionIndex: 0 }, /Slides have no answers/, slideQuiz);
    });
    it("an ended session and an expired availability are refused", () => {
      const ended = apply(presenterPaced("reveal").session(), timedQuiz, { type: "end" }, 900).session;
      refused(ended, { type: "rerun", role: "control", questionIndex: 0 }, /ended/);
      const expiring = presenterPaced("reveal").session();
      expiring.availability = { schemaVersion: 1, availableUntil: 5_000, generation: 1 };
      refused(expiring, { type: "rerun", role: "control", questionIndex: 0 }, /Availability ended/, timedQuiz, 6_000);
    });
    it("a final results scope is refused independently of state and availability", () => {
      const session = presenterPaced("open").session();
      session.resultScope = { schemaVersion: 1, releasedQuestionIndexes: [0], scoredQuestionIndexes: [0], endedAt: 900, disclosed: true };
      refused(session, { type: "rerun", role: "control", questionIndex: 0 }, /Session has ended/);
    });
    it("a policy-less legacy session is refused and keeps its ranking", () => {
      const session = presenterPaced("open").session();
      delete session.policy;
      expect(effectiveRanking(session, timedQuiz)).toBe("legacy");
      refused(session, { type: "rerun", role: "control", questionIndex: 0 }, /Legacy sessions cannot re-run/);
    });
    it("an unreleased self-paced item is refused", () => {
      const session = started("self-paced", goldenQuiz).current();
      refused(session, { type: "rerun", role: "control", questionIndex: 3 }, /released question/, goldenQuiz);
    });
  });
});
