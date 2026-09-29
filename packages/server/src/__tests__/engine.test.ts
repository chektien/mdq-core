import { Quiz, Session, SessionState, SocketEvents } from "@mdq/shared";
import { apply, type Command } from "../engine";
import { emitMessages } from "../socket";
import { storeSession, clearAllSessions } from "../session";
import { Server } from "socket.io";

const question = (index: number) => ({
  index, topic: `Item ${index}`, textMd: "Question", textHtml: "<p>Question</p>",
  options: [{ label: "A", textMd: "One", textHtml: "One" }],
  correctOptions: ["A"], allowsMultiple: false, explanation: "Correct", timeLimitSec: 20,
});
const quiz: Quiz = { week: "sample", title: "Sample", sourceFile: "sample.md", questions: [question(0), question(1)] };
const states: SessionState[] = ["LOBBY", "QUESTION_OPEN", "QUESTION_CLOSED", "REVEAL", "LEADERBOARD", "ENDED"];
const commands: Command["type"][] = ["start", "next", "previous", "open", "close", "reveal", "end", "leaderboardShow", "leaderboardHide", "timeout"];
const base = (state: SessionState): Session => ({
  sessionId: "session", sessionCode: "SAMPLE1", week: "sample", mode: "open", state,
  currentQuestionIndex: state === "LOBBY" ? -1 : 0, questionStartedAt: state === "LOBBY" ? undefined : 1000,
  revealedQuestionIndexes: new Set<number>(), participants: new Map(), submissions: [], createdAt: 0,
});
const openPayload = (index: number) => ({
  questionIndex: index, topic: `Item ${index}`, text: "<p>Question</p>", questionType: "multiple_choice",
  attendeeNotes: undefined, slideMedia: undefined, slideMediaPosition: undefined, slideMediaOpacity: undefined,
  slideBackground: undefined, slideLiveEmbed: undefined, slideVideo: undefined, slideReferences: undefined,
  options: [{ label: "A", text: "One" }], allowsMultiple: false, isPoll: false, timeLimitSec: 20, startedAt: 1000,
});
const count = (index: number) => ({ questionIndex: index, submitted: 0, total: 0, openResponses: undefined });
const reveal = (index: number) => ({ questionIndex: index, questionType: "multiple_choice", correctOptions: ["A"],
  explanation: "Correct", distribution: {}, isPoll: false, openResponses: undefined });
const msg = (event: string, payload: unknown, audience: "all" | "staff" = "all") => ({ audience, event, payload });
const opened = (index: number) => [
  msg(SocketEvents.QUESTION_OPEN, openPayload(index)),
  msg(SocketEvents.SESSION_STATE, { state: "QUESTION_OPEN", questionIndex: index }),
  msg(SocketEvents.ANSWER_COUNT, count(index), "staff"),
];
const revealed = (index: number) => [
  msg(SocketEvents.QUESTION_OPEN, openPayload(index)), msg(SocketEvents.RESULTS_REVEAL, reveal(index)),
  msg(SocketEvents.SESSION_STATE, { state: "REVEAL", questionIndex: index }),
];
const closed = [
  msg(SocketEvents.QUESTION_CLOSE, { questionIndex: 0 }),
  msg(SocketEvents.SESSION_STATE, { state: "QUESTION_CLOSED", questionIndex: 0 }),
  msg(SocketEvents.RESULTS_DISTRIBUTION, { questionIndex: 0, distribution: {} }, "staff"),
];
const leaders = [msg(SocketEvents.LEADERBOARD_UPDATE, { entries: [], totalQuestions: 2 }),
  msg(SocketEvents.SESSION_STATE, { state: "LEADERBOARD" })];
const ended = [msg(SocketEvents.SESSION_STATE, { state: "ENDED" })];
const cases: Record<string, { state: SessionState; messages: ReturnType<typeof msg>[] } | { error: string }> = {
  "LOBBY:start": { state: "QUESTION_OPEN", messages: opened(0) },
  "LOBBY:open": { state: "QUESTION_OPEN", messages: opened(0) },
  "QUESTION_OPEN:close": { state: "QUESTION_CLOSED", messages: closed },
  "QUESTION_OPEN:timeout": { state: "QUESTION_CLOSED", messages: closed },
  "QUESTION_OPEN:end": { state: "ENDED", messages: ended },
  "QUESTION_CLOSED:reveal": { state: "REVEAL", messages: revealed(0) },
  "QUESTION_CLOSED:leaderboardHide": { state: "REVEAL", messages: revealed(0) },
  "QUESTION_CLOSED:leaderboardShow": { state: "LEADERBOARD", messages: leaders },
  "QUESTION_CLOSED:end": { state: "ENDED", messages: ended },
  "REVEAL:next": { state: "QUESTION_OPEN", messages: opened(1) },
  "REVEAL:start": { state: "QUESTION_OPEN", messages: opened(0) },
  "REVEAL:open": { state: "QUESTION_OPEN", messages: opened(0) },
  "REVEAL:leaderboardShow": { state: "LEADERBOARD", messages: leaders },
  "REVEAL:end": { state: "ENDED", messages: ended },
  "LEADERBOARD:leaderboardHide": { state: "REVEAL", messages: revealed(0) },
  "LEADERBOARD:reveal": { state: "REVEAL", messages: revealed(0) },
  "LEADERBOARD:end": { state: "ENDED", messages: ended },
};

