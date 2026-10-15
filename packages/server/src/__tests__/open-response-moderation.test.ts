import { createLegacySession } from "./fixtures/legacy-session";
import { Quiz, Session, SocketEvents, AnswerCountPayload, ResultsRevealPayload, MAX_OPEN_RESPONSE_LENGTH } from "@mdq/shared";
import { apply, EngineCommandError, type Command, type EngineMessage } from "../engine";
import { serializeSession, deserializeSession, getOpenResponses, createSession } from "../session";
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
function openSession(defaultHidden?: boolean): { session: Session; keys: string[]; step: (command: Command, at?: number) => EngineMessage[] } {
  let session: Session = createLegacySession("moderation", "open");
  if (defaultHidden !== undefined) session.openResponsesHiddenByDefault = defaultHidden;
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
  it("keeps a session from before default-hidden on its reveal-only boundary: no text on the projector while open", () => {
    for (const flag of [undefined, false]) {
      const { step } = openSession(flag);
      const messages = step({ type: "snapshot", view: "display" });
      const count = to(messages, "display", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
      expect(count.submitted).toBe(3);
      expect(count.openResponseTotal).toBe(3);
      expect(count.openResponses).toBeUndefined();
      const more = step({ type: "answerSubmit", studentId: IDS[0], payload: { questionIndex: 1, responseText: "A second thought" } });
      expect(JSON.stringify(to(more, "display", SocketEvents.ANSWER_COUNT))).not.toContain("A second thought");
      // The presenter still sees every response.
      expect(JSON.stringify(to(more, "control", SocketEvents.ANSWER_COUNT))).toContain("A second thought");
    }
  });

  it("creates default-hidden sessions and round-trips the flag without adopting it on old sessions", () => {
    const fresh = createSession("smoke", "open");
    expect(fresh.openResponsesHiddenByDefault).toBe(true);
    expect(deserializeSession(serializeSession(fresh)).openResponsesHiddenByDefault).toBe(true);
    const { session } = openSession();
    const restored = deserializeSession(serializeSession(session));
    expect(restored.openResponsesHiddenByDefault).toBeUndefined();
    expect(getOpenResponses(restored, 1).every((r) => !r.hidden)).toBe(true);
  });

  it("starts hidden, shows and hides live in open and closed states, and retains the total at reveal", () => {
    const { step, keys } = openSession(true);
    const readCount = (messages: EngineMessage[]) => to(messages, "display", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
    const before = readCount(step({ type: "snapshot", view: "display" }));
    expect(before.openResponses).toEqual([]);
    expect(before.openResponseTotal).toBe(3);
    const consoleCount = to(step({ type: "snapshot", view: "control" }), "control", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
    expect(consoleCount.openResponsesHiddenByDefault).toBe(true);
    expect(consoleCount.openResponses!.every((r) => r.hidden)).toBe(true);
    for (const state of ["QUESTION_OPEN", "QUESTION_CLOSED"]) {
      if (state === "QUESTION_CLOSED") step({ type: "close" }, 6000);
      const shown = readCount(step(hide(1, keys[0], false), 6100));
      expect(shown.openResponseTotal).toBe(3);
      expect(texts(shown.openResponses)).toEqual([TEXTS[0]]);
      expect(Object.keys(shown.openResponses![0]).sort()).toEqual(["label", "publicKey", "responseText", "submittedAt"]);
      const hidden = readCount(step(hide(1, keys[0]), 6200));
      expect(hidden.openResponses).toEqual([]);
      expect(hidden.openResponseTotal).toBe(3);
    }
    step(hide(1, keys[2], false), 6300);
    const reveal = to(step({ type: "reveal" }, 6400), "display", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload;
    expect(reveal.openResponseTotal).toBe(3);
    expect(texts(reveal.openResponses)).toEqual([TEXTS[2]]);
    const allHidden = to(step(hide(1, keys[2]), 6500), "display", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload;
    expect(allHidden.openResponses).toEqual([]);
    expect(allHidden.openResponseTotal).toBe(3);
    const snapshot = to(step({ type: "snapshot", view: "display" }, 6600), "display", SocketEvents.RESULTS_REVEAL)[0].payload as ResultsRevealPayload;
    expect(snapshot).toEqual(allHidden);
  });

  it("keeps shown and hidden choices on edits and starts a new participant hidden", () => {
    const { step, keys } = openSession(true);
    step(hide(1, keys[0], false));
    const shownEdit = step({ type: "answerSubmit", studentId: IDS[0], payload: { questionIndex: 1, responseText: "Edited shown" } });
    const display = to(shownEdit, "display", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
    expect(texts(display.openResponses)).toEqual(["Edited shown"]);
    const hiddenEdit = step({ type: "answerSubmit", studentId: IDS[1], payload: { questionIndex: 1, responseText: "Edited hidden" } });
    expect(JSON.stringify(to(hiddenEdit, "display", SocketEvents.ANSWER_COUNT))).not.toContain("Edited hidden");
    step({ type: "join", socketId: "sock-new", newToken: "tok-new", payload: { studentId: "smoke-new" } });
    const submitted = step({ type: "answerSubmit", studentId: "smoke-new", payload: { questionIndex: 1, responseText: "New hidden" } });
    const after = to(submitted, "display", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
    expect(after.openResponseTotal).toBe(4);
    expect(texts(after.openResponses)).toEqual(["Edited shown"]);
    for (const messages of [shownEdit, hiddenEdit, submitted]) {
      expect(messages.filter((m) => ["all", "public", "participants"].includes(m.audience)).some((m) => JSON.stringify(m).includes("Edited"))).toBe(false);
    }
  });

  it("never sends shown responses to participants, on reveal or reconnect", () => {
    const { step } = openSession(true);
    const shown = step({ type: "responsesVisibility", role: "control", questionIndex: 1, hidden: false });
    expect(shown.every((m) => ["control", "display"].includes(m.audience))).toBe(true);
    step({ type: "close" }, 6000);
    const revealed = step({ type: "reveal" }, 6100);
    const phones = revealed.filter((m) => ["all", "public", "participants"].includes(m.audience));
    expect(phones.some((m) => m.event === SocketEvents.RESULTS_REVEAL)).toBe(true);
    const rejoined = step({ type: "snapshot", participantId: IDS[0], isReconnect: true }, 6200);
    for (const messages of [phones, rejoined]) for (const text of TEXTS) expect(JSON.stringify(messages)).not.toContain(text);
  });

  it.each([true, false])("bulk changes only current responses for default-hidden=%s and persists choices without mutating input", (defaultHidden) => {
    const { session, keys } = openSession(defaultHidden);
    const bulk = (hidden: boolean): Extract<Command, { type: "responsesVisibility" }> => ({ type: "responsesVisibility", role: "control", questionIndex: 1, hidden });
    const shown = apply(session, quiz, bulk(false), 5000);
    expect(getOpenResponses(shown.session, 1).every((r) => !r.hidden)).toBe(true);
    // While open, only a default-hidden session puts the shown text on the projector.
    expect(texts((to(shown.messages, "display", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload).openResponses)).toEqual(defaultHidden ? [...TEXTS].sort() : []);
    expect(session.shownResponses).toBeUndefined();
    expect(session.hiddenResponses).toBeUndefined();
    const saved = deserializeSession(serializeSession(shown.session));
    expect(saved.openResponsesHiddenByDefault).toBe(defaultHidden);
    if (defaultHidden) expect(saved.shownResponses?.[1].sort()).toEqual([...keys].sort());
    const hidden = apply(saved, quiz, bulk(true), 5100);
    expect(getOpenResponses(hidden.session, 1).every((r) => r.hidden)).toBe(true);
    const count = to(hidden.messages, "display", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
    // A default-hidden session sends an empty list; an older session sends no text while open at all.
    expect(count.openResponses).toEqual(defaultHidden ? [] : undefined);
    expect(count.openResponseTotal).toBe(3);
    expect(getOpenResponses(saved, 1).every((r) => !r.hidden)).toBe(true);
    for (const role of ["display", "participant"] as const) expect(() => apply(saved, quiz, { ...bulk(false), role }, 5200)).toThrow(EngineCommandError);
    expect(() => apply(saved, quiz, { ...bulk(false), questionIndex: 0 }, 5200)).toThrow(EngineCommandError);
    expect(() => apply({ ...saved, currentQuestionIndex: 0 }, quiz, bulk(false), 5200)).toThrow("current item");
    const rejoined = apply(saved, quiz, { type: "join", socketId: "new", newToken: "new", payload: { studentId: "smoke-new" } }, 5300).session;
    const added = apply(rejoined, quiz, { type: "answerSubmit", studentId: "smoke-new", payload: { questionIndex: 1, responseText: "New response" } }, 5400).session;
    expect(getOpenResponses(added, 1).find((r) => r.responseText === "New response")!.hidden).toBe(defaultHidden);
  });

  it("keeps shown text private while public results are hidden, including snapshots and bulk actions", () => {
    const { session, keys } = openSession(true);
    for (const boundary of [{ resultsDisclosed: false }, { policy: { schemaVersion: 1 as const, pacing: "self-paced" as const, ranking: "correctness" as const, effectiveTiming: "untimed" as const } }]) {
      const privateSession = { ...session, ...boundary };
      const shown = apply(privateSession, quiz, hide(1, keys[0], false), 5000);
      const bulk = apply(shown.session, quiz, { type: "responsesVisibility", role: "control", questionIndex: 1, hidden: false }, 5100);
      const snap = apply(bulk.session, quiz, { type: "snapshot", view: "display" }, 5200);
      const revealed = apply({ ...bulk.session, state: "REVEAL", revealedQuestionIndexes: new Set([1]), releasedQuestionIndexes: new Set([1]) }, quiz, { type: "snapshot", view: "display" }, 5400);
      for (const result of [shown, bulk, snap, revealed]) {
        const publicMessages = result.messages.filter((m) => m.audience !== "control");
        for (const text of TEXTS) expect(JSON.stringify(publicMessages)).not.toContain(text);
      }
      const participant = apply(bulk.session, quiz, { type: "snapshot", participantId: IDS[0], isReconnect: true }, 5500);
      for (const text of TEXTS.slice(1)) expect(JSON.stringify(participant.messages)).not.toContain(text);
    }
  });

  it("shows the instructor every response live, each with a hidden flag; a pre-change session's projector gets no text while open", () => {
    const { step, keys } = openSession();
    const before = to(step({ type: "snapshot", view: "control" }), "control", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
    expect(texts(before.openResponses)).toEqual([...TEXTS].sort());
    expect(before.openResponses!.every((r) => r.hidden === false && r.studentId)).toBe(true);
    const messages = step(hide(1, keys[1]));
    const after = to(messages, "control", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
    expect(texts(after.openResponses)).toEqual([...TEXTS].sort());
    expect(after.openResponses!.filter((r) => r.hidden).map((r) => r.publicKey)).toEqual([keys[1]]);
    const display = to(messages, "display", SocketEvents.ANSWER_COUNT)[0].payload as AnswerCountPayload;
    expect(display.openResponseTotal).toBe(3);
    expect(display.openResponses).toBeUndefined();
    expect(messages.filter((m) => !["control", "display"].includes(m.audience))).toEqual([]);
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

  it("counts characters, not bytes or UTF-16 units, so an emoji counts as one", () => {
    const { step } = openSession();
    const accepted = step({ type: "answerSubmit", studentId: IDS[0], payload: { questionIndex: 1, responseText: "é字".repeat(MAX_OPEN_RESPONSE_LENGTH / 2) } });
    expect(accepted.some((m) => m.event === SocketEvents.ANSWER_ACCEPTED)).toBe(true);
    const rejected = step({ type: "answerSubmit", studentId: IDS[1], payload: { questionIndex: 1, responseText: "字".repeat(MAX_OPEN_RESPONSE_LENGTH + 1) } });
    expect(rejected.some((m) => m.event === SocketEvents.ANSWER_REJECTED)).toBe(true);
    expect(rejected.some((m) => m.event === SocketEvents.ANSWER_ACCEPTED)).toBe(false);
  });

  it("accepts a full response of emoji and rejects one more", () => {
    const { step } = openSession();
    const emoji = "\u{1F600}";
    expect(emoji.length).toBe(2);
    const accepted = step({ type: "answerSubmit", studentId: IDS[0], payload: { questionIndex: 1, responseText: emoji.repeat(MAX_OPEN_RESPONSE_LENGTH) } });
    expect(accepted.some((m) => m.event === SocketEvents.ANSWER_ACCEPTED)).toBe(true);
    const rejected = step({ type: "answerSubmit", studentId: IDS[1], payload: { questionIndex: 1, responseText: emoji.repeat(MAX_OPEN_RESPONSE_LENGTH + 1) } });
    expect(rejected.some((m) => m.event === SocketEvents.ANSWER_REJECTED)).toBe(true);
    expect(rejected.some((m) => m.event === SocketEvents.ANSWER_ACCEPTED)).toBe(false);
  });

  it("lists responses from the same millisecond in the same order whatever the submit order", () => {
    const orderFor = (submitOrder: number[]): string[] => {
      let session: Session = createLegacySession("tiebreak", "open");
      const step = (command: Command, at: number) => { session = apply(session, quiz, command, at).session; };
      IDS.forEach((id, i) => step({ type: "join", socketId: `sock-${i}`, newToken: `tok-${i}`, newPublicKey: `key-${i}`, payload: { studentId: id } }, 100 + i));
      step({ type: "start" }, 1000);
      step({ type: "close" }, 1500);
      step({ type: "reveal" }, 1600);
      step({ type: "next" }, 2000);
      submitOrder.forEach((i) => step({ type: "answerSubmit", studentId: IDS[i], payload: { questionIndex: 1, responseText: TEXTS[i] } }, 2100));
      return getOpenResponses(session, 1).map((r) => r.publicKey);
    };
    expect(orderFor([0, 1, 2])).toEqual(["key-0", "key-1", "key-2"]);
    expect(orderFor([2, 0, 1])).toEqual(["key-0", "key-1", "key-2"]);
    expect(orderFor([1, 2, 0])).toEqual(["key-0", "key-1", "key-2"]);
  });
});
