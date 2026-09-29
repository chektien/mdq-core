import {
  createSession,
  serializeSession,
  deserializeSession,
  transitionState,
  addParticipant,
  recordSubmission,
  getDistribution,
  getSubmissionCount,
  computeLeaderboard,
  isExactOptionMatch,
  StateTransitionError,
} from "../session";
import { Session, SessionState, SESSION_STATES, STATE_TRANSITIONS } from "@mdq/shared";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

describe("Session Engine", () => {
  let session: Session;

  beforeEach(() => {
    session = createSession("week01", "open");
  });

  describe("createSession", () => {
    it("creates a session with LOBBY state", () => {
      expect(session.state).toBe("LOBBY");
      expect(session.currentQuestionIndex).toBe(-1);
      expect(session.sessionCode).toHaveLength(6);
      expect(session.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(session.mode).toBe("open");
      expect(session.week).toBe("week01");
    });

    it("generates join codes from the expected alphabet without using the legacy random source", () => {
      const randomSpy = jest.spyOn(Math, "random").mockImplementation(() => {
        throw new Error("Legacy random source used");
      });
      try {
        const codes = Array.from({ length: 1000 }, () => createSession("week01", "open").sessionCode);
        for (const code of codes) {
          expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
        }
        expect(randomSpy).not.toHaveBeenCalled();
      } finally {
        randomSpy.mockRestore();
      }
    });

    it("has no legacy random calls in server sources", () => {
      const files: string[] = [];
      const collect = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) collect(path);
          else if (path.endsWith(".ts")) files.push(path);
        }
      };
      collect(join(__dirname, ".."));
      for (const file of files) {
        expect(readFileSync(file, "utf8")).not.toMatch(/\bMath[.]random\b/);
      }
    });
  });

  describe("session JSON round trips", () => {
    it.each(SESSION_STATES)("preserves a populated %s session", (state) => {
      const original = createSession("week01", "strict");
      addParticipant(original, "S001", "sock1", "Alice", undefined, "client-a");
      addParticipant(original, "S002", "sock2");
      original.state = state;
      original.currentQuestionIndex = 1;
      original.questionStartedAt = 123456;
      original.revealedQuestionIndexes?.add(0);
      original.revealedQuestionIndexes?.add(1);
      original.submissions.push(
        { studentId: "S001", questionIndex: 0, selectedOptions: ["A"], responseText: undefined, submittedAt: 123500, responseTimeMs: 44 },
        { studentId: "S002", questionIndex: 1, selectedOptions: ["B"], responseText: undefined, submittedAt: 123600, responseTimeMs: 100 },
      );

      const restored = deserializeSession(serializeSession(original));
      expect(restored).toStrictEqual(original);
      expect(restored).not.toBe(original);
      expect(restored.participants).toBeInstanceOf(Map);
      expect(restored.revealedQuestionIndexes).toBeInstanceOf(Set);
      expect(restored.participants.get("S001")).not.toBe(original.participants.get("S001"));
      expect(getDistribution(restored, 0)).toEqual(getDistribution(original, 0));
      expect(computeLeaderboard(restored, new Map([[0, ["A"]], [1, ["B"]]])))
        .toEqual(computeLeaderboard(original, new Map([[0, ["A"]], [1, ["B"]]])));
    });

    it("preserves absent optional fields and remains usable after restoration", () => {
      const original = createSession("week01", "open");
      delete original.revealedQuestionIndexes;
      const { participant } = addParticipant(original, "S001", "sock1");
      original.state = "QUESTION_OPEN";
      original.currentQuestionIndex = 0;
      original.questionStartedAt = Date.now() - 1000;

      const restored = deserializeSession(serializeSession(original));
      expect(restored).toStrictEqual(original);
      restored.participants.get("S001")!.connected = false;
      expect(addParticipant(restored, "S001", "sock2", undefined, participant.sessionToken).isReconnect).toBe(true);
      recordSubmission(restored, "S001", 0, ["A"]);
      expect(getSubmissionCount(restored, 0)).toEqual({ submitted: 1, total: 1 });
      transitionState(restored, "QUESTION_CLOSED");
      expect(restored.state).toBe("QUESTION_CLOSED");
    });
  });

  describe("state transitions", () => {
    it("allows LOBBY -> QUESTION_OPEN", () => {
      transitionState(session, "QUESTION_OPEN");
      expect(session.state).toBe("QUESTION_OPEN");
    });

    it("allows full happy path", () => {
      transitionState(session, "QUESTION_OPEN");
      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");
      transitionState(session, "QUESTION_OPEN"); // next question
      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");
      transitionState(session, "LEADERBOARD");
      transitionState(session, "ENDED");
      expect(session.state).toBe("ENDED");
    });

    it("rejects invalid transitions", () => {
      // LOBBY -> QUESTION_CLOSED is not allowed
      expect(() => transitionState(session, "QUESTION_CLOSED")).toThrow(
        StateTransitionError,
      );
      expect(() => transitionState(session, "REVEAL")).toThrow(StateTransitionError);
      expect(() => transitionState(session, "LEADERBOARD")).toThrow(StateTransitionError);
    });

    it("allows ending a session that never started", () => {
      transitionState(session, "ENDED");
      expect(session.state).toBe("ENDED");
    });

    it("rejects transitions from ENDED", () => {
      transitionState(session, "QUESTION_OPEN");
      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");
      transitionState(session, "LEADERBOARD");
      transitionState(session, "ENDED");

      expect(() => transitionState(session, "LOBBY")).toThrow(StateTransitionError);
      expect(() => transitionState(session, "QUESTION_OPEN")).toThrow(
        StateTransitionError,
      );
    });

    it("allows REVEAL -> QUESTION_OPEN (next question)", () => {
      transitionState(session, "QUESTION_OPEN");
      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");
      // Can go to next question or leaderboard
      transitionState(session, "QUESTION_OPEN");
      expect(session.state).toBe("QUESTION_OPEN");
    });

    it("allows REVEAL -> LEADERBOARD", () => {
      transitionState(session, "QUESTION_OPEN");
      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");
      transitionState(session, "LEADERBOARD");
      expect(session.state).toBe("LEADERBOARD");
    });

    it("allows LEADERBOARD -> REVEAL for instructor resume", () => {
      transitionState(session, "QUESTION_OPEN");
      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");
      transitionState(session, "LEADERBOARD");
      transitionState(session, "REVEAL");
      expect(session.state).toBe("REVEAL");
    });

    it("validates all transitions in STATE_TRANSITIONS map", () => {
      // Exhaustive check: every invalid pair is rejected
      const allStates: SessionState[] = [
        "LOBBY",
        "QUESTION_OPEN",
        "QUESTION_CLOSED",
        "REVEAL",
        "LEADERBOARD",
        "ENDED",
      ];
      for (const from of allStates) {
        for (const to of allStates) {
          const s = createSession("w", "open");
          // Force state to "from"
          (s as { state: SessionState }).state = from;
          const allowed = STATE_TRANSITIONS[from].includes(to);
          if (allowed) {
            expect(() => transitionState(s, to)).not.toThrow();
          } else {
            expect(() => transitionState(s, to)).toThrow(StateTransitionError);
          }
        }
      }
    });
  });

  describe("participants", () => {
    it("adds a new participant", () => {
      const { participant, isReconnect } = addParticipant(
        session,
        "S001",
        "sock1",
        "Alice",
      );
      expect(isReconnect).toBe(false);
      expect(participant.studentId).toBe("S001");
      expect(participant.displayName).toBe("Alice");
      expect(participant.sessionToken).toBeTruthy();
      expect(participant.connected).toBe(true);
      expect(session.participants.size).toBe(1);
    });

    it("allows reconnection with matching token", () => {
      const { participant: p1 } = addParticipant(session, "S001", "sock1", "Alice");
      const token = p1.sessionToken;
      // Simulate disconnect
      p1.connected = false;
      p1.socketId = "";

      // Reconnect with same token
      const { participant: p2, isReconnect } = addParticipant(
        session,
        "S001",
        "sock2",
        undefined,
        token,
      );
      expect(isReconnect).toBe(true);
      expect(p2.socketId).toBe("sock2");
      expect(p2.connected).toBe(true);
      expect(session.participants.size).toBe(1); // still 1 participant
    });

    it("rejects duplicate studentId with different token", () => {
      addParticipant(session, "S001", "sock1");
      expect(() =>
        addParticipant(session, "S001", "sock2", undefined, "wrong-token"),
      ).toThrow(/already in use/);
    });

    it("rejects duplicate studentId with no token", () => {
      addParticipant(session, "S001", "sock1");
      expect(() => addParticipant(session, "S001", "sock2")).toThrow(/already in use/);
    });

    it("allows token-less reconnect when same client instance rejoins", () => {
      const { participant } = addParticipant(session, "S001", "sock1", "Alice", undefined, "client-a");
      participant.connected = false;

      const { participant: rejoined, isReconnect } = addParticipant(
        session,
        "S001",
        "sock2",
        undefined,
        undefined,
        "client-a",
      );

      expect(isReconnect).toBe(true);
      expect(rejoined.socketId).toBe("sock2");
      expect(rejoined.connected).toBe(true);
    });

    it("rejects token-less reconnect from different client instance", () => {
      const { participant } = addParticipant(session, "S001", "sock1", "Alice", undefined, "client-a");
      participant.connected = false;

      expect(() =>
        addParticipant(session, "S001", "sock2", undefined, undefined, "client-b"),
      ).toThrow(/already in use/);
    });
  });

  describe("submissions", () => {
    beforeEach(() => {
      addParticipant(session, "S001", "sock1");
      addParticipant(session, "S002", "sock2");
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 1000;
    });

    it("records a valid submission", () => {
      const sub = recordSubmission(session, "S001", 0, ["B"]);
      expect(sub.studentId).toBe("S001");
      expect(sub.selectedOptions).toEqual(["B"]);
      expect(sub.responseTimeMs).toBeGreaterThan(0);
      expect(session.submissions).toHaveLength(1);
    });

    it("normalizes multi-select submissions before storing", () => {
      const sub = recordSubmission(session, "S001", 0, ["D", "A", "D"]);
      expect(sub.selectedOptions).toEqual(["A", "D"]);
    });

    it("rejects duplicate submission", () => {
      recordSubmission(session, "S001", 0, ["B"]);
      expect(() => recordSubmission(session, "S001", 0, ["A"])).toThrow(
        /Already submitted/,
      );
    });

    it("rejects submission when not in QUESTION_OPEN", () => {
      transitionState(session, "QUESTION_CLOSED");
      expect(() => recordSubmission(session, "S001", 0, ["B"])).toThrow(
        /QUESTION_OPEN/,
      );
    });

    it("rejects submission for wrong question index", () => {
      expect(() => recordSubmission(session, "S001", 1, ["B"])).toThrow(
        /Question index mismatch/,
      );
    });

    it("rejects submission from non-participant", () => {
      expect(() => recordSubmission(session, "S999", 0, ["B"])).toThrow(
        /not a participant/,
      );
    });

    it("rejects submission with empty selectedOptions", () => {
      expect(() => recordSubmission(session, "S001", 0, [])).toThrow();
    });

    it("records a valid open response submission", () => {
      const sub = recordSubmission(session, "S001", 0, { responseText: "The rendering pipeline." });
      expect(sub.selectedOptions).toEqual([]);
      expect(sub.responseText).toBe("The rendering pipeline.");
    });

    it("updates an existing open response submission", () => {
      const first = recordSubmission(session, "S001", 0, { responseText: "First response." });
      const updated = recordSubmission(session, "S001", 0, { responseText: "Updated response." });

      expect(updated).toBe(first);
      expect(session.submissions).toHaveLength(1);
      expect(session.submissions[0].responseText).toBe("Updated response.");
    });

    it("rejects blank open response submissions", () => {
      expect(() => recordSubmission(session, "S001", 0, { responseText: "   " })).toThrow(/required/i);
    });
  });

  describe("edge cases", () => {
    it("multiple participants can submit different answers to same question", () => {
      addParticipant(session, "S001", "sock1");
      addParticipant(session, "S002", "sock2");
      addParticipant(session, "S003", "sock3");
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 1000;

      recordSubmission(session, "S001", 0, ["A"]);
      recordSubmission(session, "S002", 0, ["B"]);
      recordSubmission(session, "S003", 0, ["C"]);
      expect(session.submissions).toHaveLength(3);

      const dist = getDistribution(session, 0);
      expect(dist).toEqual({ A: 1, B: 1, C: 1 });
    });

    it("QUESTION_OPEN -> QUESTION_CLOSED -> REVEAL -> QUESTION_OPEN cycle works repeatedly", () => {
      for (let i = 0; i < 5; i++) {
        transitionState(session, "QUESTION_OPEN");
        transitionState(session, "QUESTION_CLOSED");
        transitionState(session, "REVEAL");
      }
      expect(session.state).toBe("REVEAL");
      transitionState(session, "LEADERBOARD");
      transitionState(session, "ENDED");
      expect(session.state).toBe("ENDED");
    });

    it("leaderboard with no submissions returns empty entries for all participants", () => {
      addParticipant(session, "S001", "sock1", "Alice");
      addParticipant(session, "S002", "sock2", "Bob");

      const correctMap = new Map<number, string[]>();
      correctMap.set(0, ["A"]);

      const board = computeLeaderboard(session, correctMap);
      expect(board.length).toBe(2);
      expect(board[0].correctCount).toBe(0);
      expect(board[1].correctCount).toBe(0);
    });
  });

  describe("distribution and counts", () => {
    beforeEach(() => {
      addParticipant(session, "S001", "sock1");
      addParticipant(session, "S002", "sock2");
      addParticipant(session, "S003", "sock3");
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 1000;
    });

    it("computes answer distribution", () => {
      recordSubmission(session, "S001", 0, ["A"]);
      recordSubmission(session, "S002", 0, ["B"]);
      recordSubmission(session, "S003", 0, ["A"]);
      const dist = getDistribution(session, 0);
      expect(dist).toEqual({ A: 2, B: 1 });
    });

    it("computes submission count", () => {
      recordSubmission(session, "S001", 0, ["A"]);
      const count = getSubmissionCount(session, 0);
      expect(count).toEqual({ submitted: 1, total: 3 });
    });
  });

  describe("leaderboard", () => {
    it("ranks by correct count then time", () => {
      addParticipant(session, "S001", "sock1", "Alice");
      addParticipant(session, "S002", "sock2", "Bob");
      addParticipant(session, "S003", "sock3", "Charlie");

      // Simulate 2 questions
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 5000;

      recordSubmission(session, "S001", 0, ["B"]); // correct
      recordSubmission(session, "S002", 0, ["A"]); // wrong
      recordSubmission(session, "S003", 0, ["B"]); // correct

      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 1;
      session.questionStartedAt = Date.now() - 3000;

      recordSubmission(session, "S001", 1, ["C"]); // correct
      recordSubmission(session, "S002", 1, ["C"]); // correct
      recordSubmission(session, "S003", 1, ["A"]); // wrong

      const correctMap = new Map<number, string[]>();
      correctMap.set(0, ["B"]);
      correctMap.set(1, ["C"]);

      const board = computeLeaderboard(session, correctMap);

      // S001: 2 correct, S002: 1 correct, S003: 1 correct
      expect(board[0].studentId).toBe("S001");
      expect(board[0].correctCount).toBe(2);
      expect(board[0].rank).toBe(1);

      // S002 and S003 both have 1 correct, tiebreak by total time
      expect(board[1].correctCount).toBe(1);
      expect(board[2].correctCount).toBe(1);
    });

    it("treats multi-select answers as exact sets", () => {
      expect(isExactOptionMatch(["D", "A"], ["A", "D"])).toBe(true);
      expect(isExactOptionMatch(["A", "D", "A"], ["A", "D"])).toBe(true);
      expect(isExactOptionMatch(["A"], ["A", "D"])).toBe(false);
      expect(isExactOptionMatch(["A", "B"], ["A", "D"])).toBe(false);
    });
  });
});
