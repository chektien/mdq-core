import { IncomingMessage, ServerResponse } from "http";
import { Socket } from "net";
import { Duplex } from "stream";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { API, SocketEvents } from "@mdq/shared";
import { createApp } from "../app";
import { apply, EngineResult } from "../engine";
import { clearAllSessions, getSession, storeSession } from "../session";
import { clearInstructorSessionsForTests } from "../instructor-auth";

// Run the real Express middleware and routes without a network listener.
const post = (app: ReturnType<typeof createApp>, url: string, body: unknown, cookie?: string) =>
  new Promise<{ status: number; body: Record<string, unknown>; cookies: string[] }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }) as Socket;
    const req = new IncomingMessage(socket);
    const json = JSON.stringify(body);
    req.method = "POST";
    req.url = url;
    req.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(json)), ...(cookie ? { cookie } : {}) };
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    res.on("error", reject);
    res.on("finish", () => {
      const payload = Buffer.concat(chunks).toString().split("\r\n\r\n")[1];
      const cookieHeader = res.getHeader("set-cookie");
      const cookies = Array.isArray(cookieHeader) ? cookieHeader : typeof cookieHeader === "string" ? [cookieHeader] : [];
      resolve({ status: res.statusCode, body: payload ? JSON.parse(payload) : {}, cookies });
      socket.destroy();
    });
    app(req, res);
    req.push(json);
    req.push(null);
  });

// Intentional public, synthetic fixtures. No teaching-instance content.
const DECK = `# Synthetic route poll
---
## Poll
type: poll
time-limit: none
multi-select: true
live-results: on
Choose.
A. One
B. Two
---
## Scored
time-limit: none
Choose.
A. One
B. Two
> Correct Answer: A
`;

