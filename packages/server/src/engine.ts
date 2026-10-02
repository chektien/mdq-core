import { availabilityAlarmMatches, availabilityPayload, nextAvailabilityAlarm, sessionAvailabilityPhase, validateAvailabilityDeadline } from "./availability";
import { defaultSessionPolicy, effectiveRanking, getSessionScoredQuestionCount, isQuestionReleased, isSelfPaced, publicResultsHidden, releasedQuestionIndexes, scoredCorrectAnswersForSession } from "./policy";
import { isSlideType } from "@mdq/shared";
import {
  Quiz, Session, SessionState, SocketEvents, QuestionOpenPayload, QuestionClosePayload, FoldoutNote,
  StudentJoinPayload, AnswerSubmitPayload, Participant, STATE_TRANSITIONS, StudentAnswer,
  LeaderboardRow, OpenResponseEntry, SessionParticipantsPayload, SocketRole, QuestionTiming,
  JOIN_LOCKED_MESSAGE, MAX_DISPLAY_NAME_LENGTH, MAX_OPEN_RESPONSE_LENGTH, MAX_STUDENT_ID_LENGTH, normalizeDisplayName, usesStudentIds,
} from "@mdq/shared";
import {
  StateTransitionError, computeLeaderboard, getAnsweredQuestions, getDistribution,
  getOpenResponses, getSubmissionCount, isExactOptionMatch,
} from "./session";
import { getQuestionType, isOpenResponseQuestion } from "./scoring";
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
  | { type: "end"; discloseResults?: boolean }
  | { type: "configureAvailability"; role: SocketRole; availableUntil?: number; extendForMs?: number }
  | { type: "expireAvailability" | "purgeAvailability"; alarm: import("@mdq/shared").SessionAvailabilityAlarm }
  | { type: "configurePolicy"; role: SocketRole; pacing: "presenter-paced" | "self-paced"; ranking?: "correctness" | "speed" }
  | { type: "start" | "next" | "previous" | "open" | "close" | "reveal" | "leaderboardShow" | "leaderboardHide" | "broadcastOpen" | "broadcastReveal" | "broadcastLeaderboard" | "participants" | "repairClosedSlide" }
  | { type: "timeout"; deadline?: number; questionIndex?: number; startedAt?: number; restartCount?: number }
  | { type: "restartCountdown"; role: SocketRole }
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
/** Captured when scheduling an alarm: numeric deadlines alone are not item identities. */
export interface QuestionAlarm {
  questionIndex: number;
  startedAt: number;
  deadlineAt: number;
  restartCount: number;
}
export interface EngineResult {
  session: Session;
  messages: EngineMessage[];
  nextDeadline: number | null;
  nextAlarm: QuestionAlarm | null;
  nextAvailabilityAlarm: import("@mdq/shared").SessionAvailabilityAlarm | null;
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
  availability: session.availability ? { ...session.availability } : undefined,
  policy: session.policy ? { ...session.policy } : undefined,
  releasedQuestionIndexes: session.releasedQuestionIndexes ? new Set(session.releasedQuestionIndexes) : undefined,
  resultScope: session.resultScope ? { ...session.resultScope, releasedQuestionIndexes: [...session.resultScope.releasedQuestionIndexes], scoredQuestionIndexes: [...session.resultScope.scoredQuestionIndexes] } : undefined,
  revealedQuestionIndexes: session.revealedQuestionIndexes ? new Set(session.revealedQuestionIndexes) : undefined,
  participants: new Map([...session.participants].map(([id, p]) => [id, { ...p }])),
  submissions: session.submissions.map((s) => ({ ...s, selectedOptions: [...s.selectedOptions] })),
  questionTiming: session.questionTiming ? Object.fromEntries(Object.entries(session.questionTiming)
    .map(([index, timing]) => [index, { ...timing, restarts: timing.restarts.map((restart) => ({ ...restart })) }])) : undefined,
  hiddenResponses: session.hiddenResponses
    ? Object.fromEntries(Object.entries(session.hiddenResponses).map(([index, keys]) => [index, [...keys]]))
    : undefined,
});
const transition = (session: Session, to: SessionState): void => {
  if (!STATE_TRANSITIONS[session.state].includes(to)) throw new StateTransitionError(session.state, to);
  session.state = to;
};
const questionAt = (session: Session, quiz: Quiz) => quiz.questions[session.currentQuestionIndex];
/** Read legacy timing without inventing a first-open history or resetting its clock. */
export const timingFor = (session: Session, quiz: Quiz, index = session.currentQuestionIndex): QuestionTiming | undefined => {
  quiz = session.deckSnapshot ?? quiz;
  const saved = session.questionTiming?.[String(index)];
  if (isSelfPaced(session) && saved) return { ...saved, deadlineAt: null };
  if (saved) return saved;
  const q = quiz.questions[index];
  if (!q || index !== session.currentQuestionIndex || session.questionStartedAt === undefined) return undefined;
  return {
    startedAt: session.questionStartedAt,
    deadlineAt: isSelfPaced(session) || q.timeLimitSec === null || isSlideType(getQuestionType(q)) ? null
      : session.questionDeadlineAt !== undefined ? session.questionDeadlineAt : session.questionStartedAt + q.timeLimitSec * 1000,
    restarts: [],
  };
};
/**
 * "Question 3 of 8" counts only items that ask something: slides have no
 * position. Shared by the live payload and the instructor's restore.
 */
