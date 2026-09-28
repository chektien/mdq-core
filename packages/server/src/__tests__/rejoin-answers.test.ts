import { Quiz, Session, SocketEvents, StudentAnswer, StudentJoinedPayload } from "@mdq/shared";
import { apply } from "../engine";
import {
  NO_ANSWER, mergeOwnAnswers, seedSubmittedAnswer, toOptionIndexes, toOptionLabels,
} from "../../../client/src/ownAnswers";

const options = [
  { label: "A", textMd: "One", textHtml: "One" },
  { label: "B", textMd: "Two", textHtml: "Two" },
  { label: "C", textMd: "Three", textHtml: "Three" },
];
const quiz: Quiz = {
  week: "sample", title: "Sample", sourceFile: "sample.md",
  questions: [
    { index: 0, topic: "Choice", textMd: "Q", textHtml: "<p>Q</p>", options, correctOptions: ["B"],
      allowsMultiple: false, explanation: "", timeLimitSec: 20 },
    { index: 1, topic: "Poll", textMd: "Q", textHtml: "<p>Q</p>", options, correctOptions: [],
      allowsMultiple: true, isPoll: true, questionType: "poll", explanation: "", timeLimitSec: 20 },
    { index: 2, topic: "Open", textMd: "Q", textHtml: "<p>Q</p>", options: [], correctOptions: [],
      allowsMultiple: false, questionType: "open_response", explanation: "", timeLimitSec: 20 },
  ],
};

const lobby = (): Session => ({
  sessionId: "session", sessionCode: "SAMPLE1", week: "sample", mode: "open", state: "LOBBY",
  currentQuestionIndex: -1, revealedQuestionIndexes: new Set<number>(), participants: new Map(), submissions: [], createdAt: 0,
});

/** Two students answer all three items, then the session reveals the open response. */
function playedSession(): { session: Session; tokens: Record<string, string> } {
  let session = lobby();
  const tokens: Record<string, string> = {};
  const step = (command: Parameters<typeof apply>[2]) => { session = apply(session, quiz, command, 1000).session; };
  for (const id of ["S1", "S2"]) {
    tokens[id] = `token-${id}`;
    step({ type: "join", socketId: `socket-${id}`, newToken: tokens[id], payload: { studentId: id } });
  }
  step({ type: "start" });
  step({ type: "answerSubmit", studentId: "S1", payload: { questionIndex: 0, selectedOptions: ["C"] } });
  step({ type: "answerSubmit", studentId: "S2", payload: { questionIndex: 0, selectedOptions: ["B"] } });
  step({ type: "close" }); step({ type: "reveal" }); step({ type: "next" });
  step({ type: "answerSubmit", studentId: "S1", payload: { questionIndex: 1, selectedOptions: ["C", "A"] } });
  step({ type: "answerSubmit", studentId: "S2", payload: { questionIndex: 1, selectedOptions: ["B"] } });
  step({ type: "close" }); step({ type: "reveal" }); step({ type: "next" });
  step({ type: "answerSubmit", studentId: "S1", payload: { questionIndex: 2, responseText: "  mine  " } });
  step({ type: "answerSubmit", studentId: "S2", payload: { questionIndex: 2, responseText: "theirs" } });
  step({ type: "close" }); step({ type: "reveal" });
  // Both phones drop off, as when a tab is reloaded.
  for (const id of ["S1", "S2"]) step({ type: "disconnect", studentId: id, socketId: `socket-${id}` });
  return { session, tokens };
}

const joinedPayload = (messages: ReturnType<typeof apply>["messages"]) =>
  messages.find((m) => m.event === SocketEvents.STUDENT_JOINED)?.payload as StudentJoinedPayload | undefined;

