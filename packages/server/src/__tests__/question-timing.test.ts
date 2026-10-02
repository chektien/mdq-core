import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { Question, Quiz, Session, SocketEvents, QuestionOpenPayload } from "@mdq/shared";
import { apply, Command } from "../engine";
import { createSession, deserializeSession, serializeSession, clearAllSessions, getSession } from "../session";
import { parseQuizMarkdown } from "../parser";
import { saveSessionSnapshot } from "../persistence";
import { createApp } from "../app";
import { clearInstructorSessionsForTests } from "../instructor-auth";
import { localRemainingSec, clockOffsetFromTick } from "../../../client/src/countdown";

const question = (extra: Partial<Question> = {}): Question => ({ index: 0, topic: "Synthetic", textMd: "Choose.", textHtml: "Choose.",
  options: [{ label: "A", textMd: "One", textHtml: "One" }, { label: "B", textMd: "Two", textHtml: "Two" }],
  correctOptions: ["A"], allowsMultiple: false, explanation: "Synthetic explanation.", timeLimitSec: 10, ...extra });
const deck = (questions = [question()]): Quiz => ({ week: "synthetic", title: "Synthetic timing", sourceFile: "synthetic.md", questions });
const run = (session: Session, command: Command, now: number, quiz = deck()) => apply(session, quiz, command, now);
const opened = (quiz = deck(), now = 0) => run(createSession("synthetic", "open"), { type: "start" }, now, quiz).session;
const joined = (session: Session, quiz = deck()) => run(session, { type: "join", payload: { studentId: "test" }, socketId: "test-socket", newToken: "test-token" }, 1, quiz).session;
const answer = (session: Session, now: number, quiz = deck(), selectedOptions = ["A"]) => run(session,
  { type: "answerSubmit", studentId: "test", sessionToken: "test-token", payload: { questionIndex: 0, selectedOptions } }, now, quiz);
const timing = (session: Session) => session.questionTiming!["0"];
const payload = (result: ReturnType<typeof apply>) => result.messages.find(message => message.event === SocketEvents.QUESTION_OPEN)?.payload as QuestionOpenPayload;