export const questionPosition = (quiz: Quiz, questionIndex: number): { questionNumber?: number; questionTotal?: number } => {
  const q = quiz.questions[questionIndex];
  if (!q || isSlideType(getQuestionType(q))) return {};
  return {
    questionNumber: quiz.questions.slice(0, questionIndex + 1).filter((item) => !isSlideType(getQuestionType(item))).length,
    questionTotal: quiz.questions.filter((item) => !isSlideType(getQuestionType(item))).length,
  };
};
/** Audience-safe content; reading/previewing must never release an item. */
export const publicQuestionPayload = (session: Session, quiz: Quiz, index: number, now: number): QuestionOpenPayload | null => {
  quiz = session.deckSnapshot ?? quiz;
  if (sessionAvailabilityPhase(session, now) === "deleted" || !isQuestionReleased(session, index)) return null;
  const q = quiz.questions[index];
  if (!q) return null;
  const attendeeNotes: FoldoutNote[] | undefined = q.attendeeNotes?.length ? q.attendeeNotes : undefined;
  const timing = timingFor(session, quiz, index);
  return {
    questionIndex: index, topic: q.topic, text: q.textHtml,
    questionType: getQuestionType(q), attendeeNotes, slideMedia: q.slideMedia,
    slideMediaPosition: q.slideMediaPosition, slideMediaOpacity: q.slideMediaOpacity,
    slideBackground: q.slideBackground, slideLiveEmbed: q.slideLiveEmbed,
    slideVideo: q.slideVideo, slideReferences: q.slideReferences,
    ...(quiz.style ? { deckStyle: quiz.style } : {}),
    options: q.options.map((o) => ({ label: o.label, text: o.textHtml })),
    allowsMultiple: q.allowsMultiple, isPoll: q.isPoll === true,
    timeLimitSec: isSelfPaced(session) ? null : q.timeLimitSec, startedAt: timing?.startedAt ?? now, serverNow: now,
    ...(isSelfPaced(session) ? { deadlineAt: null, ...(timing?.firstOpenedAt !== undefined ? { firstOpenedAt: timing.firstOpenedAt } : {}) } : timing ? { deadlineAt: timing.deadlineAt, ...(timing.firstOpenedAt !== undefined ? { firstOpenedAt: timing.firstOpenedAt } : {}) }
      : q.timeLimitSec === null || isSlideType(getQuestionType(q)) ? { deadlineAt: null } : {}),
    ...questionPosition(quiz, index),
  };
};
const questionPayload = (session: Session, quiz: Quiz, now: number) => publicQuestionPayload(session, quiz, session.currentQuestionIndex, now);
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
const revealPayload = (session: Session, quiz: Quiz, view: ResponseView, now = Date.now()) => {
  const q = questionAt(session, quiz);
  if (view !== "control" && publicResultsHidden(session, now)) return null;
  return {
    questionIndex: session.currentQuestionIndex, questionType: getQuestionType(q),
    correctOptions: q.correctOptions, explanation: q.explanation,
    distribution: getDistribution(session, session.currentQuestionIndex), isPoll: q.isPoll === true,
    openResponses: isOpenResponseQuestion(q) && view !== "participant" ? responsesFor(getOpenResponses(session, session.currentQuestionIndex), view) : undefined,
  };
};
/** One student's own submissions, with option labels turned into option positions. */
export const ownAnswers = (session: Session, quiz: Quiz, studentId: string): StudentAnswer[] => session.submissions
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
/** Safe released-content projection. Adapters authenticate the seat before calling. */
export function participantStudyPayload(session: Session, quiz: Quiz, studentId: string, now: number): import("@mdq/shared").ParticipantStudyPayload {
  if (sessionAvailabilityPhase(session, now) === "deleted") return { availability: availabilityPayload(session, now), policy: null, items: [], currentQuestionIndex: -1, state: session.state, answers: [], answeredQuestions: [], answerableQuestionIndexes: [] };
  quiz = session.deckSnapshot ?? quiz;
  const items = releasedQuestionIndexes(session, quiz)
    .map(index => publicQuestionPayload(session, quiz, index, now))
    .filter((item): item is QuestionOpenPayload => item !== null);
  const answers = ownAnswers(session, quiz, studentId);
  const answeredQuestions = [...new Set(answers.map(answer => answer.questionIndex))];
  const answerableQuestionIndexes = items.filter(item => {
    if (sessionAvailabilityPhase(session, now) !== "active" || session.resultScope || session.state !== "QUESTION_OPEN" || isSlideType(item.questionType ?? "multiple_choice")
      || session.revealedQuestionIndexes?.has(item.questionIndex)) return false;
    if (!isSelfPaced(session) && item.questionIndex !== session.currentQuestionIndex) return false;
    if (item.deadlineAt != null && now >= item.deadlineAt) return false;
    return item.questionType === "open_response" || !answeredQuestions.includes(item.questionIndex);
  }).map(item => item.questionIndex);
  return { availability: availabilityPayload(session, now), policy: session.policy ?? null, items, currentQuestionIndex: session.currentQuestionIndex,
    state: session.state, answers, answeredQuestions, answerableQuestionIndexes };
}
/** Counts are hints for the confirmation, never a condition for finalization. */
export function endSessionAdvisory(session: Session, quiz: Quiz): import("@mdq/shared").EndSessionAdvisory {
  quiz = session.deckSnapshot ?? quiz;
  const released = new Set(quiz.questions.map((_, index) => index).filter(index => isQuestionReleased(session, index)));
  const available = [...released].filter(index => !isSlideType(getQuestionType(quiz.questions[index])));
  const answeredBySeat = new Map<string, Set<number>>();
  for (const answer of session.submissions) {
    const indexes = answeredBySeat.get(answer.studentId) ?? new Set<number>();
    indexes.add(answer.questionIndex); answeredBySeat.set(answer.studentId, indexes);
  }
  return {
    unfinishedParticipantCount: [...session.participants.values()].filter(seat => !seat.released && available.some(index => !answeredBySeat.get(seat.studentId)?.has(index))).length,
    // Legacy scoring intentionally retains its whole-deck scope, so do not promise exclusion.
    unshownQuestionCount: session.policy ? quiz.questions.filter((question, index) => !isSlideType(getQuestionType(question)) && !released.has(index)).length : 0,
  };
}

