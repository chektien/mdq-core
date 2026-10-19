import { type AnswerSubmitPayload, MAX_OPEN_RESPONSE_LENGTH, Session, SocketEvents } from "@mdq/shared";
import { containsBlockedLanguage, createBlockedTextMatcher, BLOCKED_LANGUAGE_MESSAGE } from "../text-filter";
import { apply, type Command, type EngineOptions } from "../engine";
import { createSession, serializeSession } from "../session";
import { parseQuizMarkdown } from "../parser";

it.each(["fuck", "FUCK", "f-u-c-k", "f.u.c.k", "f u c k", "  f  u  c  k  ", "ｆｕｃｋ", "f\u200bu\u200bc\u200bk", "That is shit!", "cheebye"])("normalizes blocked text %j", text => {
  expect(containsBlockedLanguage(text)).toBe(true);
});

it.each(["class assessment", "Scunthorpe", "Dickson", "Shitij", "A shell command", "butterfly", "••••", "hello@example.com", "This is a clean response."])("accepts benign text %j", text => {
  expect(containsBlockedLanguage(text)).toBe(false);
});

it("supports a reusable configurable matcher without substring false positives", () => {
  const check = createBlockedTextMatcher(["badword"]);
  expect(check("BAD-WORD")).toBe(true);
  expect(check("bad word")).toBe(true);
  expect(check("notbadword")).toBe(false);
  expect(createBlockedTextMatcher([])("anything")).toBe(false);
});

const quiz = parseQuizMarkdown(`# Filter fixture
---
## Share
question-type: open-response
time-limit: 30
Share a thought.

> Overall Feedback: Thanks.
`, "synthetic").quiz!;

it("rejects before storage or any staff emission, preserves an accepted answer, and permits revision", () => {
  let session: Session = createSession("synthetic", "open");
  const step = (command: Command) => { const result = apply(session, quiz, command, 1000); session = result.session; return result; };
  step({ type: "start" });
  step({ type: "join", payload: { studentId: "TEST" }, socketId: "socket", newToken: "token" });
  const answer = (responseText: string): Command => ({ type: "answerSubmit", studentId: "TEST", sessionToken: "token", payload: { questionIndex: 0, responseText, selectedOptions: [] } });
  const refused = step(answer("f-u-c-k"));
  expect(session.submissions).toEqual([]);
  expect(refused.messages).toEqual([{ audience: "participant:TEST", event: SocketEvents.ANSWER_REJECTED, payload: { questionIndex: 0, reason: BLOCKED_LANGUAGE_MESSAGE } }]);
  expect(serializeSession(session)).not.toContain("f-u-c-k");
  expect(step(answer("A clean thought.")).messages[0].event).toBe(SocketEvents.ANSWER_ACCEPTED);
  step(answer("SHIT"));
  expect(session.submissions.map(item => item.responseText)).toEqual(["A clean thought."]);
  expect(step(answer("A revised thought.")).messages[0].event).toBe(SocketEvents.ANSWER_ACCEPTED);
  expect(session.submissions.map(item => item.responseText)).toEqual(["A revised thought."]);
  // A host can apply its own masking policy first, as Cloud's children mode does.
  expect(step(answer("My thought: ••••")).messages[0].event).toBe(SocketEvents.ANSWER_ACCEPTED);
});

