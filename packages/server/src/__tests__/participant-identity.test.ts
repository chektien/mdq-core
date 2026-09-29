import { Quiz, Session, SocketEvents, StudentJoinedPayload, normalizeDisplayName } from "@mdq/shared";
import { apply } from "../engine";
import { createSession } from "../session";

const question = {
  index: 0, topic: "Item", textMd: "Question", textHtml: "<p>Question</p>",
  options: [{ label: "A", textMd: "One", textHtml: "One" }],
  correctOptions: ["A"], allowsMultiple: false, explanation: "Correct", timeLimitSec: 20,
};
const withIds: Quiz = { week: "ids", title: "IDs", sourceFile: "ids.md", questions: [question] };
const nameOnly: Quiz = { ...withIds, week: "names", studentId: false };

type Join = { studentId?: string; displayName?: string; sessionToken?: string; clientInstanceId?: string };

/** One join on an existing session; returns the new session and what the joiner was sent. */
function join(session: Session, quiz: Quiz, payload: Join, socketId = `socket-${session.participants.size + 1}`) {
  const result = apply(session, quiz, { type: "join", payload, socketId, newToken: `token-${socketId}` }, 1000);
  const rejected = result.messages.find((m) => m.event === SocketEvents.STUDENT_REJECTED)?.payload as { reason: string } | undefined;
  const joined = result.messages.find((m) => m.event === SocketEvents.STUDENT_JOINED)?.payload as StudentJoinedPayload | undefined;
  return { session: result.session, rejected, joined, messages: result.messages };
}

describe("name normalisation", () => {
  it("uses NFC, trims and collapses whitespace", () => {
    expect(normalizeDisplayName("  Alex \t  Tan\n")).toBe("Alex Tan");
    expect(normalizeDisplayName("José")).toBe("José");
    expect(normalizeDisplayName(undefined)).toBe("");
    expect(normalizeDisplayName("   ")).toBe("");
  });
});

describe("joining with a Student ID", () => {
  it("keeps the ID and the optional name, and gives the participant a random public key", () => {
    const first = join(createSession("ids", "open"), withIds, { studentId: "S0001", displayName: "  Alex   Tan " });
    expect(first.joined).toMatchObject({ participantId: "S0001", label: "Alex Tan" });
    expect(first.joined?.labelNote).toBeUndefined();
    expect(first.joined?.publicKey).toBeTruthy();
    expect(first.joined?.publicKey).not.toContain("S0001");
    const second = join(first.session, withIds, { studentId: "S0002", displayName: "Sam" });
    expect(second.joined?.publicKey).not.toBe(first.joined?.publicKey);
  });

  it("uses a supplied public key and falls back to a random one", () => {
    const supplied = apply(createSession("ids", "open"), withIds, { type: "join", payload: { studentId: "S0001" }, socketId: "s", newToken: "t", newPublicKey: "fixed-key" }, 1000);
    expect(supplied.session.participants.get("S0001")?.publicKey).toBe("fixed-key");
    expect(join(createSession("ids", "open"), withIds, { studentId: "S0001" }).joined?.publicKey).toMatch(/[0-9a-f-]{20,}/);
  });

  it("requires an ID and limits its length", () => {
    const session = createSession("ids", "open");
    expect(join(session, withIds, { displayName: "Alex" }).rejected?.reason).toBe("Student ID is required");
    expect(join(session, withIds, { studentId: "   " }).rejected?.reason).toBe("Student ID is required");
    expect(join(session, withIds, { studentId: "x".repeat(65) }).rejected?.reason).toMatch(/at most 64/);
    expect(join(session, withIds, { studentId: "x".repeat(64) }).joined).toBeTruthy();
    expect(join(session, withIds, { studentId: "S1", displayName: "n".repeat(61) }).rejected?.reason).toMatch(/at most 60/);
  });

  it("tells an ID that is already in use on another device, clearly", () => {
    const first = join(createSession("ids", "open"), withIds, { studentId: "S0001", displayName: "Alex" });
    const clash = join(first.session, withIds, { studentId: "S0001", displayName: "Sam" }, "other");
    expect(clash.joined).toBeUndefined();
    expect(clash.rejected?.reason).toBe('The Student ID "S0001" is already in this session on another device. Use that device, or check that you typed your own ID.');
    expect(clash.messages).toHaveLength(1);
    expect(clash.session.participants.size).toBe(1);
    expect(clash.session.participants.get("S0001")?.socketId).toBe("socket-1");
  });

  it("does not treat your own seat as a clash", () => {
    const first = join(createSession("ids", "open"), withIds, { studentId: "S0001", displayName: "Alex", clientInstanceId: "phone" });
    const token = first.joined!.sessionToken;
    const again = join(first.session, withIds, { studentId: "S0001", sessionToken: token }, "socket-2");
    expect(again.rejected).toBeUndefined();
    expect(again.joined).toMatchObject({ participantId: "S0001", publicKey: first.joined!.publicKey, label: "Alex" });
    // Same browser after it went offline, without the token.
    const offline = apply(first.session, withIds, { type: "disconnect", studentId: "S0001", socketId: "socket-1" }, 2000).session;
    const back = join(offline, withIds, { studentId: "S0001", clientInstanceId: "phone" }, "socket-3");
    expect(back.rejected).toBeUndefined();
    expect(back.joined?.label).toBe("Alex");
    // A different browser is a clash even when the seat is offline.
    expect(join(offline, withIds, { studentId: "S0001", clientInstanceId: "laptop" }, "socket-4").rejected).toBeDefined();
  });
});

