import { createServer } from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import request from "supertest";
import { Server } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { JOIN_LOCKED_MESSAGE, Quiz, SocketEvents, StudentJoinedPayload, SessionParticipantsPayload } from "@mdq/shared";
import { createApp } from "../app";
import { clearAllSessions } from "../session";
import { setupSocket, emitMessages } from "../socket";
import { clearInstructorSessionsForTests } from "../instructor-auth";

const DECK = `# Join Lock

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

describe("locking joining over real sockets", () => {
  let dir: string;
  let httpServer: ReturnType<typeof createServer>;
  let ioServer: Server;
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;
  const sockets: ClientSocket[] = [];

  beforeAll((done) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-join-lock-"));
    fs.writeFileSync(path.join(dir, "lock.md"), DECK);
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
  const release = (sessionId: string, publicKey: string) => request(app).post(`/api/session/${sessionId}/release-seat`).send({ publicKey });
  const setLock = (sessionId: string, body: unknown) => request(app).post(`/api/session/${sessionId}/join-lock`).send(body as object);
  const joinAs = async (sessionId: string, payload: object) => {
    const recorder = connect(sessionId);
    await until(() => recorder.socket.connected, "phone connects");
    recorder.socket.emit(SocketEvents.STUDENT_JOIN, payload);
    await until(() => recorder.events.some((e) => e.event === SocketEvents.STUDENT_JOINED || e.event === SocketEvents.STUDENT_REJECTED), "phone joins or is refused");
    const joinedEvent = recorder.events.find((e) => e.event === SocketEvents.STUDENT_JOINED);
    return { recorder, joined: joinedEvent?.payload as StudentJoinedPayload | undefined };
  };
  const last = <T>(recorder: Recorder, event: string) => recorder.events.filter((e) => e.event === event).pop()?.payload as T;

  const create = async () => (await request(app).post("/api/session").send({ week: "lock" }).expect(201)).body.sessionId as string;
  const lockedList = (r: Recorder) => last<SessionParticipantsPayload>(r, SocketEvents.SESSION_PARTICIPANTS)?.joinLocked;
  const reasons = (r: Recorder) => r.events.filter((e) => e.event === SocketEvents.STUDENT_REJECTED).map((e) => (e.payload as { reason: string }).reason);

  it("refuses a new join while locked, lets a rejoin and a takeover through, and tells only control and display", async () => {
    const sessionId = await create();
    const control = connect(sessionId, "instructor");
    const display = connect(sessionId, "presentation");
    await until(() => control.socket.connected && display.socket.connected, "staff connect");
    const first = await joinAs(sessionId, { studentId: ID, displayName: "Alex Tan", clientInstanceId: "phone-1" });
    expect(first.joined).toBeDefined();
    const phoneEventsBefore = first.recorder.events.length;

    const res = await setLock(sessionId, { locked: true }).expect(200);
    expect(res.body).toEqual({ locked: true });
    await until(() => lockedList(control) === true && lockedList(display) === true, "control and display see the lock");
    // The phone that is already in is told nothing about the lock.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(first.recorder.events.slice(phoneEventsBefore).filter((e) => /lock/i.test(e.text))).toEqual([]);

    // A new person is refused with the plain message and does not show up for the presenter.
    const refused = await joinAs(sessionId, { studentId: "ZQ-2002", displayName: "Sam Lee", clientInstanceId: "phone-2" });
    expect(refused.joined).toBeUndefined();
    expect(reasons(refused.recorder)).toEqual([JOIN_LOCKED_MESSAGE]);
    expect(last<SessionParticipantsPayload>(control, SocketEvents.SESSION_PARTICIPANTS).count).toBe(1);

    // The same phone dropping and coming back with its token is let in.
    const token = first.joined!.sessionToken;
    first.recorder.socket.disconnect();
    await until(() => (last<SessionParticipantsPayload>(control, SocketEvents.SESSION_PARTICIPANTS)?.offline ?? []).length === 1, "phone shows offline");
    const back = await joinAs(sessionId, { studentId: ID, displayName: "Alex Tan", clientInstanceId: "phone-1", sessionToken: token });
    expect(back.joined?.publicKey).toBe(first.joined!.publicKey);

    // A freed seat is taken over by another device while locked, but a stranger still cannot join.
    await release(sessionId, first.joined!.publicKey).expect(200);
    const stranger = await joinAs(sessionId, { studentId: "ZQ-3003", displayName: "Pat Ong", clientInstanceId: "phone-3" });
    expect(stranger.joined).toBeUndefined();
    const other = await joinAs(sessionId, { studentId: ID, displayName: "Alex Tan", clientInstanceId: "phone-new" });
    expect(other.joined?.publicKey).toBe(first.joined!.publicKey);
    expect(lockedList(control)).toBe(true);

    // Unlocking lets new people in, and the screens hear it.
    await setLock(sessionId, { locked: false }).expect(200);
    await until(() => lockedList(control) === undefined && lockedList(display) === undefined, "screens see it unlocked");
    const late = await joinAs(sessionId, { studentId: "ZQ-2002", displayName: "Sam Lee", clientInstanceId: "phone-2" });
    expect(late.joined).toBeDefined();
  });

  it("tells a projector or instructor that connects later", async () => {
    const sessionId = await create();
    await setLock(sessionId, { locked: true }).expect(200);
    const control = connect(sessionId, "instructor");
    const display = connect(sessionId, "presentation");
    await until(() => lockedList(control) === true && lockedList(display) === true, "late screens see the lock");
    const restore = await request(app).get(`/api/session/${sessionId}/state`).expect(200);
    expect(restore.body.joinLocked).toBe(true);
    const presentation = await request(app).get(`/api/session/${sessionId}/presentation`).expect(200);
    expect(presentation.body.joinLocked).toBe(true);
  });

  it("cannot be set from the projector or a phone, and the route checks its input", async () => {
    const sessionId = await create();
    const display = connect(sessionId, "presentation");
    const phone = await joinAs(sessionId, { studentId: ID, displayName: "Alex Tan" });
    await until(() => display.socket.connected, "projector connects");
    // Sockets carry no lock command at all: emitting one changes nothing.
    display.socket.emit("session:join-lock", { locked: true });
    display.socket.emit("joinLock", { locked: true });
    phone.recorder.socket.emit("session:join-lock", { locked: true });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const stranger = await joinAs(sessionId, { studentId: "ZQ-2002", displayName: "Sam Lee" });
    expect(stranger.joined).toBeDefined();
    await setLock("nope", { locked: true }).expect(404);
    await setLock(sessionId, {}).expect(400);
    await setLock(sessionId, { locked: "yes" }).expect(400);
    await setLock(sessionId, { locked: 1 }).expect(400);
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
      const { sessionId } = (await agent.post("/api/session").send({ week: "lock" }).expect(201)).body;
      await request(protectedApp).post(`/api/session/${sessionId}/join-lock`).send({ locked: true }).expect(401);
      await agent.post(`/api/session/${sessionId}/join-lock`).send({ locked: true }).expect(200);
    });
  });
});
