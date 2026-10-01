import {
  Quiz, Session, SessionState, SocketEvents, QuestionOpenPayload, QuestionClosePayload, FoldoutNote,
  StudentJoinPayload, AnswerSubmitPayload, Participant, STATE_TRANSITIONS, StudentAnswer,
  LeaderboardRow, OpenResponseEntry, SessionParticipantsPayload, SocketRole,
  JOIN_LOCKED_MESSAGE, MAX_DISPLAY_NAME_LENGTH, MAX_OPEN_RESPONSE_LENGTH, MAX_STUDENT_ID_LENGTH, normalizeDisplayName, usesStudentIds,
} from "@mdq/shared";
import {
  StateTransitionError, computeLeaderboard, getAnsweredQuestions, getDistribution,
  getOpenResponses, getSubmissionCount,
} from "./session";
import { buildScoredCorrectAnswersMap, getQuestionType, getScoredQuestionCount, isOpenResponseQuestion } from "./scoring";
import {
  assignLabel, ensureParticipantIdentity, findSeatByName, idTakenMessage, nameTakenMessage, newPublicKey,
} from "./identity";

export class EngineCommandError extends Error {}

/**
 * Who a message is for. An adapter decides which of its sockets get a message
 * with `audienceReaches`, so every adapter routes the same way:
 *
 * - `all`: control, display and participant sockets. Never carries a Student ID.
 * - `staff`: control and display sockets. Never carries a Student ID.
 * - `control`: control sockets only (the instructor). May carry Student IDs and names.
 * - `display`: display sockets only (the projector). Carries labels, never Student IDs.
 * - `public`: display and participant sockets. Carries labels, never Student IDs.
 * - `participants`: every participant socket, and nothing else.
 * - `participant:<id>`: one participant's own socket.
 *
 * An event that carries who said what is sent twice: the full payload as
 * `control`, and the same event with labels and public keys as `display`
 * (or `public` when phones get it too). Open-response text is the exception:
 * the instructor gets every response, the projector gets only the ones the
 * presenter has not hidden and only once the answers are revealed, and phones
 * never get anyone else's response.
 */
export type Audience = "all" | "staff" | "control" | "display" | "public" | "participants" | `participant:${string}`;
export interface EngineMessage { audience: Audience; event: string; payload: unknown }

const AUDIENCE_ROLES: Record<Exclude<Audience, `participant:${string}`>, readonly SocketRole[]> = {
  all: ["control", "display", "participant"],
  staff: ["control", "display"],
  control: ["control"],
  display: ["display"],
  public: ["display", "participant"],
  participants: ["participant"],
};

/**
 * Whether a socket of `role` should receive a message sent to `audience`.
 * A `participant:<id>` message reaches only that participant's own socket, so
 * the adapter resolves the socket and this answers true for the participant role.
 */
export function audienceReaches(audience: Audience, role: SocketRole): boolean {
  if (audience.startsWith("participant:")) return role === "participant";
  return AUDIENCE_ROLES[audience as keyof typeof AUDIENCE_ROLES].includes(role);
}

/** Which payload a view gets: `control` has Student IDs and names, `public` has labels only. */
export type PayloadView = "control" | "public";
/** Who an open-response payload is built for: only `control` sees every response. */
export type ResponseView = "control" | "display" | "participant";
export type Command =
  | { type: "start" | "next" | "previous" | "open" | "close" | "reveal" | "end" | "leaderboardShow" | "leaderboardHide" | "broadcastOpen" | "broadcastReveal" | "broadcastLeaderboard" | "participants" | "repairClosedSlide" }
  | { type: "timeout"; deadline?: number }
  | { type: "join"; payload: StudentJoinPayload; socketId: string; newToken: string; newPublicKey?: string }
  /**
   * `sessionToken` is the token the answering connection joined with. When it is given and is no longer
   * the participant's current token (the seat was freed and taken again), the answer is refused; a
   * connection with the current token, on any device or tab, still answers.
   */
  | { type: "answerSubmit"; studentId?: string; sessionToken?: string; payload: AnswerSubmitPayload }
  /** Hide or show one open response on the projector. `role` is who is asking; only `control` may. */
  | { type: "responseVisibility"; role: SocketRole; questionIndex: number; publicKey: string; hidden: boolean }
  /** Free one participant's seat so the next join with that ID (or name) takes it over. `role` is who is asking; only `control` may. */
  | { type: "releaseSeat"; role: SocketRole; publicKey: string; newToken: string }
  /** Stop (or allow again) new participants joining. `role` is who is asking; only `control` may. Someone who already has a seat can still rejoin it. */
  | { type: "joinLock"; role: SocketRole; locked: boolean }
  | { type: "disconnect"; studentId: string; socketId: string }
  | { type: "snapshot"; participantId?: string; isReconnect?: boolean; view?: "control" | "display" }
  | { type: "tick"; remainingSec: number };
