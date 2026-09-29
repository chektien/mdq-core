import { createServer, Server as HttpServer } from "http";
import { AddressInfo } from "net";
import * as fs from "fs";
import * as path from "path";
import request from "supertest";
import { io as ioClient, Socket as ClientSocket } from "socket.io-client";
import { Server as IOServer } from "socket.io";
import { createApp } from "../app";
import { setupSocket, broadcastQuestionOpen, broadcastReveal, broadcastLeaderboard, clearSessionTimers } from "../socket";
import { clearAllSessions, getDistribution } from "../session";
import {
  SocketEvents,
  Quiz,
  StudentJoinedPayload,
  QuestionOpenPayload,
  ResultsDistributionPayload,
  ResultsRevealPayload,
  LeaderboardUpdatePayload,
} from "@mdq/shared";
import { parseQuizMarkdown } from "../parser";

function waitFor<T>(socket: ClientSocket, event: string, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

describe("week00 smoke multi-select", () => {
  const quizDir = path.resolve(__dirname, "../../../../samples/decks");
  let httpServer: HttpServer;
  let ioServer: IOServer;
  let app: ReturnType<typeof createApp>;
  let baseUrl: string;

  beforeAll((done) => {
    const ioRef: { current: IOServer | null } = { current: null };

    function sessionRoom(sessionId: string): string {
      return `session:${sessionId}`;
    }

    app = createApp({
      quizDir,
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
            io.to(sessionRoom(sessionId)).emit(SocketEvents.RESULTS_DISTRIBUTION, {
              questionIndex: session.currentQuestionIndex,
              distribution: getDistribution(session, session.currentQuestionIndex),
            });
            break;
          }
          case "REVEAL":
            if (quiz) broadcastReveal(io, session, sessionId, quiz);
            break;
          case "LEADERBOARD":
            if (quiz) broadcastLeaderboard(io, session, sessionId, quiz);
            break;
        }
      },
    });

    httpServer = createServer(app);
    const quizzes = (app as unknown as { _quizzes: Map<string, Quiz> })._quizzes;
    ioServer = setupSocket(httpServer, quizzes);
    ioRef.current = ioServer;

    httpServer.listen(0, () => {
      const port = (httpServer.address() as AddressInfo).port;
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

  it("includes visual smoke slides for each image position suffix", () => {
    const markdown = fs.readFileSync(path.join(quizDir, "week00.md"), "utf-8");
    const result = parseQuizMarkdown(markdown, "week00.md");
    expect(result.errors).toHaveLength(0);

    const visualSlides = result.quiz!.questions.slice(6);
    expect(visualSlides.map((question) => question.topic)).toEqual(Array(5).fill("Visual Smoke"));
    expect(visualSlides.map((question) => question.subtopic)).toEqual([
      "Image Left",
      "Image Right",
      "Image Top",
      "Image Bottom",
      "Image Background",
    ]);
    expect(visualSlides.map((question) => question.slideMediaPosition)).toEqual([
      "left",
      "right",
      "top",
      "bottom",
      "background",
    ]);
    expect(visualSlides.map((question) => question.slideMedia?.[0]?.src)).toEqual(
      Array(5).fill("/data/images/week00-smoke-diagram.svg"),
    );
    expect(visualSlides[4].slideMediaOpacity).toBe(0.22);
  });

  it("covers the smoke-test multi-select and poll questions without scoring the poll", async () => {
    const createRes = await request(app)
      .post("/api/session")
      .send({ week: "week00", mode: "open" })
      .expect(201);

    const { sessionId } = createRes.body;
    const student = ioClient(baseUrl, {
      autoConnect: false,
      auth: { sessionId },
      transports: ["websocket"],
    });

    student.connect();
    const joinedPromise = waitFor<StudentJoinedPayload>(student, SocketEvents.STUDENT_JOINED);
    student.emit(SocketEvents.STUDENT_JOIN, { studentId: "S001", displayName: "Smoke Student" });
    const { publicKey } = await joinedPromise;

    const q0OpenPromise = waitFor<QuestionOpenPayload>(student, SocketEvents.QUESTION_OPEN);
    await request(app).post(`/api/session/${sessionId}/start`).expect(200);
    const q0 = await q0OpenPromise;
    expect(q0.questionIndex).toBe(0);
    expect(q0.questionType).toBe("slide");
    expect(q0.options).toEqual([]);
    expect(q0.attendeeNotes?.[0]?.bodyHtml).toContain("public smoke-test example");

    const q1OpenPromise = waitFor<QuestionOpenPayload>(student, SocketEvents.QUESTION_OPEN);
    await request(app).post(`/api/session/${sessionId}/next`).expect(200);
    const q1 = await q1OpenPromise;
    expect(q1.questionIndex).toBe(1);
    expect(q1.allowsMultiple).toBe(false);

    const q1Accepted = waitFor(student, SocketEvents.ANSWER_ACCEPTED);
    student.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 1, selectedOptions: ["B"] });
    await q1Accepted;
    await request(app).post(`/api/session/${sessionId}/close`).expect(200);
    await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);

    const q2OpenPromise = waitFor<QuestionOpenPayload>(student, SocketEvents.QUESTION_OPEN);
    await request(app).post(`/api/session/${sessionId}/next`).expect(200);
    const q2 = await q2OpenPromise;
    expect(q2.questionIndex).toBe(2);
    expect(q2.allowsMultiple).toBe(true);

    const distributionPromise = waitFor<ResultsDistributionPayload>(student, SocketEvents.RESULTS_DISTRIBUTION);
    const revealPromise = waitFor<ResultsRevealPayload>(student, SocketEvents.RESULTS_REVEAL);
    const leaderboardPromise = waitFor<LeaderboardUpdatePayload>(student, SocketEvents.LEADERBOARD_UPDATE);

    const acceptedPromise = waitFor(student, SocketEvents.ANSWER_ACCEPTED);
    student.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 2, selectedOptions: ["D", "A", "D"] });
    await acceptedPromise;

    await request(app).post(`/api/session/${sessionId}/close`).expect(200);
    const distribution = await distributionPromise;
    expect(distribution.questionIndex).toBe(2);
    expect(distribution.distribution).toEqual({ A: 1, D: 1 });

    await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
    const reveal = await revealPromise;
    expect(reveal.correctOptions).toEqual(["A", "D"]);

    const q3OpenPromise = waitFor<QuestionOpenPayload>(student, SocketEvents.QUESTION_OPEN);
    await request(app).post(`/api/session/${sessionId}/next`).expect(200);
    const q3 = await q3OpenPromise;
    expect(q3.questionIndex).toBe(3);
    expect(q3.isPoll).toBe(true);
    expect(q3.allowsMultiple).toBe(false);

    const pollDistributionPromise = waitFor<ResultsDistributionPayload>(student, SocketEvents.RESULTS_DISTRIBUTION);
    const pollRevealPromise = waitFor<ResultsRevealPayload>(student, SocketEvents.RESULTS_REVEAL);
    const pollAcceptedPromise = waitFor(student, SocketEvents.ANSWER_ACCEPTED);
    student.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 3, selectedOptions: ["C"] });
    await pollAcceptedPromise;

    await request(app).post(`/api/session/${sessionId}/close`).expect(200);
    const pollDistribution = await pollDistributionPromise;
    expect(pollDistribution.questionIndex).toBe(3);
    expect(pollDistribution.distribution).toEqual({ C: 1 });

    await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
    const pollReveal = await pollRevealPromise;
    expect(pollReveal.questionIndex).toBe(3);
    expect(pollReveal.isPoll).toBe(true);
    expect(pollReveal.correctOptions).toEqual([]);

    const q4OpenPromise = waitFor<QuestionOpenPayload>(student, SocketEvents.QUESTION_OPEN);
    await request(app).post(`/api/session/${sessionId}/next`).expect(200);
    const q4 = await q4OpenPromise;
    expect(q4.questionIndex).toBe(4);
    expect(q4.questionType).toBe("open_response");
    expect(q4.options).toEqual([]);

    const q4AcceptedPromise = waitFor(student, SocketEvents.ANSWER_ACCEPTED);
    student.emit(SocketEvents.ANSWER_SUBMIT, {
      questionIndex: 4,
      responseText: "They should see that the response was submitted and can still be updated.",
    });
    await q4AcceptedPromise;

    const openRevealPromise = waitFor<ResultsRevealPayload>(student, SocketEvents.RESULTS_REVEAL);
    await request(app).post(`/api/session/${sessionId}/close`).expect(200);
    await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);
    const openReveal = await openRevealPromise;
    expect(openReveal.questionIndex).toBe(4);
    expect(openReveal.questionType).toBe("open_response");
    // A phone never gets other participants' responses, not even after the reveal.
    expect(openReveal.openResponses).toBeUndefined();

    const q5OpenPromise = waitFor<QuestionOpenPayload>(student, SocketEvents.QUESTION_OPEN);
    await request(app).post(`/api/session/${sessionId}/next`).expect(200);
    const q5 = await q5OpenPromise;
    expect(q5.questionIndex).toBe(5);
    expect(q5.allowsMultiple).toBe(false);

    const q5AcceptedPromise = waitFor(student, SocketEvents.ANSWER_ACCEPTED);
    student.emit(SocketEvents.ANSWER_SUBMIT, { questionIndex: 5, selectedOptions: ["B"] });
    await q5AcceptedPromise;

    await request(app).post(`/api/session/${sessionId}/close`).expect(200);
    await request(app).post(`/api/session/${sessionId}/reveal`).expect(200);

    await request(app).post(`/api/session/${sessionId}/leaderboard-show`).expect(200);
    const leaderboard = await leaderboardPromise;
    const entry = leaderboard.entries.find((item) => item.publicKey === publicKey);
    expect(leaderboard.totalQuestions).toBe(3);
    expect(entry?.correctCount).toBe(3);

    student.disconnect();
  });
});
