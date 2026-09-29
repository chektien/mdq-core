import {
  Quiz, Session, SessionState, SocketEvents, QuestionOpenPayload, FoldoutNote,
  StudentJoinPayload, AnswerSubmitPayload, Participant, STATE_TRANSITIONS, StudentAnswer,
} from "@mdq/shared";
import {
  StateTransitionError, computeLeaderboard, getAnsweredQuestions, getDistribution,
  getOpenResponses, getSubmissionCount,
} from "./session";
import { buildScoredCorrectAnswersMap, getQuestionType, getScoredQuestionCount, isOpenResponseQuestion } from "./scoring";

export class EngineCommandError extends Error {}

export type Audience = "all" | "staff" | `participant:${string}`;
export interface EngineMessage { audience: Audience; event: string; payload: unknown }
export type Command =
  | { type: "start" | "next" | "previous" | "open" | "close" | "reveal" | "end" | "leaderboardShow" | "leaderboardHide" | "broadcastOpen" | "broadcastReveal" | "broadcastLeaderboard" | "participants" | "repairClosedSlide" }
  | { type: "timeout"; deadline?: number }
  | { type: "join"; payload: StudentJoinPayload; socketId: string; newToken: string }
  | { type: "answerSubmit"; studentId?: string; payload: AnswerSubmitPayload }
  | { type: "disconnect"; studentId: string; socketId: string }
  | { type: "snapshot"; participantId?: string; isReconnect?: boolean }
  | { type: "tick"; remainingSec: number };
export interface EngineResult { session: Session; messages: EngineMessage[]; nextDeadline: number | null }

const message = (event: string, payload: unknown, audience: Audience = "all"): EngineMessage => ({ audience, event, payload });
const clone = (session: Session): Session => ({
  ...session,
  revealedQuestionIndexes: session.revealedQuestionIndexes ? new Set(session.revealedQuestionIndexes) : undefined,
  participants: new Map([...session.participants].map(([id, p]) => [id, { ...p }])),
  submissions: session.submissions.map((s) => ({ ...s, selectedOptions: [...s.selectedOptions] })),
});
const transition = (session: Session, to: SessionState): void => {
  if (!STATE_TRANSITIONS[session.state].includes(to)) throw new StateTransitionError(session.state, to);
  session.state = to;
};
const questionAt = (session: Session, quiz: Quiz) => quiz.questions[session.currentQuestionIndex];
const questionPayload = (session: Session, quiz: Quiz, now: number): QuestionOpenPayload | null => {
  const q = questionAt(session, quiz);
  if (!q) return null;
  const attendeeNotes: FoldoutNote[] | undefined = q.attendeeNotes?.length ? q.attendeeNotes : undefined;
  return {
    questionIndex: session.currentQuestionIndex, topic: q.topic, text: q.textHtml,
    questionType: getQuestionType(q), attendeeNotes, slideMedia: q.slideMedia,
    slideMediaPosition: q.slideMediaPosition, slideMediaOpacity: q.slideMediaOpacity,
    slideBackground: q.slideBackground, slideLiveEmbed: q.slideLiveEmbed,
    slideVideo: q.slideVideo, slideReferences: q.slideReferences,
    options: q.options.map((o) => ({ label: o.label, text: o.textHtml })),
    allowsMultiple: q.allowsMultiple, isPoll: q.isPoll === true,
    timeLimitSec: q.timeLimitSec, startedAt: session.questionStartedAt || now,
  };
};
const countPayload = (session: Session, quiz: Quiz) => ({
  questionIndex: session.currentQuestionIndex,
  ...getSubmissionCount(session, session.currentQuestionIndex),
  openResponses: isOpenResponseQuestion(questionAt(session, quiz))
    ? getOpenResponses(session, session.currentQuestionIndex) : undefined,
});
const revealPayload = (session: Session, quiz: Quiz) => {
  const q = questionAt(session, quiz);
  return {
    questionIndex: session.currentQuestionIndex, questionType: getQuestionType(q),
    correctOptions: q.correctOptions, explanation: q.explanation,
    distribution: getDistribution(session, session.currentQuestionIndex), isPoll: q.isPoll === true,
    openResponses: isOpenResponseQuestion(q) ? getOpenResponses(session, session.currentQuestionIndex) : undefined,
  };
};
/** One student's own submissions, with option labels turned into option positions. */
const ownAnswers = (session: Session, quiz: Quiz, studentId: string): StudentAnswer[] => session.submissions
  .filter((s) => s.studentId === studentId)
  .map((s) => {
    const options = quiz.questions[s.questionIndex]?.options ?? [];
    return {
      questionIndex: s.questionIndex,
      selectedOptions: s.selectedOptions.map((label) => options.findIndex((o) => o.label === label)).filter((i) => i >= 0),
      ...(s.responseText ? { responseText: s.responseText } : {}),
    };
  })
  .sort((a, b) => a.questionIndex - b.questionIndex);
