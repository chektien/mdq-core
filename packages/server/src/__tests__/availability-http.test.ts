import fs from "fs";
import os from "os";
import path from "path";
import { createServer } from "http";
import type { AddressInfo } from "net";
import request from "supertest";
import { io as client, Socket } from "socket.io-client";
import { Quiz, SESSION_RECOVERY_MS, SessionAvailabilityPayload, SocketEvents, StudentJoinedPayload } from "@mdq/shared";
import { createApp } from "../app";
import { clearAllSessions, deserializeSession, getSession, serializeSession, storeSession } from "../session";
import { clearInstructorSessionsForTests } from "../instructor-auth";
import { emitMessages, setupSocket } from "../socket";
const DECK = `# Synthetic availability HTTP\n---\n## Released\ntime-limit: none\nChoose.\nA. One\nB. Two\n> Correct Answer: A\n> Overall Feedback: PRIVATE_EXPLANATION\n---\n## PRIVATE_FUTURE_STEM\nA. Future\nB. Other\n> Correct Answer: B\n`;
function once<T>(socket: Socket, event: string, match: (value: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off(event, listener); reject(new Error(`Missing ${event}`)); }, 3500);
    const listener = (value: T) => { if (!match(value)) return; clearTimeout(timeout); socket.off(event, listener); resolve(value); };
    socket.on(event, listener);
  });
}
it("actual expiry/reconnect/extension/End transports deny new seats and result leakage while preserving existing seats", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-availability-http-"));
  fs.writeFileSync(path.join(dir, "synthetic.md"), DECK);
  const oldPassword = process.env.INSTRUCTOR_PASSWORD;const oldKey = process.env.INSTRUCTOR_KEY;
  process.env.INSTRUCTOR_PASSWORD = "synthetic-password";delete process.env.INSTRUCTOR_KEY;
  clearAllSessions();clearInstructorSessionsForTests();
  const app = createApp({ quizDir: dir, dataDir: path.join(dir, "runtime"), onMessages(_session, id, result) { emitMessages(ioServer, id, result.messages); }, onStateChange(_session, id, _state, _quiz, result) { if (result) emitMessages(ioServer, id, result.messages); } });
  const server = createServer(app);const ioServer = setupSocket(server, (app as unknown as { _quizzes: Map<string, Quiz> })._quizzes);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: Socket[] = [];
  let sessionId = "";
  const socket = () => { const value = client(url, { auth: { sessionId }, autoConnect: false, reconnection: false, transports: ["websocket"] });sockets.push(value);return value; };
  try {
    const teacher = request.agent(app);
    await teacher.post("/api/instructor/login").send({ password: "synthetic-password" }).expect(204);
    await teacher.post("/api/session").send({ week: "synthetic", availableUntil: Date.now() + SESSION_RECOVERY_MS + 10_000 }).expect(400);
    const expiry = Date.now() + 1000;
    const made = await teacher.post("/api/session").send({ week: "synthetic", availableUntil: expiry }).expect(201);
    sessionId = made.body.sessionId;
    expect(made.body.availability.availableUntil).toBe(expiry);
    await teacher.post(`/api/session/${sessionId}/policy`).send({ pacing: "self-paced" }).expect(200);
    await teacher.post(`/api/session/${sessionId}/start`).expect(200);
    const first = socket();const joined = once<StudentJoinedPayload>(first, SocketEvents.STUDENT_JOINED);
    first.connect();first.emit(SocketEvents.STUDENT_JOIN, { studentId: "synthetic-seat", clientInstanceId: "same-device" });const seat = await joined;
    const accepted = once(first, SocketEvents.ANSWER_ACCEPTED);first.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, selectedOptions: ["A"] });await accepted;
    const expiredEvent = once<SessionAvailabilityPayload>(first, SocketEvents.SESSION_AVAILABILITY, value => value.phase === "expired");
    expect((await expiredEvent).availableUntil).toBe(expiry);
    expect(getSession(sessionId)!.state).toBe("QUESTION_OPEN");expect(getSession(sessionId)!.resultScope).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "runtime", "winners"))).toBe(false);
    const token = { Authorization: `Bearer ${seat.sessionToken}` };
    const metadata = await request(app).get(`/api/session/${sessionId}/availability`).expect(200);
    expect(metadata.body).toMatchObject({ phase: "expired", recoverBefore: expiry + SESSION_RECOVERY_MS });
    const study = await request(app).get(`/api/session/${sessionId}/items`).set(token).expect(200);
    expect(study.body.items).toHaveLength(1);expect(study.body.answerableQuestionIndexes).toEqual([]);
    expect(JSON.stringify(study.body)).not.toMatch(/correctOptions|correctCount|explanation|PRIVATE_EXPLANATION|PRIVATE_FUTURE_STEM|"rank"/);
    await request(app).get(`/api/session/${sessionId}/own-results`).set(token).expect(409);
    expect((await request(app).get(`/api/session/${sessionId}/leaderboard`).expect(200)).body.entries).toEqual([]);
    await request(app).post(`/api/session/${sessionId}/availability`).send({ availableUntil: Date.now() + 10_000 }).expect(401);
    const late = once(first, SocketEvents.ANSWER_REJECTED);first.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, selectedOptions: ["B"] });expect(await late).toMatchObject({ reason: "Availability ended" });
    first.disconnect();
    const fresh = socket();const freshRefused = once(fresh, SocketEvents.STUDENT_REJECTED);fresh.connect();fresh.emit(SocketEvents.STUDENT_JOIN, { studentId: "new-seat" });expect(await freshRefused).toMatchObject({ reason: expect.stringContaining("Availability ended") });
    const nameOnly = socket();const sameDeviceRefused = once(nameOnly, SocketEvents.STUDENT_REJECTED);nameOnly.connect();nameOnly.emit(SocketEvents.STUDENT_JOIN, { studentId: "synthetic-seat", clientInstanceId: "same-device" });await sameDeviceRefused;
    const again = socket();const againJoined = once<StudentJoinedPayload>(again, SocketEvents.STUDENT_JOINED);again.connect();again.emit(SocketEvents.STUDENT_JOIN, { studentId: "synthetic-seat", sessionToken: seat.sessionToken });
    expect(await againJoined).toMatchObject({ sessionToken: seat.sessionToken, availability: { phase: "expired" }, answers: [{ questionIndex: 0, selectedOptions: [0] }] });
    const before = serializeSession(getSession(sessionId)!);
    const extendedUntil = Date.now() + 10_000;
    await teacher.post(`/api/session/${sessionId}/availability`).send({ availableUntil: extendedUntil }).expect(200);
    expect(getSession(sessionId)!.availability?.generation).toBe(2);
    const original = deserializeSession(before);const recovered = getSession(sessionId)!;
    expect(serializeSession({ ...recovered, availability: original.availability })).toBe(before);
    storeSession(deserializeSession(serializeSession(recovered)));
    expect((await request(app).get(`/api/session/by-code/${made.body.sessionCode}`).expect(200)).body.sessionId).toBe(sessionId);
    const actual = getSession(sessionId)!;actual.availability!.availableUntil = Date.now() - 1;
    const end = await teacher.post(`/api/session/${sessionId}/end`).expect(200);expect(end.body.state).toBe("ENDED");
    const finality = await request(app).get(`/api/session/${sessionId}/availability`).expect(200);
    expect(finality.body.phase).toBe("ended");expect(finality.body.recoverBefore).toBeUndefined();
    expect(finality.body.resultRetainedUntil).toBe(actual.resultScope!.endedAt + SESSION_RECOVERY_MS);
    expect((await request(app).get(`/api/session/${sessionId}/own-results`).set(token).expect(200)).body.questions[0].correct).toBe(true);
    await teacher.post(`/api/session/${sessionId}/availability`).send({ availableUntil: Date.now() + 20_000 }).expect(400);
    const finalTimestamp = actual.resultScope!.endedAt;
    await teacher.post(`/api/session/${sessionId}/end`).expect(200);expect(actual.resultScope!.endedAt).toBe(finalTimestamp);
  } finally {
    sockets.forEach(value => value.disconnect());await new Promise<void>(resolve => ioServer.close(() => resolve()));
    clearAllSessions();clearInstructorSessionsForTests();
    if (oldPassword === undefined) delete process.env.INSTRUCTOR_PASSWORD;else process.env.INSTRUCTOR_PASSWORD = oldPassword;
    if (oldKey === undefined) delete process.env.INSTRUCTOR_KEY;else process.env.INSTRUCTOR_KEY = oldKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

it("native notification/purge alarms resolve rehydrated identity and purge unrecovered data without End", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-availability-purge-"));
  fs.writeFileSync(path.join(dir, "synthetic.md"), DECK);
  const oldPassword = process.env.INSTRUCTOR_PASSWORD;const oldKey = process.env.INSTRUCTOR_KEY;
  delete process.env.INSTRUCTOR_PASSWORD;delete process.env.INSTRUCTOR_KEY;
  clearAllSessions();clearInstructorSessionsForTests();
  let now: jest.SpyInstance | undefined;
  try {
    const app = createApp({ quizDir: dir, dataDir: path.join(dir, "runtime") });
    const expiry = Date.now() + 300;
    const made = await request(app).post("/api/session").send({ week: "synthetic", availableUntil: expiry }).expect(201);
    const restored = deserializeSession(serializeSession(getSession(made.body.sessionId)!));storeSession(restored);
    now = jest.spyOn(Date, "now").mockReturnValue(expiry + SESSION_RECOVERY_MS + 1);
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(getSession(made.body.sessionId)).toBeUndefined();
    expect(restored.deletedAt).toBe(expiry + SESSION_RECOVERY_MS + 1);
    expect(restored.state).toBe("LOBBY");expect(restored.resultScope).toBeUndefined();
    expect(fs.existsSync(path.join(dir, "runtime", "winners"))).toBe(false);
    await request(app).get(`/api/session/by-code/${made.body.sessionCode}`).expect(404);
    await request(app).get(`/api/session/${made.body.sessionId}/availability`).expect(410);
  } finally {
    now?.mockRestore();clearAllSessions();clearInstructorSessionsForTests();
    if (oldPassword === undefined) delete process.env.INSTRUCTOR_PASSWORD;else process.env.INSTRUCTOR_PASSWORD = oldPassword;
    if (oldKey === undefined) delete process.env.INSTRUCTOR_KEY;else process.env.INSTRUCTOR_KEY = oldKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
