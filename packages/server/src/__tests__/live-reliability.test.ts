import request from "supertest";
import { Session, SocketEvents } from "@mdq/shared";
import { createApp } from "../app";
import { apply, type Command } from "../engine";
import { clearAllSessions, createSession, getSession, serializeSession, deserializeSession } from "../session";
import { parseQuizMarkdown } from "../parser";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

const quiz = parseQuizMarkdown(`# Reliability fixture
---
## One
time-limit: 20
Pick one.
A. Yes
B. No
> Correct Answer: A
---
## Two
time-limit: 20
Pick one.
A. Yes
B. No
> Correct Answer: A
`, "synthetic").quiz!;

function runner() {
  let session: Session = { ...createSession("synthetic", "open"), createdAt: 0 };
  return {
    get session() { return session; },
    step(command: Command, now = 1000) {
      const result = apply(session, quiz, command, now);
      session = result.session;
      return result;
    },
  };
}

describe("close retries preserve the original question outcome", () => {
  it.each([false, true])("keeps a manual/timer close idempotent, timedOut=%s", timedOut => {
    const run = runner(); run.step({ type: "start" });
    const first = run.step(timedOut ? { type: "timeout", deadline: 21000 } : { type: "close" }, 21000);
    const before = serializeSession(first.session);
    const repeat = run.step({ type: "close", questionIndex: 0, startedAt: 1000 }, 21001);
    expect(serializeSession(repeat.session)).toBe(before);
    expect(repeat.messages).toEqual([]);
    expect(repeat.session.closedByTimer).toBe(timedOut);
    expect(run.step({ type: "timeout", deadline: 21000 }, 21002).messages).toEqual([]);
    run.step({ type: "reveal" }, 21003);
    expect(run.step({ type: "close", questionIndex: 0, startedAt: 1000 }, 21004).session.state).toBe("REVEAL");
  });

  it("refuses a delayed close for a different item or another opening", () => {
    const run = runner(); run.step({ type: "start" }); run.step({ type: "close" }); run.step({ type: "reveal" });
    run.step({ type: "next" }, 3000);
    const before = serializeSession(run.session);
    expect(() => run.step({ type: "close", questionIndex: 0, startedAt: 1000 })).toThrow("question has changed");
    expect(serializeSession(run.session)).toBe(before);
    expect(() => apply({ ...run.session, currentQuestionIndex: 0, questionStartedAt: 4000 }, quiz,
      { type: "close", questionIndex: 0, startedAt: 1000 }, 4100)).toThrow("question has changed");
  });
});

it("keeps answers and scores across disconnect, persistence and reconnect", () => {
  const run = runner(); run.step({ type: "start" });
  run.step({ type: "join", payload: { studentId: "TEST1" }, socketId: "first", newToken: "token" });
  run.step({ type: "answerSubmit", studentId: "TEST1", sessionToken: "token", payload: { questionIndex: 0, selectedOptions: ["A"] } }, 2000);
  const disconnected = run.step({ type: "disconnect", studentId: "TEST1", socketId: "first" }, 3000);
  const counter = disconnected.messages.find(message => message.event === SocketEvents.ANSWER_COUNT)?.payload;
  expect(counter).toMatchObject({ submitted: 1 });
  expect(disconnected.session.participants.get("TEST1")?.connected).toBe(false);
  const restored = deserializeSession(serializeSession(disconnected.session));
  const rejoined = apply(restored, quiz, { type: "join", payload: { studentId: "TEST1", sessionToken: "token" }, socketId: "second", newToken: "unused" }, 4000);
  expect(rejoined.session.submissions).toEqual(restored.submissions);
  expect(rejoined.session.submissions).toHaveLength(1);
  expect(rejoined.session.participants.get("TEST1")?.connected).toBe(true);
  expect(rejoined.messages.find(message => message.event === SocketEvents.STUDENT_JOINED)?.payload).toMatchObject({ answeredQuestions: [0] });
});

describe("REST close retries", () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    clearAllSessions();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-close-retry-"));
    app = createApp({ quizDir: path.join(__dirname, "fixtures/quizzes"), dataDir, shortUrlProviders: [] });
  });
  afterEach(() => { clearAllSessions(); fs.rmSync(dataDir, { recursive: true, force: true }); });

  it("accepts two instructor clients and refuses a delayed request after advancing", async () => {
    const created = await request(app).post("/api/session").send({ week: "week01" }).expect(201);
    const id = created.body.sessionId;
    await request(app).post(`/api/session/${id}/start`).expect(200);
    const opening = { questionIndex: 0, startedAt: getSession(id)!.questionStartedAt };
    const replies = await Promise.all([request(app).post(`/api/session/${id}/close`).send(opening), request(app).post(`/api/session/${id}/close`).send(opening)]);
    expect(replies.map(reply => reply.status)).toEqual([200, 200]);
    expect(replies.every(reply => reply.body.state === "QUESTION_CLOSED")).toBe(true);
    await request(app).post(`/api/session/${id}/reveal`).expect(200);
    await request(app).post(`/api/session/${id}/next`).expect(200);
    const before = serializeSession(getSession(id)!);
    await request(app).post(`/api/session/${id}/close`).send(opening).expect(400);
    expect(serializeSession(getSession(id)!)).toBe(before);
    await request(app).post(`/api/session/${id}/close`).send({ questionIndex: "bad" }).expect(400);
  });
});
