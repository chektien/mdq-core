import { Session, SocketEvents } from "@mdq/shared";
import { containsBlockedLanguage, createBlockedTextMatcher, BLOCKED_LANGUAGE_MESSAGE } from "../text-filter";
import { apply, type Command } from "../engine";
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
  const answer = (responseText: string): Command => ({ type: "answerSubmit", studentId: "TEST", payload: { questionIndex: 0, responseText, selectedOptions: [] } });
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