/** Seat authentication and retention are adapter responsibilities. Never reuse admin projections here. */
export function participantResultsPayload(session: Session, quiz: Quiz, studentId: string, now = Date.now()): import("@mdq/shared").ParticipantResultsPayload | null {
  if (session.state !== "ENDED" || publicResultsHidden(session, now) || (session.policy && session.resultScope?.disclosed !== true)) return null;
  const seat = session.participants.get(studentId);
  if (!seat || seat.released) return null;
  quiz = session.deckSnapshot ?? quiz;
  const own = new Map(ownAnswers(session, quiz, studentId).map(answer => [answer.questionIndex, answer]));
  const scored = scoredCorrectAnswersForSession(session, quiz);
  const endedAt = session.resultScope?.endedAt ?? session.endedAt ?? null;
  const questions = releasedQuestionIndexes(session, quiz).flatMap(index => {
    const q = quiz.questions[index];
    if (!q || isSlideType(getQuestionType(q))) return [];
    // Legacy result scope retains whole-deck scoring without inventing release history.
    const question = publicQuestionPayload(session, quiz, index, endedAt ?? session.createdAt);
    if (!question) return [];
    const answer = own.get(index) ?? null;
    const submission = session.submissions.find(s => s.studentId === studentId && s.questionIndex === index);
    return [{ question, answer, explanation: q.explanation, ...(scored.has(index) ? {
      correct: !!submission && isExactOptionMatch(submission.selectedOptions, scored.get(index)!),
      correctOptions: [...scored.get(index)!],
    } : {}) }];
  });
  const scoredQuestionCount = scored.size;
  const leaderboard = scoredQuestionCount ? leaderboardRows(session, quiz, "public", now).map(row => ({
    publicKey: row.publicKey, label: row.label, rank: row.rank, score: row.correctCount,
  })) : undefined;
  return { schemaVersion: 1, resultVersion: session.resultScope?.resultVersion ?? (session.policy ? 1 : 0), endedAt,
    deckTitle: quiz.title, policy: session.policy ? { ...session.policy } : null, publicKey: seat.publicKey,
    summary: { answeredCount: questions.filter(result => result.answer !== null).length, availableQuestionCount: questions.length,
      ...(scoredQuestionCount ? { scoredQuestionCount } : {}) }, questions, ...(leaderboard ? { leaderboard } : {}) };
}

/**
 * The ranked rows for one view. `public` rows name people by label and public
 * key only, so they are safe for phones and the projector.
 */
