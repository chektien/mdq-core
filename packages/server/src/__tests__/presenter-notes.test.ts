import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createServer } from "http";
import { AddressInfo } from "net";
import { Server } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { createApp } from "../app";
import { setupSocket, clearSessionTimers, broadcastQuestionOpen } from "../socket";
import {
  clearAllSessions,
  storeSession,
  createSession,
  transitionState,
} from "../session";
import { clearInstructorSessionsForTests } from "../instructor-auth";
import { loadRuntimeConfig } from "../config";
import { parseQuizMarkdown } from "../parser";
import { SocketEvents, QuestionOpenPayload, Quiz } from "@mdq/shared";

const DECK_WITH_NOTES = `# Presenter Notes Deck

---

## Opening slide

type: slide

Body text for the audience.

> Attendee Note: Attendees can see this.
> Presenter Note: SAY only the presenter sees this.
> - TRANSITION: move to the poll.

---

## A quick poll

type: poll
time_limit: 30
multi_select: true

**Pick any that apply.**

A. First
B. Second

> Overall Feedback: The public explanation for the poll.
> Presenter Note: SAY the poll gauges the room.
> - FALLBACK: skip if the network is down.

---

## Your turn

type: open_response
time_limit: 60

Name one thing.

> Presenter Note: INTERACTION invite two answers aloud.

---

## Slide without notes

type: slide

Nothing to see here.

---
`;

const DECK_WITH_NOTES_DISABLED = DECK_WITH_NOTES.replace(
  "# Presenter Notes Deck",
  `# Presenter Notes Deck
presenter_notes: false
presenter_notes_default_open: true`,
);

function writeTempDeck(contents: string): { dir: string; week: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-pnotes-"));
  fs.writeFileSync(path.join(dir, "talk.md"), contents);
  return { dir, week: "talk" };
}

describe("presenter notes: runtime config", () => {
  function createRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-pncfg-"));
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    return root;
  }

  it("defaults to disabled and not-default-open", () => {
    const config = loadRuntimeConfig({ rootDir: createRoot(), env: {} });
    expect(config.presenterNotes).toBe(false);
    expect(config.presenterNotesDefaultOpen).toBe(false);
  });

  it("honors data/config.json overrides", () => {
    const root = createRoot();
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({ presenterNotes: true, presenterNotesDefaultOpen: true }),
    );
    const config = loadRuntimeConfig({ rootDir: root, env: {} });
    expect(config.presenterNotes).toBe(true);
    expect(config.presenterNotesDefaultOpen).toBe(true);
  });

  it("honors env overrides over file", () => {
    const root = createRoot();
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({ presenterNotes: false }),
    );
    const config = loadRuntimeConfig({
      rootDir: root,
      env: { MDQ_PRESENTER_NOTES: "true", MDQ_PRESENTER_NOTES_DEFAULT_OPEN: "1" },
    });
    expect(config.presenterNotes).toBe(true);
    expect(config.presenterNotesDefaultOpen).toBe(true);
  });
});

describe("presenter notes: parser association", () => {
  const parsed = parseQuizMarkdown(DECK_WITH_NOTES, "talk.md");

  it("parses without errors", () => {
    expect(parsed.errors).toHaveLength(0);
  });

  it("associates presenter notes with the correct slide, poll, and open_response", () => {
    const qs = parsed.quiz!.questions;
    expect(qs[0].questionType).toBe("slide");
    expect(qs[0].presenterNotes).toHaveLength(1);
    expect(qs[0].presenterNotes?.[0].bodyMd).toContain("only the presenter sees this");
    expect(qs[0].attendeeNotes).toHaveLength(1);

    expect(qs[1].questionType).toBe("poll");
    expect(qs[1].presenterNotes).toHaveLength(1);
    expect(qs[1].presenterNotes?.[0].bodyMd).toContain("gauges the room");

    expect(qs[2].questionType).toBe("open_response");
    expect(qs[2].presenterNotes).toHaveLength(1);
    expect(qs[2].presenterNotes?.[0].bodyMd).toContain("invite two answers");
  });

  it("keeps a poll explanation blockquote independent from the presenter note", () => {
    const poll = parsed.quiz!.questions[1];
    expect(poll.explanation).toContain("public explanation for the poll");
    expect(poll.explanation).not.toContain("gauges the room");
  });

  it("strips presenter notes from the audience-visible slide body", () => {
    const qs = parsed.quiz!.questions;
    expect(qs[0].textMd).not.toContain("Presenter Note");
    expect(qs[0].textMd).not.toContain("only the presenter sees this");
    expect(qs[0].textHtml).not.toContain("only the presenter sees this");
  });

  it("handles items with no presenter notes gracefully", () => {
    const last = parsed.quiz!.questions[3];
    expect(last.presenterNotes ?? []).toHaveLength(0);
  });

  it("parses deck-level presenter-note overrides from the preamble", () => {
    const result = parseQuizMarkdown(DECK_WITH_NOTES_DISABLED, "talk.md");
    expect(result.errors).toHaveLength(0);
    expect(result.quiz?.presenterNotes).toBe(false);
    expect(result.quiz?.presenterNotesDefaultOpen).toBe(true);
  });

  it("rejects invalid deck-level boolean metadata", () => {
    const result = parseQuizMarkdown(
      DECK_WITH_NOTES.replace(
        "# Presenter Notes Deck",
        `# Presenter Notes Deck
presenter_notes: sometimes`,
      ),
      "talk.md",
    );
    expect(result.errors.map((error) => error.detail)).toContain(
      "Invalid presenter-notes: sometimes (expected true or false)",
    );
  });
});

