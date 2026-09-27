import { Quiz, Session } from "@mdq/shared";
import { broadcastQuestionOpen, broadcastReveal, broadcastLeaderboard, clearSessionTimers, setupSocket } from "../socket";
import { createSession } from "../session";
import { Server } from "socket.io";
import { apply } from "../engine";
import { createServer } from "http";

const quiz: Quiz = {
  week: "sample", title: "Sample", sourceFile: "sample.md",
  questions: [{ index: 0, topic: "Sample question", textMd: "Question", textHtml: "<p>Question</p>",
    options: [{ label: "A", textMd: "One", textHtml: "One" }, { label: "B", textMd: "Two", textHtml: "Two" }],
    correctOptions: ["B"], allowsMultiple: false, explanation: "Two is correct", timeLimitSec: 20 }],
};

it("captures existing outbound transition payloads", () => {
  const now = jest.spyOn(Date, "now").mockReturnValue(1000);
  const session: Session = createSession("sample", "open");
  session.state = "QUESTION_OPEN";
  session.currentQuestionIndex = 0;
  session.questionStartedAt = 1000;
  const httpServer = createServer();
  const socketServer = setupSocket(httpServer, new Map([["sample", quiz]]));
  const sent: { event: string; payload: unknown }[] = [];
  const io = { to: () => ({ emit: (event: string, payload: unknown) => sent.push({ event, payload }) }) } as unknown as Server;
  broadcastQuestionOpen(io, session, session.sessionId, quiz);
  clearSessionTimers(session.sessionId);
  session.state = "REVEAL";
  broadcastReveal(io, session, session.sessionId, quiz);
  session.state = "LEADERBOARD";
  broadcastLeaderboard(io, session, session.sessionId, quiz);
  expect(sent).toMatchSnapshot();
  const lobby = createSession("sample", "open");
  const opened = apply(lobby, quiz, { type: "start" }, 1000);
  const closed = apply(opened.session, quiz, { type: "close" }, 1000);
  const revealed = apply(closed.session, quiz, { type: "reveal" }, 1000);
  const leaderboard = apply(revealed.session, quiz, { type: "leaderboardShow" }, 1000);
  const engineMessages = [...opened.messages, ...revealed.messages, ...leaderboard.messages]
    .map(({ event, payload }) => ({ event, payload }));
  expect(engineMessages).toEqual(sent);
  socketServer.close();
  now.mockRestore();
});
