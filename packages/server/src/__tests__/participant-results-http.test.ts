import fs from "fs";
import os from "os";
import path from "path";
import { createServer } from "http";
import { AddressInfo } from "net";
import request from "supertest";
import { Server } from "socket.io";
import { io as ioClient, Socket } from "socket.io-client";
import { Quiz, SocketEvents, StudentJoinedPayload } from "@mdq/shared";
import { createApp } from "../app";
import { clearAllSessions, getSession, deserializeSession, serializeSession, storeSession } from "../session";
import { clearInstructorSessionsForTests } from "../instructor-auth";
import { clearSessionTimers, emitMessages, setupSocket } from "../socket";
const DECK = `# Synthetic retained results
---
## Scored
 time-limit: none
Choose.
A. One
B. Two
> Correct Answer: A
> Overall Feedback: VERIFIED_EXPLANATION
---
## Written
question-type: open-response
time-limit: none
Write a response.
---
## NEVER_SHOWN_PRIVATE_STEM
A. Future
B. Other
> Correct Answer: B
`;
function once<T>(socket: Socket, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, listener); reject(new Error(`Missing ${event}`)); }, 3500);
    const listener = (value: T) => { clearTimeout(timer); resolve(value); };
    socket.once(event, listener);
  });
}
it("HTTP retained own results survive missed/rejected final sockets, token-only auth and idempotent End", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-retained-"));
  const oldPassword = process.env.INSTRUCTOR_PASSWORD;
  const oldKey = process.env.INSTRUCTOR_KEY;
  process.env.INSTRUCTOR_PASSWORD = "synthetic-instructor-password";delete process.env.INSTRUCTOR_KEY;
  clearAllSessions();clearInstructorSessionsForTests();
  fs.writeFileSync(path.join(dir, "synthetic.md"), DECK);
  let ioServer: Server;
  const app = createApp({ quizDir: dir, dataDir: path.join(dir, "runtime"), onStateChange(_session, id, _state, _quiz, result) {
    if (result) emitMessages(ioServer, id, result.messages);
    clearSessionTimers(id);
  } });
  const httpServer = createServer(app);
  const quizzes = (app as unknown as { _quizzes: Map<string, Quiz> })._quizzes;
  ioServer = setupSocket(httpServer, quizzes);
  await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const sockets: Socket[] = [];
  let sessionId = "";
  const client = () => { const socket = ioClient(url, { auth: { sessionId }, autoConnect: false, transports: ["websocket"], reconnection: false });sockets.push(socket);return socket; };
  try {
    const teacher = request.agent(app);
    await teacher.post("/api/instructor/login").send({ password: "synthetic-instructor-password" }).expect(204);
    const made = await teacher.post("/api/session").send({ week: "synthetic" }).expect(201);
    sessionId = made.body.sessionId;
    await teacher.post(`/api/session/${sessionId}/policy`).send({ pacing: "self-paced" }).expect(200);
    await teacher.post(`/api/session/${sessionId}/start`).expect(200);
    const first = client();const firstJoined = once<StudentJoinedPayload>(first, SocketEvents.STUDENT_JOINED);
    first.connect();first.emit(SocketEvents.STUDENT_JOIN, { studentId: "synthetic-one" });const seat = await firstJoined;
    const second = client();const secondJoined = once<StudentJoinedPayload>(second, SocketEvents.STUDENT_JOINED);
    second.connect();second.emit(SocketEvents.STUDENT_JOIN, { studentId: "synthetic-two" });await secondJoined;
    const accepted = once(first, SocketEvents.ANSWER_ACCEPTED);first.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, selectedOptions: ["A"] });await accepted;
    await teacher.post(`/api/session/${sessionId}/next`).expect(200);
    const ownAccepted = once(first, SocketEvents.ANSWER_ACCEPTED);first.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 1, responseText: "MY_OWN_RESPONSE" });await ownAccepted;
    const otherAccepted = once(second, SocketEvents.ANSWER_ACCEPTED);second.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 1, responseText: "ANOTHER_RESPONSE_PRIVATE" });await otherAccepted;
    const endpoint = `/api/session/${sessionId}/own-results`;
    await request(app).get(endpoint).set("Authorization", `Bearer ${seat.sessionToken}`).expect(409);
    await request(app).get(`/api/session/${sessionId}/end-advisory`).expect(401);
    const advisory = await teacher.get(`/api/session/${sessionId}/end-advisory`).expect(200);
    expect(advisory.body).toEqual({ unfinishedParticipantCount: 1, unshownQuestionCount: 1 });
    first.disconnect(); // Miss every final event intentionally.
    const finalEvent = once<{ state: string }>(second, SocketEvents.SESSION_STATE);
    await teacher.post(`/api/session/${sessionId}/end`).expect(200);
    expect(await finalEvent).toMatchObject({ state: "ENDED" });
    const lateRejected = once(second, SocketEvents.ANSWER_REJECTED);second.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 1, responseText: "TOO_LATE" });await lateRejected;
    const read = await request(app).get(endpoint).set("Authorization", `Bearer ${seat.sessionToken}`).expect(200);
    expect(read.headers["cache-control"]).toBe("no-store");expect(read.body.resultVersion).toBe(1);
    expect(read.body.questions[1].answer.responseText).toBe("MY_OWN_RESPONSE");
    expect(read.body.questions[0]).toMatchObject({ correct: true, explanation: "VERIFIED_EXPLANATION" });
    expect(JSON.stringify(read.body)).not.toMatch(/ANOTHER_RESPONSE_PRIVATE|synthetic-one|synthetic-two|studentId|displayName|sessionToken|NEVER_SHOWN_PRIVATE_STEM|TOO_LATE|totalTimeMs/);
    await request(app).get(endpoint).expect(410);
    await request(app).get(endpoint).set("Authorization", "Bearer invalid").expect(410);
    await request(app).get(endpoint).query({ participantId: "synthetic-one", displayName: "same", sessionToken: seat.sessionToken }).expect(410);
    const session = getSession(sessionId)!;const scope = { ...session.resultScope };
    const winnerPath = path.join(dir, "runtime", "winners", "synthetic.json");const saved = fs.readFileSync(winnerPath, "utf8");
    await teacher.post(`/api/session/${sessionId}/end`).send({ discloseResults: false }).expect(200);
    expect(session.resultScope).toEqual(scope);expect(fs.readFileSync(winnerPath, "utf8")).toBe(saved);
    const finalRead = await request(app).get(endpoint).set("Authorization", `Bearer ${seat.sessionToken}`).expect(200);
    expect(finalRead.body).toEqual(read.body);
    storeSession(deserializeSession(serializeSession(session))); // Actual transport read from rehydrated runtime state.
    expect((await request(app).get(endpoint).set("Authorization", `Bearer ${seat.sessionToken}`).expect(200)).body).toEqual(read.body);
    const newSocket = client();const rejected = once(newSocket, SocketEvents.STUDENT_REJECTED);newSocket.connect();
    expect(await rejected).toMatchObject({ reason: "Session has ended" });
    expect(getSession(sessionId)!.participants.size).toBe(2);
    const byCode = await request(app).get(`/api/session/by-code/${made.body.sessionCode}`).expect(200);expect(byCode.body).toMatchObject({ state: "ENDED", sessionId });
    const oldEnd = getSession(sessionId)!.resultScope!.endedAt;
    getSession(sessionId)!.resultScope!.endedAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
    await request(app).get(endpoint).set("Authorization", `Bearer ${seat.sessionToken}`).expect(410);
    getSession(sessionId)!.resultScope!.endedAt = oldEnd;
    getSession(sessionId)!.participants.get("synthetic-one")!.released = true;
    await request(app).get(endpoint).set("Authorization", `Bearer ${seat.sessionToken}`).expect(410);
  } finally {
    sockets.forEach(socket => socket.disconnect());if (sessionId) clearSessionTimers(sessionId);
    await new Promise<void>(resolve => ioServer.close(() => resolve()));
    clearAllSessions();clearInstructorSessionsForTests();
    if (oldPassword === undefined) delete process.env.INSTRUCTOR_PASSWORD;else process.env.INSTRUCTOR_PASSWORD = oldPassword;
    if (oldKey === undefined) delete process.env.INSTRUCTOR_KEY;else process.env.INSTRUCTOR_KEY = oldKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
