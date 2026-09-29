import { createServer } from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import request from "supertest";
import { Server } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { Quiz, SocketEvents, AnswerCountPayload, ResultsRevealPayload, StudentJoinedPayload } from "@mdq/shared";
import { createApp, resultsFileName } from "../app";
import { clearAllSessions } from "../session";
import { setupSocket, emitMessages } from "../socket";
import { clearInstructorSessionsForTests } from "../instructor-auth";

const DECK = `# Moderation Sockets

---

## Say something

question-type: open-response
time-limit: 60

Share a thought.

> Overall Feedback: Thanks.
`;
const TEXTS = ["Kind words from Alex", "Rude words from Sam", "Plain words from Robin"];
const IDS = ["ZQ-1001", "ZQ-2002", "ZQ-3003"];

describe("open response moderation over real sockets", () => {
  let dir: string;
  let httpServer: ReturnType<typeof createServer>;
  let ioServer: Server;
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;
  const sockets: ClientSocket[] = [];

  beforeAll((done) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-moderation-"));
    fs.writeFileSync(path.join(dir, "moderation.md"), DECK);
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
  const joinAs = async (sessionId: string, payload: object) => {
    const recorder = connect(sessionId);
    await until(() => recorder.socket.connected, "phone connects");
    recorder.socket.emit(SocketEvents.STUDENT_JOIN, payload);
    await until(() => recorder.events.some((e) => e.event === SocketEvents.STUDENT_JOINED), "phone joins");
    return { recorder, joined: recorder.events.find((e) => e.event === SocketEvents.STUDENT_JOINED)!.payload as StudentJoinedPayload };
  };
  const last = <T>(recorder: Recorder, event: string) => recorder.events.filter((e) => e.event === event).pop()?.payload as T;
  const revealsOf = (recorder: Recorder) => recorder.events.filter((e) => e.event === SocketEvents.RESULTS_REVEAL).map((e) => e.payload as ResultsRevealPayload);
  const setVisibility = (sessionId: string, questionIndex: number, publicKey: string, hidden: boolean) =>
    request(app).post(`/api/session/${sessionId}/response-visibility`).send({ questionIndex, publicKey, hidden });
  const visibleTexts = (reveal: ResultsRevealPayload) => (reveal.openResponses ?? []).map((r) => r.responseText).sort();

  it("never sends a hidden response to the projector or a phone, and moves the projector at once", async () => {
    const created = await request(app).post("/api/session").send({ week: "moderation" }).expect(201);
    const { sessionId } = created.body;
    const control = connect(sessionId, "instructor");
    const display = connect(sessionId, "presentation");
    await until(() => control.socket.connected && display.socket.connected, "staff connect");
    const phones = [
      await joinAs(sessionId, { studentId: IDS[0], displayName: "Alex Tan" }),
      await joinAs(sessionId, { studentId: IDS[1], displayName: "Sam Lee" }),
      await joinAs(sessionId, { studentId: IDS[2], displayName: "Robin Ng" }),
    ];
    await post(sessionId, "start");
    phones.forEach(({ recorder }, i) => recorder.socket.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, responseText: TEXTS[i] }));
    await until(() => (last<AnswerCountPayload>(control, SocketEvents.ANSWER_COUNT)?.openResponses ?? []).length === 3, "instructor sees all three");

    // The instructor sees every response live; the projector only a count.
    const live = last<AnswerCountPayload>(control, SocketEvents.ANSWER_COUNT);
    expect(live.openResponses!.map((r) => r.responseText).sort()).toEqual([...TEXTS].sort());
    await until(() => last<AnswerCountPayload>(display, SocketEvents.ANSWER_COUNT)?.submitted === 3, "projector count");
    expect(last<AnswerCountPayload>(display, SocketEvents.ANSWER_COUNT).openResponses).toBeUndefined();

    // Hide Sam's response before the reveal.
    const sam = live.openResponses!.find((r) => r.responseText === TEXTS[1])!;
    await setVisibility(sessionId, 0, sam.publicKey, true).expect(200);
    await until(() => last<AnswerCountPayload>(control, SocketEvents.ANSWER_COUNT).openResponses!.some((r) => r.hidden), "instructor sees the flag");
    expect(display.events.filter((e) => e.event === SocketEvents.RESULTS_REVEAL)).toHaveLength(0);

    await post(sessionId, "close");
    await post(sessionId, "reveal");
    await until(() => revealsOf(display).length === 1 && revealsOf(control).length === 1, "reveal delivered");
    expect(visibleTexts(revealsOf(display)[0])).toEqual([TEXTS[0], TEXTS[2]].sort());
    expect(revealsOf(control)[0].openResponses).toHaveLength(3);

    // Hide Alex's response after the reveal: the projector updates without waiting for anything else.
    const alex = live.openResponses!.find((r) => r.responseText === TEXTS[0])!;
    await setVisibility(sessionId, 0, alex.publicKey, true).expect(200);
    await until(() => revealsOf(display).length === 2, "projector update after hiding");
    expect(visibleTexts(revealsOf(display)[1])).toEqual([TEXTS[2]]);

    // Show puts it back.
    await setVisibility(sessionId, 0, sam.publicKey, false).expect(200);
    await until(() => revealsOf(display).length === 3, "projector update after showing");
    expect(visibleTexts(revealsOf(display)[2])).toEqual([TEXTS[1], TEXTS[2]].sort());

    // A projector that connects late gets the same view; the instructor's page reload sees all with flags.
    const late = connect(sessionId, "presentation");
    await until(() => revealsOf(late).length === 1, "late projector snapshot");
    expect(visibleTexts(revealsOf(late)[0])).toEqual([TEXTS[1], TEXTS[2]].sort());
    const lateControl = connect(sessionId, "instructor");
    await until(() => revealsOf(lateControl).length === 1, "late instructor snapshot");
    expect(revealsOf(lateControl)[0].openResponses!.filter((r) => r.hidden).map((r) => r.responseText)).toEqual([TEXTS[0]]);

    // Frames sent to the projector never hold a Student ID or the text of a response that was hidden at that moment.
    for (const frame of [...display.events, ...late.events]) for (const id of IDS) expect(frame.text).not.toContain(id);
    for (const frame of display.events.filter((e) => e.event === SocketEvents.ANSWER_COUNT)) for (const text of TEXTS) expect(frame.text).not.toContain(text);
    const projectorReveals = revealsOf(display);
    expect(JSON.stringify(projectorReveals[0])).not.toContain(TEXTS[1]);
    expect(JSON.stringify(projectorReveals[1])).not.toContain(TEXTS[0]);
    expect(JSON.stringify(projectorReveals[1])).not.toContain(TEXTS[1]);

    // Phones never get anyone's response text, hidden or not, and are told nothing of the change.
    for (const { recorder } of phones) {
      for (const frame of recorder.events) for (const text of TEXTS) expect(frame.text).not.toContain(text);
      for (const reveal of revealsOf(recorder)) expect(reveal.openResponses).toBeUndefined();
      expect(revealsOf(recorder)).toHaveLength(1);
    }
    // A phone that rejoins after the reveal also gets none.
    const again = connect(sessionId);
    await until(() => again.socket.connected, "phone reconnects");
    again.socket.emit(SocketEvents.STUDENT_JOIN, { studentId: IDS[0], displayName: "Alex Tan", sessionToken: phones[0].joined.sessionToken });
    await until(() => again.events.some((e) => e.event === SocketEvents.STUDENT_JOINED), "phone rejoins");
    for (const frame of again.events) for (const text of TEXTS.slice(1)) expect(frame.text).not.toContain(text);
  });

  it("refuses a bad request, an unknown question and an unknown response", async () => {
    const created = await request(app).post("/api/session").send({ week: "moderation" }).expect(201);
    const { sessionId } = created.body;
    const phone = await joinAs(sessionId, { studentId: IDS[0], displayName: "Alex Tan" });
    await post(sessionId, "start");
    phone.recorder.socket.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, responseText: TEXTS[0] });
    await until(() => phone.recorder.events.some((e) => e.event === SocketEvents.ANSWER_ACCEPTED), "accepted");
    const key = phone.joined.publicKey;
    await setVisibility(sessionId, 0, IDS[0], true).expect(400);
    await setVisibility(sessionId, 4, key, true).expect(400);
    await setVisibility(sessionId, 0, "", true).expect(400);
    await request(app).post(`/api/session/${sessionId}/response-visibility`).send({ questionIndex: "0", publicKey: key, hidden: true }).expect(400);
    await request(app).post(`/api/session/${sessionId}/response-visibility`).send({ questionIndex: 0, publicKey: key }).expect(400);
    await request(app).post("/api/session/nope/response-visibility").send({ questionIndex: 0, publicKey: key, hidden: true }).expect(404);
    await setVisibility(sessionId, 0, key, true).expect(200);
    // A phone cannot ask the server to hide anything: it has no such event.
    expect(phone.recorder.events.every((e) => !e.text.includes("hidden"))).toBe(true);
  });

  it("hands the instructor the results CSV while the session runs and after it ends", async () => {
    const created = await request(app).post("/api/session").send({ week: "moderation" }).expect(201);
    const { sessionId } = created.body;
    const phone = await joinAs(sessionId, { studentId: IDS[0], displayName: "Alex Tan" });
    await post(sessionId, "start");
    phone.recorder.socket.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, responseText: TEXTS[0] });
    await until(() => phone.recorder.events.some((e) => e.event === SocketEvents.ANSWER_ACCEPTED), "accepted");

    const running = await request(app).get(`/api/session/${sessionId}/results.csv`).expect(200);
    expect(running.headers["content-type"]).toContain("text/csv");
    expect(running.headers["cache-control"]).toBe("no-store");
    expect(running.headers["content-disposition"]).toMatch(/^attachment; filename="moderation-sockets-results-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(running.text.split("\n")[0]).toContain("student_id");
    expect(running.text).toContain(IDS[0]);
    expect(running.text).toContain(TEXTS[0]);

    await post(sessionId, "close");
    await post(sessionId, "reveal");
    await post(sessionId, "end");
    const ended = await request(app).get(`/api/session/${sessionId}/results.csv`).expect(200);
    expect(ended.text).toContain(TEXTS[0]);
    // The reveal time is still there after the end.
    expect(ended.text.split("\n")[1]).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z,Kind words from Alex/);
    await request(app).get("/api/session/nope/results.csv").expect(404);
  });

  describe("with an instructor password", () => {
    const original = process.env.INSTRUCTOR_PASSWORD;
    afterEach(() => {
      if (typeof original === "string") process.env.INSTRUCTOR_PASSWORD = original; else delete process.env.INSTRUCTOR_PASSWORD;
      clearInstructorSessionsForTests();
    });

    it("keeps the CSV and the visibility route to the instructor", async () => {
      process.env.INSTRUCTOR_PASSWORD = "secret-password";
      const protectedApp = createApp({ quizDir: dir, dataDir: path.join(dir, "data") });
      const agent = request.agent(protectedApp);
      await agent.post("/api/instructor/login").send({ password: "secret-password" }).expect(204);
      const { sessionId } = (await agent.post("/api/session").send({ week: "moderation" }).expect(201)).body;
      await request(protectedApp).get(`/api/session/${sessionId}/results.csv`).expect(401);
      await request(protectedApp).post(`/api/session/${sessionId}/response-visibility`).send({ questionIndex: 0, publicKey: "k", hidden: true }).expect(401);
      await agent.get(`/api/session/${sessionId}/results.csv`).expect(200);
    });
  });

  it("names the download from the deck title and the session date", () => {
    expect(resultsFileName("Week 1: Intro & Setup!", new Date(2026, 2, 4, 10).getTime())).toBe("week-1-intro-setup-results-2026-03-04.csv");
    expect(resultsFileName("Café Ünïcode", new Date(2026, 11, 31, 23).getTime())).toBe("cafe-unicode-results-2026-12-31.csv");
    expect(resultsFileName("!!!", new Date(2026, 0, 2).getTime())).toBe("session-results-2026-01-02.csv");
  });
});
