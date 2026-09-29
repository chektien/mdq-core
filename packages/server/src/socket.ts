import { Server as HttpServer } from "http";
import { Server, Socket } from "socket.io";
import { SocketEvents, StudentJoinPayload, StudentJoinedPayload, AnswerSubmitPayload, TICK_INTERVAL_MS, Quiz, Session, SOCKET_ROLES, type SocketRole } from "@mdq/shared";
import { getSession } from "./session";
import { apply, audienceReaches, type Audience, type EngineMessage, type EngineResult } from "./engine";
import { getQuestionType } from "./scoring";
import { isInstructorAuthEnabled, getInstructorSessionFromCookie, hasValidInstructorSession } from "./instructor-auth";

const sessionTimers = new Map<string, NodeJS.Timeout>();
const tickTimers = new Map<string, NodeJS.Timeout>();
let quizStore: Map<string, Quiz>;
/** Every socket of a session: the instructor's, the projector's and the participants'. */
const sessionRoom = (id: string) => `session:${id}`;
/** The sockets of one role, so a message goes only to the roles its audience reaches. */
const roleRoom = (id: string, role: SocketRole) => `session:${id}:${role}`;
const audienceRooms = (id: string, audience: Audience): string[] => audience === "all"
  ? [sessionRoom(id)]
  : SOCKET_ROLES.filter((role) => audienceReaches(audience, role)).map((role) => roleRoom(id, role));
const logActivity = (message: string) => console.log(`[mdq activity] ${message}`);

export function clearSessionTimers(sessionId: string): void {
  const timer = sessionTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  sessionTimers.delete(sessionId);
  const tick = tickTimers.get(sessionId);
  if (tick) clearInterval(tick);
  tickTimers.delete(sessionId);
}

/**
 * Send each message to the sockets its audience reaches: `all` to the whole
 * session, the others to the role rooms they name, and a participant message
 * to that participant's own socket. A socket passed as `directSocket` (a
 * snapshot for one connection) gets every message, already built for its role.
 */
export function emitMessages(io: Server, sessionId: string, messages: EngineMessage[], directSocket?: Socket): void {
  for (const { audience, event, payload } of messages) {
    if (audience.startsWith("participant:")) {
      const id = audience.slice("participant:".length);
      io.to(getSession(sessionId)?.participants.get(id)?.socketId || id).emit(event, payload);
    } else if (directSocket) {
      directSocket.emit(event, payload);
    } else {
      const rooms = audienceRooms(sessionId, audience);
      io.to(rooms.length === 1 ? rooms[0] : rooms).emit(event, payload);
    }
  }
}

function applyAndEmit(io: Server, session: Session, quiz: Quiz, command: Parameters<typeof apply>[2], directSocket?: Socket): EngineResult {
  const result = apply(session, quiz, command, Date.now());
  Object.assign(session, result.session);
  emitMessages(io, session.sessionId, result.messages, directSocket);
  return result;
}

export function setupSocket(httpServer: HttpServer, quizzes: Map<string, Quiz>): Server {
  quizStore = quizzes;
  const io = new Server(httpServer, { cors: { origin: "*", methods: ["GET", "POST"] } });
  io.on("connection", (socket: Socket) => {
    const sessionId = socket.handshake.auth?.sessionId as string || socket.handshake.query?.sessionId as string;
    if (!sessionId) {
      socket.emit(SocketEvents.STUDENT_REJECTED, { reason: "Missing sessionId" });
      logActivity(`reject socket=${socket.id} reason=missing-session-id`);
      socket.disconnect(); return;
    }
    const session = getSession(sessionId);
    if (!session) {
      socket.emit(SocketEvents.STUDENT_REJECTED, { reason: "Session not found" });
      logActivity(`reject socket=${socket.id} session=${sessionId} reason=session-not-found`);
      socket.disconnect(); return;
    }
    const quiz = quizStore.get(session.week);
    if (quiz) {
      const repaired = apply(session, quiz, { type: "repairClosedSlide" }, Date.now());
      if (repaired.session.state !== session.state) {
        Object.assign(session, repaired.session);
        clearSessionTimers(sessionId);
        emitMessages(io, sessionId, repaired.messages);
        logActivity(`repaired closed slide session=${sessionId} q=${session.currentQuestionIndex} state=${session.state}`);
      }
    }
    if (session.state === "ENDED") {
      socket.emit(SocketEvents.STUDENT_REJECTED, { reason: "Session has ended" });
      logActivity(`reject socket=${socket.id} session=${sessionId} reason=session-ended`);
      socket.disconnect(); return;
    }
    const role = socket.handshake.auth?.role as string || socket.handshake.query?.role as string;
    if (role === "instructor" || role === "presentation") {
      if (isInstructorAuthEnabled()) {
        const token = getInstructorSessionFromCookie(socket.handshake.headers.cookie);
        if (!token || !hasValidInstructorSession(token)) {
          socket.emit(SocketEvents.STUDENT_REJECTED, { reason: "Instructor login required" });
          socket.disconnect(); return;
        }
      }
      // The projector is a display socket; everything else that gets this far is the instructor's control socket.
      const view = role === "presentation" ? "display" : "control";
      socket.join(sessionRoom(sessionId));
      socket.join(roleRoom(sessionId, view === "display" ? "display" : "control"));
      if (quiz) emitMessages(io, sessionId, apply(session, quiz, { type: "participants" }, Date.now()).messages);
      if (quiz) emitMessages(io, sessionId, apply(session, quiz, { type: "snapshot", view }, Date.now()).messages, socket);
      socket.on("disconnect", () => logActivity(`${role} disconnected session=${sessionId} socket=${socket.id}`));
    }
    socket.on(SocketEvents.STUDENT_JOIN, (payload: StudentJoinPayload) => {
      if (!quiz) return;
      const result = apply(session, quiz, { type: "join", payload, socketId: socket.id, newToken: crypto.randomUUID(), newPublicKey: crypto.randomUUID() }, Date.now());
      Object.assign(session, result.session);
      const joined = result.messages.find((m) => m.event === SocketEvents.STUDENT_JOINED)?.payload as StudentJoinedPayload | undefined;
      if (joined) {
        socket.join(sessionRoom(sessionId));
        socket.join(roleRoom(sessionId, "participant"));
        (socket as Socket & { _studentId?: string })._studentId = joined.participantId;
      }
      emitMessages(io, sessionId, result.messages);
    });
    socket.on(SocketEvents.ANSWER_SUBMIT, (payload: AnswerSubmitPayload) => {
      if (!quiz) return;
      const studentId = (socket as Socket & { _studentId?: string })._studentId;
      const result = apply(session, quiz, { type: "answerSubmit", studentId, payload }, Date.now());
      Object.assign(session, result.session);
      // An unjoined socket has no participant ID, so route its rejection directly.
      if (!studentId) for (const item of result.messages) socket.emit(item.event, item.payload);
      else emitMessages(io, sessionId, result.messages);
    });
    socket.on("disconnect", () => {
      const studentId = (socket as Socket & { _studentId?: string })._studentId;
      if (studentId && quiz) applyAndEmit(io, session, quiz, { type: "disconnect", studentId, socketId: socket.id });
    });
  });
  return io;
}