describe("public labels", () => {
  it("gives people with the same name distinct labels and tells the later ones", () => {
    let session = createSession("ids", "open");
    const alex = join(session, withIds, { studentId: "S0001", displayName: "Alex" }); session = alex.session;
    const second = join(session, withIds, { studentId: "S0002", displayName: "  alex " }); session = second.session;
    const third = join(session, withIds, { studentId: "S0003", displayName: "ALEX" }); session = third.session;
    expect([alex.joined?.label, second.joined?.label, third.joined?.label]).toEqual(["Alex", "alex (2)", "ALEX (3)"]);
    expect(alex.joined?.labelNote).toBeUndefined();
    expect(second.joined?.labelNote).toBe("Another participant is also called alex, so you appear as alex (2).");
    expect(third.joined?.labelNote).toBe("Another participant is also called ALEX, so you appear as ALEX (3).");
  });

  it("numbers people with no name by join order", () => {
    let session = createSession("ids", "open");
    const named = join(session, withIds, { studentId: "S0001", displayName: "Alex" }); session = named.session;
    const anon = join(session, withIds, { studentId: "S0002" }); session = anon.session;
    const anon2 = join(session, withIds, { studentId: "S0003", displayName: "   " });
    expect(anon.joined?.label).toBe("Participant 2");
    expect(anon.joined?.labelNote).toBe("You appear as Participant 2.");
    expect(anon2.joined?.label).toBe("Participant 3");
  });

  it("never gives out a label that is already taken, even by a typed name", () => {
    let session = createSession("ids", "open");
    session = join(session, withIds, { studentId: "S0001", displayName: "Participant 2" }).session;
    const anon = join(session, withIds, { studentId: "S0002" });
    expect(anon.joined?.label).toBe("Participant 2 (2)");
  });

  it("keeps labels after a participant leaves or rejoins, and never reuses them", () => {
    let session = createSession("ids", "open");
    session = join(session, withIds, { studentId: "S0001", displayName: "Alex" }).session;
    const second = join(session, withIds, { studentId: "S0002", displayName: "Alex" }); session = second.session;
    session = apply(session, withIds, { type: "disconnect", studentId: "S0001", socketId: "socket-1" }, 2000).session;
    session = apply(session, withIds, { type: "disconnect", studentId: "S0002", socketId: "socket-2" }, 2000).session;
    expect(session.participants.get("S0001")?.label).toBe("Alex");
    expect(session.participants.get("S0002")?.label).toBe("Alex (2)");
    // A new "Alex" while both are away does not take a free-looking label.
    const later = join(session, withIds, { studentId: "S0003", displayName: "Alex" }); session = later.session;
    expect(later.joined?.label).toBe("Alex (3)");
    // Rejoining with the token keeps the label and the note, even with another name.
    const back = join(session, withIds, { studentId: "S0002", displayName: "Robin", sessionToken: second.joined!.sessionToken }, "socket-9");
    expect(back.joined).toMatchObject({ label: "Alex (2)", publicKey: second.joined!.publicKey, labelNote: second.joined!.labelNote });
  });
});