for (const state of states) for (const type of commands) {
  it(`${state} ${type} uses the current transition and payload fixture`, () => {
    const input = base(state);
    const before = { ...input, participants: [...input.participants], submissions: [...input.submissions], revealed: [...input.revealedQuestionIndexes!] };
    const fixture = cases[`${state}:${type}`];
    if (fixture && "state" in fixture) {
      const result = apply(input, quiz, { type } as Command, type === "timeout" ? 21000 : 1000);
      expect(result.session.state).toBe(fixture.state);
      expect(result.messages).toEqual(fixture.messages);
      expect(result.nextDeadline).toBe(fixture.state === "QUESTION_OPEN" ? 21000 : null);
    } else if (type === "timeout") {
      const result = apply(input, quiz, { type }, 1000);
      expect(result.session.state).toBe(state);
      expect(result.messages).toEqual([]);
    } else if (type === "leaderboardHide" && state !== "LEADERBOARD") {
      expect(() => apply(input, quiz, { type }, 1000)).toThrow();
    } else {
      expect(() => apply(input, quiz, { type } as Command, 1000)).toThrow();
    }
    expect(input).toEqual(expect.objectContaining({
      state: before.state, currentQuestionIndex: before.currentQuestionIndex,
      participants: new Map(before.participants), submissions: before.submissions,
      revealedQuestionIndexes: new Set(before.revealed),
    }));
  });
}

it("joins, answers and disconnects without changing the supplied session", () => {
  const input = base("QUESTION_OPEN");
  const joined = apply(input, quiz, { type: "join", socketId: "socket-1", newToken: "token-1", payload: { studentId: "S1", displayName: "Sam" } }, 2000);
  expect(input.participants.size).toBe(0);
  expect(joined.messages[0]).toEqual({ audience: "participant:S1", event: SocketEvents.STUDENT_JOINED,
    payload: { participantId: "S1", sessionToken: "token-1", sessionState: "QUESTION_OPEN", currentQuestion: 0, answeredQuestions: [], answers: [] } });
  const answered = apply(joined.session, quiz, { type: "answerSubmit", studentId: "S1", payload: { questionIndex: 0, selectedOptions: ["A"] } }, 3000);
  expect(joined.session.submissions).toHaveLength(0);
  expect(answered.messages).toEqual([
    { audience: "participant:S1", event: SocketEvents.ANSWER_ACCEPTED, payload: { questionIndex: 0 } },
    msg(SocketEvents.ANSWER_COUNT, { questionIndex: 0, submitted: 1, total: 1, openResponses: undefined }, "staff"),
  ]);
  const disconnected = apply(answered.session, quiz, { type: "disconnect", studentId: "S1", socketId: "socket-1" }, 4000);
  expect(disconnected.session.participants.get("S1")?.connected).toBe(false);
  expect(answered.session.participants.get("S1")?.connected).toBe(true);
});

it("ignores a late disconnect from a socket the student has already replaced", () => {
  const input = base("QUESTION_OPEN");
  const first = apply(input, quiz, { type: "join", socketId: "socket-1", newToken: "token-1", payload: { studentId: "S1" } }, 2000);
  const rejoined = apply(first.session, quiz, { type: "join", socketId: "socket-2", newToken: "unused", payload: { studentId: "S1", sessionToken: "token-1" } }, 3000);
  expect(rejoined.session.participants.get("S1")?.socketId).toBe("socket-2");
  const stale = apply(rejoined.session, quiz, { type: "disconnect", studentId: "S1", socketId: "socket-1" }, 4000);
  expect(stale.session.participants.get("S1")?.connected).toBe(true);
  expect(stale.messages).toEqual([]);
  const current = apply(stale.session, quiz, { type: "disconnect", studentId: "S1", socketId: "socket-2" }, 5000);
  expect(current.session.participants.get("S1")?.connected).toBe(false);
  expect(current.messages[0]).toEqual(msg(SocketEvents.SESSION_PARTICIPANTS, { count: 0, participants: [] }, "staff"));
});