/** Schedule the existing ticks and automatic close using the engine deadline. */
export function startQuestionTimer(io: Server, session: Session, sessionId: string, timeLimitSec: number, nextDeadline?: number | null): void {
  clearSessionTimers(sessionId);
  const quiz = quizStore.get(session.week);
  if (!quiz) return;
  const timedIndex = session.currentQuestionIndex;
  const timedStart = session.questionStartedAt;
  const due = nextDeadline ?? Date.now() + timeLimitSec * 1000;
  const isCurrent = () => session.state === "QUESTION_OPEN" && session.currentQuestionIndex === timedIndex
    && session.questionStartedAt === timedStart && getQuestionType(quiz.questions[timedIndex]) !== "slide";
  let remaining = timeLimitSec;
  const tick = setInterval(() => {
    if (tickTimers.get(sessionId) !== tick || !isCurrent()) { if (tickTimers.get(sessionId) === tick) clearSessionTimers(sessionId); return; }
    remaining--;
    if (remaining >= 0) emitMessages(io, sessionId, apply(session, quiz, { type: "tick", remainingSec: remaining }, Date.now()).messages);
  }, TICK_INTERVAL_MS);
  tickTimers.set(sessionId, tick);
  const timer = setTimeout(() => {
    if (sessionTimers.get(sessionId) !== timer || !isCurrent()) { if (sessionTimers.get(sessionId) === timer) clearSessionTimers(sessionId); return; }
    clearSessionTimers(sessionId);
    // A caller-supplied time limit has no engine deadline, so the adapter closes the item it has confirmed is current.
    const result = nextDeadline == null
      ? apply(session, quiz, { type: "close" }, Date.now())
      : apply(session, quiz, { type: "timeout", deadline: due }, Math.max(Date.now(), due));
    Object.assign(session, result.session);
    emitMessages(io, sessionId, result.messages);
  }, Math.max(0, due - Date.now()));
  sessionTimers.set(sessionId, timer);
}

/** Compatibility entry points used by existing in-process callers. */
export function broadcastQuestionOpen(io: Server, session: Session, sessionId: string, quiz: Quiz): void {
  clearSessionTimers(sessionId);
  const result = apply(session, quiz, { type: "broadcastOpen" }, Date.now());
  Object.assign(session, result.session);
  emitMessages(io, sessionId, result.messages);
  if (result.nextDeadline !== null) {
    startQuestionTimer(io, session, sessionId, quiz.questions[session.currentQuestionIndex].timeLimitSec, result.nextDeadline);
  }
}
export function broadcastReveal(io: Server, session: Session, sessionId: string, quiz: Quiz): void {
  clearSessionTimers(sessionId);
  emitMessages(io, sessionId, apply(session, quiz, { type: "broadcastReveal" }, Date.now()).messages);
}
export function broadcastLeaderboard(io: Server, session: Session, sessionId: string, quiz: Quiz): void {
  emitMessages(io, sessionId, apply(session, quiz, { type: "broadcastLeaderboard" }, Date.now()).messages);
}
