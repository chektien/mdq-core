import { createServer } from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import request from "supertest";
import { Server } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { Quiz, Session, SocketEvents, SocketRole, StudentJoinedPayload, LeaderboardUpdatePayload, ResultsRevealPayload, SessionParticipantsPayload } from "@mdq/shared";
import { createApp } from "../app";
import { apply, audienceReaches, leaderboardRows, type Command, type EngineMessage } from "../engine";
import { createSession, clearAllSessions } from "../session";
import { setupSocket, emitMessages, clearSessionTimers } from "../socket";
import { parseQuizMarkdown } from "../parser";

const DECK = `# Privacy check

---

## Warm up

type: slide

Hello.

---

## Pick one

time-limit: 20

Which one?

A. One
B. Two

> Correct Answer: A
> Overall Feedback: One.

---

## Say something

question-type: open-response
time-limit: 20

Share a thought.

> Overall Feedback: Thanks.
`;

const quizFor = (header = ""): Quiz => parseQuizMarkdown(DECK.replace("# Privacy check\n", `# Privacy check\n${header}\n`), "privacy.md").quiz!;
// Synthetic IDs that appear nowhere else in a payload by accident.
const IDS = ["ZQ-1001", "ZQ-2002", "ZQ-3003"];
const NAMES = ["Alex", "Alex", undefined];

/** Every message an engine run produced, tagged with who may receive it. */
function run(quiz: Quiz): { messages: EngineMessage[]; session: Session } {
  let session: Session = createSession("privacy", "open");
  const messages: EngineMessage[] = [];
  const step = (command: Command, at: number) => {
    const result = apply(session, quiz, command, at);
    session = result.session;
    messages.push(...result.messages);
    return result;
  };
  const joinAll = (usesIds: boolean) => IDS.forEach((id, i) => step({ type: "join", socketId: `sock-${i}`, newToken: `tok-${i}`,
    payload: usesIds ? { studentId: id, displayName: NAMES[i] } : { displayName: NAMES[i] ?? `Robin ${i}` } }, 100 + i));
  joinAll(quiz.studentId !== false);
  const ids = [...session.participants.keys()];
  step({ type: "start" }, 1000);
  step({ type: "next" }, 2000);
  ids.forEach((id, i) => step({ type: "answerSubmit", studentId: id, payload: { questionIndex: 1, selectedOptions: [i === 2 ? "B" : "A"] } }, 2500 + i));
  step({ type: "close" }, 3000);
  step({ type: "reveal" }, 3100);
  step({ type: "next" }, 4000);
  ids.forEach((id, i) => step({ type: "answerSubmit", studentId: id, payload: { questionIndex: 2, responseText: `Thought number ${i}` } }, 4500 + i));
  step({ type: "close" }, 5000);
  step({ type: "reveal" }, 5100);
  step({ type: "leaderboardShow" }, 6000);
  step({ type: "participants" }, 6100);
  step({ type: "disconnect", studentId: ids[0], socketId: "sock-0" }, 6200);
  // Reconnect snapshots for every kind of socket, in the state the session is in now.
  step({ type: "snapshot", view: "control" }, 6300);
  step({ type: "snapshot", view: "display" }, 6300);
  ids.forEach((id) => step({ type: "snapshot", participantId: id, isReconnect: true }, 6300));
  step({ type: "leaderboardHide" }, 6400);
  step({ type: "broadcastLeaderboard" }, 6500);
  step({ type: "broadcastReveal" }, 6600);
  return { messages, session };
}

const reaches = (message: EngineMessage, role: SocketRole) => audienceReaches(message.audience, role);
const text = (message: EngineMessage) => JSON.stringify(message.payload);

describe("who receives what", () => {
  it("routes each audience to the roles it names", () => {
    const table: Record<string, SocketRole[]> = {
      all: ["control", "display", "participant"], staff: ["control", "display"], control: ["control"],
      display: ["display"], public: ["display", "participant"], "participant:x": ["participant"],
    };
    for (const [audience, roles] of Object.entries(table)) {
      for (const role of ["control", "display", "participant"] as SocketRole[]) {
        expect(audienceReaches(audience as never, role)).toBe(roles.includes(role));
      }
    }
  });
});

