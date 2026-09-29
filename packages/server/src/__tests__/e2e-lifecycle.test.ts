/**
 * End-to-end integration test for the full instructor/student lifecycle.
 *
 * Verifies the complete quiz flow:
 *   1. Instructor creates session via REST
 *   2. Students join via Socket.IO
 *   3. Instructor starts quiz (LOBBY -> QUESTION_OPEN)
 *   4. Students submit answers
 *   5. Question closes (auto or manual)
 *   6. Instructor reveals results
 *   7. Instructor advances to next question (repeat 4-6)
 *   8. Instructor shows leaderboard
 *   9. Instructor ends session
 *   10. Verify leaderboard ordering and persistence artifacts
 */

import { createServer, Server as HttpServer } from "http";
import { Server as IOServer } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { createApp } from "../app";
import {
  setupSocket,
  broadcastQuestionOpen,
  broadcastReveal,
  broadcastLeaderboard,
  clearSessionTimers,
} from "../socket";
import { clearAllSessions, getDistribution } from "../session";
import {
  SocketEvents,
  Quiz,
  StudentJoinedPayload,
  QuestionOpenPayload,
  AnswerAcceptedPayload,
  ResultsRevealPayload,
  LeaderboardUpdatePayload,
  SessionStatePayload,
} from "@mdq/shared";
import * as path from "path";
import * as fs from "fs";
import { AddressInfo } from "net";

const quizDir = path.join(__dirname, "fixtures/quizzes");

/**
 * Helper: connect a student socket and join the session.
 * Returns the socket + joined payload (contains sessionToken).
 */
