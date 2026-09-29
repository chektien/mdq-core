import { Quiz, Session, SocketEvents, AnswerCountPayload, ResultsRevealPayload, MAX_OPEN_RESPONSE_LENGTH } from "@mdq/shared";
import { apply, EngineCommandError, type Command, type EngineMessage } from "../engine";
import { createSession, serializeSession, deserializeSession } from "../session";
import { parseQuizMarkdown } from "../parser";

const DECK = `# Moderation check

---

## Pick one

time-limit: 20

Which one?

A. One
B. Two

> Correct Answer: A
> Overall Feedback: One.

---

## Say something

question-type: open-response
time-limit: 20

Share a thought.

> Overall Feedback: Thanks.
`;
const quiz: Quiz = parseQuizMarkdown(DECK, "moderation.md").quiz!;
const IDS = ["ZQ-1001", "ZQ-2002", "ZQ-3003"];
const TEXTS = ["Kind words from Alex", "Rude words from Sam", "Plain words from Robin"];

/** A session with three participants who each answered the open question (index 1), left open. */
function openSession(): { session: Session; keys: string[]; step: (command: Command, at?: number) => EngineMessage[] } {
  let session: Session = createSession("moderation", "open");
  const step = (command: Command, at = 5000) => {
    const result = apply(session, quiz, command, at);
    session = result.session;
    return result.messages;
  };
  IDS.forEach((id, i) => step({ type: "join", socketId: `sock-${i}`, newToken: `tok-${i}`, payload: { studentId: id, displayName: ["Alex Tan", "Sam Lee", undefined][i] } }, 100 + i));
  step({ type: "start" }, 1000);
  step({ type: "close" }, 1500);
  step({ type: "reveal" }, 1600);
  step({ type: "next" }, 2000);
  IDS.forEach((id, i) => step({ type: "answerSubmit", studentId: id, payload: { questionIndex: 1, responseText: TEXTS[i] } }, 2100 + i));
  const keys = IDS.map((id) => session.participants.get(id)!.publicKey);
  return { session, keys, step };
}
const hide = (questionIndex: number, publicKey: string, hidden = true, role: "control" | "display" | "participant" = "control"): Command =>
  ({ type: "responseVisibility", role, questionIndex, publicKey, hidden });
const to = (messages: EngineMessage[], audience: string, event: string) => messages.filter((m) => m.audience === audience && m.event === event);
const texts = (entries?: { responseText: string }[]) => (entries ?? []).map((e) => e.responseText).sort();

