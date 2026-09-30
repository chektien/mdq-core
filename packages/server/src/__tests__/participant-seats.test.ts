import { Quiz, Session, SessionParticipantsPayload, SocketEvents } from "@mdq/shared";
import { apply } from "../engine";
import { type FreedSeats, isSeatFreed, pruneFreedSeats } from "../../../client/src/participantSeats";

const quiz: Quiz = {
  week: "sample", title: "Sample", sourceFile: "sample.md",
  questions: [{ index: 0, topic: "Item", textMd: "Q", textHtml: "<p>Q</p>", options: [{ label: "A", textMd: "One", textHtml: "One" }],
    correctOptions: ["A"], allowsMultiple: false, explanation: "", timeLimitSec: 20 }],
};
const lobby = (): Session => ({
  sessionId: "session", sessionCode: "SAMPLE1", week: "sample", mode: "open", state: "LOBBY", currentQuestionIndex: -1,
  revealedQuestionIndexes: new Set<number>(), participants: new Map(), submissions: [], createdAt: 0,
});
const controlList = (messages: { event: string; audience: string; payload: unknown }[]) =>
  messages.find((m) => m.event === SocketEvents.SESSION_PARTICIPANTS && m.audience === "control")!.payload as SessionParticipantsPayload;

describe("a participant row after the presenter lets someone rejoin", () => {
  it("stops reading 'Free to join again' as soon as a phone takes the seat", () => {
    const joined = apply(lobby(), quiz, { type: "join", socketId: "s1", newToken: "t1", newPublicKey: "key-1", payload: { studentId: "S0001", displayName: "Alex Tan" } }, 1000);
    const released = apply(joined.session, quiz, { type: "releaseSeat", role: "control", publicKey: "key-1", newToken: "t2" }, 2000);
    let freed: FreedSeats = { "key-1": true };
    const afterRelease = controlList(released.messages);
    // Freed: not connected, and the list says so.
    expect(isSeatFreed(true, afterRelease.offline![0].released, freed, "key-1")).toBe(true);
    freed = pruneFreedSeats(freed, afterRelease);
    expect(freed).toEqual({});
    expect(isSeatFreed(true, afterRelease.offline![0].released, freed, "key-1")).toBe(true);

    // A phone takes the seat: the live list has them online and no longer released.
    const taken = apply(released.session, quiz, { type: "join", socketId: "s9", newToken: "t3", payload: { studentId: "S0001", clientInstanceId: "phone-2" } }, 3000);
    const afterTakeover = controlList(taken.messages);
    expect(afterTakeover.participants.map((p) => p.publicKey)).toEqual(["key-1"]);
    expect(afterTakeover.offline).toBeUndefined();
    expect(isSeatFreed(false, undefined, {}, "key-1")).toBe(false);
  });

  it("drops a local mark once the person is online, even if the list never showed the release", () => {
    const list: SessionParticipantsPayload = { count: 1, participants: [{ publicKey: "key-1", label: "Alex", studentId: "S0001" }] };
    expect(pruneFreedSeats({ "key-1": true }, list)).toEqual({});
    expect(isSeatFreed(false, undefined, { "key-1": true }, "key-1")).toBe(false);
  });

  it("keeps the local mark while the list has not caught up, and after a later disconnect it is not free", () => {
    const stale: SessionParticipantsPayload = { count: 0, participants: [], offline: [{ publicKey: "key-1", label: "Alex", studentId: "S0001" }] };
    const freed = { "key-1": true as const };
    expect(pruneFreedSeats(freed, stale)).toBe(freed);
    expect(pruneFreedSeats({}, stale)).toEqual({});
    // Offline again after the takeover: the list has no released flag and the mark was already dropped.
    expect(isSeatFreed(true, undefined, {}, "key-1")).toBe(false);
  });
});
