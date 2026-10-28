import fs from "fs";
import os from "os";
import path from "path";
import { createServer } from "http";
import { Socket } from "socket.io";
import { AnswerSubmitPayload, Session, SocketEvents, Submission } from "@mdq/shared";
import * as attempts from "../attempts";
import { apply, Command, EngineCommandError } from "../engine";
import { buildSessionResultsCsv, saveSessionSnapshot, saveSubmissions } from "../persistence";
import { clearAllSessions, deserializeSession, recordSubmission, serializeSession, storeSession } from "../session";
import { setupSocket } from "../socket";
import { goldenQuiz, goldenSession, readerOutputs, seats } from "./attempts-test-support";

// Intersections let the behavioral tests execute against the pre-change sources too.
type Answer = Extract<Command, { type: "answerSubmit" }> & { contentVersion?: number };
const answer = (index = 0, host: object = {}, payload: object = {}): Answer => ({
  type: "answerSubmit", studentId: "one", sessionToken: "token-one", ...host,
  payload: { questionIndex: index, ...(index === 3 ? { responseText: "Smoke text" } : { selectedOptions: ["A"] }), ...payload } as AnswerSubmitPayload,
});
const open = (index = 0, legacy = false) => {
  const { current, step } = goldenSession("presenter-paced", legacy);
  for (let i = 0; i < index; i++) {
    step({ type: "close" }, 400 + i);
    step({ type: "reveal" }, 410 + i);
    step({ type: "next" }, 420 + i);
  }
  return current();
};
const submit = (session: Session, command = answer()) => apply(session, goldenQuiz, command, 1000);
const stamped = (index = 0, version = 7) => submit(open(index), answer(index, { contentVersion: version })).session;

beforeEach(() => { jest.spyOn(Date, "now").mockReturnValue(100); });
afterEach(() => { jest.restoreAllMocks(); clearAllSessions(); });