export interface EngineResult {
  session: Session;
  messages: EngineMessage[];
  nextDeadline: number | null;
  /**
   * Set by a `join` that took over a seat the presenter freed. Every connection of that participant
   * whose token is not `sessionToken` is on a device that has lost the seat, and an adapter should
   * tell it (the `SEAT_TAKEN` event, `SEAT_TAKEN_MESSAGE` from `@mdq/shared`) and stop sending it session messages.
   */
  seatTaken?: { participantId: string; sessionToken: string };
}

/** Why an answer from a device that has lost its seat is refused. */
export const SEAT_IN_USE_MESSAGE = "This seat is now in use on another device.";

const message = (event: string, payload: unknown, audience: Audience = "all"): EngineMessage => ({ audience, event, payload });
const clone = (session: Session): Session => ({
  ...session,
  revealedQuestionIndexes: session.revealedQuestionIndexes ? new Set(session.revealedQuestionIndexes) : undefined,
  participants: new Map([...session.participants].map(([id, p]) => [id, { ...p }])),
  submissions: session.submissions.map((s) => ({ ...s, selectedOptions: [...s.selectedOptions] })),
  hiddenResponses: session.hiddenResponses
    ? Object.fromEntries(Object.entries(session.hiddenResponses).map(([index, keys]) => [index, [...keys]]))
    : undefined,
});
const transition = (session: Session, to: SessionState): void => {
  if (!STATE_TRANSITIONS[session.state].includes(to)) throw new StateTransitionError(session.state, to);
  session.state = to;
};
const questionAt = (session: Session, quiz: Quiz) => quiz.questions[session.currentQuestionIndex];
/**
 * "Question 3 of 8" counts only items that ask something: slides have no
 * position. Shared by the live payload and the instructor's restore.
 */
export const questionPosition = (quiz: Quiz, questionIndex: number): { questionNumber?: number; questionTotal?: number } => {
  const q = quiz.questions[questionIndex];
  if (!q || getQuestionType(q) === "slide") return {};
  return {
    questionNumber: quiz.questions.slice(0, questionIndex + 1).filter((item) => getQuestionType(item) !== "slide").length,
    questionTotal: quiz.questions.filter((item) => getQuestionType(item) !== "slide").length,
  };
};
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
    ...(quiz.style ? { deckStyle: quiz.style } : {}),
    options: q.options.map((o) => ({ label: o.label, text: o.textHtml })),
    allowsMultiple: q.allowsMultiple, isPoll: q.isPoll === true,
    timeLimitSec: q.timeLimitSec, startedAt: session.questionStartedAt || now,
    ...questionPosition(quiz, session.currentQuestionIndex),
  };
};
/**
 * Open responses for one view. The instructor gets every response with IDs,
 * names and a hidden flag. The projector gets labels only, and only the
 * responses that are not hidden. Phones get none.
 */
export const responsesFor = (responses: OpenResponseEntry[], view: ResponseView): OpenResponseEntry[] => {
  if (view === "control") return responses;
  if (view === "participant") return [];
  return responses.filter((r) => !r.hidden)
    .map(({ publicKey, label, responseText, submittedAt }) => ({ publicKey, label, responseText, submittedAt }));
};
/**
 * The answer count. It only carries the responses themselves to the
 * instructor: the projector and phones never get open-response text while a
 * question is open, only the count.
 */