describe("presenter notes: instructor endpoint", () => {
  const PW = "secret-pw";

  beforeEach(() => {
    process.env.INSTRUCTOR_PASSWORD = PW;
  });

  afterEach(() => {
    delete process.env.INSTRUCTOR_PASSWORD;
    delete process.env.INSTRUCTOR_KEY;
    clearInstructorSessionsForTests();
  });

  async function authedAgent(app: ReturnType<typeof createApp>) {
    const agent = request.agent(app);
    const login = await agent.post("/api/instructor/login").send({ password: PW });
    expect(login.status).toBe(204);
    return agent;
  }

  it("returns enabled:false with no items when disabled", async () => {
    const { dir, week } = writeTempDeck(DECK_WITH_NOTES);
    const app = createApp({ quizDir: dir, presenterNotes: false });
    const agent = await authedAgent(app);
    const res = await agent.get(`/api/deck/${week}/presenter-notes`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.items).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("only the presenter sees this");
  });

  it("does not serve notes when enabled but no instructor password is configured", async () => {
    delete process.env.INSTRUCTOR_PASSWORD;
    const { dir, week } = writeTempDeck(DECK_WITH_NOTES);
    const app = createApp({ quizDir: dir, presenterNotes: true, presenterNotesDefaultOpen: true });
    const res = await request(app).get(`/api/deck/${week}/presenter-notes`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.items).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("only the presenter sees this");
  });

  it("returns notes per item and honors defaultOpen when enabled (authed)", async () => {
    const { dir, week } = writeTempDeck(DECK_WITH_NOTES);
    const app = createApp({ quizDir: dir, presenterNotes: true, presenterNotesDefaultOpen: true });
    const agent = await authedAgent(app);
    const res = await agent.get(`/api/deck/${week}/presenter-notes`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.defaultOpen).toBe(true);
    expect(res.body.items).toHaveLength(4);
    expect(res.body.items[0].questionIndex).toBe(0);
    expect(res.body.items[0].notes[0].bodyHtml).toContain("only the presenter sees this");
    expect(res.body.items[3].notes).toEqual([]);
  });

  it("allows a deck to disable globally enabled presenter notes", async () => {
    const { dir, week } = writeTempDeck(DECK_WITH_NOTES_DISABLED);
    const app = createApp({ quizDir: dir, presenterNotes: true, presenterNotesDefaultOpen: true });
    const agent = await authedAgent(app);
    const res = await agent.get(`/api/deck/${week}/presenter-notes`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false, defaultOpen: false, items: [] });
    expect(JSON.stringify(res.body)).not.toContain("only the presenter sees this");
  });

  it("allows a deck to override the global default-open setting", async () => {
    const contents = DECK_WITH_NOTES.replace(
      "# Presenter Notes Deck",
      `# Presenter Notes Deck
presenter_notes_default_open: false`,
    );
    const { dir, week } = writeTempDeck(contents);
    const app = createApp({ quizDir: dir, presenterNotes: true, presenterNotesDefaultOpen: true });
    const agent = await authedAgent(app);
    const res = await agent.get(`/api/deck/${week}/presenter-notes`);
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.defaultOpen).toBe(false);
  });

  it("does not let a deck enable notes when the global privacy gate is off", async () => {
    const contents = DECK_WITH_NOTES.replace(
      "# Presenter Notes Deck",
      `# Presenter Notes Deck
presenter_notes: true`,
    );
    const { dir, week } = writeTempDeck(contents);
    const app = createApp({ quizDir: dir, presenterNotes: false });
    const agent = await authedAgent(app);
    const res = await agent.get(`/api/deck/${week}/presenter-notes`);
    expect(res.body).toEqual({ enabled: false, defaultOpen: false, items: [] });
  });

  it("404s for an unknown deck when enabled (authed)", async () => {
    const { dir } = writeTempDeck(DECK_WITH_NOTES);
    const app = createApp({ quizDir: dir, presenterNotes: true });
    const agent = await authedAgent(app);
    const res = await agent.get(`/api/deck/does-not-exist/presenter-notes`);
    expect(res.status).toBe(404);
  });

  it("requires an instructor session (401) without a cookie when auth is configured", async () => {
    const { dir, week } = writeTempDeck(DECK_WITH_NOTES);
    const app = createApp({ quizDir: dir, presenterNotes: true });
    const unauth = await request(app).get(`/api/deck/${week}/presenter-notes`);
    expect(unauth.status).toBe(401);
    const agent = await authedAgent(app);
    const authed = await agent.get(`/api/deck/${week}/presenter-notes`);
    expect(authed.status).toBe(200);
    expect(authed.body.enabled).toBe(true);
  });

  it("exposes the two config flags on /api/runtime-config", async () => {
    const { dir } = writeTempDeck(DECK_WITH_NOTES);
    const app = createApp({ quizDir: dir, presenterNotes: true, presenterNotesDefaultOpen: true });
    const res = await request(app).get("/api/runtime-config");
    expect(res.body.presenterNotes).toBe(true);
    expect(res.body.presenterNotesDefaultOpen).toBe(true);
  });

  it("public deck endpoint never exposes notes", async () => {
    const { dir, week } = writeTempDeck(DECK_WITH_NOTES);
    const app = createApp({ quizDir: dir, presenterNotes: true });
    const res = await request(app).get(`/api/deck/${week}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["questionCount", "theme", "title", "week"]);
    expect(JSON.stringify(res.body)).not.toContain("presenter");
  });
});

describe("presenter notes: audience socket surface never receives them", () => {
  let httpServer: ReturnType<typeof createServer>;
  let ioServer: Server;
  let baseUrl: string;
  const quizzes = new Map<string, Quiz>();

  beforeAll((done) => {
    const parsed = parseQuizMarkdown(DECK_WITH_NOTES, "talk.md");
    quizzes.set("talk", parsed.quiz!);
    const app = createApp({ quizDir: writeTempDeck(DECK_WITH_NOTES).dir });
    httpServer = createServer(app);
    ioServer = setupSocket(httpServer, quizzes);
    httpServer.listen(0, () => {
      baseUrl = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    ioServer.close();
    httpServer.close(done);
  });

  afterEach(() => {
    clearAllSessions();
  });

  function waitForEvent<T>(socket: ClientSocket, event: string, timeout = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
      socket.once(event, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  it("QUESTION_OPEN payload has attendee notes but no presenter notes", async () => {
    const session = createSession("talk", "open");
    storeSession(session);

    const client: ClientSocket = ioClient(baseUrl, {
      query: { sessionId: session.sessionId, role: "student" },
      transports: ["websocket"],
      forceNew: true,
    });
    client.connect();

    const joined = waitForEvent(client, SocketEvents.STUDENT_JOINED);
    client.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
    await joined;

    transitionState(session, "QUESTION_OPEN");
    session.currentQuestionIndex = 0;
    session.questionStartedAt = Date.now();

    const payloadPromise = waitForEvent<QuestionOpenPayload>(client, SocketEvents.QUESTION_OPEN);
    broadcastQuestionOpen(ioServer, session, session.sessionId, quizzes.get("talk")!);
    const payload = await payloadPromise;

    clearSessionTimers(session.sessionId);
    client.disconnect();

    expect(payload.attendeeNotes && payload.attendeeNotes.length).toBeGreaterThan(0);
    expect((payload as unknown as Record<string, unknown>).presenterNotes).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("only the presenter sees this");
  });
});