it.each([["choice", 0, 7], ["open response", 3, 12], ["explicit zero", 0, 0], ["safe integer boundary", 0, Number.MAX_SAFE_INTEGER]])(
  "stamps a host version on %s", (_name, index, contentVersion) => {
    const input = open(index);
    const result = submit(input, answer(index, { contentVersion }, { contentVersion: 999 }));
    expect(result.session.submissions[0]).toHaveProperty("contentVersion", contentVersion);
    expect(result.messages).toEqual(submit(input, answer(index)).messages);
    expect(input.submissions).toEqual([]);
  },
);
it("stamps an answer at attempt 2", () => {
  const session = attempts.archiveActiveAttempt(stamped(), 0, 1100, goldenQuiz.questions[0]);
  const next = submit(session, answer(0, { contentVersion: 8 })).session;
  expect(next.submissions[0]).toMatchObject({ attempt: 2, contentVersion: 8 });
  expect(next.attemptArchive![0].submissions[0]).toHaveProperty("contentVersion", 7);
});
it.each([{}, { contentVersion: undefined }])("omits an unsupplied host stamp (%p)", host => {
  expect(submit(open(), answer(0, host)).session.submissions[0]).not.toHaveProperty("contentVersion");
});
it("ignores a version from the participant payload", () => {
  const result = submit(open(), answer(0, {}, { contentVersion: 999 }));
  expect(result.session.submissions).toHaveLength(1);
  expect(result.session.submissions[0]).not.toHaveProperty("contentVersion");
});
it("replaces an open-response stamp on new text", () => {
  const input = stamped(3);
  const before = serializeSession(input);
  const next = submit(input, answer(3, { contentVersion: 8 }, { responseText: "Edited text" })).session;
  expect(next.submissions).toHaveLength(1);
  expect(next.submissions[0]).toMatchObject({ contentVersion: 8, responseText: "Edited text" });
  expect(serializeSession(input)).toBe(before);
});
it("removes an old open-response stamp when the host supplies none", () => {
  const input = open(3);
  // Seed a stored stamp so this test isolates removal even on the old engine.
  input.submissions = [{ studentId: "one", questionIndex: 3, selectedOptions: [], responseText: "Old text", submittedAt: 900, responseTimeMs: 500, contentVersion: 7 } as Submission];
  const next = submit(input, answer(3, {}, { responseText: "Edited text" })).session;
  expect(next.submissions[0].responseText).toBe("Edited text");
  expect(next.submissions[0]).not.toHaveProperty("contentVersion");
  expect(input.submissions[0]).toHaveProperty("contentVersion", 7);
});
it("removes an old stamp in a legacy recordSubmission open-response edit", () => {
  const session = open(3, true);
  session.submissions = [{ studentId: "one", questionIndex: 3, selectedOptions: [], responseText: "Old text", submittedAt: 90, responseTimeMs: 0, contentVersion: 7 } as Submission];
  expect(recordSubmission(session, "one", 3, { responseText: "Edited text" })).not.toHaveProperty("contentVersion");
});
it.each([-1, 1.5, NaN, "7", null, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid host version %p atomically, including otherwise refused answers", contentVersion => {
    for (const input of [open(), open(3), { ...open(), state: "ENDED" } as Session]) {
      const before = serializeSession(input);
      expect(() => submit(input, answer(input.currentQuestionIndex, { contentVersion }))).toThrow(EngineCommandError);
      expect(serializeSession(input)).toBe(before);
    }
  },
);
it("archives, normalizes and removes stamped answers without inventing stamps", () => {
  let session = stamped();
  session = submit(session, { ...answer(0, { contentVersion: 9 }), studentId: "two", sessionToken: "token-two" }).session;
  session = submit(session, { ...answer(), studentId: "three", sessionToken: "token-three" }).session;
  const archived = attempts.archiveActiveAttempt(session, 0, 1100, goldenQuiz.questions[0]);
  attempts.normalizeAttemptState(archived);
  expect(archived.attemptArchive![0].submissions.map(row => (row as Submission & { contentVersion?: number }).contentVersion)).toEqual([7, 9, undefined]);
  expect(archived.attemptArchive![0].submissions[2]).not.toHaveProperty("contentVersion");
  expect(archived.attemptArchive![0].submissions[0]).not.toBe(session.submissions[0]);
  const active = submit(archived, answer(0, { contentVersion: 10 })).session;
  attempts.removeSeatAnswers(active, "one");
  expect(active.submissions).toEqual([]);
  expect(active.attemptArchive![0].submissions.map(row => row.studentId)).toEqual(["two", "three"]);
  expect(active.attemptArchive![0].submissions[0]).toHaveProperty("contentVersion", 9);
});
it("round-trips active and archived stamps through session serialization", () => {
  const archived = attempts.archiveActiveAttempt(stamped(), 0, 1100, goldenQuiz.questions[0]);
  const input = submit(archived, answer(0, { contentVersion: 8 })).session;
  const bytes = serializeSession(input);
  const restored = deserializeSession(bytes);
  expect(restored.submissions[0]).toHaveProperty("contentVersion", 8);
  expect(restored.attemptArchive![0].submissions[0]).toHaveProperty("contentVersion", 7);
  expect(serializeSession(restored)).toBe(bytes);
});
it("persists stamped submission JSON while snapshot and CSV outputs stay unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-version-"));
  try {
    const input = stamped();
    saveSubmissions(input, dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "submissions", `${input.sessionId}.json`), "utf8")).submissions[0]).toHaveProperty("contentVersion", 7);
    saveSessionSnapshot(input, dir);
    const snapshot = fs.readFileSync(path.join(dir, "sessions", `${input.sessionId}.json`), "utf8");
    saveSessionSnapshot(submit(open()).session, dir);
    expect(fs.readFileSync(path.join(dir, "sessions", `${input.sessionId}.json`), "utf8")).toBe(snapshot);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