describe("rejoining student receives only its own answers", () => {
  it("returns the joining student's own submissions as option positions", () => {
    const { session, tokens } = playedSession();
    const result = apply(session, quiz, { type: "join", socketId: "socket-new", newToken: "unused", payload: { studentId: "S1", sessionToken: tokens.S1 } }, 5000);
    const joined = result.messages.find((m) => m.event === SocketEvents.STUDENT_JOINED);
    expect(joined?.audience).toBe("participant:S1");
    expect(joinedPayload(result.messages)?.answeredQuestions).toEqual([0, 1, 2]);
    expect(joinedPayload(result.messages)?.answers).toEqual([
      { questionIndex: 0, selectedOptions: [2] },
      { questionIndex: 1, selectedOptions: [0, 2] },
      { questionIndex: 2, selectedOptions: [], responseText: "mine" },
    ]);
  });

  it("never carries another student's answers to the joining student", () => {
    const { session, tokens } = playedSession();
    const result = apply(session, quiz, { type: "join", socketId: "socket-new", newToken: "unused", payload: { studentId: "S2", sessionToken: tokens.S2 } }, 5000);
    expect(joinedPayload(result.messages)?.answers).toEqual([
      { questionIndex: 0, selectedOptions: [1] },
      { questionIndex: 1, selectedOptions: [1] },
      { questionIndex: 2, selectedOptions: [], responseText: "theirs" },
    ]);
    expect(JSON.stringify(joinedPayload(result.messages))).not.toContain("mine");
    // Only the joining student's own STUDENT_JOINED message carries answers.
    for (const m of result.messages) {
      if (m.event !== SocketEvents.STUDENT_JOINED) expect(m.payload).not.toHaveProperty("answers");
    }
  });

  it("gives a new student an empty list and a rejected join nothing", () => {
    const { session } = playedSession();
    const fresh = apply(session, quiz, { type: "join", socketId: "socket-3", newToken: "token-S3", payload: { studentId: "S3" } }, 5000);
    expect(joinedPayload(fresh.messages)?.answers).toEqual([]);
    const impostor = apply(session, quiz, { type: "join", socketId: "socket-x", newToken: "token-x", payload: { studentId: "S1", sessionToken: "wrong" } }, 5000);
    expect(impostor.messages).toEqual([expect.objectContaining({ event: SocketEvents.STUDENT_REJECTED, audience: "participant:socket-x" })]);
  });
});

describe("client seeding of the student's own answer", () => {
  const labels = options.map(({ label }) => ({ label }));
  const known = mergeOwnAnswers(new Map(), [
    { questionIndex: 0, selectedOptions: [2] },
    { questionIndex: 1, selectedOptions: [0, 2] },
    { questionIndex: 2, selectedOptions: [], responseText: "mine" },
  ]);
  const seed = (overrides: Partial<Parameters<typeof seedSubmittedAnswer>[0]>) => seedSubmittedAnswer({
    questionIndex: 0, options: labels, alreadyAnswered: true, isSameQuestion: false, current: NO_ANSWER, known, ...overrides,
  });

  it("converts between option labels and positions", () => {
    expect(toOptionIndexes(["C", "A", "Z"], labels)).toEqual([2, 0]);
    expect(toOptionLabels([2, 0, 7, -1], labels)).toEqual(["C", "A"]);
  });

  it("restores a known answer after a reload", () => {
    expect(seed({})).toEqual({ selectedOptions: ["C"], responseText: null });
    expect(seed({ questionIndex: 1 })).toEqual({ selectedOptions: ["A", "C"], responseText: null });
    expect(seed({ questionIndex: 2, options: [] })).toEqual({ selectedOptions: [], responseText: "mine" });
  });

  it("keeps the answer already on the page for the same question", () => {
    const current = { selectedOptions: ["B"], responseText: null };
    expect(seed({ isSameQuestion: true, current })).toBe(current);
  });

  it("shows nothing for an unanswered or unknown question", () => {
    expect(seed({ alreadyAnswered: false })).toEqual(NO_ANSWER);
    expect(seed({ questionIndex: 5 })).toEqual(NO_ANSWER);
  });

  it("lets later answers replace earlier ones and ignores malformed entries", () => {
    const merged = mergeOwnAnswers(known, [
      { questionIndex: 2, selectedOptions: [], responseText: "edited" },
      { questionIndex: "x", selectedOptions: [] } as unknown as StudentAnswer,
    ]);
    expect(merged.get(2)?.responseText).toBe("edited");
    expect(merged.size).toBe(3);
    expect(known.get(2)?.responseText).toBe("mine");
  });
});
