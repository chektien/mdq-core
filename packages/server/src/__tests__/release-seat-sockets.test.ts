import { createServer } from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import request from "supertest";
import { Server } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { Quiz, SocketEvents, StudentJoinedPayload, SessionParticipantsPayload } from "@mdq/shared";
import { createApp } from "../app";
import { clearAllSessions } from "../session";
import { setupSocket, emitMessages } from "../socket";
import { clearInstructorSessionsForTests } from "../instructor-auth";

const DECK = `# Release Seat

---

## First

time-limit: 60

**Pick one.**

A. One
B. Two

> Correct Answer: A. One
> Overall Feedback: Yes.

---

## Second

time-limit: 60

**Pick again.**

A. One
B. Two

> Correct Answer: B. Two
> Overall Feedback: Yes.
`;
const ID = "ZQ-1001";

describe("freeing a seat over real sockets", () => {
  let dir: string;
  let httpServer: ReturnType<typeof createServer>;
  let ioServer: Server;
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;
  const sockets: ClientSocket[] = [];

  beforeAll((done) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-release-seat-"));
    fs.writeFileSync(path.join(dir, "seat.md"), DECK);
    const ioRef: { current: Server | null } = { current: null };
    app = createApp({
      quizDir: dir,
      dataDir: path.join(dir, "data"),
      onMessages: (_session, sessionId, result) => { if (ioRef.current) emitMessages(ioRef.current, sessionId, result.messages); },
      onStateChange: (_session, sessionId, _state, _quiz, result) => { if (ioRef.current && result) emitMessages(ioRef.current, sessionId, result.messages); },
    });
    httpServer = createServer(app);
    ioServer = setupSocket(httpServer, (app as unknown as { _quizzes: Map<string, Quiz> })._quizzes);
    ioRef.current = ioServer;
    httpServer.listen(0, () => {
      baseUrl = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
      done();
    });
  });

  afterEach(() => {
    while (sockets.length) sockets.pop()!.disconnect();
    clearAllSessions();
  });

  afterAll((done) => {
    ioServer.close();
    httpServer.close(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      done();
    });
  });

  interface Recorder { socket: ClientSocket; events: { event: string; text: string; payload: unknown }[] }
  const connect = (sessionId: string, role?: string): Recorder => {
    const socket = ioClient(baseUrl, { autoConnect: false, auth: { sessionId, role }, transports: ["websocket"] });
    const events: Recorder["events"] = [];
    socket.onAny((event: string, payload: unknown) => events.push({ event, text: JSON.stringify(payload), payload }));
    sockets.push(socket);
    socket.connect();
    return { socket, events };
  };
  const until = async (condition: () => boolean, label: string) => {
    for (let i = 0; i < 100 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 30));
    if (!condition()) throw new Error(`Timed out: ${label}`);
  };
  const post = (sessionId: string, action: string) => request(app).post(`/api/session/${sessionId}/${action}`).expect(200);
  const release = (sessionId: string, publicKey: string) => request(app).post(`/api/session/${sessionId}/release-seat`).send({ publicKey });
  const joinAs = async (sessionId: string, payload: object) => {
    const recorder = connect(sessionId);
    await until(() => recorder.socket.connected, "phone connects");
    recorder.socket.emit(SocketEvents.STUDENT_JOIN, payload);
    await until(() => recorder.events.some((e) => e.event === SocketEvents.STUDENT_JOINED || e.event === SocketEvents.STUDENT_REJECTED), "phone joins or is refused");
    const joinedEvent = recorder.events.find((e) => e.event === SocketEvents.STUDENT_JOINED);
    return { recorder, joined: joinedEvent?.payload as StudentJoinedPayload | undefined };
  };
  const last = <T>(recorder: Recorder, event: string) => recorder.events.filter((e) => e.event === event).pop()?.payload as T;

  it("lets the same ID join from a new device and keeps the answers, label and key", async () => {
    const { sessionId } = (await request(app).post("/api/session").send({ week: "seat" }).expect(201)).body;
    const control = connect(sessionId, "instructor");
    const display = connect(sessionId, "presentation");
    await until(() => control.socket.connected && display.socket.connected, "staff connect");
    const oldPhone = await joinAs(sessionId, { studentId: ID, displayName: "Alex Tan", clientInstanceId: "phone-old" });
    await post(sessionId, "start");
    oldPhone.recorder.socket.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, selectedOptions: ["A"] });
    await until(() => oldPhone.recorder.events.some((e) => e.event === SocketEvents.ANSWER_ACCEPTED), "first answer accepted");

    // Another device is refused while the old one holds the seat.
    const refused = await joinAs(sessionId, { studentId: ID, displayName: "Alex Tan", clientInstanceId: "phone-new" });
    expect(refused.joined).toBeUndefined();

    const key = oldPhone.joined!.publicKey;
    await release("nope", key).expect(404);
    await release(sessionId, "").expect(400);
    await release(sessionId, "not-a-key").expect(400);
    await release(sessionId, key).expect(200);
    await until(() => (last<SessionParticipantsPayload>(control, SocketEvents.SESSION_PARTICIPANTS)?.offline ?? []).some((o) => o.released), "instructor sees the freed seat");
    // The projector never learns about offline seats or IDs.
    expect(JSON.stringify(last(display, SocketEvents.SESSION_PARTICIPANTS))).not.toContain(ID);
    expect(last<SessionParticipantsPayload>(display, SocketEvents.SESSION_PARTICIPANTS).offline).toBeUndefined();

    // The old phone can no longer answer for the seat.
    oldPhone.recorder.socket.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, selectedOptions: ["B"] });
    await until(() => oldPhone.recorder.events.some((e) => e.event === SocketEvents.ANSWER_REJECTED), "old phone refused");

    const newPhone = await joinAs(sessionId, { studentId: ID, displayName: "Alex Tan", clientInstanceId: "phone-new" });
    expect(newPhone.joined).toMatchObject({ participantId: ID, publicKey: key, label: "Alex Tan" });
    expect(newPhone.joined!.sessionToken).not.toBe(oldPhone.joined!.sessionToken);
    expect(newPhone.joined!.answers).toEqual([{ questionIndex: 0, selectedOptions: [0] }]);
    await until(() => last<SessionParticipantsPayload>(control, SocketEvents.SESSION_PARTICIPANTS).count === 1, "back online");
    expect(last<SessionParticipantsPayload>(control, SocketEvents.SESSION_PARTICIPANTS).offline).toBeUndefined();

    // The new phone answers the next question; the old token cannot take the seat back.
    await post(sessionId, "close");
    await post(sessionId, "reveal");
    await post(sessionId, "next");
    newPhone.recorder.socket.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 1, selectedOptions: ["B"] });
    await until(() => newPhone.recorder.events.some((e) => e.event === SocketEvents.ANSWER_ACCEPTED), "new phone answers");
    const stale = await joinAs(sessionId, { studentId: ID, displayName: "Alex Tan", sessionToken: oldPhone.joined!.sessionToken, clientInstanceId: "phone-old" });
    expect(stale.joined).toBeUndefined();
    const csv = (await request(app).get(`/api/session/${sessionId}/results.csv`).expect(200)).text;
    expect(csv.split("\n").filter((line) => line.includes(ID))).toHaveLength(1);
  });

  it("lists a seat that went offline so the presenter can free it", async () => {
    const { sessionId } = (await request(app).post("/api/session").send({ week: "seat" }).expect(201)).body;
    const control = connect(sessionId, "instructor");
    await until(() => control.socket.connected, "instructor connects");
    const phone = await joinAs(sessionId, { studentId: ID, displayName: "Alex Tan", clientInstanceId: "phone-old" });
    phone.recorder.socket.disconnect();
    await until(() => (last<SessionParticipantsPayload>(control, SocketEvents.SESSION_PARTICIPANTS)?.offline ?? []).length === 1, "offline seat listed");
    const listed = last<SessionParticipantsPayload>(control, SocketEvents.SESSION_PARTICIPANTS);
    expect(listed.count).toBe(0);
    expect(listed.offline![0]).toMatchObject({ publicKey: phone.joined!.publicKey, studentId: ID, label: "Alex Tan" });
    expect(listed.offline![0].released).toBeUndefined();
    await release(sessionId, phone.joined!.publicKey).expect(200);
    const other = await joinAs(sessionId, { studentId: ID, displayName: "Alex Tan", clientInstanceId: "phone-new" });
    expect(other.joined?.publicKey).toBe(phone.joined!.publicKey);
  });

  describe("with an instructor password", () => {
    const original = process.env.INSTRUCTOR_PASSWORD;
    afterEach(() => {
      if (typeof original === "string") process.env.INSTRUCTOR_PASSWORD = original; else delete process.env.INSTRUCTOR_PASSWORD;
      clearInstructorSessionsForTests();
    });

    it("keeps the route to the instructor", async () => {
      process.env.INSTRUCTOR_PASSWORD = "secret-password";
      const protectedApp = createApp({ quizDir: dir, dataDir: path.join(dir, "data") });
      const agent = request.agent(protectedApp);
      await agent.post("/api/instructor/login").send({ password: "secret-password" }).expect(204);
      const { sessionId } = (await agent.post("/api/session").send({ week: "seat" }).expect(201)).body;
      await request(protectedApp).post(`/api/session/${sessionId}/release-seat`).send({ publicKey: "k" }).expect(401);
      await agent.post(`/api/session/${sessionId}/release-seat`).send({ publicKey: "k" }).expect(400);
    });
  });
});