for (const state of states) {
  it(`${state} accepts a join and preserves its current state`, () => {
    const input = base(state);
    const result = apply(input, quiz, { type: "join", socketId: "socket", newToken: "token", payload: { studentId: "S1" } }, 2000);
    expect(result.session.state).toBe(state);
    if (state === "ENDED") {
      expect(result.session.participants.size).toBe(0);
      expect(result.messages).toEqual([{ audience: "participant:socket", event: SocketEvents.STUDENT_REJECTED,
        payload: { reason: "Session has ended" } }]);
      return;
    }
    expect(result.session.participants.get("S1")?.sessionToken).toBe("token");
    expect(result.messages[0]).toEqual({ audience: "participant:S1", event: SocketEvents.STUDENT_JOINED,
      payload: { participantId: "S1", sessionToken: "token", sessionState: state,
        currentQuestion: state === "LOBBY" ? undefined : 0, answeredQuestions: [], answers: [] } });
    expect(input.participants.size).toBe(0);
  });

  it(`${state} returns the original submission outcome`, () => {
    const input = base(state);
    input.participants.set("S1", { studentId: "S1", sessionToken: "token", socketId: "socket", joinedAt: 0, connected: true });
    const result = apply(input, quiz, { type: "answerSubmit", studentId: "S1", payload: { questionIndex: 0, selectedOptions: ["A"] } }, 2000);
    const event = state === "QUESTION_OPEN" ? SocketEvents.ANSWER_ACCEPTED : SocketEvents.ANSWER_REJECTED;
    expect(result.messages[0].event).toBe(event);
    expect(result.messages[0].audience).toBe("participant:S1");
    expect(result.session.submissions).toHaveLength(state === "QUESTION_OPEN" ? 1 : 0);
    expect(input.submissions).toHaveLength(0);
  });
}

it("previous navigation returns to a revealed quiz and a slide opens without a timer", () => {
  const input = base("QUESTION_OPEN");
  input.currentQuestionIndex = 1;
  const previous = apply(input, quiz, { type: "previous" }, 1000);
  expect(previous.session.state).toBe("REVEAL");
  expect(previous.messages).toEqual(revealed(0));
  expect(previous.session.revealedQuestionIndexes?.has(0)).toBe(true);
  expect(input.revealedQuestionIndexes?.size).toBe(0);

  const slideQuiz: Quiz = { ...quiz, questions: [{ ...question(0), questionType: "slide" }, question(1)] };
  const slide = apply(base("LOBBY"), slideQuiz, { type: "start" }, 1000);
  expect(slide.nextDeadline).toBeNull();
  expect(slide.messages.map((item) => item.event)).toEqual([SocketEvents.QUESTION_OPEN, SocketEvents.SESSION_STATE]);
  expect(() => apply(slide.session, slideQuiz, { type: "close" }, 1000)).toThrow("Slides do not close");
  expect(apply(slide.session, slideQuiz, { type: "timeout" }, 21000).session.state).toBe("QUESTION_OPEN");
});

it("does not close before the deadline or after navigation", () => {
  const input = base("QUESTION_OPEN");
  expect(apply(input, quiz, { type: "timeout" }, 20000).messages).toEqual([]);
  const moved = apply({ ...input, state: "REVEAL" }, quiz, { type: "next" }, 1000);
  expect(apply(moved.session, quiz, { type: "timeout", deadline: 21000 }, 20000).messages).toEqual([]);
});

it("ignores a stale alarm whose deadline belongs to an earlier opening", () => {
  const reopened = { ...base("QUESTION_OPEN"), questionStartedAt: 5000 };
  const stale = apply(reopened, quiz, { type: "timeout", deadline: 21000 }, 21000);
  expect(stale.session.state).toBe("QUESTION_OPEN");
  expect(stale.messages).toEqual([]);
  expect(stale.nextDeadline).toBe(25000);
  expect(apply(reopened, quiz, { type: "timeout", deadline: 25000 }, 25000).session.state).toBe("QUESTION_CLOSED");
});

it("routes participant messages to their socket and keeps staff in the session room", () => {
  const session = base("QUESTION_OPEN");
  session.participants.set("S1", { studentId: "S1", sessionToken: "token", socketId: "socket-1", joinedAt: 0, connected: true });
  storeSession(session);
  const sent: { room: string; event: string; payload: unknown }[] = [];
  const io = { to: (room: string) => ({ emit: (event: string, payload: unknown) => sent.push({ room, event, payload }) }) };
  emitMessages(io as unknown as Server, session.sessionId, [
    { audience: "participant:S1", event: SocketEvents.ANSWER_ACCEPTED, payload: { questionIndex: 0 } },
    { audience: "staff", event: SocketEvents.ANSWER_COUNT, payload: count(0) },
    { audience: "all", event: SocketEvents.SESSION_STATE, payload: { state: "QUESTION_OPEN", questionIndex: 0 } },
  ]);
  expect(sent).toEqual([
    { room: "socket-1", event: SocketEvents.ANSWER_ACCEPTED, payload: { questionIndex: 0 } },
    { room: "session:session", event: SocketEvents.ANSWER_COUNT, payload: count(0) },
    { room: "session:session", event: SocketEvents.SESSION_STATE, payload: { state: "QUESTION_OPEN", questionIndex: 0 } },
  ]);
  clearAllSessions();
});
