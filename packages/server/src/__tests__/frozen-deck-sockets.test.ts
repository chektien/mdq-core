import fs from "fs";
import os from "os";
import path from "path";
import { createServer } from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { Server } from "socket.io";
import { io as ioClient, Socket } from "socket.io-client";
import { QuestionOpenPayload, Quiz, SocketEvents, StudentJoinedPayload } from "@mdq/shared";
import { createApp } from "../app";
import { getSession, clearAllSessions } from "../session";
import { clearSessionTimers, emitMessages, setupSocket, startQuestionTimer } from "../socket";

const ORIGINAL = `# Synthetic frozen deck
---
## Frozen question
time-limit: 2
Choose the original option.
A. Original one
B. Original two
> Correct Answer: A
> Overall Feedback: Synthetic feedback.
`;
const REPLACEMENT = `# Synthetic replacement deck
---
## Replacement slide
type: slide
Replacement content must not appear in the existing session.
`;

function once<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`Missing ${event}`)); }, 3500);
    const listener = (payload: T) => { clearTimeout(timer); resolve(payload); };
    socket.once(event, listener);
  });
}

it.each(["replace", "remove"] as const)("frozen socket reconnect, content, answers and restart timers survive %s + source reload", async (operation) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-frozen-sockets-"));
  const source = path.join(directory, "synthetic.md");
  fs.writeFileSync(source, ORIGINAL);
  const previousPassword = process.env.INSTRUCTOR_PASSWORD;
  const previousKey = process.env.INSTRUCTOR_KEY;
  delete process.env.INSTRUCTOR_PASSWORD; delete process.env.INSTRUCTOR_KEY;
  clearAllSessions();
  let ioServer: Server;
  const app = createApp({ quizDir: directory, dataDir: path.join(directory, "runtime"), onStateChange(session, id, _state, quiz, result) {
    if (!result || !quiz) return;
    emitMessages(ioServer, id, result.messages);
    clearSessionTimers(id);
    if (result.nextDeadline !== null) {
      // Deliberately pass the current source duration, including null after removal:
      // the timer adapter must prefer the pinned item just like its engine does.
      const sourceLimit = quizzes.get(session.week)?.questions[session.currentQuestionIndex]?.timeLimitSec ?? null;
      startQuestionTimer(ioServer, session, id, sourceLimit, result.nextDeadline);
    }
  } });
  const httpServer = createServer(app);
  const quizzes = (app as unknown as { _quizzes: Map<string, Quiz> })._quizzes;
  ioServer = setupSocket(httpServer, quizzes);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const sockets: Socket[] = [];
  let sessionId: string | undefined;
  const connect = (role?: string) => {
    const socket = ioClient(baseUrl, { autoConnect: false, auth: { sessionId, ...(role ? { role } : {}) }, transports: ["websocket"], reconnection: false });
    sockets.push(socket); return socket;
  };
  try {
    const created = await request(app).post("/api/session").send({ week: "synthetic" }).expect(201);
    sessionId = created.body.sessionId;
    await request(app).post(`/api/session/${sessionId}/start`).expect(200);
    const session = getSession(sessionId!)!;
    const originalTiming = { ...session.questionTiming!["0"], restarts: [...session.questionTiming!["0"].restarts] };
    const first = connect();
    const joinedPromise = once<StudentJoinedPayload>(first, SocketEvents.STUDENT_JOINED);
    const originalOpenPromise = once<QuestionOpenPayload>(first, SocketEvents.QUESTION_OPEN);
    first.connect(); first.emit(SocketEvents.STUDENT_JOIN, { studentId: "synthetic-seat" });
    const joined = await joinedPromise;
    expect(await originalOpenPromise).toMatchObject({ topic: "Frozen question", deadlineAt: originalTiming.deadlineAt });
    const accepted = once(first, SocketEvents.ANSWER_ACCEPTED);
    first.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, selectedOptions: ["A"] });
    await accepted;
    const originalSubmission = { ...session.submissions[0] };
    first.disconnect();

    if (operation === "replace") fs.writeFileSync(source, REPLACEMENT);
    else fs.unlinkSync(source);
    await request(app).post("/api/decks/reload").expect(200);
    if (operation === "replace") expect(quizzes.get("synthetic")?.questions[0].questionType).toBe("slide");
    else expect(quizzes.has("synthetic")).toBe(false);

    const reconnected = connect();
    const rejoinedPromise = once<StudentJoinedPayload>(reconnected, SocketEvents.STUDENT_JOINED);
    const frozenOpenPromise = once<QuestionOpenPayload>(reconnected, SocketEvents.QUESTION_OPEN);
    reconnected.connect(); reconnected.emit(SocketEvents.STUDENT_JOIN, { studentId: joined.participantId, sessionToken: joined.sessionToken });
    const rejoined = await rejoinedPromise;
    expect(rejoined).toMatchObject({ sessionToken: joined.sessionToken, answeredQuestions: [0], answers: [{ questionIndex: 0, selectedOptions: [0] }] });
    expect(await frozenOpenPromise).toMatchObject({ topic: "Frozen question", questionType: "multiple_choice", timeLimitSec: 2, deadlineAt: originalTiming.deadlineAt });
    expect(session.questionTiming!["0"]).toEqual(originalTiming);
    expect(session.submissions).toEqual([originalSubmission]);

    // A new projector must receive its frozen snapshot even when the source map is empty.
    const projector = connect("presentation");
    const projectorOpen = once<QuestionOpenPayload>(projector, SocketEvents.QUESTION_OPEN);
    projector.connect();
    expect(await projectorOpen).toMatchObject({ topic: "Frozen question", timeLimitSec: 2, deadlineAt: originalTiming.deadlineAt });

    const tick = once<{ remainingSec: number }>(reconnected, SocketEvents.QUESTION_TICK);
    const closed = once<{ questionIndex: number; timedOut: boolean }>(reconnected, SocketEvents.QUESTION_CLOSE);
    await request(app).post(`/api/session/${sessionId}/restart-countdown`).expect(200);
    const restarted = session.questionTiming!["0"];
    expect(restarted).toMatchObject({ firstOpenedAt: originalTiming.firstOpenedAt, restarts: [{ previousStartedAt: originalTiming.startedAt, previousDeadlineAt: originalTiming.deadlineAt }] });
    expect((await tick).remainingSec).toBeGreaterThan(0);
    expect(await closed).toEqual({ questionIndex: 0, timedOut: true });
    expect(session.state).toBe("QUESTION_CLOSED");
    expect(session.submissions).toEqual([originalSubmission]);
    expect(session.questionTiming!["0"]).toEqual(restarted);
  } finally {
    if (sessionId) clearSessionTimers(sessionId);
    for (const socket of sockets) socket.disconnect();
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
    if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    clearAllSessions();
    if (previousPassword === undefined) delete process.env.INSTRUCTOR_PASSWORD; else process.env.INSTRUCTOR_PASSWORD = previousPassword;
    if (previousKey === undefined) delete process.env.INSTRUCTOR_KEY; else process.env.INSTRUCTOR_KEY = previousKey;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
