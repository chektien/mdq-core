import { createServer } from "http";
import { Server } from "socket.io";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import request from "supertest";
import { createApp } from "../app";
import {
  setupSocket,
  clearSessionTimers,
  startQuestionTimer,
  broadcastQuestionOpen,
  broadcastReveal,
  broadcastLeaderboard,
} from "../socket";
import {
  clearAllSessions,
  storeSession,
  createSession,
  transitionState,
} from "../session";
import {
  SocketEvents,
  Quiz,
  QuestionOpenPayload,
  ResultsRevealPayload,
  LeaderboardUpdatePayload,
} from "@mdq/shared";
import { clearInstructorSessionsForTests } from "../instructor-auth";
import { getScoredQuestionCount } from "../scoring";
import * as path from "path";
import { AddressInfo } from "net";

const quizDir = path.join(__dirname, "fixtures/quizzes");

describe("Socket.IO Integration", () => {
  let httpServer: ReturnType<typeof createServer>;
  let ioServer: Server;
  let port: number;
  let baseUrl: string;
  let quizzes: Map<string, Quiz>;

  beforeAll((done) => {
    const app = createApp(quizDir);
    httpServer = createServer(app);
    quizzes = (app as unknown as { _quizzes: Map<string, Quiz> })._quizzes;
    ioServer = setupSocket(httpServer, quizzes);
    httpServer.listen(0, () => {
      port = (httpServer.address() as AddressInfo).port;
      baseUrl = `http://localhost:${port}`;
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

  function createClient(sessionId: string): ClientSocket {
    return ioClient(baseUrl, {
      autoConnect: false,
      auth: { sessionId },
      transports: ["websocket"],
    });
  }

  function waitForEvent<T>(client: ClientSocket, event: string, timeout = 3000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
      client.once(event, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  function waitForNoEvent(client: ClientSocket, event: string, timeout = 400): Promise<void> {
    return new Promise((resolve, reject) => {
      const onEvent = () => {
        clearTimeout(timer);
        reject(new Error(`Unexpected event: ${event}`));
      };
      const timer = setTimeout(() => {
        client.off(event, onEvent);
        resolve();
      }, timeout);
      client.once(event, onEvent);
    });
  }

  describe("student:join flow", () => {
    it("joins a session and receives student:joined", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      const client = createClient(session.sessionId);
      client.connect();

      const joinedPromise = waitForEvent<{ participantId: string; sessionToken: string; sessionState: string }>(
        client,
        SocketEvents.STUDENT_JOINED,
      );

      client.emit(SocketEvents.STUDENT_JOIN, {
        studentId: "S001",
        displayName: "Alice",
      });

      const joined = await joinedPromise;
      expect(joined.participantId).toBe("S001");
      expect(joined.sessionToken).toBeTruthy();
      expect(joined.sessionState).toBe("LOBBY");

      client.disconnect();
    });

    it("rejects join with empty studentId", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      const client = createClient(session.sessionId);
      client.connect();

      const rejectedPromise = waitForEvent<{ reason: string }>(
        client,
        SocketEvents.STUDENT_REJECTED,
      );

      client.emit(SocketEvents.STUDENT_JOIN, { studentId: "" });

      const rejected = await rejectedPromise;
      expect(rejected.reason).toContain("required");

      client.disconnect();
    });

    it("rejects duplicate studentId with different token", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      // First student joins
      const client1 = createClient(session.sessionId);
      client1.connect();
      const joined1Promise = waitForEvent<{ sessionToken: string }>(
        client1,
        SocketEvents.STUDENT_JOINED,
      );
      client1.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joined1Promise;

      // Second client tries same ID with wrong token
      const client2 = createClient(session.sessionId);
      client2.connect();
      const rejectedPromise = waitForEvent<{ reason: string }>(
        client2,
        SocketEvents.STUDENT_REJECTED,
      );
      client2.emit(SocketEvents.STUDENT_JOIN, {
        studentId: "S001",
        sessionToken: "wrong-token",
      });
      const rejected = await rejectedPromise;
      expect(rejected.reason).toContain("already in this session on another device");

      client1.disconnect();
      client2.disconnect();
    });

    it("allows reconnection with valid token", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      // First join
      const client1 = createClient(session.sessionId);
      client1.connect();
      const joined1Promise = waitForEvent<{ sessionToken: string }>(
        client1,
        SocketEvents.STUDENT_JOINED,
      );
      client1.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      const joined1 = await joined1Promise;
      const token = joined1.sessionToken;
      client1.disconnect();

      // Wait for disconnect to process
      await new Promise((r) => setTimeout(r, 100));

      // Reconnect with same token
      const client2 = createClient(session.sessionId);
      client2.connect();
      const joined2Promise = waitForEvent<{ sessionToken: string; participantId: string }>(
        client2,
        SocketEvents.STUDENT_JOINED,
      );
      client2.emit(SocketEvents.STUDENT_JOIN, {
        studentId: "S001",
        sessionToken: token,
      });
      const joined2 = await joined2Promise;
      expect(joined2.participantId).toBe("S001");
      expect(joined2.sessionToken).toBe(token);

      client2.disconnect();
    });

    it("allows token-less reconnect for same client instance after disconnect", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      const client1 = createClient(session.sessionId);
      client1.connect();
      const joined1Promise = waitForEvent<{ sessionToken: string }>(
        client1,
        SocketEvents.STUDENT_JOINED,
      );
      client1.emit(SocketEvents.STUDENT_JOIN, {
        studentId: "S001",
        clientInstanceId: "client-a",
      });
      await joined1Promise;
      client1.disconnect();
      await new Promise((r) => setTimeout(r, 100));

      const client2 = createClient(session.sessionId);
      client2.connect();
      const joined2Promise = waitForEvent<{ participantId: string }>(
        client2,
        SocketEvents.STUDENT_JOINED,
      );
      client2.emit(SocketEvents.STUDENT_JOIN, {
        studentId: "S001",
        clientInstanceId: "client-a",
      });

      const joined2 = await joined2Promise;
      expect(joined2.participantId).toBe("S001");

      client2.disconnect();
    });

    it("rejects join to non-existent session", async () => {
      const client = createClient("no-such-session");
      const rejectedPromise = waitForEvent<{ reason: string }>(
        client,
        SocketEvents.STUDENT_REJECTED,
      );
      client.connect();
      const rejected = await rejectedPromise;
      expect(rejected.reason).toContain("Session not found");
      client.disconnect();
    });

    it("rejects join to ended session", async () => {
      const session = createSession("week01", "open");
      // Force session to ENDED state
      session.state = "ENDED";
      storeSession(session);

      const client = createClient(session.sessionId);
      const rejectedPromise = waitForEvent<{ reason: string }>(
        client,
        SocketEvents.STUDENT_REJECTED,
      );
      client.connect();
      const rejected = await rejectedPromise;
      expect(rejected.reason).toContain("ended");
      client.disconnect();
    });
  });

  describe("answer:submit flow", () => {
    let session: ReturnType<typeof createSession>;
    let client: ClientSocket;

    beforeEach(async () => {
      session = createSession("week01", "open");
      storeSession(session);

      client = createClient(session.sessionId);
      client.connect();

      const joinedPromise = waitForEvent<{ sessionToken: string }>(
        client,
        SocketEvents.STUDENT_JOINED,
      );
      client.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joinedPromise;

      // Transition to QUESTION_OPEN
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now();
    });

    afterEach(() => {
      clearSessionTimers(session.sessionId);
      client.disconnect();
    });

    it("accepts valid submission", async () => {
      const acceptedPromise = waitForEvent<{ questionIndex: number }>(
        client,
        SocketEvents.ANSWER_ACCEPTED,
      );
      client.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["B"],
      });
      const accepted = await acceptedPromise;
      expect(accepted.questionIndex).toBe(0);
    });

    it("rejects duplicate submission (first-submission-only)", async () => {
      // First submission
      const accepted = waitForEvent(client, SocketEvents.ANSWER_ACCEPTED);
      client.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["B"],
      });
      await accepted;

      // Second submission
      const rejectedPromise = waitForEvent<{ reason: string }>(
        client,
        SocketEvents.ANSWER_REJECTED,
      );
      client.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["A"],
      });
      const rejected = await rejectedPromise;
      expect(rejected.reason).toContain("Already submitted");
    });

    it("rejects submission when question is closed", async () => {
      // Close the question
      transitionState(session, "QUESTION_CLOSED");

      const rejectedPromise = waitForEvent<{ reason: string }>(
        client,
        SocketEvents.ANSWER_REJECTED,
      );
      client.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["B"],
      });
      const rejected = await rejectedPromise;
      expect(rejected.reason).toContain("QUESTION_OPEN");
    });

    it("rejects submission for wrong question index", async () => {
      const rejectedPromise = waitForEvent<{ reason: string }>(
        client,
        SocketEvents.ANSWER_REJECTED,
      );
      client.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 5,
        selectedOptions: ["B"],
      });
      const rejected = await rejectedPromise;
      expect(rejected.reason).toContain("mismatch");
    });

    it("rejects multiple selections for single-select questions", async () => {
      const rejectedPromise = waitForEvent<{ reason: string }>(
        client,
        SocketEvents.ANSWER_REJECTED,
      );
      client.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["A", "B"],
      });
      const rejected = await rejectedPromise;
      expect(rejected.reason).toContain("one answer only");
    });

    it("accepts open response text, rejects blank input, and allows resubmission before close", async () => {
      const session = createSession("week-open", "open");
      const quiz = {
        week: "week-open",
        title: "Open Response Quiz",
        sourceFile: "week-open.md",
        questions: [{
          index: 0,
          topic: "Reflection",
          textMd: "Share one takeaway.",
          textHtml: "<p>Share one takeaway.</p>",
          questionType: "open_response" as const,
          options: [],
          correctOptions: [],
          allowsMultiple: false,
          explanation: "Thanks for sharing.",
          timeLimitSec: 30,
        }],
      };
      quizzes.set("week-open", quiz);
      storeSession(session);

      const openClient = createClient(session.sessionId);
      openClient.connect();
      const joinedPromise = waitForEvent<{ sessionToken: string }>(openClient, SocketEvents.STUDENT_JOINED);
      openClient.emit(SocketEvents.STUDENT_JOIN, { studentId: "S010" });
      await joinedPromise;

      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now();

      const blankRejectedPromise = waitForEvent<{ reason: string }>(openClient, SocketEvents.ANSWER_REJECTED);
      openClient.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        responseText: "   ",
      });
      const blankRejected = await blankRejectedPromise;
      expect(blankRejected.reason).toContain("cannot be blank");

      const acceptedPromise = waitForEvent<{ questionIndex: number }>(openClient, SocketEvents.ANSWER_ACCEPTED);
      openClient.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        responseText: "I finally understand the pipeline.",
      });
      await acceptedPromise;

      const resubmittedPromise = waitForEvent<{ questionIndex: number }>(openClient, SocketEvents.ANSWER_ACCEPTED);
      openClient.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        responseText: "Another answer",
      });
      await resubmittedPromise;
      expect(session.submissions).toHaveLength(1);
      expect(session.submissions[0].responseText).toBe("Another answer");

      openClient.disconnect();
      quizzes.delete("week-open");
    });
  });

  describe("reconnect during open question", () => {
    it("reconnected student can still submit if they have not answered", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      // Join
      const client1 = createClient(session.sessionId);
      client1.connect();
      const joined1Promise = waitForEvent<{ sessionToken: string }>(
        client1,
        SocketEvents.STUDENT_JOINED,
      );
      client1.emit(SocketEvents.STUDENT_JOIN, {
        studentId: "S001",
        displayName: "Alice",
      });
      const joined1 = await joined1Promise;
      const token = joined1.sessionToken;

      // Open question
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now();

      // Disconnect
      client1.disconnect();
      await new Promise((r) => setTimeout(r, 200));

      // Reconnect with valid token
      const client2 = createClient(session.sessionId);
      const joined2Promise = waitForEvent<{ sessionToken: string; answeredQuestions: number[] }>(
        client2,
        SocketEvents.STUDENT_JOINED,
      );
      client2.connect();
      client2.emit(SocketEvents.STUDENT_JOIN, {
        studentId: "S001",
        sessionToken: token,
      });
      const joined2 = await joined2Promise;
      expect(joined2.sessionToken).toBe(token);

      // Should be able to submit after reconnect
      const acceptedPromise = waitForEvent<{ questionIndex: number }>(
        client2,
        SocketEvents.ANSWER_ACCEPTED,
      );
      client2.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["B"],
      });
      const accepted = await acceptedPromise;
      expect(accepted.questionIndex).toBe(0);

      clearSessionTimers(session.sessionId);
      client2.disconnect();
    });

    it("reconnected student who already answered gets answeredQuestions in join response", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      // Join
      const client1 = createClient(session.sessionId);
      client1.connect();
      const joined1Promise = waitForEvent<{ sessionToken: string }>(
        client1,
        SocketEvents.STUDENT_JOINED,
      );
      client1.emit(SocketEvents.STUDENT_JOIN, {
        studentId: "S001",
        displayName: "Alice",
      });
      const joined1 = await joined1Promise;
      const token = joined1.sessionToken;

      // Open question and submit answer
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now();

      const acceptedPromise = waitForEvent<{ questionIndex: number }>(
        client1,
        SocketEvents.ANSWER_ACCEPTED,
      );
      client1.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["B"],
      });
      await acceptedPromise;

      // Disconnect
      client1.disconnect();
      await new Promise((r) => setTimeout(r, 200));

      // Reconnect with valid token -- should include question 0 in answeredQuestions
      const client2 = createClient(session.sessionId);
      const joined2Promise = waitForEvent<{ sessionToken: string; answeredQuestions: number[] }>(
        client2,
        SocketEvents.STUDENT_JOINED,
      );
      client2.connect();
      client2.emit(SocketEvents.STUDENT_JOIN, {
        studentId: "S001",
        sessionToken: token,
      });
      const joined2 = await joined2Promise;
      expect(joined2.answeredQuestions).toContain(0);

      // Attempting to resubmit should still be rejected for multiple-choice questions.
      const rejectedPromise = waitForEvent<{ reason: string }>(client2, SocketEvents.ANSWER_REJECTED);
      client2.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["A"],
      });
      const rejected = await rejectedPromise;
      expect(rejected.reason).toContain("Already submitted");

      clearSessionTimers(session.sessionId);
      client2.disconnect();
    });
  });

  describe("timer auto-close", () => {
    it("auto-closes question after timer expires", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      const client = createClient(session.sessionId);
      client.connect();
      const joinedPromise = waitForEvent(client, SocketEvents.STUDENT_JOINED);
      client.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joinedPromise;

      // Transition to QUESTION_OPEN
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now();

      // Start a very short timer (1 second)
      startQuestionTimer(ioServer, session, session.sessionId, 1);

      // Wait for auto-close
      const closeData = await waitForEvent<{ questionIndex: number }>(
        client,
        SocketEvents.QUESTION_CLOSE,
        5000,
      );
      expect(closeData.questionIndex).toBe(0);
      expect(session.state).toBe("QUESTION_CLOSED");

      // Submissions after close should be rejected
      const rejectedPromise = waitForEvent<{ reason: string }>(
        client,
        SocketEvents.ANSWER_REJECTED,
      );
      client.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["B"],
      });
      const rejected = await rejectedPromise;
      expect(rejected.reason).toContain("QUESTION_OPEN");

      clearSessionTimers(session.sessionId);
      client.disconnect();
    }, 10000);

    it("sends tick events during countdown", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      const client = createClient(session.sessionId);
      client.connect();
      const joinedPromise = waitForEvent(client, SocketEvents.STUDENT_JOINED);
      client.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joinedPromise;

      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now();

      // Start 3-second timer to allow at least 2 clear ticks
      startQuestionTimer(ioServer, session, session.sessionId, 3);

      // Collect ticks until we see at least 2
      const ticks: number[] = [];
      const tickPromise = new Promise<void>((resolve) => {
        client.on(SocketEvents.QUESTION_TICK, (data: { remainingSec: number }) => {
          ticks.push(data.remainingSec);
          if (ticks.length >= 2) resolve();
        });
      });

      await tickPromise;
      // Should have received ticks counting down (e.g., 2, 1)
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks[0]).toBeGreaterThan(ticks[1]);

      clearSessionTimers(session.sessionId);
      client.disconnect();
    }, 10000);

    it("does not let an old question timer close a different current item", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      const client = createClient(session.sessionId);
      client.connect();
      const joinedPromise = waitForEvent(client, SocketEvents.STUDENT_JOINED);
      client.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joinedPromise;

      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 1;
      session.questionStartedAt = Date.now();
      startQuestionTimer(ioServer, session, session.sessionId, 1);

      // Reproduce the race even if navigation-time cleanup is missed: the
      // timeout belongs to question 1 and must not mutate question 0.
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() + 1;

      await waitForNoEvent(client, SocketEvents.QUESTION_CLOSE, 1300);
      expect(session.state).toBe("QUESTION_OPEN");
      expect(session.currentQuestionIndex).toBe(0);

      clearSessionTimers(session.sessionId);
      client.disconnect();
    }, 10000);

    it("cancels a question timer when navigation broadcasts a slide", async () => {
      const sourceQuiz = quizzes.get("week01")!;
      const navigationQuiz: Quiz = {
        ...sourceQuiz,
        week: "timer-navigation",
        questions: [
          { ...sourceQuiz.questions[0], questionType: "slide" },
          sourceQuiz.questions[1],
        ],
      };
      quizzes.set(navigationQuiz.week, navigationQuiz);

      const session = createSession(navigationQuiz.week, "open");
      storeSession(session);

      const client = createClient(session.sessionId);
      client.connect();
      const joinedPromise = waitForEvent(client, SocketEvents.STUDENT_JOINED);
      client.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joinedPromise;

      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 1;
      session.questionStartedAt = Date.now();
      startQuestionTimer(ioServer, session, session.sessionId, 1);

      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() + 1;
      broadcastQuestionOpen(ioServer, session, session.sessionId, navigationQuiz);

      await waitForNoEvent(client, SocketEvents.QUESTION_CLOSE, 1300);
      expect(session.state).toBe("QUESTION_OPEN");
      expect(session.currentQuestionIndex).toBe(0);

      clearSessionTimers(session.sessionId);
      client.disconnect();
      quizzes.delete(navigationQuiz.week);
    }, 10000);
  });

  describe("edge cases", () => {
    it("student can join during QUESTION_OPEN and submit immediately", async () => {
      const session = createSession("week01", "open");
      storeSession(session);
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now();

      const client = createClient(session.sessionId);
      const joinedPromise = waitForEvent<{ sessionState: string }>(
        client,
        SocketEvents.STUDENT_JOINED,
      );
      client.connect();
      client.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      const joined = await joinedPromise;
      expect(joined.sessionState).toBe("QUESTION_OPEN");

      // Submit immediately
      const acceptedPromise = waitForEvent<{ questionIndex: number }>(
        client,
        SocketEvents.ANSWER_ACCEPTED,
      );
      client.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["A"],
      });
      const accepted = await acceptedPromise;
      expect(accepted.questionIndex).toBe(0);

      clearSessionTimers(session.sessionId);
      client.disconnect();
    });

    it("late join during QUESTION_CLOSED receives deterministic closed-question snapshot", async () => {
      const session = createSession("week01", "open");
      storeSession(session);
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 2000;
      transitionState(session, "QUESTION_CLOSED");

      const client = createClient(session.sessionId);
      client.connect();

      const joinedPromise = waitForEvent<{ sessionState: string }>(client, SocketEvents.STUDENT_JOINED);
      const qOpenPromise = waitForEvent<{ questionIndex: number }>(client, SocketEvents.QUESTION_OPEN);
      const qClosePromise = waitForEvent<{ questionIndex: number }>(client, SocketEvents.QUESTION_CLOSE);

      client.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });

      const [joined, qOpen, qClose] = await Promise.all([joinedPromise, qOpenPromise, qClosePromise]);
      expect(joined.sessionState).toBe("QUESTION_CLOSED");
      expect(qOpen.questionIndex).toBe(0);
      expect(qClose.questionIndex).toBe(0);

      client.disconnect();
    });

    it("late join during REVEAL does not receive reveal payload", async () => {
      const session = createSession("week01", "open");
      storeSession(session);
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 2000;
      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");

      const client = createClient(session.sessionId);
      client.connect();

      const joinedPromise = waitForEvent<{ sessionState: string }>(client, SocketEvents.STUDENT_JOINED);
      client.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      const joined = await joinedPromise;

      expect(joined.sessionState).toBe("REVEAL");
      await waitForNoEvent(client, SocketEvents.RESULTS_REVEAL);

      client.disconnect();
    });

    it("two students submit to same question concurrently", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      // Join two students
      const client1 = createClient(session.sessionId);
      const client2 = createClient(session.sessionId);
      client1.connect();
      const j1Promise = waitForEvent(client1, SocketEvents.STUDENT_JOINED);
      client1.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await j1Promise;

      client2.connect();
      const j2Promise = waitForEvent(client2, SocketEvents.STUDENT_JOINED);
      client2.emit(SocketEvents.STUDENT_JOIN, { studentId: "S002" });
      await j2Promise;

      // Open question
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now();

      // Submit concurrently
      const a1Promise = waitForEvent<{ questionIndex: number }>(
        client1,
        SocketEvents.ANSWER_ACCEPTED,
      );
      const a2Promise = waitForEvent<{ questionIndex: number }>(
        client2,
        SocketEvents.ANSWER_ACCEPTED,
      );
      client1.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, selectedOptions: ["A"] });
      client2.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 0, selectedOptions: ["B"] });

      const [a1, a2] = await Promise.all([a1Promise, a2Promise]);
      expect(a1.questionIndex).toBe(0);
      expect(a2.questionIndex).toBe(0);
      expect(session.submissions).toHaveLength(2);

      clearSessionTimers(session.sessionId);
      client1.disconnect();
      client2.disconnect();
    });

    it("rejects submission with empty selectedOptions via socket", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      const client = createClient(session.sessionId);
      client.connect();
      const joinedPromise = waitForEvent(client, SocketEvents.STUDENT_JOINED);
      client.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joinedPromise;

      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now();

      const rejectedPromise = waitForEvent<{ reason: string }>(
        client,
        SocketEvents.ANSWER_REJECTED,
      );
      client.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: [],
      });
      const rejected = await rejectedPromise;
      expect(rejected.reason).toContain("option");

      clearSessionTimers(session.sessionId);
      client.disconnect();
    });
  });

  describe("instructor socket room join", () => {
    function createInstructorClient(sessionId: string): ClientSocket {
      return ioClient(baseUrl, {
        autoConnect: false,
        auth: { sessionId, role: "instructor" },
        transports: ["websocket"],
      });
    }

    function createPresentationClient(sessionId: string): ClientSocket {
      return ioClient(baseUrl, {
        autoConnect: false,
        auth: { sessionId, role: "presentation" },
        transports: ["websocket"],
      });
    }

    it("instructor receives SESSION_PARTICIPANTS when a student joins", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      // Connect instructor first
      const instructor = createInstructorClient(session.sessionId);
      instructor.connect();
      await new Promise<void>((resolve) => instructor.once("connect", resolve));

      // Register listener for participant update
      const participantsPromise = waitForEvent<{ count: number; participants: { studentId: string }[] }>(
        instructor,
        SocketEvents.SESSION_PARTICIPANTS,
      );

      // Student joins
      const student = createClient(session.sessionId);
      student.connect();
      student.emit(SocketEvents.STUDENT_JOIN, {
        studentId: "S001",
        displayName: "Alice",
      });

      const participants = await participantsPromise;
      expect(participants.count).toBe(1);
      expect(participants.participants[0].studentId).toBe("S001");

      instructor.disconnect();
      student.disconnect();
    });

    it("instructor receives SESSION_STATE after REST state transition", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      // Connect instructor
      const instructor = createInstructorClient(session.sessionId);
      instructor.connect();
      await new Promise<void>((resolve) => instructor.once("connect", resolve));

      // Student joins (needed for realistic flow)
      const student = createClient(session.sessionId);
      student.connect();
      const joinedPromise = waitForEvent(student, SocketEvents.STUDENT_JOINED);
      student.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joinedPromise;

      // Instructor should receive SESSION_STATE when quiz starts
      const statePromise = waitForEvent<{ state: string }>(
        instructor,
        SocketEvents.SESSION_STATE,
      );

      // Transition state via session object (simulating REST onStateChange callback)
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now();

      // Broadcast via socket functions (same as index.ts onStateChange does)
      // Use the io server to emit SESSION_STATE directly
      ioServer.to(`session:${session.sessionId}`).emit(SocketEvents.SESSION_STATE, {
        state: session.state,
        questionIndex: session.currentQuestionIndex,
      });

      const stateData = await statePromise;
      expect(stateData.state).toBe("QUESTION_OPEN");

      clearSessionTimers(session.sessionId);
      instructor.disconnect();
      student.disconnect();
    });

    it("instructor receives initial participant list on connect", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      // Student joins first
      const student = createClient(session.sessionId);
      student.connect();
      const joinedPromise = waitForEvent(student, SocketEvents.STUDENT_JOINED);
      student.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001", displayName: "Alice" });
      await joinedPromise;

      // Now instructor connects (student already in room)
      const instructor = createInstructorClient(session.sessionId);

      // Instructor should receive participants list immediately on connect
      const participantsPromise = waitForEvent<{ count: number; participants: { studentId: string }[] }>(
        instructor,
        SocketEvents.SESSION_PARTICIPANTS,
      );

      instructor.connect();

      const participants = await participantsPromise;
      expect(participants.count).toBe(1);
      expect(participants.participants[0].studentId).toBe("S001");

      instructor.disconnect();
      student.disconnect();
    });

    it("instructor reconnect during QUESTION_OPEN receives state snapshot", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      const student = createClient(session.sessionId);
      student.connect();
      const joinedPromise = waitForEvent(student, SocketEvents.STUDENT_JOINED);
      student.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joinedPromise;

      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 1000;

      const firstInstructor = createInstructorClient(session.sessionId);
      firstInstructor.connect();
      await new Promise<void>((resolve) => firstInstructor.once("connect", resolve));
      firstInstructor.disconnect();

      const instructor = createInstructorClient(session.sessionId);
      const statePromise = waitForEvent<{ state: string; questionIndex?: number }>(
        instructor,
        SocketEvents.SESSION_STATE,
      );
      const openPromise = waitForEvent<{ questionIndex: number; timeLimitSec: number }>(
        instructor,
        SocketEvents.QUESTION_OPEN,
      );
      const tickPromise = waitForEvent<{ remainingSec: number }>(
        instructor,
        SocketEvents.QUESTION_TICK,
      );
      const countPromise = waitForEvent<{ questionIndex: number; submitted: number; total: number }>(
        instructor,
        SocketEvents.ANSWER_COUNT,
      );
      instructor.connect();

      const [state, open, tick, count] = await Promise.all([
        statePromise,
        openPromise,
        tickPromise,
        countPromise,
      ]);

      expect(state.state).toBe("QUESTION_OPEN");
      expect(state.questionIndex).toBe(0);
      expect(open.questionIndex).toBe(0);
      expect(tick.remainingSec).toBeGreaterThanOrEqual(0);
      expect(tick.remainingSec).toBeLessThanOrEqual(open.timeLimitSec);
      expect(count.questionIndex).toBe(0);
      expect(count.submitted).toBe(0);
      expect(count.total).toBe(1);

      clearSessionTimers(session.sessionId);
      instructor.disconnect();
      student.disconnect();
    });

    it("Projector connects without instructor auth when no password is configured", async () => {
      const originalInstructorPassword = process.env.INSTRUCTOR_PASSWORD;
      delete process.env.INSTRUCTOR_PASSWORD;
      clearInstructorSessionsForTests();

      try {
        const session = createSession("week01", "open");
        storeSession(session);

        const student = createClient(session.sessionId);
        student.connect();
        const joinedPromise = waitForEvent(student, SocketEvents.STUDENT_JOINED);
        student.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
        await joinedPromise;

        transitionState(session, "QUESTION_OPEN");
        session.currentQuestionIndex = 0;
        session.questionStartedAt = Date.now() - 1000;

        const presentation = createPresentationClient(session.sessionId);
        const participantsPromise = waitForEvent<{ count: number }>(presentation, SocketEvents.SESSION_PARTICIPANTS);
        const statePromise = waitForEvent<{ state: string; questionIndex?: number }>(
          presentation,
          SocketEvents.SESSION_STATE,
        );
        const openPromise = waitForEvent<{ questionIndex: number }>(presentation, SocketEvents.QUESTION_OPEN);
        const countPromise = waitForEvent<{ questionIndex: number; submitted: number; total: number }>(
          presentation,
          SocketEvents.ANSWER_COUNT,
        );

        presentation.connect();

        const [participants, state, open, count] = await Promise.all([
          participantsPromise,
          statePromise,
          openPromise,
          countPromise,
        ]);

        expect(participants.count).toBe(1);
        expect(state.state).toBe("QUESTION_OPEN");
        expect(state.questionIndex).toBe(0);
        expect(open.questionIndex).toBe(0);
        expect(count.submitted).toBe(0);
        expect(count.total).toBe(1);

        clearSessionTimers(session.sessionId);
        presentation.disconnect();
        student.disconnect();
      } finally {
        if (typeof originalInstructorPassword === "string") {
          process.env.INSTRUCTOR_PASSWORD = originalInstructorPassword;
        } else {
          delete process.env.INSTRUCTOR_PASSWORD;
        }
        clearInstructorSessionsForTests();
      }
    });

    it("late join during open_response QUESTION_OPEN rebroadcasts live answer count before submission", async () => {
      const quiz = quizzes.get("week01");
      expect(quiz).toBeDefined();
      const originalQuestion = {
        ...quiz!.questions[0],
        options: [...quiz!.questions[0].options],
        correctOptions: [...quiz!.questions[0].correctOptions],
      };

      try {
        quiz!.questions[0] = {
          ...quiz!.questions[0],
          questionType: "open_response",
          options: [],
          correctOptions: [],
          allowsMultiple: false,
        };

        const session = createSession("week01", "open");
        storeSession(session);
        transitionState(session, "QUESTION_OPEN");
        session.currentQuestionIndex = 0;
        session.questionStartedAt = Date.now();

        const instructor = createInstructorClient(session.sessionId);
        instructor.connect();

        const initialCount = await waitForEvent<{ questionIndex: number; submitted: number; total: number }>(
          instructor,
          SocketEvents.ANSWER_COUNT,
        );
        expect(initialCount.questionIndex).toBe(0);
        expect(initialCount.submitted).toBe(0);
        expect(initialCount.total).toBe(0);

        const lateJoinCountPromise = waitForEvent<{ questionIndex: number; submitted: number; total: number }>(
          instructor,
          SocketEvents.ANSWER_COUNT,
        );

        const student = createClient(session.sessionId);
        student.connect();
        const joinedPromise = waitForEvent(student, SocketEvents.STUDENT_JOINED);
        student.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001", displayName: "Alice" });
        await joinedPromise;

        const lateJoinCount = await lateJoinCountPromise;
        expect(lateJoinCount.questionIndex).toBe(0);
        expect(lateJoinCount.submitted).toBe(0);
        expect(lateJoinCount.total).toBe(1);

        clearSessionTimers(session.sessionId);
        instructor.disconnect();
        student.disconnect();
      } finally {
        quiz!.questions[0] = originalQuestion;
      }
    });

    it("question open broadcasts initial answer count for already-joined open_response students", async () => {
      const quiz = quizzes.get("week01");
      expect(quiz).toBeDefined();
      const originalQuestion = {
        ...quiz!.questions[0],
        options: [...quiz!.questions[0].options],
        correctOptions: [...quiz!.questions[0].correctOptions],
      };

      try {
        quiz!.questions[0] = {
          ...quiz!.questions[0],
          questionType: "open_response",
          options: [],
          correctOptions: [],
          allowsMultiple: false,
        };

        const session = createSession("week01", "open");
        storeSession(session);

        const student = createClient(session.sessionId);
        student.connect();
        const joinedPromise = waitForEvent(student, SocketEvents.STUDENT_JOINED);
        student.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001", displayName: "Alice" });
        await joinedPromise;

        const instructor = createInstructorClient(session.sessionId);
        instructor.connect();
        await waitForEvent(instructor, SocketEvents.SESSION_PARTICIPANTS);

        const openPromise = waitForEvent<QuestionOpenPayload>(instructor, SocketEvents.QUESTION_OPEN);
        const countPromise = waitForEvent<{ questionIndex: number; submitted: number; total: number }>(
          instructor,
          SocketEvents.ANSWER_COUNT,
        );

        transitionState(session, "QUESTION_OPEN");
        session.currentQuestionIndex = 0;
        broadcastQuestionOpen(ioServer, session, session.sessionId, quiz!);

        const open = await openPromise;
        const count = await countPromise;
        expect(open.questionIndex).toBe(0);
        expect(count.questionIndex).toBe(0);
        expect(count.submitted).toBe(0);
        expect(count.total).toBe(1);

        clearSessionTimers(session.sessionId);
        instructor.disconnect();
        student.disconnect();
      } finally {
        quiz!.questions[0] = originalQuestion;
      }
    });

    it("marks poll questions in socket payloads and excludes them from leaderboard totals", async () => {
      const quiz = quizzes.get("week01");
      expect(quiz).toBeDefined();
      const originalQuestion = { ...quiz!.questions[0], correctOptions: [...quiz!.questions[0].correctOptions] };

      try {
        quiz!.questions[0] = {
          ...quiz!.questions[0],
          isPoll: true,
          correctOptions: [],
        };

        const session = createSession("week01", "open");
        storeSession(session);

        const student = createClient(session.sessionId);
        student.connect();
        const joinedPromise = waitForEvent(student, SocketEvents.STUDENT_JOINED);
        student.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
        await joinedPromise;

        transitionState(session, "QUESTION_OPEN");
        session.currentQuestionIndex = 0;
        session.questionStartedAt = Date.now() - 1000;

        const instructor = createInstructorClient(session.sessionId);
        const openPromise = waitForEvent<QuestionOpenPayload>(instructor, SocketEvents.QUESTION_OPEN);
        instructor.connect();
        const open = await openPromise;

        expect(open.isPoll).toBe(true);
        expect(open.allowsMultiple).toBe(false);

        transitionState(session, "QUESTION_CLOSED");
        transitionState(session, "REVEAL");
        const revealPromise = waitForEvent<ResultsRevealPayload>(instructor, SocketEvents.RESULTS_REVEAL);
        broadcastReveal(ioServer, session, session.sessionId, quiz!);
        const reveal = await revealPromise;

        expect(reveal.isPoll).toBe(true);
        expect(reveal.correctOptions).toEqual([]);

        transitionState(session, "LEADERBOARD");
        const leaderboardPromise = waitForEvent<LeaderboardUpdatePayload>(instructor, SocketEvents.LEADERBOARD_UPDATE);
        broadcastLeaderboard(ioServer, session, session.sessionId, quiz!);
        const leaderboard = await leaderboardPromise;

        expect(leaderboard.totalQuestions).toBe(getScoredQuestionCount(quiz!));

        instructor.disconnect();
        student.disconnect();
      } finally {
        quiz!.questions[0] = originalQuestion;
      }
    });

    it("instructor reconnect during REVEAL receives current reveal context", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      const student = createClient(session.sessionId);
      student.connect();
      const joinedPromise = waitForEvent(student, SocketEvents.STUDENT_JOINED);
      student.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joinedPromise;

      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 1500;

      const acceptedPromise = waitForEvent<{ questionIndex: number }>(
        student,
        SocketEvents.ANSWER_ACCEPTED,
      );
      student.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["B"],
      });
      await acceptedPromise;

      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");

      const firstInstructor = createInstructorClient(session.sessionId);
      firstInstructor.connect();
      await new Promise<void>((resolve) => firstInstructor.once("connect", resolve));
      firstInstructor.disconnect();

      const instructor = createInstructorClient(session.sessionId);
      const statePromise = waitForEvent<{ state: string; questionIndex?: number }>(
        instructor,
        SocketEvents.SESSION_STATE,
      );
      const openPromise = waitForEvent<{ questionIndex: number }>(
        instructor,
        SocketEvents.QUESTION_OPEN,
      );
      const revealPromise = waitForEvent<{
        questionIndex: number;
        correctOptions: string[];
        explanation: string;
        distribution: Record<string, number>;
      }>(instructor, SocketEvents.RESULTS_REVEAL);
      const countPromise = waitForEvent<{ questionIndex: number; submitted: number; total: number }>(
        instructor,
        SocketEvents.ANSWER_COUNT,
      );
      instructor.connect();

      const [state, open, reveal, count] = await Promise.all([
        statePromise,
        openPromise,
        revealPromise,
        countPromise,
      ]);

      expect(state.state).toBe("REVEAL");
      expect(state.questionIndex).toBe(0);
      expect(open.questionIndex).toBe(0);
      expect(reveal.questionIndex).toBe(0);
      expect(reveal.correctOptions.length).toBeGreaterThan(0);
      expect(reveal.explanation).toBeTruthy();
      expect(Object.values(reveal.distribution).reduce((sum, value) => sum + value, 0)).toBe(1);
      expect(count.questionIndex).toBe(0);
      expect(count.submitted).toBe(1);
      expect(count.total).toBe(1);

      clearSessionTimers(session.sessionId);
      instructor.disconnect();
      student.disconnect();
    });

    it("instructor reconnect during LEADERBOARD receives leaderboard and state", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      const student = createClient(session.sessionId);
      student.connect();
      const joinedPromise = waitForEvent(student, SocketEvents.STUDENT_JOINED);
      student.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joinedPromise;

      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now() - 1000;

      const acceptedPromise = waitForEvent<{ questionIndex: number }>(
        student,
        SocketEvents.ANSWER_ACCEPTED,
      );
      student.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["B"],
      });
      await acceptedPromise;

      transitionState(session, "QUESTION_CLOSED");
      transitionState(session, "REVEAL");
      transitionState(session, "LEADERBOARD");

      const firstInstructor = createInstructorClient(session.sessionId);
      firstInstructor.connect();
      await new Promise<void>((resolve) => firstInstructor.once("connect", resolve));
      firstInstructor.disconnect();

      const instructor = createInstructorClient(session.sessionId);
      const statePromise = waitForEvent<{ state: string; questionIndex?: number }>(
        instructor,
        SocketEvents.SESSION_STATE,
      );
      const leaderboardPromise = waitForEvent<{
        entries: { studentId: string }[];
        totalQuestions: number;
      }>(instructor, SocketEvents.LEADERBOARD_UPDATE);
      instructor.connect();

      const [state, leaderboard] = await Promise.all([statePromise, leaderboardPromise]);

      expect(state.state).toBe("LEADERBOARD");
      expect(state.questionIndex).toBe(0);
      expect(leaderboard.totalQuestions).toBeGreaterThan(0);
      expect(leaderboard.entries.some((entry) => entry.studentId === "S001")).toBe(true);

      clearSessionTimers(session.sessionId);
      instructor.disconnect();
      student.disconnect();
    });

    it("instructor receives ANSWER_COUNT when student submits", async () => {
      const session = createSession("week01", "open");
      storeSession(session);

      // Connect instructor
      const instructor = createInstructorClient(session.sessionId);
      instructor.connect();
      await new Promise<void>((resolve) => instructor.once("connect", resolve));

      // Student joins
      const student = createClient(session.sessionId);
      student.connect();
      const joinedPromise = waitForEvent(student, SocketEvents.STUDENT_JOINED);
      student.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001" });
      await joinedPromise;

      // Open question
      transitionState(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = Date.now();

      // Instructor listens for answer count
      const countPromise = waitForEvent<{ questionIndex: number; submitted: number; total: number }>(
        instructor,
        SocketEvents.ANSWER_COUNT,
      );

      // Student submits
      student.emit(SocketEvents.ANSWER_SUBMIT, {
        questionIndex: 0,
        selectedOptions: ["B"],
      });

      const count = await countPromise;
      expect(count.questionIndex).toBe(0);
      expect(count.submitted).toBe(1);
      expect(count.total).toBe(1);

      clearSessionTimers(session.sessionId);
      instructor.disconnect();
      student.disconnect();
    });
  });

  describe("instructor socket auth", () => {
    const originalInstructorPassword = process.env.INSTRUCTOR_PASSWORD;

    afterEach(() => {
      if (typeof originalInstructorPassword === "string") {
        process.env.INSTRUCTOR_PASSWORD = originalInstructorPassword;
      } else {
        delete process.env.INSTRUCTOR_PASSWORD;
      }
      clearInstructorSessionsForTests();
      clearAllSessions();
    });

    it("rejects unauthenticated instructor socket when password is configured", async () => {
      process.env.INSTRUCTOR_PASSWORD = "socket-secret";

      const authApp = createApp(quizDir);
      const authServer = createServer(authApp);
      const authQuizzes = (authApp as unknown as { _quizzes: Map<string, Quiz> })._quizzes;
      const authIo = setupSocket(authServer, authQuizzes);

      await new Promise<void>((resolve) => authServer.listen(0, resolve));
      try {
        const authPort = (authServer.address() as AddressInfo).port;
        const authBaseUrl = `http://localhost:${authPort}`;

        const createRes = await request(authApp)
          .post("/api/instructor/login")
          .send({ password: "socket-secret" })
          .expect(204);
        const cookieHeader = createRes.headers["set-cookie"][0].split(";")[0];

        const sessionRes = await request(authApp)
          .post("/api/session")
          .set("Cookie", cookieHeader)
          .send({ week: "week01" })
          .expect(201);

        const unauthInstructor = ioClient(authBaseUrl, {
          autoConnect: false,
          auth: { sessionId: sessionRes.body.sessionId, role: "instructor" },
          transports: ["websocket"],
        });

        const rejectedPromise = waitForEvent<{ reason: string }>(
          unauthInstructor,
          SocketEvents.STUDENT_REJECTED,
        );

        unauthInstructor.connect();
        const rejected = await rejectedPromise;
        expect(rejected.reason).toContain("login required");
        unauthInstructor.disconnect();

        const authInstructor = ioClient(authBaseUrl, {
          autoConnect: false,
          auth: { sessionId: sessionRes.body.sessionId, role: "instructor" },
          transports: ["websocket"],
          extraHeaders: { Cookie: cookieHeader },
        });

        await new Promise<void>((resolve) => {
          authInstructor.once("connect", () => resolve());
          authInstructor.connect();
        });

        authInstructor.disconnect();
      } finally {
        authIo.close();
        await new Promise<void>((resolve) => authServer.close(() => resolve()));
      }
    });

    it("rejects unauthenticated presentation socket when password is configured", async () => {
      process.env.INSTRUCTOR_PASSWORD = "presentation-test-secret";

      const authApp = createApp(quizDir);
      const authServer = createServer(authApp);
      const authQuizzes = (authApp as unknown as { _quizzes: Map<string, Quiz> })._quizzes;
      const authIo = setupSocket(authServer, authQuizzes);

      await new Promise<void>((resolve) => authServer.listen(0, resolve));
      try {
        const authPort = (authServer.address() as AddressInfo).port;
        const authBaseUrl = `http://localhost:${authPort}`;

        const createRes = await request(authApp)
          .post("/api/instructor/login")
          .send({ password: "presentation-test-secret" })
          .expect(204);
        const cookieHeader = createRes.headers["set-cookie"][0].split(";")[0];

        const sessionRes = await request(authApp)
          .post("/api/session")
          .set("Cookie", cookieHeader)
          .send({ week: "week01" })
          .expect(201);

        const unauthPresentation = ioClient(authBaseUrl, {
          autoConnect: false,
          auth: { sessionId: sessionRes.body.sessionId, role: "presentation" },
          transports: ["websocket"],
        });

        const rejectedPromise = waitForEvent<{ reason: string }>(
          unauthPresentation,
          SocketEvents.STUDENT_REJECTED,
        );

        unauthPresentation.connect();
        const rejected = await rejectedPromise;
        expect(rejected.reason).toContain("login required");
        unauthPresentation.disconnect();

        const authPresentation = ioClient(authBaseUrl, {
          autoConnect: false,
          auth: { sessionId: sessionRes.body.sessionId, role: "presentation" },
          transports: ["websocket"],
          extraHeaders: { Cookie: cookieHeader },
        });

        await new Promise<void>((resolve) => {
          authPresentation.once("connect", () => resolve());
          authPresentation.connect();
        });

        authPresentation.disconnect();
      } finally {
        authIo.close();
        await new Promise<void>((resolve) => authServer.close(() => resolve()));
      }
    });
  });
});
