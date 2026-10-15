import { createServer } from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import request from "supertest";
import { Server } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { PollLivePayload, Quiz, SocketEvents, StudentJoinedPayload } from "@mdq/shared";
import { createApp } from "../app";
import { clearAllSessions } from "../session";
import { setupSocket, emitMessages } from "../socket";

// Intentional public, synthetic fixture. No teaching-instance content.
const DECK = `# Synthetic live poll

---

## Live poll

type: poll
time-limit: none
live-results: on

**Choose.**

A. One
B. Two
`;

describe("live poll counts over real sockets", () => {
  let dir: string;
  let httpServer: ReturnType<typeof createServer>;
  let ioServer: Server;
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;
  const sockets: ClientSocket[] = [];

  beforeAll((done) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-poll-live-"));
    fs.writeFileSync(path.join(dir, "live.md"), DECK);
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

  interface Recorder { socket: ClientSocket; events: { event: string; payload: unknown }[] }
  const connect = (sessionId: string, role?: string): Recorder => {
    const socket = ioClient(baseUrl, { autoConnect: false, auth: { sessionId, role }, transports: ["websocket"] });
    const events: Recorder["events"] = [];
    socket.onAny((event: string, payload: unknown) => events.push({ event, payload }));
    sockets.push(socket);
    socket.connect();
    return { socket, events };
  };
  const until = async (condition: () => boolean, label: string) => {
    for (let i = 0; i < 100 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 30));
    if (!condition()) throw new Error(`Timed out: ${label}`);
  };
  const joinAs = async (sessionId: string, studentId: string) => {
    const recorder = connect(sessionId);
    await until(() => recorder.socket.connected, "phone connects");
    recorder.socket.emit(SocketEvents.STUDENT_JOIN, { studentId, displayName: `Name ${studentId}` });
    await until(() => recorder.events.some((e) => e.event === SocketEvents.STUDENT_JOINED), "phone joins");
    return recorder;
  };
  const live = (recorder: Recorder) => recorder.events.filter((e) => e.event === SocketEvents.POLL_LIVE).map((e) => e.payload as PollLivePayload);
  const counted = (recorder: Recorder) => live(recorder).filter((p) => "counts" in p && p.counts !== null);

  it("sends each new count to every earlier voter, never to a phone that has not voted", async () => {
    const { sessionId } = (await request(app).post("/api/session").send({ week: "live" }).expect(201)).body;
    const control = connect(sessionId, "instructor");
    const display = connect(sessionId, "presentation");
    await until(() => control.socket.connected && display.socket.connected, "staff connect");
    const phones = [];
    for (const id of ["ZQ-1", "ZQ-2", "ZQ-3", "ZQ-4"]) phones.push(await joinAs(sessionId, id));
    await request(app).post(`/api/session/${sessionId}/start`).expect(200);
    const [first, second, third, unvoted] = phones;
    for (const [index, phone] of [first, second, third].entries()) {
      phone.socket.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, selectedOptions: [index === 2 ? "B" : "A"] });
      await until(() => phone.events.some((e) => e.event === SocketEvents.ANSWER_ACCEPTED), `vote ${index + 1} accepted`);
    }
    const final = { questionIndex: 0, voters: 3, counts: { A: 2, B: 1 } };
    for (const [label, phone] of [["first", first], ["second", second], ["third", third]] as const) {
      await until(() => counted(phone).some((p) => JSON.stringify(p) === JSON.stringify(final)), `${label} voter receives the third vote's counts`);
      expect(counted(phone).filter((p) => JSON.stringify(p) === JSON.stringify(final))).toHaveLength(1);
    }
    await until(() => counted(display).some((p) => JSON.stringify(p) === JSON.stringify(final)), "projector receives counts");
    await until(() => counted(control).some((p) => JSON.stringify(p) === JSON.stringify(final)), "presenter receives counts");
    expect(live(unvoted)).toEqual([]);
    for (const recorder of [first, second, third, display, control]) {
      expect(JSON.stringify(live(recorder))).not.toMatch(/ZQ-|Name /);
    }
    const joined = first.events.find((e) => e.event === SocketEvents.STUDENT_JOINED)?.payload as StudentJoinedPayload;
    expect(joined.participantId).toBe("ZQ-1");
  });
});