it("preserves stamps through release, takeover and reconnect without exposing them", () => {
  let session = stamped();
  session = apply(session, goldenQuiz, { type: "releaseSeat", role: "control", publicKey: "key-one", newToken: "released" }, 1100).session;
  expect(session.submissions[0]).toHaveProperty("contentVersion", 7);
  const join: Command = { type: "join", payload: { studentId: "one" }, socketId: "new", newToken: "new-token" };
  const taken = apply(session, goldenQuiz, join, 1200);
  expect(taken.session.submissions[0]).toHaveProperty("contentVersion", 7);
  const rejoined = apply(taken.session, goldenQuiz, { ...join, payload: { studentId: "one", sessionToken: "new-token" } }, 1300);
  expect(rejoined.session.submissions[0]).toHaveProperty("contentVersion", 7);
  expect(JSON.stringify([...taken.messages, ...rejoined.messages])).not.toContain("contentVersion");
});
it("keeps every reader, timing, both CSV builders and lifecycle frame identical with stamps", () => {
  const plain = goldenSession("presenter-paced"), versioned = goldenSession("presenter-paced");
  const both = (command: Command, now: number) => {
    const a = plain.step(command, now);
    const b = versioned.step(command.type === "answerSubmit" ? { ...command, contentVersion: 7 } as Answer : command, now);
    expect(b.messages).toEqual(a.messages);
    expect(b.nextDeadline).toEqual(a.nextDeadline);
    expect(b.session.questionTiming).toEqual(a.session.questionTiming);
    expect(readerOutputs(b.session)).toEqual(readerOutputs(a.session));
    expect(buildSessionResultsCsv(b.session, goldenQuiz)).toBe(buildSessionResultsCsv(a.session, goldenQuiz));
  };
  for (let index = 0; index < 4; index++) {
    for (const id of seats) both({ ...answer(index), studentId: id, sessionToken: `token-${id}` }, 1000 + index * 100);
    both({ type: "close" }, 2000 + index * 100);
    both({ type: "reveal" }, 2100 + index * 100);
    if (index < 3) both({ type: "next" }, 2200 + index * 100);
  }
  both({ type: "end", discloseResults: true }, 5000);
  expect(versioned.current().submissions.every(row => Object.prototype.hasOwnProperty.call(row, "contentVersion"))).toBe(true);
});
it("loads and saves legacy fixture bytes exactly", () => {
  const captures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "attempts-origin-main.json"), "utf8")) as { legacy: boolean; serialized: string }[];
  for (const capture of captures.filter(row => row.legacy)) expect(serializeSession(deserializeSession(capture.serialized))).toBe(capture.serialized);
});
it.each([false, true])("serializes answers without a host version to origin/main bytes (legacy %p)", legacy => {
  const captures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "attempts-origin-main.json"), "utf8")) as { pacing: string; legacy: boolean; label: string; serialized: string }[];
  const { step, current } = goldenSession("presenter-paced", legacy);
  for (const [position, id] of seats.entries()) step({ ...answer(), studentId: id, sessionToken: `token-${id}`, payload: { questionIndex: 0, selectedOptions: [position === 1 ? "B" : "A"] } }, 1000 + position);
  expect(serializeSession(current())).toBe(captures.find(row => row.pacing === "presenter-paced" && row.legacy === legacy && row.label === "open-0")!.serialized);
});
it("reads the accepted stamp and keeps legacy unknown distinct from explicit zero", () => {
  const read = (attempts as typeof attempts & { answeredContentVersion: (row: Submission) => number | undefined }).answeredContentVersion;
  expect(read(stamped().submissions[0])).toBe(7);
  expect(read(submit(open()).session.submissions[0])).toBeUndefined();
  expect(read(stamped(0, 0).submissions[0])).toBe(0);
});
it("Core's socket path ignores participant versions and stores no stamp", async () => {
  const session = open();
  storeSession(session);
  const server = createServer();
  const io = setupSocket(server, new Map([[goldenQuiz.week, goldenQuiz]]));
  // Inject a connection into the real adapter, without needing a TCP listener.
  const handlers = new Map<string, (payload: object) => void>();
  const socket = {
    id: "version-smoke-socket", handshake: { auth: { sessionId: session.sessionId } },
    join: jest.fn(), emit: jest.fn(),
    on: (event: string, handler: (payload: object) => void) => handlers.set(event, handler),
  };
  try {
    io.sockets.listeners("connection")[0](socket as unknown as Socket);
    handlers.get(SocketEvents.STUDENT_JOIN)!({ studentId: "one", sessionToken: "token-one" });
    handlers.get(SocketEvents.ANSWER_SUBMIT)!({ questionIndex: 0, selectedOptions: ["A"], contentVersion: 999 });
    expect(socket.emit).toHaveBeenCalledWith(SocketEvents.ANSWER_ACCEPTED, { questionIndex: 0 });
    expect(session.submissions).toHaveLength(1);
    expect(session.submissions[0]).not.toHaveProperty("contentVersion");
  } finally { await new Promise<void>(resolve => io.close(() => resolve())); }
});