const leaderboardPayload = (session: Session, quiz: Quiz) => ({
  entries: computeLeaderboard(session, buildScoredCorrectAnswersMap(quiz)),
  totalQuestions: getScoredQuestionCount(quiz),
});
const participantsPayload = (session: Session) => {
  const participants = [...session.participants.values()].filter((p) => p.connected)
    .map((p) => ({ studentId: p.studentId, displayName: p.displayName }));
  return { count: participants.length, participants };
};
const deadline = (session: Session, quiz: Quiz): number | null => {
  const q = questionAt(session, quiz);
  return session.state === "QUESTION_OPEN" && q && getQuestionType(q) !== "slide" && session.questionStartedAt !== undefined
    ? session.questionStartedAt + q.timeLimitSec * 1000 : null;
};

/** Calculate a session change without mutating its input or using a clock or transport. */
export function apply(input: Session, quiz: Quiz, command: Command, now: number): EngineResult {
  const session = clone(input);
  const messages: EngineMessage[] = [];
  const emit = (event: string, payload: unknown, audience: Audience = "all") => messages.push(message(event, payload, audience));
  const openContext = () => {
    const payload = questionPayload(session, quiz, now);
    if (payload) emit(SocketEvents.QUESTION_OPEN, payload);
  };
  const state = (includeIndex = true) => emit(SocketEvents.SESSION_STATE,
    includeIndex ? { state: session.state, questionIndex: session.currentQuestionIndex } : { state: session.state });
  const review = () => {
    session.revealedQuestionIndexes ??= new Set<number>();
    session.revealedQuestionIndexes.add(session.currentQuestionIndex);
  };
  switch (command.type) {
    case "start":
      transition(session, "QUESTION_OPEN");
      session.currentQuestionIndex = 0;
      session.questionStartedAt = now;
      openContext(); state();
      if (getQuestionType(questionAt(session, quiz)) !== "slide") emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz), "staff");
      break;
    case "previous": {
      const prev = session.currentQuestionIndex - 1;
      if (session.state === "LOBBY") throw new EngineCommandError("Start the session before going back.");
      if (prev < 0) throw new EngineCommandError("Already at the first item");
      session.currentQuestionIndex = prev;
      session.state = getQuestionType(questionAt(session, quiz)) === "slide" ? "QUESTION_OPEN" : "REVEAL";
      if (session.state === "QUESTION_OPEN") {
        session.questionStartedAt = now;
        openContext(); state();
      } else {
        review(); openContext(); emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz)); state();
      }
      break;
    }
    case "next": {
      const next = session.currentQuestionIndex + 1;
      if (next >= quiz.questions.length) throw new EngineCommandError("No more questions");
      if (session.state === "LOBBY") throw new EngineCommandError("Start the session before advancing.");
      if (session.state === "QUESTION_OPEN") {
        if (getQuestionType(questionAt(session, quiz)) !== "slide") throw new EngineCommandError("Close and reveal the current question before advancing.");
      } else transition(session, "QUESTION_OPEN");
      session.currentQuestionIndex = next;
      if (getQuestionType(questionAt(session, quiz)) !== "slide" && session.revealedQuestionIndexes?.has(next)) session.state = "REVEAL";
      if (session.state === "QUESTION_OPEN") {
        session.questionStartedAt = now; openContext(); state();
        if (getQuestionType(questionAt(session, quiz)) !== "slide") emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz), "staff");
      } else {
        openContext(); emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz)); state();
      }
      break;
    }
    case "open":
      transition(session, "QUESTION_OPEN");
      if (session.currentQuestionIndex < 0) session.currentQuestionIndex = 0;
      session.questionStartedAt = now;
      openContext(); state();
      if (getQuestionType(questionAt(session, quiz)) !== "slide") emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz), "staff");
      break;
    case "close":
    case "timeout":
      if (command.type === "close" && getQuestionType(questionAt(session, quiz)) === "slide") throw new EngineCommandError("Slides do not close; advance to the next item.");
      if (command.type === "timeout" && (session.state !== "QUESTION_OPEN" || getQuestionType(questionAt(session, quiz)) === "slide" || now < (command.deadline ?? deadline(session, quiz) ?? Infinity))) break;
      transition(session, "QUESTION_CLOSED");
      emit(SocketEvents.QUESTION_CLOSE, { questionIndex: session.currentQuestionIndex }); state();
      emit(SocketEvents.RESULTS_DISTRIBUTION, { questionIndex: session.currentQuestionIndex, distribution: getDistribution(session, session.currentQuestionIndex) }, "staff");
      break;
    case "reveal":
      if (getQuestionType(questionAt(session, quiz)) === "slide") throw new EngineCommandError("Slides do not reveal answers; advance to the next item.");
      transition(session, "REVEAL"); review();
      openContext(); emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz)); state();
      break;
    case "end":
      if (session.state === "QUESTION_CLOSED") transition(session, "REVEAL");
      if (session.state === "REVEAL") transition(session, "LEADERBOARD");
      transition(session, "ENDED"); state(false);
      break;
    case "leaderboardShow":
      if (session.state === "QUESTION_CLOSED") transition(session, "REVEAL");
      transition(session, "LEADERBOARD");
      emit(SocketEvents.LEADERBOARD_UPDATE, leaderboardPayload(session, quiz)); state(false);
      break;
    case "leaderboardHide":
      if (session.currentQuestionIndex >= quiz.questions.length - 1) break;
      transition(session, "REVEAL");
      openContext(); emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz)); state();
      break;
    case "join": {
      const { payload, socketId } = command;
      if (session.state === "ENDED") {
        emit(SocketEvents.STUDENT_REJECTED, { reason: "Session has ended" }, `participant:${socketId}`);
        break;
      }
      const id = payload.studentId?.trim();
      if (!id) { emit(SocketEvents.STUDENT_REJECTED, { reason: "Student ID is required" }, `participant:${socketId}`); break; }
      const existing = session.participants.get(id);
      let participant: Participant;
      let isReconnect = false;
      if (existing) {
        const validToken = !!payload.sessionToken && payload.sessionToken === existing.sessionToken;
        const validClient = !existing.connected && !!payload.clientInstanceId && !!existing.clientInstanceId && payload.clientInstanceId === existing.clientInstanceId;
        if (!validToken && !validClient) {
          emit(SocketEvents.STUDENT_REJECTED, { reason: `Student ID "${id}" is already in use with a different session token.` }, `participant:${socketId}`);
          break;
        }
        existing.socketId = socketId; existing.connected = true;
        if (payload.displayName?.trim()) existing.displayName = payload.displayName.trim();
        if (validToken && payload.clientInstanceId) existing.clientInstanceId = payload.clientInstanceId;
        participant = existing; isReconnect = true;
      } else {
        participant = { studentId: id, displayName: payload.displayName?.trim(), sessionToken: command.newToken,
          clientInstanceId: payload.clientInstanceId, socketId, joinedAt: now, connected: true };
        session.participants.set(id, participant);
      }
      emit(SocketEvents.STUDENT_JOINED, { participantId: id, sessionToken: participant.sessionToken,
        sessionState: session.state, currentQuestion: session.currentQuestionIndex >= 0 ? session.currentQuestionIndex : undefined,
        answeredQuestions: getAnsweredQuestions(session, id), answers: ownAnswers(session, quiz, id) }, `participant:${id}`);
      emit(SocketEvents.SESSION_PARTICIPANTS, participantsPayload(session), "staff");
      if (session.state === "QUESTION_OPEN" && session.currentQuestionIndex >= 0) emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz), "staff");
      messages.push(...snapshotMessages(session, quiz, now, `participant:${id}`, false, isReconnect));
      break;
    }
    case "answerSubmit": {
      const { payload, studentId } = command;
      const target: Audience = `participant:${studentId || ""}`;
      const reject = (reason: string) => emit(SocketEvents.ANSWER_REJECTED, { questionIndex: payload.questionIndex, reason }, target);
      if (!studentId) { reject("Not joined to a session"); break; }
      const q = questionAt(session, quiz);
      if (!q) { reject(`Question ${session.currentQuestionIndex + 1} not found.`); break; }
      const options = payload.selectedOptions || [];
      const responseText = payload.responseText?.trim();
      if (isOpenResponseQuestion(q)) {
        if (options.length) { reject("Open response questions accept text responses only."); break; }
        if (!responseText) { reject("Response text cannot be blank."); break; }
      } else {
        if (!q.allowsMultiple && options.length > 1) { reject("This question accepts one answer only."); break; }
        if (!options.length) { reject("At least one option must be selected."); break; }
      }
      if (session.state !== "QUESTION_OPEN") { reject("Submissions only accepted during QUESTION_OPEN state."); break; }
      if (payload.questionIndex !== session.currentQuestionIndex) { reject(`Question index mismatch: expected ${session.currentQuestionIndex}, got ${payload.questionIndex}.`); break; }
      if (!session.participants.has(studentId)) { reject(`Student "${studentId}" is not a participant in this session.`); break; }
      const existing = session.submissions.find((s) => s.studentId === studentId && s.questionIndex === payload.questionIndex);
      if (existing && !isOpenResponseQuestion(q)) { reject("Already submitted an answer for this question."); break; }
      const submission = { studentId, questionIndex: payload.questionIndex,
        selectedOptions: [...new Set(options)].sort(), responseText: responseText || undefined,
        submittedAt: now, responseTimeMs: session.questionStartedAt ? now - session.questionStartedAt : 0 };
      if (existing) Object.assign(existing, submission);
      else session.submissions.push(submission);
      emit(SocketEvents.ANSWER_ACCEPTED, { questionIndex: payload.questionIndex }, target);
      emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz), "staff");
      break;
    }
    case "disconnect": {
      const participant = session.participants.get(command.studentId);
      // A socket replaced by a rejoin can time out later; only the current socket marks the student offline.
      if (participant && participant.socketId === command.socketId) {
        participant.connected = false;
        emit(SocketEvents.SESSION_PARTICIPANTS, participantsPayload(session), "staff");
        if (session.state === "QUESTION_OPEN" && session.currentQuestionIndex >= 0) emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz), "staff");
      }
      break;
    }
    case "snapshot":
      messages.push(...snapshotMessages(session, quiz, now, command.participantId ? `participant:${command.participantId}` : "staff", !command.participantId, !!command.isReconnect));
      break;
    case "broadcastOpen":
      session.questionStartedAt = now;
      openContext(); state();
      if (getQuestionType(questionAt(session, quiz)) !== "slide") emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz), "staff");
      break;
    case "broadcastReveal":
      openContext(); emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz)); state();
      break;
    case "broadcastLeaderboard":
      emit(SocketEvents.LEADERBOARD_UPDATE, leaderboardPayload(session, quiz)); state(false);
      break;
    case "participants": emit(SocketEvents.SESSION_PARTICIPANTS, participantsPayload(session), "staff"); break;
    case "repairClosedSlide":
      if (session.state === "QUESTION_CLOSED" && getQuestionType(questionAt(session, quiz)) === "slide") {
        session.state = "QUESTION_OPEN";
        session.questionStartedAt = now;
        openContext(); state();
      }
      break;
    case "tick": emit(SocketEvents.QUESTION_TICK, { remainingSec: command.remainingSec }); break;
  }
  return { session, messages, nextDeadline: deadline(session, quiz) };
}