describe("payload privacy through a whole session (Student IDs on)", () => {
  const { messages, session } = run(quizFor());

  it("runs to the end with every kind of message", () => {
    const events = new Set(messages.map((m) => m.event));
    for (const event of [SocketEvents.SESSION_PARTICIPANTS, SocketEvents.ANSWER_COUNT, SocketEvents.RESULTS_REVEAL, SocketEvents.LEADERBOARD_UPDATE, SocketEvents.STUDENT_JOINED]) {
      expect(events.has(event)).toBe(true);
    }
    expect(messages.some((m) => m.event === SocketEvents.RESULTS_REVEAL && (m.payload as ResultsRevealPayload).openResponses?.length)).toBe(true);
  });

  it("never puts a Student ID in anything the projector or a phone can receive", () => {
    let checked = 0;
    for (const message of messages) {
      const forOthers = reaches(message, "display") || (reaches(message, "participant") && !message.audience.startsWith("participant:"));
      if (!forOthers) continue;
      checked += 1;
      for (const id of IDS) expect(text(message)).not.toContain(id);
      expect(text(message)).not.toContain('"studentId"');
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("gives a participant only their own ID, never another participant's", () => {
    for (const message of messages.filter((m) => m.audience.startsWith("participant:") && m.event !== SocketEvents.STUDENT_REJECTED)) {
      const own = message.audience.slice("participant:".length);
      for (const id of IDS.filter((candidate) => candidate !== own)) expect(text(message)).not.toContain(id);
      if (message.event !== SocketEvents.STUDENT_JOINED) expect(text(message)).not.toContain(own);
    }
  });

  it("still gives the instructor the IDs and names", () => {
    const control = messages.filter((m) => m.audience === "control");
    for (const event of [SocketEvents.SESSION_PARTICIPANTS, SocketEvents.ANSWER_COUNT, SocketEvents.RESULTS_REVEAL, SocketEvents.LEADERBOARD_UPDATE]) {
      const forEvent = control.filter((m) => m.event === event);
      expect(forEvent.length).toBeGreaterThan(0);
      const seen = forEvent.map(text).join(" ");
      for (const id of IDS) if (event !== SocketEvents.ANSWER_COUNT) expect(seen).toContain(id);
    }
    const board = control.filter((m) => m.event === SocketEvents.LEADERBOARD_UPDATE).pop()!.payload as LeaderboardUpdatePayload;
    expect(board.entries.map((row) => row.studentId).sort()).toEqual(IDS);
    expect(board.entries.every((row) => row.publicKey && row.label)).toBe(true);
    const openCount = control.filter((m) => m.event === SocketEvents.ANSWER_COUNT && text(m).includes("Thought number")).pop()!;
    expect(text(openCount)).toContain('"studentId"');
  });

  it("shows the projector and phones labels and public keys in place of IDs", () => {
    const publicBoard = messages.filter((m) => m.event === SocketEvents.LEADERBOARD_UPDATE && m.audience === "public").pop()!.payload as LeaderboardUpdatePayload;
    const keys = [...session.participants.values()].map((p) => p.publicKey).sort();
    expect(publicBoard.entries.map((row) => row.publicKey).sort()).toEqual(keys);
    expect(publicBoard.entries.map((row) => row.label).sort()).toEqual(["Alex", "Alex (2)", "Participant 3"]);
    for (const row of publicBoard.entries) expect(Object.keys(row).sort()).toEqual(["correctCount", "label", "publicKey", "rank", "totalTimeMs"]);
    const lobby = messages.filter((m) => m.event === SocketEvents.SESSION_PARTICIPANTS && m.audience === "display").pop()!.payload as SessionParticipantsPayload;
    for (const person of lobby.participants) expect(Object.keys(person).sort()).toEqual(["label", "publicKey"]);
    const reveal = messages.filter((m) => m.event === SocketEvents.RESULTS_REVEAL && m.audience === "public" && (m.payload as ResultsRevealPayload).openResponses).pop()!.payload as ResultsRevealPayload;
    for (const response of reveal.openResponses!) expect(Object.keys(response).sort()).toEqual(["label", "publicKey", "responseText", "submittedAt"]);
  });

  it("uses public keys that are not derived from the Student ID", () => {
    const again = run(quizFor()).session;
    for (const id of IDS) {
      const a = session.participants.get(id)!.publicKey;
      const b = again.participants.get(id)!.publicKey;
      expect(a).not.toBe(b);
      expect(a).not.toContain(id);
    }
  });

  it("builds the public leaderboard for the REST endpoint from the same rows", () => {
    const rows = leaderboardRows(session, quizFor(), "public");
    expect(rows.every((row) => !("studentId" in row) && !("displayName" in row))).toBe(true);
  });
});

describe("payload privacy when names are the IDs (student-id: false)", () => {
  const { messages, session } = run(quizFor("student-id: false"));

  it("labels people by name and carries no studentId or displayName field to others", () => {
    // The names are the IDs here: the second "Alex" is refused, and the seats are keyed and labelled by name.
    expect([...session.participants.values()].map((p) => [p.studentId, p.label])).toEqual([["Alex", "Alex"], ["Robin 2", "Robin 2"]]);
    for (const message of messages) {
      const forOthers = reaches(message, "display") || (reaches(message, "participant") && !message.audience.startsWith("participant:"));
      if (!forOthers) continue;
      expect(text(message)).not.toContain('"studentId"');
      expect(text(message)).not.toContain('"displayName"');
    }
  });
});

describe("payload privacy over real sockets", () => {
  let dir: string;
  let httpServer: ReturnType<typeof createServer>;
  let ioServer: Server;
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;
  const sockets: ClientSocket[] = [];

  beforeAll((done) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-privacy-"));
    fs.writeFileSync(path.join(dir, "privacy.md"), DECK.replace("# Privacy check\n", "# Privacy check\n"));
    fs.writeFileSync(path.join(dir, "names.md"), DECK.replace("# Privacy check\n", "# Names only\nstudent-id: false\n"));
    const ioRef: { current: Server | null } = { current: null };
    app = createApp({
      quizDir: dir,
      dataDir: path.join(dir, "data"),
      onStateChange: (session, sessionId, _state, _quiz, result) => {
        if (!ioRef.current || !result) return;
        clearSessionTimers(sessionId);
        emitMessages(ioRef.current, sessionId, result.messages);
      },
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
  const joinAs = async (sessionId: string, payload: object): Promise<{ recorder: Recorder; joined: StudentJoinedPayload }> => {
    const recorder = connect(sessionId);
    await until(() => recorder.socket.connected, "student connects");
    recorder.socket.emit(SocketEvents.STUDENT_JOIN, payload);
    await until(() => recorder.events.some((e) => e.event === SocketEvents.STUDENT_JOINED), "student joins");
    return { recorder, joined: recorder.events.find((e) => e.event === SocketEvents.STUDENT_JOINED)!.payload as StudentJoinedPayload };
  };

  it("keeps Student IDs off the projector and other phones for a whole session, and on for the instructor", async () => {
    const created = await request(app).post("/api/session").send({ week: "privacy" }).expect(201);
    const { sessionId, sessionCode } = created.body;
    const lookup = await request(app).get(`/api/session/by-code/${sessionCode}`).expect(200);
    expect(lookup.body.studentIds).toBe(true);
    const control = connect(sessionId, "instructor");
    const display = connect(sessionId, "presentation");
    await until(() => control.socket.connected && display.socket.connected, "staff connect");
    const a = await joinAs(sessionId, { studentId: IDS[0], displayName: "Alex" });
    const b = await joinAs(sessionId, { studentId: IDS[1], displayName: "Alex" });
    const c = await joinAs(sessionId, { studentId: IDS[2] });
    expect([a.joined.label, b.joined.label, c.joined.label]).toEqual(["Alex", "Alex (2)", "Participant 3"]);
    expect(b.joined.labelNote).toBe("Another participant is also called Alex, so you appear as Alex (2).");
    const students = [a, b, c];

    await post(sessionId, "start");
    await post(sessionId, "next");
    students.forEach(({ recorder }, i) => recorder.socket.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 1, selectedOptions: [i === 2 ? "B" : "A"] }));
    await until(() => students.every(({ recorder }) => recorder.events.some((e) => e.event === SocketEvents.ANSWER_ACCEPTED)), "answers accepted");
    await post(sessionId, "close");
    await post(sessionId, "reveal");
    await post(sessionId, "next");
    students.forEach(({ recorder }, i) => recorder.socket.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 2, responseText: `Thought ${i}` }));
    await until(() => control.events.some((e) => e.event === SocketEvents.ANSWER_COUNT && e.text.includes("Thought 2")), "open responses counted");
    await post(sessionId, "close");
    await post(sessionId, "reveal");
    await post(sessionId, "leaderboard-show");
    await until(() => students.every(({ recorder }) => recorder.events.some((e) => e.event === SocketEvents.LEADERBOARD_UPDATE)), "leaderboard delivered");
    await until(() => control.events.some((e) => e.event === SocketEvents.LEADERBOARD_UPDATE), "control leaderboard");
    // A projector that connects late gets a snapshot built for it.
    const lateDisplay = connect(sessionId, "presentation");
    await until(() => lateDisplay.events.some((e) => e.event === SocketEvents.LEADERBOARD_UPDATE), "late projector snapshot");

    for (const recorder of [display, lateDisplay, ...students.map((s) => s.recorder)]) {
      expect(recorder.events.length).toBeGreaterThanOrEqual(3);
      for (const entry of recorder.events) {
        for (const id of IDS.filter((candidate) => recorder !== students[IDS.indexOf(candidate)]?.recorder)) expect(entry.text).not.toContain(id);
        expect(entry.text).not.toContain('"studentId"');
      }
    }
    // Phones never receive the instructor's messages at all.
    for (const { recorder } of students) {
      expect(recorder.events.map((e) => e.event)).not.toContain(SocketEvents.SESSION_PARTICIPANTS);
      expect(recorder.events.map((e) => e.event)).not.toContain(SocketEvents.ANSWER_COUNT);
      expect(recorder.events.map((e) => e.event)).not.toContain(SocketEvents.RESULTS_DISTRIBUTION);
    }
    // The projector still gets the lobby, counts and reveals, by label.
    const lobby = display.events.filter((e) => e.event === SocketEvents.SESSION_PARTICIPANTS).pop()!.payload as SessionParticipantsPayload;
    expect(lobby.participants.map((p) => p.label).sort()).toEqual(["Alex", "Alex (2)", "Participant 3"]);
    expect(display.events.some((e) => e.event === SocketEvents.ANSWER_COUNT && e.text.includes("Thought 2"))).toBe(true);
    expect(display.events.some((e) => e.event === SocketEvents.RESULTS_DISTRIBUTION)).toBe(true);
    // A phone finds its own leaderboard row by public key.
    const board = a.recorder.events.filter((e) => e.event === SocketEvents.LEADERBOARD_UPDATE).pop()!.payload as LeaderboardUpdatePayload;
    expect(board.entries.find((row) => row.publicKey === a.joined.publicKey)?.label).toBe("Alex");
    // The instructor still sees who is who.
    const controlBoard = control.events.filter((e) => e.event === SocketEvents.LEADERBOARD_UPDATE).pop()!.payload as LeaderboardUpdatePayload;
    expect(controlBoard.entries.map((row) => row.studentId).sort()).toEqual(IDS);
    const controlLobby = control.events.filter((e) => e.event === SocketEvents.SESSION_PARTICIPANTS).pop()!.payload as SessionParticipantsPayload;
    expect(controlLobby.participants.map((p) => p.studentId).sort()).toEqual(IDS);
    // The public leaderboard endpoint is scrubbed too.
    const rest = await request(app).get(`/api/session/${sessionId}/leaderboard`).expect(200);
    expect(JSON.stringify(rest.body)).not.toContain("ZQ-");
    expect(rest.body.entries.map((row: { label: string }) => row.label).sort()).toEqual(["Alex", "Alex (2)", "Participant 3"]);
  });

  it("joins by name only when the deck turns Student IDs off, and tells a clash", async () => {
    const created = await request(app).post("/api/session").send({ week: "names" }).expect(201);
    const { sessionId, sessionCode } = created.body;
    const lookup = await request(app).get(`/api/session/by-code/${sessionCode}`).expect(200);
    expect(lookup.body.studentIds).toBe(false);
    const alex = await joinAs(sessionId, { displayName: "Alex Tan" });
    expect(alex.joined.participantId).toBe("Alex Tan");
    const second = connect(sessionId);
    await until(() => second.socket.connected, "second connects");
    second.socket.emit(SocketEvents.STUDENT_JOIN, { displayName: " alex   TAN " });
    await until(() => second.events.some((e) => e.event === SocketEvents.STUDENT_REJECTED), "clash reported");
    expect((second.events.find((e) => e.event === SocketEvents.STUDENT_REJECTED)!.payload as { reason: string }).reason)
      .toBe('Someone here is already using the name "alex TAN". Add an initial or your surname, for example "alex TAN B."');
    // Trying again with an initial works on the same connection.
    second.socket.emit(SocketEvents.STUDENT_JOIN, { displayName: "Alex Tan B." });
    await until(() => second.events.some((e) => e.event === SocketEvents.STUDENT_JOINED), "second joins");
  });
});
