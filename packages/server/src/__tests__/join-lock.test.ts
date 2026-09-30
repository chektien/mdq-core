import { JOIN_LOCKED_MESSAGE, Quiz, Session, SessionParticipantsPayload, SocketEvents } from "@mdq/shared";
import { apply, EngineCommandError, type EngineMessage } from "../engine";
import { readFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { joinRefusalMessage } from "../../../client/src/joinForm";
import { deserializeSession, serializeSession } from "../session";

const quiz: Quiz = {
  week: "sample", title: "Sample", sourceFile: "sample.md",
  questions: [{ index: 0, topic: "Item", textMd: "Q", textHtml: "<p>Q</p>", options: [{ label: "A", textMd: "One", textHtml: "One" }],
    correctOptions: ["A"], allowsMultiple: false, explanation: "", timeLimitSec: 20 }],
};
const lobby = (): Session => ({
  sessionId: "session", sessionCode: "SAMPLE1", week: "sample", mode: "open", state: "LOBBY", currentQuestionIndex: -1,
  revealedQuestionIndexes: new Set<number>(), participants: new Map(), submissions: [], createdAt: 0,
});
const join = (session: Session, studentId: string, socketId: string, extra: object = {}, newToken = `token-${socketId}`, now = 1000) =>
  apply(session, quiz, { type: "join", socketId, newToken, newPublicKey: `key-${studentId}`, payload: { studentId, ...extra } }, now);
const lock = (session: Session, locked: boolean, role: "control" | "display" | "participant" = "control") =>
  apply(session, quiz, { type: "joinLock", role, locked }, 2000);
const to = (messages: EngineMessage[], audience: string, event: string) =>
  messages.filter((m) => m.audience === audience && m.event === event).map((m) => m.payload);
const participantsFor = (messages: EngineMessage[], audience: "control" | "display") =>
  to(messages, audience, SocketEvents.SESSION_PARTICIPANTS)[0] as SessionParticipantsPayload;

describe("locking joining", () => {
  it("is a control-only command", () => {
    const session = lobby();
    for (const role of ["display", "participant"] as const) {
      expect(() => lock(session, true, role)).toThrow(EngineCommandError);
      expect(() => lock(session, true, role)).toThrow("Only the presenter");
    }
    expect(session.joinLocked).toBeUndefined();
    expect(() => apply(session, quiz, { type: "joinLock", role: "control", locked: "yes" as unknown as boolean }, 2000)).toThrow(EngineCommandError);
  });

  it("refuses a join that would make a new seat, with a plain message, and adds nobody", () => {
    const locked = lock(join(lobby(), "S0001", "s1").session, true).session;
    const refused = join(locked, "S0002", "s2", { displayName: "Sam Lee" });
    expect(refused.session.participants.size).toBe(1);
    expect(to(refused.messages, "participant:s2", SocketEvents.STUDENT_REJECTED)).toEqual([{ reason: JOIN_LOCKED_MESSAGE }]);
    expect(JOIN_LOCKED_MESSAGE).toBe("This session is not taking new participants. Ask the presenter.");
    expect(refused.messages.some((m) => m.event === SocketEvents.STUDENT_JOINED)).toBe(false);
    expect(refused.messages.some((m) => m.event === SocketEvents.SESSION_PARTICIPANTS)).toBe(false);
  });

  it("still lets an existing seat rejoin with its token or its browser", () => {
    const first = join(lobby(), "S0001", "s1", { clientInstanceId: "phone-1" }, "token-1");
    const locked = lock(first.session, true).session;
    const sameToken = join(locked, "S0001", "s2", { sessionToken: "token-1" }, "token-2", 3000);
    expect(sameToken.messages.some((m) => m.event === SocketEvents.STUDENT_JOINED)).toBe(true);
    const offline = apply(sameToken.session, quiz, { type: "disconnect", studentId: "S0001", socketId: "s2" }, 4000).session;
    const sameBrowser = join(offline, "S0001", "s3", { clientInstanceId: "phone-1" }, "token-3", 5000);
    expect(sameBrowser.messages.some((m) => m.event === SocketEvents.STUDENT_JOINED)).toBe(true);
    expect(sameBrowser.session.joinLocked).toBe(true);
  });

  it("still lets a freed seat be taken over, and still refuses an unknown device that was not freed", () => {
    const first = join(lobby(), "S0001", "s1", { clientInstanceId: "phone-1" }, "token-1");
    const locked = lock(first.session, true).session;
    const refusedClash = join(locked, "S0001", "s9", { clientInstanceId: "phone-9" }, "token-9", 3000);
    expect(to(refusedClash.messages, "participant:s9", SocketEvents.STUDENT_REJECTED)).toHaveLength(1);
    const released = apply(locked, quiz, { type: "releaseSeat", role: "control", publicKey: "key-S0001", newToken: "token-2" }, 4000).session;
    const taken = join(released, "S0001", "s9", { clientInstanceId: "phone-9" }, "token-9", 5000);
    expect(taken.messages.some((m) => m.event === SocketEvents.STUDENT_JOINED)).toBe(true);
    expect(taken.seatTaken).toEqual({ participantId: "S0001", sessionToken: "token-9" });
    expect(taken.session.participants.get("S0001")).toMatchObject({ released: false, connected: true, socketId: "s9" });
  });

  it("also refuses new names when Student IDs are off, and lets a known name rejoin", () => {
    const named: Quiz = { ...quiz, studentId: false };
    const first = apply(lobby(), named, { type: "join", socketId: "s1", newToken: "t1", payload: { displayName: "Alex Tan", clientInstanceId: "phone-1" } }, 1000);
    const locked = apply(first.session, named, { type: "joinLock", role: "control", locked: true }, 2000).session;
    const other = apply(locked, named, { type: "join", socketId: "s2", newToken: "t2", payload: { displayName: "Sam Lee" } }, 3000);
    expect(to(other.messages, "participant:s2", SocketEvents.STUDENT_REJECTED)).toEqual([{ reason: JOIN_LOCKED_MESSAGE }]);
    const same = apply(locked, named, { type: "join", socketId: "s3", newToken: "t3", payload: { displayName: "Alex Tan", sessionToken: "t1" } }, 3000);
    expect(same.messages.some((m) => m.event === SocketEvents.STUDENT_JOINED)).toBe(true);
  });

  it("takes new participants again once unlocked", () => {
    const locked = lock(lobby(), true).session;
    expect(join(locked, "S0002", "s2").messages.some((m) => m.event === SocketEvents.STUDENT_JOINED)).toBe(false);
    const open = lock(locked, false).session;
    expect(open.joinLocked).toBe(false);
    expect(join(open, "S0002", "s2").messages.some((m) => m.event === SocketEvents.STUDENT_JOINED)).toBe(true);
  });

  it("tells control and display, and nobody else, and only while locked", () => {
    const locked = lock(join(lobby(), "S0001", "s1").session, true);
    expect(participantsFor(locked.messages, "control")).toMatchObject({ count: 1, joinLocked: true });
    expect(participantsFor(locked.messages, "display")).toEqual({ count: 1, participants: [{ publicKey: "key-S0001", label: expect.any(String) }], joinLocked: true });
    for (const m of locked.messages) expect(["control", "display"]).toContain(m.audience);
    const open = lock(locked.session, false);
    expect(participantsFor(open.messages, "control")).not.toHaveProperty("joinLocked");
    expect(participantsFor(open.messages, "display")).not.toHaveProperty("joinLocked");
    // A screen that connects later is told again through the same list.
    const late = apply(locked.session, quiz, { type: "participants" }, 3000).messages;
    expect(participantsFor(late, "control").joinLocked).toBe(true);
    expect(participantsFor(late, "display").joinLocked).toBe(true);
  });

  it("never reaches a phone: a phone's own messages carry no lock state", () => {
    const locked = lock(join(lobby(), "S0001", "s1").session, true).session;
    const rejoin = join(locked, "S0001", "s2", { sessionToken: "token-s1" }, "token-2", 3000);
    expect(JSON.stringify(rejoin.messages.filter((m) => m.audience.startsWith("participant:") || m.audience === "all" || m.audience === "participants"))).not.toMatch(/joinLock/i);
  });

  it("does not change the input session and survives a save and restore", () => {
    const session = lobby();
    const result = lock(session, true);
    expect(session.joinLocked).toBeUndefined();
    const restored = deserializeSession(serializeSession(result.session));
    expect(restored.joinLocked).toBe(true);
    expect(restored).toStrictEqual(result.session);
    expect(join(restored, "S0002", "s2").messages.some((m) => m.event === SocketEvents.STUDENT_REJECTED)).toBe(true);
    const unlocked = deserializeSession(serializeSession(lock(restored, false).session));
    expect(unlocked.joinLocked).toBe(false);
    // A session saved before this existed restores as open.
    const older = deserializeSession(serializeSession(lobby()));
    expect(older.joinLocked).toBeUndefined();
    expect(join(older, "S0002", "s2").messages.some((m) => m.event === SocketEvents.STUDENT_JOINED)).toBe(true);
  });
});

describe("the lock on the screens", () => {
  const read = (file: string) => readFileSync(joinPath(__dirname, "../../../client/src", file), "utf8");

  it("shows a phone the plain refusal as it is", () => {
    expect(joinRefusalMessage(JOIN_LOCKED_MESSAGE)).toBe("This session is not taking new participants. Ask the presenter.");
  });

  it("gives the instructor a 44px switch that says its state, in the lobby and the Participants dialog", () => {
    const toggle = read("components/JoinLockToggle.tsx");
    expect(toggle).toContain("Joining locked");
    expect(toggle).toContain("Lock joining");
    expect(read("components/SettingSwitch.tsx")).toContain("aria-checked");
    expect(read("index.css")).toMatch(/\.setting-switch \{[^}]*min-height: 2\.75rem/);
    expect(read("hooks/api.ts")).toContain("API.SESSION_JOIN_LOCK");
    expect(read("views/InstructorView.tsx").match(/<JoinLockToggle/g)).toHaveLength(2);
  });

  it("shows the projector 'Joining is closed' instead of the code and QR", () => {
    const card = read("components/SessionCodeCard.tsx");
    expect(card).toContain("Joining is closed");
    expect(card).toContain("!joinClosed && (qrDataUrl");
    expect(read("components/QRPanel.tsx")).toContain("Joining is closed");
    const view = read("views/PresentationView.tsx");
    expect(view).toContain("sock.participants?.joinLocked === true");
    // Every join card on the projector gets the flag.
    expect(view.match(/joinClosed=\{joinClosed\}/g)!.length).toBeGreaterThanOrEqual(5);
    expect(view).toContain("closed={joinClosed}");
  });
});