function snapshotMessages(session: Session, quiz: Quiz, now: number, audience: Audience, staff: boolean, isReconnect: boolean): EngineMessage[] {
  const messages: EngineMessage[] = [];
  const emit = (event: string, payload: unknown, target: Audience = audience) => messages.push(message(event, payload, target));
  if (staff) emit(SocketEvents.SESSION_STATE, { state: session.state, questionIndex: session.currentQuestionIndex >= 0 ? session.currentQuestionIndex : undefined });
  const q = questionAt(session, quiz);
  const payload = questionPayload(session, quiz, now);
  if (!q || !payload) return messages;
  if (session.state === "QUESTION_OPEN") {
    emit(SocketEvents.QUESTION_OPEN, payload);
    if (session.questionStartedAt) emit(SocketEvents.QUESTION_TICK, { remainingSec: Math.max(0, q.timeLimitSec - Math.floor((now - session.questionStartedAt) / 1000)) });
    if (staff) emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz), "staff");
  } else if (session.state === "QUESTION_CLOSED") {
    emit(SocketEvents.QUESTION_OPEN, payload);
    emit(SocketEvents.QUESTION_CLOSE, { questionIndex: session.currentQuestionIndex });
    if (staff) {
      emit(SocketEvents.RESULTS_DISTRIBUTION, { questionIndex: session.currentQuestionIndex, distribution: getDistribution(session, session.currentQuestionIndex) }, "staff");
      emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz), "staff");
    }
  } else if (session.state === "REVEAL" && (staff || isReconnect)) {
    emit(SocketEvents.QUESTION_OPEN, payload);
    emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz));
    if (staff) emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz), "staff");
  } else if (session.state === "LEADERBOARD") emit(SocketEvents.LEADERBOARD_UPDATE, leaderboardPayload(session, quiz));
  return messages;
}