const countPayload = (session: Session, quiz: Quiz, view: ResponseView) => ({
  questionIndex: session.currentQuestionIndex,
  ...getSubmissionCount(session, session.currentQuestionIndex),
  ...(session.submissions.length > 0 ? { hasAnswers: true as const } : {}),
  openResponses: view === "control" && isOpenResponseQuestion(questionAt(session, quiz))
    ? responsesFor(getOpenResponses(session, session.currentQuestionIndex), view) : undefined,
});
const revealPayload = (session: Session, quiz: Quiz, view: ResponseView) => {
  const q = questionAt(session, quiz);
  return {
    questionIndex: session.currentQuestionIndex, questionType: getQuestionType(q),
    correctOptions: q.correctOptions, explanation: q.explanation,
    distribution: getDistribution(session, session.currentQuestionIndex), isPoll: q.isPoll === true,
    openResponses: isOpenResponseQuestion(q) && view !== "participant" ? responsesFor(getOpenResponses(session, session.currentQuestionIndex), view) : undefined,
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
/**
 * The ranked rows for one view. `public` rows name people by label and public
 * key only, so they are safe for phones and the projector.
 */
export function leaderboardRows(session: Session, quiz: Quiz, view: PayloadView): LeaderboardRow[] {
  return computeLeaderboard(session, buildScoredCorrectAnswersMap(quiz)).map((entry) => {
    const participant = session.participants.get(entry.studentId);
    const row = {
      rank: entry.rank, publicKey: participant?.publicKey ?? "", label: participant?.label ?? "",
      correctCount: entry.correctCount, totalTimeMs: entry.totalTimeMs,
    };
    return view === "control" ? { ...row, studentId: entry.studentId, displayName: entry.displayName } : row;
  });
}
const leaderboardPayload = (session: Session, quiz: Quiz, view: PayloadView) => ({
  entries: leaderboardRows(session, quiz, view),
  totalQuestions: getScoredQuestionCount(quiz),
});
const participantsPayload = (session: Session, view: PayloadView): SessionParticipantsPayload => {
  const participants = [...session.participants.values()].filter((p) => p.connected)
    .map((p) => view === "control"
      ? { publicKey: p.publicKey, label: p.label, studentId: p.studentId, displayName: p.displayName }
      : { publicKey: p.publicKey, label: p.label });
  const lock = session.joinLocked ? { joinLocked: true as const } : {};
  if (view !== "control") return { count: participants.length, participants, ...lock };
  const offline = [...session.participants.values()].filter((p) => !p.connected)
    .map((p) => ({ publicKey: p.publicKey, label: p.label, studentId: p.studentId, displayName: p.displayName,
      ...(p.released ? { released: true } : {}) }));
  return offline.length ? { count: participants.length, participants, offline, ...lock } : { count: participants.length, participants, ...lock };
};
/** The close message: it says so when the timer ran out, so screens can tell that from the presenter closing early. */
const closePayload = (session: Session): QuestionClosePayload => ({
  questionIndex: session.currentQuestionIndex, ...(session.closedByTimer ? { timedOut: true as const } : {}),
});
const deadline = (session: Session, quiz: Quiz): number | null => {
  const q = questionAt(session, quiz);
  return session.state === "QUESTION_OPEN" && q && getQuestionType(q) !== "slide" && session.questionStartedAt !== undefined
    ? session.questionStartedAt + q.timeLimitSec * 1000 : null;
};

/** Calculate a session change without mutating its input or using a clock or transport. */
export function apply(input: Session, quiz: Quiz, command: Command, now: number): EngineResult {
  const session = clone(input);
  ensureParticipantIdentity(session);
  const messages: EngineMessage[] = [];
  let seatTaken: EngineResult["seatTaken"];
  const emit = (event: string, payload: unknown, audience: Audience = "all") => messages.push(message(event, payload, audience));
  // Open responses go out in full to control only; the projector gets the count, then the visible responses at reveal.
  const emitCount = () => {
    if (isOpenResponseQuestion(questionAt(session, quiz))) {
      emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz, "control"), "control");
      emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz, "display"), "display");
    } else emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz, "display"), "staff");
  };
  const emitReveal = () => {
    if (isOpenResponseQuestion(questionAt(session, quiz))) {
      emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "control"), "control");
      emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "display"), "display");
      emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "participant"), "participants");
    } else emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "display"));
  };
  const emitLeaderboard = () => {
    emit(SocketEvents.LEADERBOARD_UPDATE, leaderboardPayload(session, quiz, "control"), "control");
    emit(SocketEvents.LEADERBOARD_UPDATE, leaderboardPayload(session, quiz, "public"), "public");
  };
  const emitParticipants = () => {
    emit(SocketEvents.SESSION_PARTICIPANTS, participantsPayload(session, "control"), "control");
    emit(SocketEvents.SESSION_PARTICIPANTS, participantsPayload(session, "public"), "display");
  };
  const openContext = () => {
    const payload = questionPayload(session, quiz, now);
    if (payload) emit(SocketEvents.QUESTION_OPEN, payload);
  };
  const state = (includeIndex = true) => emit(SocketEvents.SESSION_STATE,
    { ...(includeIndex ? { state: session.state, questionIndex: session.currentQuestionIndex } : { state: session.state }),
      ...(session.submissions.length > 0 ? { hasAnswers: true } : {}) });
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
      if (getQuestionType(questionAt(session, quiz)) !== "slide") emitCount();
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
        review(); openContext(); emitReveal(); state();
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
        if (getQuestionType(questionAt(session, quiz)) !== "slide") emitCount();
      } else {
        openContext(); emitReveal(); state();
      }
      break;
    }
    case "open":
      transition(session, "QUESTION_OPEN");
      if (session.currentQuestionIndex < 0) session.currentQuestionIndex = 0;
      session.questionStartedAt = now;
      openContext(); state();
      if (getQuestionType(questionAt(session, quiz)) !== "slide") emitCount();
      break;
    case "close":
    case "timeout":
      if (command.type === "close" && getQuestionType(questionAt(session, quiz)) === "slide") throw new EngineCommandError("Slides do not close; advance to the next item.");
      if (command.type === "timeout") {
        const due = deadline(session, quiz);
        // An alarm set for an earlier question or opening carries a different deadline and is ignored.
        if (due === null || (command.deadline !== undefined && command.deadline !== due) || now < due) break;
      }
      transition(session, "QUESTION_CLOSED");
      session.closedByTimer = command.type === "timeout";
      emit(SocketEvents.QUESTION_CLOSE, closePayload(session)); state();
      emit(SocketEvents.RESULTS_DISTRIBUTION, { questionIndex: session.currentQuestionIndex, distribution: getDistribution(session, session.currentQuestionIndex) }, "staff");
      break;
    case "reveal":
      if (getQuestionType(questionAt(session, quiz)) === "slide") throw new EngineCommandError("Slides do not reveal answers; advance to the next item.");
      transition(session, "REVEAL"); review();
      openContext(); emitReveal(); state();
      break;
    case "end":
      if (session.state === "QUESTION_CLOSED") transition(session, "REVEAL");
      if (session.state === "REVEAL") transition(session, "LEADERBOARD");
      transition(session, "ENDED"); state(false);
      break;
    case "leaderboardShow":
      if (session.state === "QUESTION_CLOSED") transition(session, "REVEAL");
      transition(session, "LEADERBOARD");
      emitLeaderboard(); state(false);
      break;
    case "leaderboardHide":
      if (session.currentQuestionIndex >= quiz.questions.length - 1) break;
      transition(session, "REVEAL");
      openContext(); emitReveal(); state();
      break;
    case "join": {
      const { payload, socketId } = command;
      const reject = (reason: string) => emit(SocketEvents.STUDENT_REJECTED, { reason }, `participant:${socketId}`);
      if (session.state === "ENDED") { reject("Session has ended"); break; }
      // The name is normalised for everyone; where Student IDs are off it is also the ID.
      const usesIds = usesStudentIds(quiz);
      const typedName = normalizeDisplayName(payload.displayName);
      const id = usesIds
        ? (typeof payload.studentId === "string" ? payload.studentId.trim() : "")
        : typedName || normalizeDisplayName(payload.studentId);
      if (!id) { reject(usesIds ? "Student ID is required" : "Please enter your name to join."); break; }
      if (usesIds && id.length > MAX_STUDENT_ID_LENGTH) { reject(`Student ID can be at most ${MAX_STUDENT_ID_LENGTH} characters.`); break; }
      if (typedName.length > MAX_DISPLAY_NAME_LENGTH) { reject(`Name can be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`); break; }
      const existing = usesIds ? session.participants.get(id) : findSeatByName(session, id);
      let participant: Participant;
      let isReconnect = false;
      if (existing) {
        // Your own seat is never a clash: the same session token, or the same browser after it went offline.
        const validToken = !!payload.sessionToken && payload.sessionToken === existing.sessionToken;
        const validClient = !existing.connected && !!payload.clientInstanceId && !!existing.clientInstanceId && payload.clientInstanceId === existing.clientInstanceId;
        // A seat the presenter freed goes to the next join, from any device.
        const takeover = existing.released === true;
        if (!validToken && !validClient && !takeover) { reject(usesIds ? idTakenMessage(id) : nameTakenMessage(id)); break; }
        existing.socketId = socketId; existing.connected = true;
        if (usesIds && typedName) existing.displayName = typedName;
        if (takeover) {
          existing.released = false; existing.sessionToken = command.newToken; existing.clientInstanceId = payload.clientInstanceId;
          seatTaken = { participantId: existing.studentId, sessionToken: command.newToken };
        } else if (validToken && payload.clientInstanceId) existing.clientInstanceId = payload.clientInstanceId;
        participant = existing; isReconnect = true;
      } else {
        // A new seat is what a lock refuses; every rejoin above got through.
        if (session.joinLocked) { reject(JOIN_LOCKED_MESSAGE); break; }
        const { label, labelNote } = assignLabel(session, typedName);
        participant = { studentId: id, displayName: usesIds ? typedName || undefined : id,
          publicKey: command.newPublicKey ?? newPublicKey(), label, labelNote,
          sessionToken: command.newToken, clientInstanceId: payload.clientInstanceId, socketId, joinedAt: now, connected: true };
        session.participants.set(participant.studentId, participant);
      }
      emit(SocketEvents.STUDENT_JOINED, { participantId: participant.studentId, sessionToken: participant.sessionToken,
        sessionState: session.state, currentQuestion: session.currentQuestionIndex >= 0 ? session.currentQuestionIndex : undefined,
        answeredQuestions: getAnsweredQuestions(session, participant.studentId), answers: ownAnswers(session, quiz, participant.studentId),
        publicKey: participant.publicKey, label: participant.label, labelNote: participant.labelNote,
        ...(quiz.title ? { deckTitle: quiz.title } : {}) }, `participant:${participant.studentId}`);
      emitParticipants();
      if (session.state === "QUESTION_OPEN" && session.currentQuestionIndex >= 0) emitCount();
      messages.push(...snapshotMessages(session, quiz, now, `participant:${participant.studentId}`, "participant", isReconnect));
      break;
    }
    case "answerSubmit": {
      const { payload, studentId, sessionToken } = command;
      const target: Audience = `participant:${studentId || ""}`;
      const reject = (reason: string) => emit(SocketEvents.ANSWER_REJECTED, { questionIndex: payload.questionIndex, reason }, target);
      if (!studentId) { reject("Not joined to a session"); break; }
      const seat = session.participants.get(studentId);
      if (seat && sessionToken !== undefined && sessionToken !== seat.sessionToken) { reject(SEAT_IN_USE_MESSAGE); break; }
      const q = questionAt(session, quiz);
      if (!q) { reject(`Question ${session.currentQuestionIndex + 1} not found.`); break; }
      const options = payload.selectedOptions || [];
      const responseText = payload.responseText?.trim();
      if (isOpenResponseQuestion(q)) {
        if (options.length) { reject("Open response questions accept text responses only."); break; }
        if (!responseText) { reject("Response text cannot be blank."); break; }
        if ([...responseText].length > MAX_OPEN_RESPONSE_LENGTH) { reject(`Please use up to ${MAX_OPEN_RESPONSE_LENGTH} characters.`); break; }
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
      emitCount();
      break;
    }
    case "responseVisibility": {
      if (command.role !== "control") throw new EngineCommandError("Only the presenter can hide or show responses.");
      const { questionIndex, publicKey, hidden } = command;
      const question = quiz.questions[questionIndex];
      if (!question || !isOpenResponseQuestion(question)) throw new EngineCommandError("That question has no open responses.");
      if (!getOpenResponses(session, questionIndex).some((r) => r.publicKey === publicKey)) throw new EngineCommandError("That response was not found.");
      const key = String(questionIndex);
      const others = (session.hiddenResponses?.[key] ?? []).filter((k) => k !== publicKey);
      const keys = hidden ? [...others, publicKey] : others;
      const next = { ...session.hiddenResponses };
      if (keys.length) next[key] = keys; else delete next[key];
      session.hiddenResponses = Object.keys(next).length ? next : undefined;
      // Only the question on screen has an audience to update. The instructor sees the new flag at once,
      // and the projector changes only while the answers are showing.
      if (questionIndex === session.currentQuestionIndex && session.state !== "LOBBY" && session.state !== "ENDED") {
        emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz, "control"), "control");
        if (session.state === "REVEAL") {
          emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "control"), "control");
          emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "display"), "display");
        }
      }
      break;
    }
    case "releaseSeat": {
      if (command.role !== "control") throw new EngineCommandError("Only the presenter can let someone join again.");
      const participant = [...session.participants.values()].find((p) => p.publicKey === command.publicKey);
      if (!participant) throw new EngineCommandError("That participant was not found.");
      // The old device's token and socket stop working; the seat, its answers, label and public key stay.
      participant.released = true; participant.connected = false;
      participant.sessionToken = command.newToken; participant.socketId = "";
      participant.clientInstanceId = undefined;
      emitParticipants();
      if (session.state === "QUESTION_OPEN" && session.currentQuestionIndex >= 0) emitCount();
      break;
    }
    case "joinLock": {
      if (command.role !== "control") throw new EngineCommandError("Only the presenter can lock or unlock joining.");
      if (typeof command.locked !== "boolean") throw new EngineCommandError("Send locked as true or false.");
      session.joinLocked = command.locked;
      emitParticipants();
      break;
    }
    case "disconnect": {
      const participant = session.participants.get(command.studentId);
      // A socket replaced by a rejoin can time out later; only the current socket marks the student offline.
      if (participant && participant.socketId === command.socketId) {
        participant.connected = false;
        emitParticipants();
        if (session.state === "QUESTION_OPEN" && session.currentQuestionIndex >= 0) emitCount();
      }
      break;
    }
    case "snapshot":
      messages.push(...command.participantId
        ? snapshotMessages(session, quiz, now, `participant:${command.participantId}`, "participant", !!command.isReconnect)
        : snapshotMessages(session, quiz, now, command.view === "display" ? "display" : "control", command.view === "display" ? "display" : "control", !!command.isReconnect));
      break;
    case "broadcastOpen":
      session.questionStartedAt = now;
      openContext(); state();
      if (getQuestionType(questionAt(session, quiz)) !== "slide") emitCount();
      break;
    case "broadcastReveal":
      openContext(); emitReveal(); state();
      break;
    case "broadcastLeaderboard":
      emitLeaderboard(); state(false);
      break;
    case "participants": emitParticipants(); break;
    case "repairClosedSlide":
      if (session.state === "QUESTION_CLOSED" && getQuestionType(questionAt(session, quiz)) === "slide") {
        session.state = "QUESTION_OPEN";
        session.questionStartedAt = now;
        openContext(); state();
      }
      break;
    case "tick": emit(SocketEvents.QUESTION_TICK, { remainingSec: command.remainingSec }); break;
  }
  return { session, messages, nextDeadline: deadline(session, quiz), ...(seatTaken ? { seatTaken } : {}) };
}