describe("authoritative question timing", () => {
  it("sets a deadline once, including time zero, across broadcasts, snapshots, joins and reload", () => {
    let session = opened();
    const original = timing(session);
    expect(original).toEqual({ firstOpenedAt: 0, startedAt: 0, deadlineAt: 10000, restarts: [] });
    for (const command of [{ type: "broadcastOpen" }, { type: "snapshot", view: "control" },
      { type: "join", payload: { studentId: "test" }, socketId: "one", newToken: "test-token" },
      { type: "join", payload: { studentId: "test", sessionToken: "test-token" }, socketId: "two", newToken: "unused" },
      { type: "snapshot", participantId: "test", isReconnect: true }] as Command[]) {
      const result = run(session, command, 4000);
      session = deserializeSession(serializeSession(result.session));
      expect(timing(session)).toEqual(original);
      expect(session.questionStartedAt).toBe(0);
      expect(result.nextDeadline).toBe(10000);
      expect(payload(result)).toMatchObject({ startedAt: 0, firstOpenedAt: 0, deadlineAt: 10000, serverNow: 4000 });
    }
  });

  it("preserves item clocks through slide navigation and never reopens a reviewed question", () => {
    const quiz = deck([question({ questionType: "slide", options: [], correctOptions: [], timeLimitSec: 0 }), question({ index: 1 }), question({ index: 2 })]);
    let session = opened(quiz, 0);
    session = run(session, { type: "next" }, 1000, quiz).session;
    const original = session.questionTiming!["1"];
    session = run(session, { type: "previous" }, 2000, quiz).session;
    session = run(session, { type: "next" }, 3000, quiz).session;
    expect(session.questionTiming!["1"]).toEqual(original);
    expect(session.questionStartedAt).toBe(1000);
    expect(run(session, { type: "snapshot" }, 4000, quiz).nextDeadline).toBe(11000);
    session = run(session, { type: "close" }, 5000, quiz).session;
    session = run(session, { type: "reveal" }, 5001, quiz).session;
    expect(() => run(session, { type: "open" }, 6000, quiz)).toThrow("Revealed");
    expect(() => run(session, { type: "start" }, 6000, quiz)).toThrow("already started");
    session = run(session, { type: "next" }, 7000, quiz).session;
    session = run(session, { type: "previous" }, 8000, quiz).session;
    expect(session.state).toBe("REVEAL");
    expect(session.questionTiming!["1"]).toEqual(original);
  });

  it.each(["multiple_choice", "poll", "open_response"] as const)("uses explicit null for an untimed %s", questionType => {
    const quiz = deck([question({ questionType, timeLimitSec: null })]);
    let session = joined(opened(quiz), quiz);
    const result = run(session, { type: "snapshot" }, 100000, quiz);
    expect(result.nextDeadline).toBeNull();
    expect(payload(result)).toMatchObject({ timeLimitSec: null, deadlineAt: null, startedAt: 0 });
    expect(result.messages.some(message => message.event === SocketEvents.QUESTION_TICK)).toBe(false);
    expect(run(session, { type: "timeout" }, 100000, quiz).session.state).toBe("QUESTION_OPEN");
    const response = questionType === "open_response" ? { responseText: "Synthetic response" } : { selectedOptions: ["A"] };
    session = run(session, { type: "answerSubmit", studentId: "test", sessionToken: "test-token", payload: { questionIndex: 0, ...response } }, 100000, quiz).session;
    expect(session.submissions).toHaveLength(1);
    expect(deserializeSession(serializeSession(session)).questionTiming!["0"].deadlineAt).toBeNull();
  });

  it("enforces the numeric deadline before any timeout callback, including its exact boundary", () => {
    const session = joined(opened());
    expect(answer(session, 9999).messages[0].event).toBe(SocketEvents.ANSWER_ACCEPTED);
    for (const now of [10000, 10001]) {
      const rejected = answer(session, now);
      expect(rejected.session.state).toBe("QUESTION_OPEN");
      expect(rejected.session.submissions).toHaveLength(0);
      expect(rejected.messages[0]).toMatchObject({ event: SocketEvents.ANSWER_REJECTED, payload: { reason: "The question deadline has passed." } });
    }
  });

  it("explicitly restarts only the clock, preserves original response timestamps, and ignores stale alarms", () => {
    const answered = answer(joined(opened()), 2000).session;
    const before = serializeSession(answered);
    const restarted = run(answered, { type: "restartCountdown", role: "control" }, 6000);
    expect(serializeSession(answered)).toBe(before);
    expect(restarted.session.submissions).toEqual(answered.submissions);
    expect(timing(restarted.session)).toEqual({ firstOpenedAt: 0, startedAt: 6000, deadlineAt: 16000,
      restarts: [{ restartedAt: 6000, previousStartedAt: 0, previousDeadlineAt: 10000 }], timingFairnessInvalidated: true });
    expect(run(restarted.session, { type: "timeout", deadline: 10000 }, 10000).messages).toEqual([]);
    expect(answer(restarted.session, 7000).messages[0]).toMatchObject({ event: SocketEvents.ANSWER_REJECTED, payload: { reason: "Already submitted an answer for this question." } });
    expect(run(restarted.session, { type: "timeout", deadline: 16000 }, 16000).session.state).toBe("QUESTION_CLOSED");
    const repeated = run(restarted.session, { type: "restartCountdown", role: "control" }, 8000);
    expect(timing(repeated.session).restarts).toHaveLength(2);
    expect(timing(restarted.session).restarts).toHaveLength(1);
    expect(deserializeSession(serializeSession(repeated.session))).toStrictEqual(repeated.session);
  });

  it("distinguishes alarms for different items with identical starts and numeric deadlines", () => {
    const quiz = deck([question(), question({ index: 1 })]);
    const first = run(createSession("synthetic", "open"), { type: "start" }, 0, quiz);
    const closed = run(first.session, { type: "close" }, 0, quiz);
    const revealed = run(closed.session, { type: "reveal" }, 0, quiz);
    const second = run(revealed.session, { type: "next" }, 0, quiz);
    expect(first.nextDeadline).toBe(second.nextDeadline);
    const stale = run(second.session, { type: "timeout", deadline: first.nextAlarm!.deadlineAt,
      questionIndex: first.nextAlarm!.questionIndex, startedAt: first.nextAlarm!.startedAt, restartCount: first.nextAlarm!.restartCount }, 10000, quiz);
    expect(stale.session.state).toBe("QUESTION_OPEN");
    expect(stale.messages).toEqual([]);
    const sameMillisecondRestart = run(second.session, { type: "restartCountdown", role: "control" }, 0, quiz);
    const staleRestart = run(sameMillisecondRestart.session, { type: "timeout", deadline: second.nextAlarm!.deadlineAt,
      questionIndex: second.nextAlarm!.questionIndex, startedAt: second.nextAlarm!.startedAt, restartCount: second.nextAlarm!.restartCount }, 10000, quiz);
    expect(staleRestart.session.state).toBe("QUESTION_OPEN");
    expect(staleRestart.messages).toEqual([]);
  });

  it("rejects closed/revealed/ended, content, untimed, missing-timing and non-presenter restarts", () => {
    for (const state of ["LOBBY", "QUESTION_CLOSED", "REVEAL", "LEADERBOARD", "ENDED"] as const) {
      expect(() => run({ ...opened(), state }, { type: "restartCountdown", role: "control" }, 1000)).toThrow();
    }
    for (const q of [question({ questionType: "slide", timeLimitSec: 0 }), question({ questionType: "cover", timeLimitSec: 0 }), question({ timeLimitSec: null })]) {
      const quiz = deck([q]);
      expect(() => run(opened(quiz), { type: "restartCountdown", role: "control" }, 1000, quiz)).toThrow();
    }
    for (const role of ["participant", "display"] as const) expect(() => run(opened(), { type: "restartCountdown", role }, 1000)).toThrow("Only the presenter");
    expect(() => run({ ...opened(), questionTiming: undefined, questionStartedAt: undefined }, { type: "restartCountdown", role: "control" }, 1000)).toThrow("unavailable");
    expect(() => run({ ...opened(), revealedQuestionIndexes: new Set([0]) }, { type: "restartCountdown", role: "control" }, 1000)).toThrow();
  });

  it("keeps an open response's submitted and response timestamps when restarting", () => {
    const quiz = deck([question({ questionType: "open_response", options: [], correctOptions: [] })]);
    const submitted = run(joined(opened(quiz), quiz), { type: "answerSubmit", studentId: "test", sessionToken: "test-token",
      payload: { questionIndex: 0, responseText: "Synthetic response" } }, 2000, quiz).session;
    expect(submitted.submissions[0]).toMatchObject({ submittedAt: 2000, responseTimeMs: 2000 });
    const restarted = run(submitted, { type: "restartCountdown", role: "control" }, 6000, quiz);
    expect(restarted.session.submissions).toEqual(submitted.submissions);
  });

  it("refuses an overdue still-open restart at and beyond its deadline without changing recorded timing or submissions", () => {
    const session = answer(joined(opened()), 2000).session;
    const original = serializeSession(session);
    for (const now of [10000, 10001]) {
      expect(() => run(session, { type: "restartCountdown", role: "control" }, now)).toThrow("deadline has passed");
      expect(serializeSession(session)).toBe(original);
      expect(session.state).toBe("QUESTION_OPEN");
      expect(timing(session).restarts).toEqual([]);
      expect(session.submissions[0]).toMatchObject({ submittedAt: 2000, responseTimeMs: 2000 });
    }
  });

  it("preserves known legacy start/deadline without inventing a first-open time", () => {
    const legacy = { ...opened(), questionTiming: undefined, questionStartedAt: 0, questionDeadlineAt: 7500 };
    const restored = deserializeSession(serializeSession(legacy));
    const result = run(restored, { type: "broadcastOpen" }, 5000);
    expect(timing(result.session)).toEqual({ startedAt: 0, deadlineAt: 7500, restarts: [] });
    expect(payload(result)).not.toHaveProperty("firstOpenedAt");
    expect(result.nextDeadline).toBe(7500);
    expect(run({ ...restored, questionDeadlineAt: undefined }, { type: "snapshot" }, 5000).nextDeadline).toBe(10000);
  });

  it("rejects fabricated options and mismatched items, and no post-reveal retry can score", () => {
    let session = joined(opened());
    expect(answer(session, 1000, deck(), ["FABRICATED"]).messages[0].event).toBe(SocketEvents.ANSWER_REJECTED);
    expect(run(session, { type: "answerSubmit", studentId: "test", sessionToken: "test-token", payload: { questionIndex: 1, selectedOptions: ["A"] } }, 1000).messages[0].event).toBe(SocketEvents.ANSWER_REJECTED);
    session = run(run(session, { type: "close" }, 1000).session, { type: "reveal" }, 1001).session;
    expect(() => run(session, { type: "open" }, 2000)).toThrow();
    expect(() => run(session, { type: "restartCountdown", role: "control" }, 2000)).toThrow();
    expect(answer({ ...session, state: "QUESTION_OPEN" }, 2000).session.submissions).toHaveLength(0);
  });

  it("saves restart audit metadata in the end-of-session snapshot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-timing-snapshot-"));
    try {
      const session = run(opened(), { type: "restartCountdown", role: "control" }, 1000).session;
      saveSessionSnapshot(session, dir);
      const saved = JSON.parse(fs.readFileSync(path.join(dir, "sessions", `${session.sessionId}.json`), "utf8"));
      expect(saved.questionTiming).toEqual(session.questionTiming);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("portable untimed syntax and countdown", () => {
  it.each(["time-limit", "time_limit"])("parses %s: none for MC, multi-select, poll and open response", key => {
    for (const [type, multi] of [["multiple-choice", false], ["multiple-choice", true], ["poll", false], ["open-response", false]] as const) {
      const result = parseQuizMarkdown(`# Synthetic\n\n---\n\n## Question\n${key}: none\ntype: ${type}\n${multi ? "multi-select: true\n" : ""}\nChoose.\n\n${type === "open-response" ? "" : "A. One\nB. Two\n"}${type === "multiple-choice" ? "\n> Correct Answer: A\n" : ""}`, "synthetic.md");
      expect(result.errors).toEqual([]);
      expect(result.quiz!.questions[0].timeLimitSec).toBeNull();
      expect(result.quiz!.questions[0].textMd).not.toContain("none");
    }
  });
  it("keeps slide-specific time-limit rejection and rejects invalid numeric sentinels", () => {
    for (const value of ["none", "10"]) expect(parseQuizMarkdown(`# Synthetic\n---\n## Slide\ntype: slide\ntime-limit: ${value}\nText.`, "synthetic.md").errors).toHaveLength(1);
    for (const value of ["0", "Infinity", "-1", "1.5", "NaN", "9007199254740992"]) expect(parseQuizMarkdown(`# Synthetic\n---\n## Question\ntime-limit: ${value}\nChoose.\n- A) One\n> Answer: A`, "synthetic.md").errors).toHaveLength(1);
  });
  it("retains lowercase time-limit key semantics", () => {
    for (const key of ["Time-Limit", "TIME_LIMIT"]) {
      const parsed = parseQuizMarkdown(`# Synthetic\n---\n## Question\n${key}: none\nChoose.\nA. One\n> Correct Answer: A`, "synthetic.md");
      expect(parsed.errors).toEqual([]);
      expect(parsed.quiz!.questions[0].timeLimitSec).toBe(35);
    }
  });
  it("returns null without arithmetic on none and uses the saved authoritative deadline", () => {
    expect(localRemainingSec({ startedAt: 0, timeLimitSec: null, deadlineAt: null }, 999999)).toBeNull();
    expect(clockOffsetFromTick({ startedAt: 0, timeLimitSec: null }, 0, 999999)).toBe(0);
    expect(localRemainingSec({ startedAt: 0, timeLimitSec: 10, deadlineAt: 7500 }, 5000)).toBe(3);
  });
});

it("authenticates the restart REST adapter and publishes/persists the engine result", async () => {
  const previousPassword = process.env.INSTRUCTOR_PASSWORD;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-timing-rest-"));
  process.env.INSTRUCTOR_PASSWORD = "synthetic-secret";
  clearAllSessions(); clearInstructorSessionsForTests();
  try {
    const callbacks: ReturnType<typeof apply>[] = [];
    const app = createApp({ quizDir: path.join(__dirname, "fixtures/quizzes"), dataDir: dir, shortUrlProviders: [],
      onStateChange: (_session, _id, _state, _quiz, result) => { if (result) callbacks.push(result); } });
    const agent = request.agent(app);
    await agent.post("/api/instructor/login").send({ password: "synthetic-secret" }).expect(204);
    const created = await agent.post("/api/session").send({ week: "week01" }).expect(201);
    const id = created.body.sessionId;
    await agent.post(`/api/session/${id}/start`).expect(200);
    const session = getSession(id)!;
    const original = { ...session.questionTiming!["0"] };
    await request(app).post(`/api/session/${id}/restart-countdown`).expect(401);
    await agent.post(`/api/session/${id}/restart-countdown`).expect(200);
    expect(session.questionTiming!["0"].firstOpenedAt).toBe(original.firstOpenedAt);
    expect(session.questionTiming!["0"].restarts).toHaveLength(1);
    expect(callbacks.at(-1)!.nextDeadline).toBe(session.questionTiming!["0"].deadlineAt);
    const restored = await agent.get(`/api/session/${id}/state`).expect(200);
    expect(restored.body.reviewQuestions[0].deadlineAt).toBe(session.questionTiming!["0"].deadlineAt);
    const beforeExpiredAttempt = serializeSession(session);
    const now = jest.spyOn(Date, "now").mockReturnValue(session.questionTiming!["0"].deadlineAt!);
    try {
      const expiredAttempt = await agent.post(`/api/session/${id}/restart-countdown`).expect(400);
      expect(expiredAttempt.body.error).toContain("deadline has passed");
      expect(serializeSession(session)).toBe(beforeExpiredAttempt);
    } finally { now.mockRestore(); }
    await agent.post(`/api/session/${id}/close`).expect(200);
    await agent.post(`/api/session/${id}/restart-countdown`).expect(400);
  } finally {
    if (previousPassword === undefined) delete process.env.INSTRUCTOR_PASSWORD; else process.env.INSTRUCTOR_PASSWORD = previousPassword;
    clearAllSessions(); clearInstructorSessionsForTests(); fs.rmSync(dir, { recursive: true, force: true });
  }
});