describe("joining by name only (student-id: false)", () => {
  it("uses the normalised name as the ID and needs no Student ID", () => {
    const result = join(createSession("names", "open"), nameOnly, { displayName: "  Alex \n Tan " });
    expect(result.joined).toMatchObject({ participantId: "Alex Tan", label: "Alex Tan" });
    expect(result.joined?.labelNote).toBeUndefined();
    const seat = result.session.participants.get("Alex Tan");
    expect(seat).toMatchObject({ studentId: "Alex Tan", displayName: "Alex Tan" });
  });

  it("asks for a name, and limits its length", () => {
    const session = createSession("names", "open");
    expect(join(session, nameOnly, {}).rejected?.reason).toBe("Please enter your name to join.");
    expect(join(session, nameOnly, { displayName: "  \t " }).rejected?.reason).toBe("Please enter your name to join.");
    expect(join(session, nameOnly, { displayName: "n".repeat(61) }).rejected?.reason).toMatch(/at most 60/);
  });

  it("ignores a Student ID sent with the name", () => {
    const result = join(createSession("names", "open"), nameOnly, { studentId: "S0001", displayName: "Alex" });
    expect(result.joined?.participantId).toBe("Alex");
  });

  it("refuses a name another seat holds, ignoring case, spacing and accents composed differently", () => {
    const first = join(createSession("names", "open"), nameOnly, { displayName: "Alex Tan" });
    for (const typed of ["alex tan", "ALEX   TAN", " Alex Tan "]) {
      const clash = join(first.session, nameOnly, { displayName: typed }, "other");
      expect(clash.joined).toBeUndefined();
      expect(clash.rejected?.reason).toBe('Someone here is already using the name "' + normalizeDisplayName(typed) + '". Add an initial or your surname, for example "' + normalizeDisplayName(typed) + ' B."');
      expect(clash.session.participants.size).toBe(1);
    }
    const accents = join(createSession("names", "open"), nameOnly, { displayName: "José" });
    expect(join(accents.session, nameOnly, { displayName: "JOSÉ" }, "other").rejected).toBeDefined();
    expect(join(accents.session, nameOnly, { displayName: "José" }, "other").rejected).toBeDefined();
  });

  it("uses the friendly message from the brief for Alex Tan", () => {
    const first = join(createSession("names", "open"), nameOnly, { displayName: "Alex Tan" });
    expect(join(first.session, nameOnly, { displayName: "Alex Tan" }, "other").rejected?.reason)
      .toBe('Someone here is already using the name "Alex Tan". Add an initial or your surname, for example "Alex Tan B."');
  });

  it("accepts the name again with an initial", () => {
    const first = join(createSession("names", "open"), nameOnly, { displayName: "Alex Tan" });
    const second = join(first.session, nameOnly, { displayName: "Alex Tan B." }, "other");
    expect(second.rejected).toBeUndefined();
    expect(second.joined?.label).toBe("Alex Tan B.");
    expect(second.session.participants.size).toBe(2);
  });

  it("does not treat your own seat as a clash: same token, or the same browser while offline", () => {
    const first = join(createSession("names", "open"), nameOnly, { displayName: "Alex Tan", clientInstanceId: "phone" });
    const token = first.joined!.sessionToken;
    // The client rejoins with the ID it was given and its token, without retyping the name.
    const byId = join(first.session, nameOnly, { studentId: "Alex Tan", sessionToken: token }, "socket-2");
    expect(byId.rejected).toBeUndefined();
    expect(byId.joined).toMatchObject({ participantId: "Alex Tan", publicKey: first.joined!.publicKey });
    // Or retypes it in another case.
    const retyped = join(first.session, nameOnly, { displayName: "alex  tan", sessionToken: token }, "socket-3");
    expect(retyped.rejected).toBeUndefined();
    expect(retyped.session.participants.size).toBe(1);
    expect(retyped.session.participants.get("Alex Tan")?.displayName).toBe("Alex Tan");
    const offline = apply(first.session, nameOnly, { type: "disconnect", studentId: "Alex Tan", socketId: "socket-1" }, 2000).session;
    expect(join(offline, nameOnly, { displayName: "ALEX TAN", clientInstanceId: "phone" }, "socket-4").rejected).toBeUndefined();
    expect(join(offline, nameOnly, { displayName: "ALEX TAN", clientInstanceId: "laptop" }, "socket-5").rejected).toBeDefined();
  });

  it("holds a name for the whole session, even after its holder leaves", () => {
    const first = join(createSession("names", "open"), nameOnly, { displayName: "Alex Tan" });
    const offline = apply(first.session, nameOnly, { type: "disconnect", studentId: "Alex Tan", socketId: "socket-1" }, 2000).session;
    expect(join(offline, nameOnly, { displayName: "alex tan" }, "other").rejected).toBeDefined();
  });
});