/**
 * What one socket is sent when it connects or rejoins. `view` picks the
 * payloads: control gets IDs and names, display and participant get labels.
 * Each message is addressed to that view's own audience, so an adapter that
 * routes by audience sends it no further than the socket it was built for.
 */
function snapshotMessages(session: Session, quiz: Quiz, now: number, audience: Audience, view: "control" | "display" | "participant", isReconnect: boolean): EngineMessage[] {
  const messages: EngineMessage[] = [];
  const staff = view !== "participant";
  const payloadView: PayloadView = view === "control" ? "control" : "public";
  const emit = (event: string, payload: unknown, target: Audience = audience) => messages.push(message(event, payload, target));
  const emitCount = () => emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz, view));
  if (staff) emit(SocketEvents.SESSION_STATE, { state: session.state, questionIndex: session.currentQuestionIndex >= 0 ? session.currentQuestionIndex : undefined,
    ...(session.submissions.length > 0 ? { hasAnswers: true } : {}) });
  const q = questionAt(session, quiz);
  const payload = questionPayload(session, quiz, now);
  if (!q || !payload) return messages;
  if (session.state === "QUESTION_OPEN") {
    emit(SocketEvents.QUESTION_OPEN, payload);
    if (session.questionStartedAt) emit(SocketEvents.QUESTION_TICK, { remainingSec: Math.max(0, q.timeLimitSec - Math.floor((now - session.questionStartedAt) / 1000)) });
    if (staff) emitCount();
  } else if (session.state === "QUESTION_CLOSED") {
    emit(SocketEvents.QUESTION_OPEN, payload);
    emit(SocketEvents.QUESTION_CLOSE, closePayload(session));
    if (staff) {
      emit(SocketEvents.RESULTS_DISTRIBUTION, { questionIndex: session.currentQuestionIndex, distribution: getDistribution(session, session.currentQuestionIndex) });
      emitCount();
    }
  } else if (session.state === "REVEAL" && (staff || isReconnect)) {
    emit(SocketEvents.QUESTION_OPEN, payload);
    emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, view));
    if (staff) emitCount();
  } else if (session.state === "LEADERBOARD") emit(SocketEvents.LEADERBOARD_UPDATE, leaderboardPayload(session, quiz, payloadView));
  return messages;
}