describe("host open-response filter options", () => {
  function runner() {
    let session: Session = createSession("synthetic", "open");
    const step = (command: Command, options?: EngineOptions) => {
      const result = apply(session, quiz, command, 1000, options);
      session = result.session;
      return result;
    };
    step({ type: "start" });
    step({ type: "join", payload: { studentId: "TEST" }, socketId: "socket", newToken: "token" });
    return {
      get session() { return session; },
      step,
      answer(payload: Omit<AnswerSubmitPayload, "questionIndex">, options?: EngineOptions) {
        return step({ type: "answerSubmit", studentId: "TEST", sessionToken: "token", payload: { questionIndex: 0, ...payload } }, options);
      },
    };
  }

  it.each([{}, { openResponseFilter: undefined }])("keeps the default for options %j", options => {
    const run = runner();
    const result = run.answer({ responseText: "f-u-c-k" }, options);
    expect(result.messages).toEqual([{ audience: "participant:TEST", event: SocketEvents.ANSWER_REJECTED,
      payload: { questionIndex: 0, reason: BLOCKED_LANGUAGE_MESSAGE } }]);
    expect(result.session.submissions).toEqual([]);
    expect(serializeSession(result.session)).not.toContain("f-u-c-k");
  });

  it("accepts and stores the exact text with filtering off, without changing the next call's default", () => {
    const run = runner();
    const input = run.session;
    const responseText = "F-u-c-k — ｓｈｉｔ\nStill my words.";
    expect(containsBlockedLanguage(responseText)).toBe(true);
    const accepted = run.answer({ responseText }, { openResponseFilter: false });
    expect(accepted.messages[0].event).toBe(SocketEvents.ANSWER_ACCEPTED);
    expect(accepted.session.submissions).toHaveLength(1);
    expect(accepted.session.submissions[0].responseText).toBe(responseText);
    expect(input.submissions).toEqual([]);
    expect(run.answer({ responseText: "SHIT" }).messages[0]).toMatchObject({
      event: SocketEvents.ANSWER_REJECTED, payload: { reason: BLOCKED_LANGUAGE_MESSAGE },
    });
    expect(run.session.submissions[0].responseText).toBe(responseText);
  });

  it("uses the custom matcher instead of the default", () => {
    const run = runner();
    const openResponseFilter = jest.fn(createBlockedTextMatcher(["badword"]));
    const options: EngineOptions = { openResponseFilter };
    const refused = run.answer({ responseText: "  B-A-D-WORD  " }, options);
    expect(openResponseFilter).toHaveBeenCalledWith("B-A-D-WORD");
    expect(refused.messages).toEqual([{ audience: "participant:TEST", event: SocketEvents.ANSWER_REJECTED,
      payload: { questionIndex: 0, reason: BLOCKED_LANGUAGE_MESSAGE } }]);
    expect(refused.session.submissions).toEqual([]);
    expect(serializeSession(refused.session)).not.toContain("B-A-D-WORD");
    expect(run.answer({ responseText: "fuck" }, options).messages[0].event).toBe(SocketEvents.ANSWER_ACCEPTED);
    expect(openResponseFilter).toHaveBeenLastCalledWith("fuck");
    expect(run.session.submissions[0].responseText).toBe("fuck");
  });

  it.each<{ name: string; payload: Omit<AnswerSubmitPayload, "questionIndex">; revealed?: boolean; reason: string }>([
    { name: "empty", payload: { responseText: "" }, reason: "Response text cannot be blank." },
    { name: "whitespace", payload: { responseText: " \n\t " }, reason: "Response text cannot be blank." },
    { name: "too long", payload: { responseText: "x".repeat(MAX_OPEN_RESPONSE_LENGTH + 1) }, reason: `Please use up to ${MAX_OPEN_RESPONSE_LENGTH} characters.` },
    { name: "revealed question", payload: { responseText: "fuck" }, revealed: true, reason: "Revealed questions do not accept answers." },
    { name: "selected options", payload: { responseText: "fuck", selectedOptions: ["A"] }, reason: "Open response questions accept text responses only." },
  ])("still refuses $name with filtering off", ({ payload, revealed, reason }) => {
    const run = runner();
    if (revealed) { run.step({ type: "close" }); run.step({ type: "reveal" }); }
    const before = serializeSession(run.session);
    const result = run.answer(payload, { openResponseFilter: false });
    expect(result.messages).toEqual([{ audience: "participant:TEST", event: SocketEvents.ANSWER_REJECTED,
      payload: { questionIndex: 0, reason } }]);
    expect(result.session.submissions).toEqual([]);
    expect(serializeSession(result.session)).toBe(before);
  });
});