async function connectStudent(
  baseUrl: string,
  sessionId: string,
  studentId: string,
  displayName: string,
): Promise<{ socket: ClientSocket; joined: StudentJoinedPayload }> {
  const socket = ioClient(baseUrl, {
    autoConnect: false,
    auth: { sessionId },
    transports: ["websocket"],
  });

  const joinedPromise = new Promise<StudentJoinedPayload>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: student:joined for ${studentId}`)), 5000);
    socket.once(SocketEvents.STUDENT_JOINED, (data: StudentJoinedPayload) => {
      clearTimeout(timer);
      resolve(data);
    });
    socket.once(SocketEvents.STUDENT_REJECTED, (data: { reason: string }) => {
      clearTimeout(timer);
      reject(new Error(`Student rejected: ${data.reason}`));
    });
  });

  socket.connect();
  socket.emit(SocketEvents.STUDENT_JOIN, { studentId, displayName });

  const joined = await joinedPromise;
  return { socket, joined };
}

/**
 * Helper: wait for any socket event with a timeout.
 */
function waitFor<T>(socket: ClientSocket, event: string, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

describe("E2E Lifecycle: Full Quiz Session", () => {
  let httpServer: HttpServer;
  let ioServer: IOServer;
  let port: number;
  let baseUrl: string;
  let app: ReturnType<typeof createApp>;
  let tmpDataDir: string;

  beforeAll((done) => {
    // Use a temp data dir for persistence tests
    tmpDataDir = fs.mkdtempSync(path.join(__dirname, "e2e-data-"));

    // Container for io reference (same pattern as index.ts)
    const ioRef: { current: IOServer | null } = { current: null };

    function sessionRoom(sessionId: string): string {
      return `session:${sessionId}`;
    }

    app = createApp({
      quizDir,
      dataDir: tmpDataDir,
      onStateChange: (session, sessionId, newState, quiz) => {
        const io = ioRef.current;
        if (!io) return;

        switch (newState) {
          case "QUESTION_OPEN":
            if (quiz) broadcastQuestionOpen(io, session, sessionId, quiz);
            break;
          case "QUESTION_CLOSED": {
            clearSessionTimers(sessionId);
            io.to(sessionRoom(sessionId)).emit(SocketEvents.QUESTION_CLOSE, {
              questionIndex: session.currentQuestionIndex,
            });
            io.to(sessionRoom(sessionId)).emit(SocketEvents.SESSION_STATE, {
              state: session.state,
              questionIndex: session.currentQuestionIndex,
            });
            const dist = getDistribution(session, session.currentQuestionIndex);
            io.to(sessionRoom(sessionId)).emit(SocketEvents.RESULTS_DISTRIBUTION, {
              questionIndex: session.currentQuestionIndex,
              distribution: dist,
            });
            break;
          }
          case "REVEAL":
            if (quiz) broadcastReveal(io, session, sessionId, quiz);
            break;
          case "LEADERBOARD":
            if (quiz) broadcastLeaderboard(io, session, sessionId, quiz);
            break;
          case "ENDED":
            io.to(sessionRoom(sessionId)).emit(SocketEvents.SESSION_STATE, {
              state: "ENDED",
            });
            break;
        }
      },
    });
    httpServer = createServer(app);
    const quizzes = (app as unknown as { _quizzes: Map<string, Quiz> })._quizzes;
    ioServer = setupSocket(httpServer, quizzes);
    ioRef.current = ioServer;
    httpServer.listen(0, () => {
      port = (httpServer.address() as AddressInfo).port;
      baseUrl = `http://localhost:${port}`;
      done();
    });
  });

  afterAll((done) => {
    ioServer.close();
    httpServer.close(() => {
      // Clean up temp data dir
      try {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      } catch { /* ignore */ }
      done();
    });
  });

  afterEach(() => {
    clearAllSessions();
  });

  it("runs complete 3-question lifecycle: join, answer, reveal, leaderboard, end", async () => {
    // ── Step 1: Create session via REST ──
    const createRes = await request(app)
      .post("/api/session")
      .send({ week: "week01", mode: "open" })
      .expect(201);

    const { sessionId, sessionCode } = createRes.body;
    expect(sessionId).toBeTruthy();
    expect(sessionCode).toMatch(/^[A-Z0-9]{6}$/);

    // Verify session lookup by code
    const lookupRes = await request(app)
      .get(`/api/session/by-code/${sessionCode}`)
      .expect(200);
    expect(lookupRes.body.sessionId).toBe(sessionId);
    expect(lookupRes.body.state).toBe("LOBBY");

    // ── Step 2: Students join ──
    const students = await Promise.all([
      connectStudent(baseUrl, sessionId, "STU001", "Alice"),
      connectStudent(baseUrl, sessionId, "STU002", "Bob"),
      connectStudent(baseUrl, sessionId, "STU003", "Charlie"),
    ]);

    // Verify all joined in LOBBY
    for (const s of students) {
      expect(s.joined.sessionState).toBe("LOBBY");
      expect(s.joined.sessionToken).toBeTruthy();
    }

    // ── Step 3: Instructor starts quiz (LOBBY -> QUESTION_OPEN) ──
    // Register listeners BEFORE the POST to avoid race condition
    const q0Promises = students.map((s) =>
      waitFor<QuestionOpenPayload>(s.socket, SocketEvents.QUESTION_OPEN),
    );

    const startRes = await request(app)
      .post(`/api/session/${sessionId}/start`)
      .expect(200);
    expect(startRes.body.state).toBe("QUESTION_OPEN");
    expect(startRes.body.questionIndex).toBe(0);

    // Students should receive QUESTION_OPEN
    const q0Opens = await Promise.all(q0Promises);
    for (const q of q0Opens) {
      expect(q.questionIndex).toBe(0);
      expect(q.timeLimitSec).toBeGreaterThan(0);
      expect(q.options.length).toBeGreaterThanOrEqual(2);
    }

    // ── Step 4: Students submit answers ──
    // Alice answers correctly (B), Bob answers wrong (A), Charlie answers correctly (B)
    const correctOption = "B"; // From week01.md: correct answer for Q1 is B
    const submitPromises = [
      { socket: students[0].socket, answer: [correctOption] },  // Alice: correct
      { socket: students[1].socket, answer: ["A"] },             // Bob: wrong
      { socket: students[2].socket, answer: [correctOption] },  // Charlie: correct
    ].map(({ socket, answer }) => {
      const acceptPromise = waitFor<AnswerAcceptedPayload>(socket, SocketEvents.ANSWER_ACCEPTED);
      socket.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: answer,
      });
      return acceptPromise;
    });

    const accepts = await Promise.all(submitPromises);
    for (const a of accepts) {
      expect(a.questionIndex).toBe(0);
    }

    // ── Step 5: Instructor closes question ──
    // Register listeners for close event before POST
    const closeStatePromises = students.map((s) =>
      waitFor<SessionStatePayload>(s.socket, SocketEvents.SESSION_STATE),
    );

    const closeRes = await request(app)
      .post(`/api/session/${sessionId}/close`)
      .expect(200);
    expect(closeRes.body.state).toBe("QUESTION_CLOSED");

    await Promise.all(closeStatePromises);

    // ── Step 6: Instructor reveals results ──
    // Register listeners BEFORE the POST
    const revealPromises = students.map((s) =>
      waitFor<ResultsRevealPayload>(s.socket, SocketEvents.RESULTS_REVEAL),
    );

    const revealRes = await request(app)
      .post(`/api/session/${sessionId}/reveal`)
      .expect(200);
    expect(revealRes.body.state).toBe("REVEAL");

    const reveals = await Promise.all(revealPromises);
    for (const r of reveals) {
      expect(r.questionIndex).toBe(0);
      expect(r.correctOptions).toContain(correctOption);
      expect(r.distribution).toBeDefined();
    }

    // ── Step 7: Advance to question 2 ──
    // Register listeners BEFORE the POST
    const q1Promises = students.map((s) =>
      waitFor<QuestionOpenPayload>(s.socket, SocketEvents.QUESTION_OPEN),
    );

    const nextRes = await request(app)
      .post(`/api/session/${sessionId}/next`)
      .expect(200);
    expect(nextRes.body.state).toBe("QUESTION_OPEN");
    expect(nextRes.body.questionIndex).toBe(1);

    // Students get Q2 open
    const q1Opens = await Promise.all(q1Promises);
    for (const q of q1Opens) {
      expect(q.questionIndex).toBe(1);
    }

    // All answer Q2 correctly (B for week01 Q2)
    for (const s of students) {
      const ap = waitFor<AnswerAcceptedPayload>(s.socket, SocketEvents.ANSWER_ACCEPTED);
      s.socket.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 1,
        selectedOptions: ["B"],
      });
      await ap;
    }

    // Close and reveal Q2
    await request(app).post(`/api/session/${sessionId}/close`).expect(200);
    // Wait briefly for close broadcasts to arrive, then register reveal listeners
    await new Promise((r) => setTimeout(r, 50));
    const reveal2Promises = students.map((s) =>
      waitFor<ResultsRevealPayload>(s.socket, SocketEvents.RESULTS_REVEAL),
    );
    await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
    const q2Reveals = await Promise.all(reveal2Promises);
    for (const reveal of q2Reveals) {
      expect(reveal.questionIndex).toBe(1);
      expect(reveal.correctOptions).toContain("B");
      expect(reveal.distribution.B).toBe(3);
    }

    const lbAfterQ2 = await request(app)
      .get(`/api/session/${sessionId}/leaderboard`)
      .expect(200);
    expect(lbAfterQ2.body.entries.find((e: { publicKey: string; correctCount: number }) => e.publicKey === students[0].joined.publicKey)!.correctCount).toBe(2);
    expect(lbAfterQ2.body.entries.find((e: { publicKey: string; correctCount: number }) => e.publicKey === students[1].joined.publicKey)!.correctCount).toBe(1);
    expect(lbAfterQ2.body.entries.find((e: { publicKey: string; correctCount: number }) => e.publicKey === students[2].joined.publicKey)!.correctCount).toBe(2);

    const prevRevealPromises = students.map((s) =>
      waitFor<ResultsRevealPayload>(s.socket, SocketEvents.RESULTS_REVEAL),
    );
    const prevRes = await request(app).post(`/api/session/${sessionId}/prev`).expect(200);
    expect(prevRes.body).toMatchObject({ state: "REVEAL", questionIndex: 0 });
    const prevReveals = await Promise.all(prevRevealPromises);
    for (const reveal of prevReveals) {
      expect(reveal.questionIndex).toBe(0);
    }

    const nextReviewRevealPromises = students.map((s) =>
      waitFor<ResultsRevealPayload>(s.socket, SocketEvents.RESULTS_REVEAL),
    );
    const nextReviewRes = await request(app).post(`/api/session/${sessionId}/next`).expect(200);
    expect(nextReviewRes.body).toMatchObject({ state: "REVEAL", questionIndex: 1 });
    const nextReviewReveals = await Promise.all(nextReviewRevealPromises);
    for (const reveal of nextReviewReveals) {
      expect(reveal.questionIndex).toBe(1);
      expect(reveal.correctOptions).toContain("B");
      expect(reveal.distribution.B).toBe(3);
    }

    const lbAfterReviewNavigation = await request(app)
      .get(`/api/session/${sessionId}/leaderboard`)
      .expect(200);
    expect(lbAfterReviewNavigation.body.entries).toEqual(lbAfterQ2.body.entries);

    // ── Step 8: Advance to question 3 ──
    // Register listeners BEFORE the POST
    const q2Promises = students.map((s) =>
      waitFor<QuestionOpenPayload>(s.socket, SocketEvents.QUESTION_OPEN),
    );

    const next2Res = await request(app)
      .post(`/api/session/${sessionId}/next`)
      .expect(200);
    expect(next2Res.body.questionIndex).toBe(2);

    await Promise.all(q2Promises);

    // Multi-select question: correct answers are A, B, D
    // Alice gets all correct, Bob gets partial (A only), Charlie gets all correct
    for (const [i, answer] of [["A", "B", "D"], ["A"], ["A", "B", "D"]].entries()) {
      const ap = waitFor<AnswerAcceptedPayload>(students[i].socket, SocketEvents.ANSWER_ACCEPTED);
      students[i].socket.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 2,
        selectedOptions: answer,
      });
      await ap;
    }

    // Close and reveal Q3
    await request(app).post(`/api/session/${sessionId}/close`).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    const reveal3Promises = students.map((s) =>
      waitFor<ResultsRevealPayload>(s.socket, SocketEvents.RESULTS_REVEAL),
    );
    await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
    await Promise.all(reveal3Promises);

    // ── Step 9: Show leaderboard ──
    // Register listeners BEFORE the POST
    const lbShowPromises = students.map((s) =>
      waitFor<LeaderboardUpdatePayload>(s.socket, SocketEvents.LEADERBOARD_UPDATE),
    );

    await request(app)
      .post(`/api/session/${sessionId}/leaderboard-show`)
      .expect(200);

    const lbUpdates = await Promise.all(lbShowPromises);
    const leaderboard = lbUpdates[0]; // same for all students
    expect(leaderboard.entries.length).toBe(3);
    expect(leaderboard.totalQuestions).toBe(3);

    // Alice: 3 correct, Charlie: 3 correct, Bob: 1 correct
    // Alice and Charlie tie on correctCount (3), tiebreak by time then studentId
    // Phones find their own row by public key; the leaderboard they get never carries Student IDs.
    const [alice, bob, charlie] = students.map((s) => s.joined.publicKey);
    const aliceEntry = leaderboard.entries.find((e) => e.publicKey === alice);
    const bobEntry = leaderboard.entries.find((e) => e.publicKey === bob);
    const charlieEntry = leaderboard.entries.find((e) => e.publicKey === charlie);
    expect(leaderboard.entries.every((e) => e.studentId === undefined)).toBe(true);

    expect(aliceEntry!.correctCount).toBe(3);
    expect(charlieEntry!.correctCount).toBe(3);
    expect(bobEntry!.correctCount).toBe(1); // only Q2 correct

    // Alice and Charlie should be ranked 1-2, Bob last
    expect(bobEntry!.rank).toBe(3);

    // Also verify via REST leaderboard
    const lbRes = await request(app)
      .get(`/api/session/${sessionId}/leaderboard`)
      .expect(200);
    expect(lbRes.body.entries.length).toBe(3);
    expect(lbRes.body.totalQuestions).toBe(3);

    // ── Step 10: End session ──
    // Register listeners BEFORE the POST
    const endPromises = students.map((s) =>
      waitFor<SessionStatePayload>(s.socket, SocketEvents.SESSION_STATE),
    );

    await request(app)
      .post(`/api/session/${sessionId}/end`)
      .expect(200);

    const endStates = await Promise.all(endPromises);
    for (const e of endStates) {
      expect(e.state).toBe("ENDED");
    }

    // ── Step 11: Verify post-session state ──
    // Session should reject new joins
    try {
      await connectStudent(baseUrl, sessionId, "STU004", "Late Dave");
      fail("Should have rejected late join");
    } catch (e) {
      expect((e as Error).message).toContain("ended");
    }

    // Clean up
    for (const s of students) {
      s.socket.disconnect();
    }
  }, 30000);

  it("handles student reconnection mid-question correctly", async () => {
    // Create and start session
    const createRes = await request(app)
      .post("/api/session")
      .send({ week: "week01", mode: "open" })
      .expect(201);
    const { sessionId } = createRes.body;

    // Student joins
    const { socket: sock1, joined } = await connectStudent(baseUrl, sessionId, "RC01", "ReconnectUser");
    const token = joined.sessionToken;

    // Start quiz - register listener BEFORE POST
    const qOpenPromise = waitFor<QuestionOpenPayload>(sock1, SocketEvents.QUESTION_OPEN);
    await request(app).post(`/api/session/${sessionId}/start`).expect(200);
    await qOpenPromise;

    // Submit answer for Q1
    const ap = waitFor<AnswerAcceptedPayload>(sock1, SocketEvents.ANSWER_ACCEPTED);
    sock1.emit(SocketEvents.ANSWER_SUBMIT, {
      questionIndex: 0,
      selectedOptions: ["A"],
    });
    await ap;

    // Disconnect
    sock1.disconnect();
    await new Promise((r) => setTimeout(r, 200));

    // Reconnect with original session token
    const sock2 = ioClient(baseUrl, {
      autoConnect: false,
      auth: { sessionId },
      transports: ["websocket"],
    });
    const joinPromise = waitFor<StudentJoinedPayload>(sock2, SocketEvents.STUDENT_JOINED);
    sock2.connect();
    sock2.emit(SocketEvents.STUDENT_JOIN, {
      studentId: "RC01",
      displayName: "ReconnectUser",
      sessionToken: token,
    });
    const reconnected = await joinPromise;

    expect(reconnected.sessionState).toBe("QUESTION_OPEN");
    expect(reconnected.answeredQuestions).toContain(0);

    sock2.disconnect();
  }, 15000);

  it("rejects submissions when question is closed", async () => {
    const createRes = await request(app)
      .post("/api/session")
      .send({ week: "week01", mode: "open" })
      .expect(201);
    const { sessionId } = createRes.body;

    const { socket } = await connectStudent(baseUrl, sessionId, "LATE01", "LateSubmitter");

    // Register listener BEFORE POST /start
    const qOpenPromise = waitFor<QuestionOpenPayload>(socket, SocketEvents.QUESTION_OPEN);
    await request(app).post(`/api/session/${sessionId}/start`).expect(200);
    await qOpenPromise;

    // Close question before student submits
    // Register listener BEFORE POST /close
    const closeStatePromise = waitFor<SessionStatePayload>(socket, SocketEvents.SESSION_STATE);
    await request(app).post(`/api/session/${sessionId}/close`).expect(200);
    await closeStatePromise;

    // Try to submit after close
    const rejectPromise = waitFor<{ reason: string }>(
      socket,
      SocketEvents.ANSWER_REJECTED,
    );
    socket.emit(SocketEvents.ANSWER_SUBMIT, {
      questionIndex: 0,
      selectedOptions: ["B"],
    });
    const rejected = await rejectPromise;
    expect(rejected.reason).toContain("QUESTION_OPEN");

    socket.disconnect();
  }, 10000);

  it("rejects duplicate multiple-choice submissions for the same question", async () => {
    const createRes = await request(app)
      .post("/api/session")
      .send({ week: "week01", mode: "open" })
      .expect(201);
    const { sessionId } = createRes.body;

    const { socket } = await connectStudent(baseUrl, sessionId, "DUP01", "DupSubmitter");

    // Register listener BEFORE POST /start
    const qOpenPromise = waitFor<QuestionOpenPayload>(socket, SocketEvents.QUESTION_OPEN);
    await request(app).post(`/api/session/${sessionId}/start`).expect(200);
    await qOpenPromise;

    // First submission
    const ap = waitFor<AnswerAcceptedPayload>(socket, SocketEvents.ANSWER_ACCEPTED);
    socket.emit(SocketEvents.ANSWER_SUBMIT, {
      questionIndex: 0,
      selectedOptions: ["B"],
    });
    await ap;

    // Second submission for same question
    const rp = waitFor<{ reason: string }>(socket, SocketEvents.ANSWER_REJECTED);
    socket.emit(SocketEvents.ANSWER_SUBMIT, {
      questionIndex: 0,
      selectedOptions: ["A"],
    });
    const rej = await rp;
    expect(rej.reason).toContain("Already submitted");

    socket.disconnect();
  }, 10000);

  it("verifies state machine rejects invalid transitions", async () => {
    const createRes = await request(app)
      .post("/api/session")
      .send({ week: "week01", mode: "open" })
      .expect(201);
    const { sessionId } = createRes.body;

    // Cannot reveal from LOBBY
    await request(app)
      .post(`/api/session/${sessionId}/reveal`)
      .expect(400);

    // Cannot close from LOBBY
    await request(app)
      .post(`/api/session/${sessionId}/close`)
      .expect(400);

    // Can start (LOBBY -> QUESTION_OPEN)
    await request(app)
      .post(`/api/session/${sessionId}/start`)
      .expect(200);

    // Cannot start again (already QUESTION_OPEN)
    await request(app)
      .post(`/api/session/${sessionId}/start`)
      .expect(400);

    // Cannot reveal from QUESTION_OPEN
    await request(app)
      .post(`/api/session/${sessionId}/reveal`)
      .expect(400);
  }, 10000);

  it("verifies REST health and quiz listing endpoints", async () => {
    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.status).toBe("ok");
    expect(health.body.uptime).toBeGreaterThanOrEqual(0);

    const quizList = await request(app).get("/api/decks").expect(200);
    expect(Array.isArray(quizList.body)).toBe(true);
    expect(quizList.body.length).toBeGreaterThanOrEqual(1);
    expect(quizList.body[0]).toHaveProperty("week");
    expect(quizList.body[0]).toHaveProperty("questionCount");
  });
});