export function leaderboardRows(session: Session, quiz: Quiz, view: PayloadView, now = Date.now()): LeaderboardRow[] {
  if ((view === "public" && publicResultsHidden(session, now)) || (session.policy && !getSessionScoredQuestionCount(session, quiz))) return [];
  return computeLeaderboard(session, scoredCorrectAnswersForSession(session, quiz), effectiveRanking(session, quiz)).map((entry) => {
    const participant = session.participants.get(entry.studentId);
    const row = {
      rank: entry.rank, publicKey: participant?.publicKey ?? "", label: participant?.label ?? "",
      correctCount: entry.correctCount, ...(view === "control" || !session.policy || (session.policy?.schemaVersion === 1 && session.state !== "ENDED" && effectiveRanking(session, quiz) === "speed") ? { totalTimeMs: entry.totalTimeMs } : {}),
    };
    return view === "control" ? { ...row, studentId: entry.studentId, displayName: entry.displayName } : row;
  });
}
const leaderboardPayload = (session: Session, quiz: Quiz, view: PayloadView, now = Date.now()) => ({
  entries: leaderboardRows(session, quiz, view, now),
  totalQuestions: getSessionScoredQuestionCount(session, quiz),
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
  return !isSelfPaced(session) && session.state === "QUESTION_OPEN" && q && q.timeLimitSec !== null && !isSlideType(getQuestionType(q))
    ? timingFor(session, quiz)?.deadlineAt ?? null : null;
};

/** Calculate a session change without mutating its input or using a clock or transport. */
export function apply(input: Session, quiz: Quiz, command: Command, now: number): EngineResult {
  const session = clone(input);
  quiz = session.deckSnapshot ?? quiz;
  ensureParticipantIdentity(session);
  // Adopt only the known current legacy clock before navigating to another item.
  const restoredTiming = timingFor(session, quiz);
  if (restoredTiming) {
    session.questionTiming ??= {};
    session.questionTiming[String(session.currentQuestionIndex)] ??= restoredTiming;
  }
  if ((session.state === "REVEAL" || session.state === "LEADERBOARD") && session.currentQuestionIndex >= 0) {
    session.revealedQuestionIndexes ??= new Set<number>();
    session.revealedQuestionIndexes.add(session.currentQuestionIndex);
  }
  const messages: EngineMessage[] = [];
  let seatTaken: EngineResult["seatTaken"];
  const emit = (event: string, payload: unknown, audience: Audience = "all") => messages.push(message(event, payload, audience));
  // Open responses go out in full to control only; the projector gets the count, then the visible responses at reveal.
  const emitCount = () => {
    if (publicResultsHidden(session, now)) { emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz, "control"), "control"); return; }
    if (isOpenResponseQuestion(questionAt(session, quiz))) {
      emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz, "control"), "control");
      emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz, "display"), "display");
    } else emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz, "display"), "staff");
  };
  const emitReveal = () => {
    if (session.policy && !isQuestionReleased(session, session.currentQuestionIndex)) return;
    if (publicResultsHidden(session, now)) { emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "control", now), "control"); return; }
    if (isOpenResponseQuestion(questionAt(session, quiz))) {
      emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "control", now), "control");
      emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "display", now), "display");
      emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "participant", now), "participants");
    } else emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "display", now));
  };
  const emitLeaderboard = () => {
    if (session.policy && !getSessionScoredQuestionCount(session, quiz)) return;
    emit(SocketEvents.LEADERBOARD_UPDATE, leaderboardPayload(session, quiz, "control", now), "control");
    if (!publicResultsHidden(session, now)) emit(SocketEvents.LEADERBOARD_UPDATE, leaderboardPayload(session, quiz, "public", now), "public");
  };
  const emitParticipants = () => {
    emit(SocketEvents.SESSION_PARTICIPANTS, participantsPayload(session, "control"), "control");
    emit(SocketEvents.SESSION_PARTICIPANTS, participantsPayload(session, "public"), "display");
  };
  const openContext = () => {
    const payload = questionPayload(session, quiz, now);
    if (payload) emit(SocketEvents.QUESTION_OPEN, payload);
  };
  const state = (includeIndex = true) => {
    const payload = { ...(session.availability ? { availability: availabilityPayload(session, now) } : {}),
      ...(includeIndex ? { state: session.state, questionIndex: session.currentQuestionIndex } : { state: session.state }),
      ...(session.submissions.length > 0 ? { hasAnswers: true as const } : {}) };
    emit(SocketEvents.SESSION_STATE, payload);
    if (session.policy) emit(SocketEvents.SESSION_STATE, { ...payload, policy: session.policy, effectiveRanking: effectiveRanking(session, quiz) }, "control");
  };
  const review = () => {
    session.revealedQuestionIndexes ??= new Set<number>();
    session.revealedQuestionIndexes.add(session.currentQuestionIndex);
  };
  const preserveOpening = () => {
    const q = questionAt(session, quiz);
    if (!q) throw new EngineCommandError("Question not found.");
    session.questionTiming ??= {};
    const timing = session.questionTiming[String(session.currentQuestionIndex)] ??= {
      firstOpenedAt: now, startedAt: now,
      deadlineAt: isSelfPaced(session) || q.timeLimitSec === null || isSlideType(getQuestionType(q)) ? null : now + q.timeLimitSec * 1000,
      restarts: [],
    };
    if (session.policy) { session.releasedQuestionIndexes ??= new Set<number>(); session.releasedQuestionIndexes.add(session.currentQuestionIndex); }
    session.questionStartedAt = timing.startedAt;
    session.questionDeadlineAt = timing.deadlineAt;
    session.closedByTimer = false;
  };
  if (session.resultScope && ["configurePolicy", "start", "next", "previous", "open", "restartCountdown", "close", "reveal", "leaderboardShow", "leaderboardHide"].includes(command.type)) throw new EngineCommandError("Session has ended.");
  const availabilityPhase = sessionAvailabilityPhase(session, now);
  if (availabilityPhase === "deleted" && !["expireAvailability", "purgeAvailability", "snapshot", "join", "answerSubmit", "disconnect"].includes(command.type)) throw new EngineCommandError("Session data has been deleted.");
  if (availabilityPhase === "expired" && ["configurePolicy", "start", "next", "previous", "open", "restartCountdown", "close", "reveal", "leaderboardShow", "leaderboardHide", "releaseSeat"].includes(command.type)) throw new EngineCommandError("Availability ended. Extend & reopen or deliberately End to show results.");
  switch (command.type) {
    case "configureAvailability": {
      if (command.role !== "control") throw new EngineCommandError("Only the presenter can change availability.");
      if (session.state === "ENDED" || session.resultScope) throw new EngineCommandError("Ended sessions cannot be reopened.");
      if (!session.availability) throw new EngineCommandError("Legacy availability must be explicitly adopted by its adapter.");
      if (command.availableUntil !== undefined && command.extendForMs !== undefined) throw new EngineCommandError("Choose a duration or an exact deadline, not both.");
      if (command.extendForMs !== undefined && (!Number.isSafeInteger(command.extendForMs) || command.extendForMs < 60_000)) throw new EngineCommandError("Invalid availability duration.");
      const until = command.extendForMs !== undefined ? now + command.extendForMs : command.availableUntil;
      try { validateAvailabilityDeadline(until, now); } catch (error) { throw new EngineCommandError((error as Error).message); }
      if (until! <= session.availability.availableUntil) throw new EngineCommandError("The new deadline must be later than the previous deadline.");
      session.availability = { ...session.availability, availableUntil: until!, generation: session.availability.generation + 1 };
      emit(SocketEvents.SESSION_AVAILABILITY, availabilityPayload(session, now));
      state();
      break;
    }
    case "expireAvailability":
      if (command.alarm.phase !== "expire" || !availabilityAlarmMatches(session, command.alarm) || now < command.alarm.dueAt || availabilityPhase !== "expired") break;
      // Expiry is observational. No End, release, reward, or clock reset.
      emit(SocketEvents.SESSION_AVAILABILITY, availabilityPayload(session, now));
      state();
      break;
    case "purgeAvailability":
      if (command.alarm.phase !== "purge" || !availabilityAlarmMatches(session, command.alarm) || now < command.alarm.dueAt || availabilityPhase !== "deleted") break;
      session.deletedAt = now;
      session.participants.clear(); session.submissions = []; session.deckSnapshot = undefined;
      session.releasedQuestionIndexes?.clear(); session.revealedQuestionIndexes?.clear();
      session.questionTiming = undefined; session.hiddenResponses = undefined;
      session.questionStartedAt = undefined; session.questionDeadlineAt = undefined;
      emit(SocketEvents.SESSION_AVAILABILITY, availabilityPayload(session, now));
      break;
    case "configurePolicy":
      if (command.role !== "control") throw new EngineCommandError("Only the presenter can select the session policy.");
      if (session.state !== "LOBBY" || session.policyFrozen) throw new EngineCommandError("The session policy is frozen after Start.");
      if (!["presenter-paced", "self-paced"].includes(command.pacing)) throw new EngineCommandError("Invalid pacing policy.");
      if (command.ranking !== undefined) {
        if (session.policy?.schemaVersion !== 1 || !["correctness", "speed"].includes(command.ranking)
          || (command.pacing === "self-paced" && command.ranking === "speed")) throw new EngineCommandError("Invalid ranking policy. New sessions rank automatically.");
        session.policy = { schemaVersion: 1, pacing: command.pacing, ranking: command.ranking,
          effectiveTiming: command.pacing === "self-paced" ? "untimed" : "authored" };
      } else if (session.policy?.schemaVersion === 1) {
        session.policy = { ...session.policy, pacing: command.pacing,
          ranking: command.pacing === "self-paced" ? "correctness" : session.policy.ranking,
          effectiveTiming: command.pacing === "self-paced" ? "untimed" : "authored" };
      } else {
        session.policy = { ...defaultSessionPolicy(), pacing: command.pacing,
          effectiveTiming: command.pacing === "self-paced" ? "untimed" : "authored" };
      }
      session.releasedQuestionIndexes ??= new Set<number>();
      break;
    case "start":
      if (session.state !== "LOBBY") throw new EngineCommandError("The session has already started.");
      transition(session, "QUESTION_OPEN");
      if (session.policy) { session.policyFrozen = true; session.deckSnapshot = JSON.parse(JSON.stringify(quiz)) as Quiz; quiz = session.deckSnapshot; }
      session.currentQuestionIndex = 0;
      preserveOpening();
      openContext(); state();
      if (!isSlideType(getQuestionType(questionAt(session, quiz)))) emitCount();
      break;
    case "previous": {
      const prev = session.currentQuestionIndex - 1;
      if (session.state === "LOBBY") throw new EngineCommandError("Start the session before going back.");
      if (session.state === "ENDED") throw new EngineCommandError("Session has ended.");
      if (prev < 0) throw new EngineCommandError("Already at the first item");
      session.currentQuestionIndex = prev;
      session.state = isSelfPaced(session) || isSlideType(getQuestionType(questionAt(session, quiz))) ? "QUESTION_OPEN" : "REVEAL";
      if (session.state === "QUESTION_OPEN") {
        preserveOpening();
        openContext(); state();
      } else {
        session.questionStartedAt = session.questionTiming?.[String(prev)]?.startedAt;
        session.questionDeadlineAt = session.questionTiming?.[String(prev)]?.deadlineAt;
        review(); openContext(); emitReveal(); state();
      }
      break;
    }
    case "next": {
      const next = session.currentQuestionIndex + 1;
      if (next >= quiz.questions.length) throw new EngineCommandError("No more questions");
      if (session.state === "LOBBY") throw new EngineCommandError("Start the session before advancing.");
      if (session.state === "ENDED") throw new EngineCommandError("Session has ended.");
      if (isSelfPaced(session)) session.state = "QUESTION_OPEN";
      else if (session.state === "QUESTION_OPEN") {
        if (!isSlideType(getQuestionType(questionAt(session, quiz)))) throw new EngineCommandError("Close and reveal the current question before advancing.");
      } else transition(session, "QUESTION_OPEN");
      session.currentQuestionIndex = next;
      if (!isSelfPaced(session) && !isSlideType(getQuestionType(questionAt(session, quiz))) && session.revealedQuestionIndexes?.has(next)) session.state = "REVEAL";
      if (session.state === "QUESTION_OPEN") {
        preserveOpening(); openContext(); state();
        if (!isSlideType(getQuestionType(questionAt(session, quiz)))) emitCount();
      } else {
        session.questionStartedAt = session.questionTiming?.[String(next)]?.startedAt;
        session.questionDeadlineAt = session.questionTiming?.[String(next)]?.deadlineAt;
        openContext(); emitReveal(); state();
      }
      break;
    }
    case "open":
      if (session.policy && session.state === "LOBBY") { session.policyFrozen = true; session.deckSnapshot = JSON.parse(JSON.stringify(quiz)) as Quiz; quiz = session.deckSnapshot; }
      if (session.state === "REVEAL" || session.revealedQuestionIndexes?.has(session.currentQuestionIndex)) {
        throw new EngineCommandError("Revealed questions cannot be reopened.");
      }
      transition(session, "QUESTION_OPEN");
      if (session.currentQuestionIndex < 0) session.currentQuestionIndex = 0;
      preserveOpening();
      openContext(); state();
      if (!isSlideType(getQuestionType(questionAt(session, quiz)))) emitCount();
      break;
    case "restartCountdown": {
      if (command.role !== "control") throw new EngineCommandError("Only the presenter can restart the countdown.");
      const q = questionAt(session, quiz);
      if (isSelfPaced(session) || session.state !== "QUESTION_OPEN" || !q || isSlideType(getQuestionType(q)) || q.timeLimitSec === null
        || !Number.isFinite(q.timeLimitSec) || q.timeLimitSec <= 0
        || session.revealedQuestionIndexes?.has(session.currentQuestionIndex)) {
        throw new EngineCommandError("Only an open, unrevealed timed question can restart its countdown.");
      }
      const timing = timingFor(session, quiz);
      if (!timing) throw new EngineCommandError("The original countdown timing is unavailable.");
      const due = deadline(session, quiz);
      if (due !== null && now >= due) throw new EngineCommandError("The question deadline has passed; its countdown cannot restart.");
      timing.restarts.push({ restartedAt: now, previousStartedAt: timing.startedAt, previousDeadlineAt: timing.deadlineAt });
      timing.startedAt = now;
      timing.deadlineAt = now + q.timeLimitSec * 1000;
      timing.timingFairnessInvalidated = true;
      session.questionTiming ??= {};
      session.questionTiming[String(session.currentQuestionIndex)] = timing;
      session.questionStartedAt = now;
      session.questionDeadlineAt = timing.deadlineAt;
      openContext(); state(); emitCount();
      break;
    }
    case "close":
    case "timeout":
      if (command.type === "timeout" && availabilityPhase !== "active") break;
      if (isSelfPaced(session)) { if (command.type === "timeout") break; throw new EngineCommandError("Self-paced answers stay open until End."); }
      if (command.type === "close" && isSlideType(getQuestionType(questionAt(session, quiz)))) throw new EngineCommandError("Slides do not close; advance to the next item.");
      if (command.type === "timeout") {
        const due = deadline(session, quiz);
        const timing = timingFor(session, quiz);
        // An alarm set for an earlier question or opening carries a different deadline and is ignored.
        if (due === null || (command.deadline !== undefined && command.deadline !== due) || now < due
          || (command.questionIndex !== undefined && command.questionIndex !== session.currentQuestionIndex)
          || (command.startedAt !== undefined && command.startedAt !== timing?.startedAt)
          || (command.restartCount !== undefined && command.restartCount !== timing?.restarts.length)) break;
      }
      transition(session, "QUESTION_CLOSED");
      session.closedByTimer = command.type === "timeout";
      emit(SocketEvents.QUESTION_CLOSE, closePayload(session)); state();
      emit(SocketEvents.RESULTS_DISTRIBUTION, { questionIndex: session.currentQuestionIndex, distribution: getDistribution(session, session.currentQuestionIndex) }, publicResultsHidden(session, now) ? "control" : "staff");
      break;
    case "reveal":
      if (isSelfPaced(session)) throw new EngineCommandError("Self-paced results remain hidden until End.");
      if (isSlideType(getQuestionType(questionAt(session, quiz)))) throw new EngineCommandError("Slides do not reveal answers; advance to the next item.");
      transition(session, "REVEAL"); review();
      openContext(); emitReveal(); state();
      break;
    case "end":
      // Terminal old records without a scope must not acquire invented history or disclosure on retry.
      if (session.state === "ENDED" || session.resultScope) break;
      if (session.policy) {
        session.resultScope = { schemaVersion: 1, resultVersion: 1, releasedQuestionIndexes: releasedQuestionIndexes(session, quiz),
          scoredQuestionIndexes: [...scoredCorrectAnswersForSession(session, quiz).keys()], endedAt: now, disclosed: command.discloseResults !== false };
        session.policyFrozen = true;
        session.state = "ENDED";
        // Final scoreboard is public-safe; HTTP own results also recover a missed terminal event.
        if (session.resultScope.disclosed) emitLeaderboard();
        state(false);
        break;
      }
      session.endedAt = now; session.resultsDisclosed = command.discloseResults !== false;
      if (session.state === "QUESTION_CLOSED") transition(session, "REVEAL");
      if (session.state === "REVEAL") transition(session, "LEADERBOARD");
      transition(session, "ENDED"); state(false);
      break;
    case "leaderboardShow":
      if (isSelfPaced(session)) { emitLeaderboard(); break; }
      if (session.state === "QUESTION_CLOSED") transition(session, "REVEAL");
      transition(session, "LEADERBOARD");
      review();
      emitLeaderboard(); state(false);
      break;
    case "leaderboardHide":
      if (isSelfPaced(session)) break;
      if (session.currentQuestionIndex >= quiz.questions.length - 1) break;
      transition(session, "REVEAL");
      review();
      openContext(); emitReveal(); state();
      break;
    case "join": {
      const { payload, socketId } = command;
      const reject = (reason: string) => emit(SocketEvents.STUDENT_REJECTED, { reason }, `participant:${socketId}`);
      if (availabilityPhase === "deleted") { reject("Session data has been deleted"); break; }
      if (session.state === "ENDED" || session.resultScope) { reject("Session has ended"); break; }
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
        if (availabilityPhase === "expired" && (!validToken || existing.released)) { reject("Availability ended. Valid existing seat credentials are required."); break; }
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
        if (availabilityPhase !== "active") { reject("Availability ended. No new seats are available."); break; }
        // A new seat is what a lock refuses; every rejoin above got through.
        if (session.joinLocked) { reject(JOIN_LOCKED_MESSAGE); break; }
        const { label, labelNote } = assignLabel(session, typedName);
        participant = { studentId: id, displayName: usesIds ? typedName || undefined : id,
          publicKey: command.newPublicKey ?? newPublicKey(), label, labelNote,
          sessionToken: command.newToken, clientInstanceId: payload.clientInstanceId, socketId, joinedAt: now, connected: true };
        session.participants.set(participant.studentId, participant);
      }
      emit(SocketEvents.STUDENT_JOINED, { participantId: participant.studentId, sessionToken: participant.sessionToken,
        sessionState: session.state, ...(session.availability ? { availability: availabilityPayload(session, now) } : {}), currentQuestion: session.currentQuestionIndex >= 0 ? session.currentQuestionIndex : undefined,
        answeredQuestions: getAnsweredQuestions(session, participant.studentId), answers: ownAnswers(session, quiz, participant.studentId),
        publicKey: participant.publicKey, label: participant.label, labelNote: participant.labelNote,
        ...(quiz.title ? { deckTitle: quiz.title } : {}) }, `participant:${participant.studentId}`);
      emitParticipants();
      if (session.state === "QUESTION_OPEN" && session.currentQuestionIndex >= 0 && !isSlideType(getQuestionType(questionAt(session, quiz)))) emitCount();
      messages.push(...snapshotMessages(session, quiz, now, `participant:${participant.studentId}`, "participant", isReconnect));
      break;
    }
    case "answerSubmit": {
      const { payload, studentId, sessionToken } = command;
      const target: Audience = `participant:${studentId || ""}`;
      const reject = (reason: string) => emit(SocketEvents.ANSWER_REJECTED, { questionIndex: payload.questionIndex, reason }, target);
      if (availabilityPhase !== "active") { reject(availabilityPhase === "expired" ? "Availability ended" : availabilityPhase === "ended" ? "Session has ended" : "Session data has been deleted"); break; }
      if (!studentId) { reject("Not joined to a session"); break; }
      if (session.resultScope) { reject("Session has ended"); break; }
      const seat = session.participants.get(studentId);
      if (seat && ((session.policy && !sessionToken) || (sessionToken !== undefined && sessionToken !== seat.sessionToken))) { reject(SEAT_IN_USE_MESSAGE); break; }
      if (!isSelfPaced(session) && payload.questionIndex !== session.currentQuestionIndex) { reject(`Question index mismatch: expected ${session.currentQuestionIndex}, got ${payload.questionIndex}.`); break; }
      const q = quiz.questions[payload.questionIndex];
      if (!q) { reject(`Question ${session.currentQuestionIndex + 1} not found.`); break; }
      if (session.policy && !isQuestionReleased(session, payload.questionIndex)) { reject("This question has not been released."); break; }
      if (session.revealedQuestionIndexes?.has(payload.questionIndex)) { reject("Revealed questions do not accept answers."); break; }
      if (isSlideType(getQuestionType(q))) { reject("Slides do not accept answers."); break; }
      const options = payload.selectedOptions || [];
      const responseText = payload.responseText?.trim();
      if (isOpenResponseQuestion(q)) {
        if (options.length) { reject("Open response questions accept text responses only."); break; }
        if (!responseText) { reject("Response text cannot be blank."); break; }
        if ([...responseText].length > MAX_OPEN_RESPONSE_LENGTH) { reject(`Please use up to ${MAX_OPEN_RESPONSE_LENGTH} characters.`); break; }
      } else {
        if (options.some((label) => !q.options.some((option) => option.label === label))) { reject("An option is not part of this question."); break; }
        if (!q.allowsMultiple && options.length > 1) { reject("This question accepts one answer only."); break; }
        if (!options.length) { reject("At least one option must be selected."); break; }
      }
      if (session.state !== "QUESTION_OPEN") { reject("Submissions only accepted during QUESTION_OPEN state."); break; }
      const due = deadline(session, quiz);
      if (due !== null && now >= due) { reject("The question deadline has passed."); break; }
      if (!session.participants.has(studentId)) { reject(`Student "${studentId}" is not a participant in this session.`); break; }
      const existing = session.submissions.find((s) => s.studentId === studentId && s.questionIndex === payload.questionIndex);
      if (existing && !isOpenResponseQuestion(q)) { reject("Already submitted an answer for this question."); break; }
      const submission = { studentId, questionIndex: payload.questionIndex,
        selectedOptions: [...new Set(options)].sort(), responseText: responseText || undefined,
        submittedAt: now, responseTimeMs: timingFor(session, quiz, payload.questionIndex)?.startedAt !== undefined ? now - timingFor(session, quiz, payload.questionIndex)!.startedAt : 0 };
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
          emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "control", now), "control");
          if (!publicResultsHidden(session, now)) emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, "display", now), "display");
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
      if (session.state === "QUESTION_OPEN" && session.currentQuestionIndex >= 0 && !isSlideType(getQuestionType(questionAt(session, quiz)))) emitCount();
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
        if (session.state === "QUESTION_OPEN" && session.currentQuestionIndex >= 0 && !isSlideType(getQuestionType(questionAt(session, quiz)))) emitCount();
      }
      break;
    }
    case "snapshot":
      messages.push(...command.participantId
        ? snapshotMessages(session, quiz, now, `participant:${command.participantId}`, "participant", !!command.isReconnect)
        : snapshotMessages(session, quiz, now, command.view === "display" ? "display" : "control", command.view === "display" ? "display" : "control", !!command.isReconnect));
      break;
    case "broadcastOpen":
      openContext(); state();
      if (!isSlideType(getQuestionType(questionAt(session, quiz)))) emitCount();
      break;
    case "broadcastReveal":
      openContext(); emitReveal(); state();
      break;
    case "broadcastLeaderboard":
      emitLeaderboard(); state(false);
      break;
    case "participants": emitParticipants(); break;
    case "repairClosedSlide":
      if (availabilityPhase !== "active") break;
      if (session.state === "QUESTION_CLOSED" && isSlideType(getQuestionType(questionAt(session, quiz)))) {
        session.state = "QUESTION_OPEN";
        openContext(); state();
      }
      break;
    case "tick": if (availabilityPhase === "active" && !isSelfPaced(session)) emit(SocketEvents.QUESTION_TICK, { remainingSec: command.remainingSec }); break;
  }
  const nextDeadline = sessionAvailabilityPhase(session, now) === "active" ? deadline(session, quiz) : null;
  const nextTiming = timingFor(session, quiz);
  const nextAlarm = nextDeadline !== null && nextTiming ? { questionIndex: session.currentQuestionIndex,
    startedAt: nextTiming.startedAt, deadlineAt: nextDeadline, restartCount: nextTiming.restarts.length } : null;
  return { session, messages, nextDeadline, nextAlarm, nextAvailabilityAlarm: nextAvailabilityAlarm(session, now), ...(seatTaken ? { seatTaken } : {}) };
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
  const emitCount = () => { if (view === "control" || !publicResultsHidden(session, now)) emit(SocketEvents.ANSWER_COUNT, countPayload(session, quiz, view)); };
  if (session.availability) emit(SocketEvents.SESSION_AVAILABILITY, availabilityPayload(session, now));
  if (sessionAvailabilityPhase(session, now) === "deleted") return messages;
  if (staff) emit(SocketEvents.SESSION_STATE, { ...(session.availability ? { availability: availabilityPayload(session, now) } : {}), state: session.state, questionIndex: session.currentQuestionIndex >= 0 ? session.currentQuestionIndex : undefined,
    ...(session.submissions.length > 0 ? { hasAnswers: true } : {}),
    ...(view === "control" && session.policy ? { policy: session.policy, effectiveRanking: effectiveRanking(session, quiz) } : {}) });
  const q = questionAt(session, quiz);
  const payload = questionPayload(session, quiz, now);
  if (!q || !payload) return messages;
  if (view !== "control" && sessionAvailabilityPhase(session, now) === "expired") {
    emit(SocketEvents.QUESTION_OPEN, payload);
    return messages;
  }
  if (session.state === "QUESTION_OPEN") {
    emit(SocketEvents.QUESTION_OPEN, payload);
    const due = deadline(session, quiz);
    if (due !== null) emit(SocketEvents.QUESTION_TICK, { remainingSec: Math.max(0, Math.ceil((due - now) / 1000)) });
    if (staff && !isSlideType(getQuestionType(q))) emitCount();
  } else if (session.state === "QUESTION_CLOSED") {
    emit(SocketEvents.QUESTION_OPEN, payload);
    emit(SocketEvents.QUESTION_CLOSE, closePayload(session));
    if (staff) {
      if (view === "control" || !publicResultsHidden(session, now)) emit(SocketEvents.RESULTS_DISTRIBUTION, { questionIndex: session.currentQuestionIndex, distribution: getDistribution(session, session.currentQuestionIndex) });
      emitCount();
    }
  } else if (session.state === "REVEAL" && (staff || isReconnect)) {
    emit(SocketEvents.QUESTION_OPEN, payload);
    if (view === "control" || !publicResultsHidden(session, now)) emit(SocketEvents.RESULTS_REVEAL, revealPayload(session, quiz, view, now));
    if (staff) emitCount();
  } else if (session.state === "LEADERBOARD" && (view === "control" || !publicResultsHidden(session, now)) && (!session.policy || getSessionScoredQuestionCount(session, quiz) > 0)) emit(SocketEvents.LEADERBOARD_UPDATE, leaderboardPayload(session, quiz, payloadView, now));
  return messages;
}
