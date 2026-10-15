import { IncomingMessage, ServerResponse } from "http";
import { Socket } from "net";
import { Duplex } from "stream";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { API, AnswerCountPayload, ResultsRevealPayload, SocketEvents } from "@mdq/shared";
import { createApp } from "../app";
import { apply, EngineResult } from "../engine";
import { clearAllSessions, getSession } from "../session";
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

const DECK = `# Synthetic moderation route
---
## Share a thought
question-type: open-response
time-limit: none
Share.
---
## Another thought
question-type: open-response
time-limit: none
Share again.
`;

describe("response visibility HTTP routes", () => {
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let emitted: EngineResult | undefined;
  const originalPassword = process.env.INSTRUCTOR_PASSWORD;
  const originalKey = process.env.INSTRUCTOR_KEY;
  beforeEach(() => {
    delete process.env.INSTRUCTOR_PASSWORD;
    delete process.env.INSTRUCTOR_KEY;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-response-route-"));
    fs.writeFileSync(path.join(dir, "smoke.md"), DECK);
    app = createApp({ quizDir: dir, dataDir: path.join(dir, "data"), onMessages: (_session, _id, result) => { emitted = result; } });
    emitted = undefined;
  });
  afterEach(() => {
    if (originalPassword === undefined) delete process.env.INSTRUCTOR_PASSWORD; else process.env.INSTRUCTOR_PASSWORD = originalPassword;
    if (originalKey === undefined) delete process.env.INSTRUCTOR_KEY; else process.env.INSTRUCTOR_KEY = originalKey;
    clearInstructorSessionsForTests();
    clearAllSessions();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const route = (id: string, bulk = true) => (bulk ? API.SESSION_RESPONSES_VISIBILITY : API.SESSION_RESPONSE_VISIBILITY).replace(":id", id);
  const start = async () => {
    const created = await post(app, API.SESSION_CREATE, { week: "smoke" });
    expect(created.status).toBe(201);
    const id = created.body.sessionId as string;
    expect((await post(app, `/api/session/${id}/start`, {})).status).toBe(200);
    const session = getSession(id)!;
    const quiz = session.deckSnapshot!;
    for (const studentId of ["synthetic-one", "synthetic-two"]) {
      Object.assign(session, apply(session, quiz, { type: "join", payload: { studentId }, socketId: studentId, newToken: studentId }, Date.now()).session);
      Object.assign(session, apply(session, quiz, { type: "answerSubmit", studentId, sessionToken: studentId,
        payload: { questionIndex: 0, responseText: `Thought from ${studentId}` } }, Date.now()).session);
    }
    return session;
  };

  it("shows and hides all current responses live, persists flags, and retains the real total after reveal", async () => {
    const session = await start();
    expect(session.openResponsesHiddenByDefault).toBe(true);
    const before = JSON.stringify({ submissions: session.submissions, timing: session.questionTiming });
    expect((await post(app, route(session.sessionId), { questionIndex: 0, hidden: false })).status).toBe(200);
    const display = emitted!.messages.find(m => m.audience === "display" && m.event === SocketEvents.ANSWER_COUNT)!.payload as AnswerCountPayload;
    expect(display.openResponseTotal).toBe(2);
    expect(display.openResponses).toHaveLength(2);
    for (const response of display.openResponses!) expect(Object.keys(response).sort()).toEqual(["label", "publicKey", "responseText", "submittedAt"]);
    expect(session.shownResponses?.[0]).toHaveLength(2);
    expect(emitted!.messages.every(m => ["control", "display"].includes(m.audience))).toBe(true);
    const publicKey = display.openResponses![0].publicKey;
    expect((await post(app, route(session.sessionId, false), { questionIndex: 0, publicKey, hidden: true })).status).toBe(200);
    expect(session.shownResponses?.[0]).toHaveLength(1);
    expect((await post(app, `/api/session/${session.sessionId}/close`, {})).status).toBe(200);
    expect((await post(app, route(session.sessionId), { questionIndex: 0, hidden: true })).status).toBe(200);
    const closed = emitted!.messages.find(m => m.audience === "display")!.payload as AnswerCountPayload;
    expect(closed.openResponses).toEqual([]);
    expect(closed.openResponseTotal).toBe(2);
    expect((await post(app, `/api/session/${session.sessionId}/reveal`, {})).status).toBe(200);
    expect((await post(app, route(session.sessionId), { questionIndex: 0, hidden: true })).status).toBe(200);
    const revealed = emitted!.messages.find(m => m.audience === "display" && m.event === SocketEvents.RESULTS_REVEAL)!.payload as ResultsRevealPayload;
    expect(revealed.openResponses).toEqual([]);
    expect(revealed.openResponseTotal).toBe(2);
    expect(JSON.stringify({ submissions: session.submissions, timing: session.questionTiming })).toBe(before);
  });

  it("requires instructor authentication on both routes", async () => {
    const session = await start();
    process.env.INSTRUCTOR_PASSWORD = "synthetic-password";
    for (const bulk of [true, false]) expect((await post(app, route(session.sessionId, bulk), { questionIndex: 0, publicKey: "ignored", hidden: false })).status).toBe(401);
    const login = await post(app, "/api/instructor/login", { password: "synthetic-password" });
    expect(login.status).toBe(204);
    expect((await post(app, route(session.sessionId), { questionIndex: 0, hidden: false }, login.cookies[0].split(";")[0])).status).toBe(200);
    expect(session.shownResponses?.[0]).toHaveLength(2);
  });

  it("rejects invalid bulk requests and non-current items without changing visibility", async () => {
    const session = await start();
    for (const body of [{}, { questionIndex: "0", hidden: true }, { questionIndex: 0.5, hidden: true }, { questionIndex: 0 },
      { questionIndex: 0, hidden: "false" }, { questionIndex: -1, hidden: true }, { questionIndex: 99, hidden: true }, { questionIndex: 1, hidden: true }]) {
      expect((await post(app, route(session.sessionId), body)).status).toBe(400);
    }
    expect((await post(app, route("missing"), { questionIndex: 0, hidden: true })).status).toBe(404);
    expect(session.shownResponses).toBeUndefined();
    expect(emitted).toBeUndefined();
  });
});