describe("live-results HTTP route", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let emitted: EngineResult | undefined;
  const originalPassword = process.env.INSTRUCTOR_PASSWORD;
  const originalKey = process.env.INSTRUCTOR_KEY;
  beforeEach(() => {
    delete process.env.INSTRUCTOR_PASSWORD;
    delete process.env.INSTRUCTOR_KEY;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-poll-route-"));
    fs.writeFileSync(path.join(dir, "on.md"), DECK);
    fs.writeFileSync(path.join(dir, "off.md"), DECK.replace("Synthetic route poll", "Synthetic private poll").replace("live-results: on", "live-results: off"));
    emitted = undefined;
    app = createApp({ quizDir: dir, dataDir: path.join(dir, "data"), onMessages: (_session, _id, result) => { emitted = result; } });
  });
  afterEach(() => {
    if (originalPassword === undefined) delete process.env.INSTRUCTOR_PASSWORD; else process.env.INSTRUCTOR_PASSWORD = originalPassword;
    if (originalKey === undefined) delete process.env.INSTRUCTOR_KEY; else process.env.INSTRUCTOR_KEY = originalKey;
    clearInstructorSessionsForTests();
    clearAllSessions();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const route = (id: string) => API.SESSION_LIVE_RESULTS.replace(":id", id);
  const start = async (week = "on", selfPaced = false, voters = 3) => {
    const created = await post(app, API.SESSION_CREATE, { week });
    expect(created.status).toBe(201);
    const id = created.body.sessionId as string;
    if (selfPaced) expect((await post(app, `/api/session/${id}/policy`, { pacing: "self-paced" })).status).toBe(200);
    expect((await post(app, `/api/session/${id}/start`, {})).status).toBe(200);
    const session = getSession(id)!;
    const quiz = session.deckSnapshot!;
    for (const studentId of ["synthetic-one", "synthetic-two", "synthetic-three"].slice(0, voters)) {
      Object.assign(session, apply(session, quiz, { type: "join", payload: { studentId }, socketId: studentId, newToken: studentId }, Date.now()).session);
      Object.assign(session, apply(session, quiz, { type: "answerSubmit", studentId, sessionToken: studentId,
        payload: { questionIndex: 0, selectedOptions: ["A", "B"] } }, Date.now()).session);
    }
    storeSession(session);
    return session;
  };

  it.each([false, true])("hides public counts while retaining the control feed and votes (self-paced=%s)", async selfPaced => {
    const session = await start("on", selfPaced);
    const before = JSON.stringify({ votes: session.submissions, timing: session.questionTiming, policy: session.policy });
    expect((await post(app, route(session.sessionId), { questionIndex: 0, visible: false })).status).toBe(200);
    expect(getSession(session.sessionId)!.liveResultsOverrides).toEqual({ "0": false });
    expect(JSON.stringify({ votes: session.submissions, timing: session.questionTiming, policy: session.policy })).toBe(before);
    const messages = emitted!.messages.filter(m => m.event === SocketEvents.POLL_LIVE);
    expect(messages.find(m => m.audience === "control")?.payload).toEqual({ questionIndex: 0, voters: 3, counts: { A: 3, B: 3 } });
    const publicMessages = messages.filter(m => m.audience !== "control");
    expect(publicMessages.map(m => m.audience)).toEqual(["display", "participant:synthetic-one", "participant:synthetic-two", "participant:synthetic-three"]);
    for (const message of publicMessages) expect(message.payload).toEqual({ questionIndex: 0, hidden: true });
    expect((await post(app, route(session.sessionId), { questionIndex: 0, visible: true })).status).toBe(200);
    for (const message of emitted!.messages) expect(message.payload).toMatchObject({ voters: 3, counts: { A: 3, B: 3 } });
  });

  it.each([false, true])("shows a poll authored off (self-paced=%s)", async selfPaced => {
    const session = await start("off", selfPaced, 1);
    const result = await post(app, route(session.sessionId), { questionIndex: 0, visible: true });
    expect(result).toMatchObject({ status: 200, body: { questionIndex: 0, visible: true } });
    expect(getSession(session.sessionId)!.liveResultsOverrides).toEqual({ "0": true });
    expect(emitted!.messages).toHaveLength(3);
    expect(emitted!.messages.find(m => m.audience === "control")?.payload).toEqual({ questionIndex: 0, voters: 1, counts: { A: 1, B: 1 } });
    for (const message of emitted!.messages.filter(m => m.audience !== "control")) {
      expect(message.payload).toEqual({ questionIndex: 0, voters: 1, counts: null, floor: 3 });
    }
  });

  it("can hide live results after the poll closes", async () => {
    const session = await start();
    expect((await post(app, `/api/session/${session.sessionId}/close`, {})).status).toBe(200);
    expect((await post(app, route(session.sessionId), { questionIndex: 0, visible: false })).status).toBe(200);
    expect(session.state).toBe("QUESTION_CLOSED");
    expect(emitted!.messages.find(m => m.audience === "control")?.payload).toMatchObject({ voters: 3, counts: { A: 3, B: 3 } });
    for (const message of emitted!.messages.filter(m => m.audience !== "control")) expect(message.payload).toEqual({ questionIndex: 0, hidden: true });
  });

  it("requires control authentication", async () => {
    const session = await start();
    process.env.INSTRUCTOR_PASSWORD = "synthetic-password";
    expect((await post(app, route(session.sessionId), { questionIndex: 0, visible: false })).status).toBe(401);
    expect(session.liveResultsOverrides).toBeUndefined();
    const login = await post(app, "/api/instructor/login", { password: "synthetic-password" });
    expect(login.status).toBe(204);
    expect((await post(app, route(session.sessionId), { questionIndex: 0, visible: false }, login.cookies[0].split(";")[0])).status).toBe(200);
    expect(session.liveResultsOverrides).toEqual({ "0": false });
  });

  it("returns 400 for bad bodies and engine command errors", async () => {
    const session = await start();
    for (const body of [{}, { questionIndex: "0", visible: true }, { questionIndex: 0.5, visible: true }, { questionIndex: 0 },
      { questionIndex: 0, visible: "false" }, { questionIndex: -1, visible: true }, { questionIndex: 99, visible: true }, { questionIndex: 1, visible: true }]) {
      expect((await post(app, route(session.sessionId), body)).status).toBe(400);
    }
    expect((await post(app, `/api/session/${session.sessionId}/end`, {})).status).toBe(200);
    expect((await post(app, route(session.sessionId), { questionIndex: 0, visible: true })).status).toBe(400);
    expect(session.liveResultsOverrides).toBeUndefined();
    expect(emitted).toBeUndefined();
  });
});