describe("open response moderation", () => {
  it("gives the projector the count only while the question is open", () => {
    const { step } = openSession();
    const messages = step({ type: "snapshot", view: "display" });
    const count = to(messages, "display", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
    expect(count.submitted).toBe(3);
    expect(count.openResponses).toBeUndefined();
    for (const text of TEXTS) expect(JSON.stringify(messages)).not.toContain(text);
    // A new answer reaches the projector as a count too.
    const more = step({ type: "answerSubmit", studentId: IDS[0], payload: { questionIndex: 1, responseText: "A second thought" } });
    expect(JSON.stringify(more.filter((m) => m.audience !== "control"))).not.toContain("A second thought");
    expect(JSON.stringify(more.filter((m) => m.audience === "control"))).toContain("A second thought");
  });

  it("shows the instructor every response live, each with a hidden flag", () => {
    const { step, keys } = openSession();
    const before = to(step({ type: "snapshot", view: "control" }), "control", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
    expect(texts(before.openResponses)).toEqual([...TEXTS].sort());
    expect(before.openResponses!.every((r) => r.hidden === false && r.studentId)).toBe(true);
    const messages = step(hide(1, keys[1]));
    const after = to(messages, "control", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
    expect(texts(after.openResponses)).toEqual([...TEXTS].sort());
    expect(after.openResponses!.filter((r) => r.hidden).map((r) => r.publicKey)).toEqual([keys[1]]);
    // Nothing goes to the projector or phones while the question is open.
    expect(messages.filter((m) => m.audience !== "control")).toEqual([]);
  });

  it("leaves a response hidden before the reveal out of the projector's reveal", () => {
    const { step, keys } = openSession();
    step(hide(1, keys[1]));
    step({ type: "close" }, 3000);
    const messages = step({ type: "reveal" }, 3100);
    const display = to(messages, "display", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload;
    expect(texts(display.openResponses)).toEqual([TEXTS[0], TEXTS[2]].sort());
    expect(JSON.stringify(display)).not.toContain(TEXTS[1]);
    for (const entry of display.openResponses!) expect(Object.keys(entry).sort()).toEqual(["label", "publicKey", "responseText", "submittedAt"]);
    const control = to(messages, "control", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload;
    expect(control.openResponses!.find((r) => r.publicKey === keys[1])?.hidden).toBe(true);
    expect(control.openResponses).toHaveLength(3);
  });

  it("takes a response off the projector at once when hidden after the reveal, and puts it back on show", () => {
    const { step, keys } = openSession();
    step({ type: "close" }, 3000);
    step({ type: "reveal" }, 3100);
    const hidden = step(hide(1, keys[0]));
    const display = to(hidden, "display", SocketEvents.RESULTS_REVEAL);
    expect(display).toHaveLength(1);
    expect(texts((display[0].payload as ResultsRevealPayload).openResponses)).toEqual([TEXTS[1], TEXTS[2]].sort());
    expect(JSON.stringify(display)).not.toContain(TEXTS[0]);
    const control = to(hidden, "control", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload;
    expect(control.openResponses!.find((r) => r.publicKey === keys[0])?.hidden).toBe(true);
    // Phones are told nothing.
    expect(hidden.filter((m) => m.audience === "participants" || m.audience === "public" || m.audience === "all" || m.audience.startsWith("participant:"))).toEqual([]);

    const shown = step(hide(1, keys[0], false));
    expect(texts((to(shown, "display", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload).openResponses)).toEqual([...TEXTS].sort());
    const controlShown = to(shown, "control", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload;
    expect(controlShown.openResponses!.every((r) => r.hidden === false)).toBe(true);
  });

  it("keeps hiding when the same response is hidden twice, and drops the record when shown again", () => {
    const { session, step, keys } = openSession();
    step(hide(1, keys[0]));
    const twice = step(hide(1, keys[0]));
    expect(twice.length).toBeGreaterThan(0);
    const saved = deserializeSession(serializeSession(apply(session, quiz, hide(1, keys[0]), 6000).session));
    expect(saved.hiddenResponses).toEqual({ 1: [keys[0]] });
    const cleared = apply(saved, quiz, hide(1, keys[0], false), 6100).session;
    expect(cleared.hiddenResponses).toBeUndefined();
  });

  it("gives phones nobody else's response, at the reveal or on rejoin", () => {
    const { step } = openSession();
    step({ type: "close" }, 3000);
    const messages = step({ type: "reveal" }, 3100);
    const forPhones = messages.filter((m) => m.audience === "participants" || m.audience === "public" || m.audience === "all");
    expect(to(forPhones, "participants", SocketEvents.RESULTS_REVEAL)).toHaveLength(1);
    for (const text of TEXTS) expect(JSON.stringify(forPhones)).not.toContain(text);
    const rejoin = step({ type: "snapshot", participantId: IDS[0], isReconnect: true });
    expect(rejoin.some((m) => m.event === SocketEvents.RESULTS_REVEAL)).toBe(true);
    for (const text of TEXTS) expect(JSON.stringify(rejoin)).not.toContain(text);
    // The projector's snapshot after the reveal has the visible responses, by label.
    const snap = step({ type: "snapshot", view: "display" });
    expect(texts((to(snap, "display", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload).openResponses)).toEqual([...TEXTS].sort());
    for (const id of IDS) expect(JSON.stringify(snap)).not.toContain(id);
  });

  it("gives a snapshot after the reveal only the visible responses to the projector and every response to the instructor", () => {
    const { step, keys } = openSession();
    step({ type: "close" }, 3000);
    step({ type: "reveal" }, 3100);
    step(hide(1, keys[2]));
    const display = to(step({ type: "snapshot", view: "display" }), "display", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload;
    expect(texts(display.openResponses)).toEqual([TEXTS[0], TEXTS[1]].sort());
    const control = to(step({ type: "snapshot", view: "control" }), "control", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload;
    expect(control.openResponses).toHaveLength(3);
    expect(control.openResponses!.filter((r) => r.hidden).map((r) => r.publicKey)).toEqual([keys[2]]);
  });

  it("refuses the command from the projector or a phone", () => {
    const { session, keys } = openSession();
    for (const role of ["display", "participant"] as const) {
      expect(() => apply(session, quiz, hide(1, keys[0], true, role), 6000)).toThrow(EngineCommandError);
    }
    expect(session.hiddenResponses).toBeUndefined();
  });

  it("refuses an unknown question, a question with no open responses, and an unknown response", () => {
    const { session, keys } = openSession();
    expect(() => apply(session, quiz, hide(7, keys[0]), 6000)).toThrow("no open responses");
    expect(() => apply(session, quiz, hide(-1, keys[0]), 6000)).toThrow(EngineCommandError);
    expect(() => apply(session, quiz, hide(0, keys[0]), 6000)).toThrow("no open responses");
    expect(() => apply(session, quiz, hide(1, "not-a-key"), 6000)).toThrow("not found");
    expect(() => apply(session, quiz, hide(1, IDS[0]), 6000)).toThrow("not found");
  });

  it("does not change the input session and keeps hidden state through a save and restore", () => {
    const { session, keys } = openSession();
    const result = apply(session, quiz, hide(1, keys[1]), 6000);
    expect(session.hiddenResponses).toBeUndefined();
    const restored = deserializeSession(serializeSession(result.session));
    expect(restored.hiddenResponses).toEqual({ 1: [keys[1]] });
    // After a restart the projector still does not get the hidden response.
    const closed = apply(restored, quiz, { type: "close" }, 7000).session;
    const messages = apply(closed, quiz, { type: "reveal" }, 7100).messages;
    expect(JSON.stringify(to(messages, "display", SocketEvents.RESULTS_REVEAL))).not.toContain(TEXTS[1]);
    expect(JSON.stringify(to(messages, "display", SocketEvents.RESULTS_REVEAL))).toContain(TEXTS[0]);
  });

  it("keeps a response hidden if its author edits it", () => {
    const { step, keys } = openSession();
    step(hide(1, keys[1]));
    step({ type: "answerSubmit", studentId: IDS[1], payload: { questionIndex: 1, responseText: "Edited words" } });
    step({ type: "close" }, 3000);
    const display = to(step({ type: "reveal" }, 3100), "display", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload;
    expect(JSON.stringify(display)).not.toContain("Edited words");
  });

  it("caps a response at 1000 characters with a short message", () => {
    const { step, session } = openSession();
    const long = "x".repeat(MAX_OPEN_RESPONSE_LENGTH + 1);
    const rejected = step({ type: "answerSubmit", studentId: IDS[0], payload: { questionIndex: 1, responseText: long } });
    const reason = (rejected.find((m) => m.event === SocketEvents.ANSWER_REJECTED)!.payload as { reason: string }).reason;
    expect(reason).toBe("Please use up to 1000 characters.");
    expect(rejected.some((m) => m.event === SocketEvents.ANSWER_ACCEPTED)).toBe(false);
    expect(session.submissions.find((s) => s.studentId === IDS[0])?.responseText).toBe(TEXTS[0]);
    const exact = "y".repeat(MAX_OPEN_RESPONSE_LENGTH);
    const accepted = step({ type: "answerSubmit", studentId: IDS[0], payload: { questionIndex: 1, responseText: `  ${exact}  ` } });
    expect(accepted.some((m) => m.event === SocketEvents.ANSWER_ACCEPTED)).toBe(true);
  });

  it("counts characters, not bytes, so multibyte text has the same cap", () => {
    const { step } = openSession();
    const accepted = step({ type: "answerSubmit", studentId: IDS[0], payload: { questionIndex: 1, responseText: "é字".repeat(MAX_OPEN_RESPONSE_LENGTH / 2) } });
    expect(accepted.some((m) => m.event === SocketEvents.ANSWER_ACCEPTED)).toBe(true);
    const rejected = step({ type: "answerSubmit", studentId: IDS[1], payload: { questionIndex: 1, responseText: "字".repeat(MAX_OPEN_RESPONSE_LENGTH + 1) } });
    expect(rejected.some((m) => m.event === SocketEvents.ANSWER_REJECTED)).toBe(true);
    expect(rejected.some((m) => m.event === SocketEvents.ANSWER_ACCEPTED)).toBe(false);
  });
});
