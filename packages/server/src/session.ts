import { availabilityPayload, sessionAvailabilityPhase } from "./availability";
import { isSlideType, parseDeckPalette } from "@mdq/shared";
import {
  Session,
  SessionState,
  SessionMode,
  Participant,
  Submission,
  OpenResponseEntry,
  Quiz,
  STATE_TRANSITIONS,
  SESSION_CODE_LENGTH,
  normalizeDisplayName,
  DEFAULT_SESSION_AVAILABILITY_MS,
} from "@mdq/shared";
import { defaultSessionPolicy } from "./policy";
import { assignLabel, ensureParticipantIdentity, newPublicKey } from "./identity";

/** Error for invalid state transitions */
export class StateTransitionError extends Error {
  constructor(
    public readonly from: SessionState,
    public readonly to: SessionState,
  ) {
    super(`Invalid transition: ${from} -> ${to}. Allowed: [${STATE_TRANSITIONS[from].join(", ")}]`);
    this.name = "StateTransitionError";
  }
}

/** Generate a random alphanumeric session code */
function generateSessionCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1 to avoid confusion
  const randomBytes = crypto.getRandomValues(new Uint8Array(SESSION_CODE_LENGTH));
  let code = "";
  for (let i = 0; i < SESSION_CODE_LENGTH; i++) {
    code += chars.charAt(randomBytes[i] % chars.length);
  }
  return code;
}

/** Convert a live session to JSON while preserving maps, sets, and explicit undefined fields. */
export function serializeSession(session: Session): string {
  return JSON.stringify(session, (_key, value: unknown) => {
    if (value instanceof Map) {
      return { __mdqSessionType: "Map", entries: [...value.entries()] };
    }
    if (value instanceof Set) {
      return { __mdqSessionType: "Set", values: [...value.values()] };
    }
    if (value === undefined) {
      return { __mdqSessionType: "Undefined" };
    }
    return value;
  });
}

function restoreSessionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(restoreSessionValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.__mdqSessionType === "Map") {
    return new Map((record.entries as [unknown, unknown][]).map(
      ([key, entry]) => [restoreSessionValue(key), restoreSessionValue(entry)],
    ));
  }
  if (record.__mdqSessionType === "Set") {
    return new Set((record.values as unknown[]).map(restoreSessionValue));
  }
  if (record.__mdqSessionType === "Undefined") {
    return undefined;
  }

  const restored: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    restored[key] = restoreSessionValue(entry);
  }
  return restored;
}

/** Restore a session previously returned by serializeSession. */
export function deserializeSession(json: string): Session {
  const session = restoreSessionValue(JSON.parse(json)) as Session;
  // Frozen decks saved before palette retirement must use the same fallback
  // as newly parsed decks, without changing their saved source or progress.
  if (session.deckSnapshot) {
    const palette = parseDeckPalette(session.deckSnapshot.palette);
    if (palette) session.deckSnapshot.palette = palette;
  }
  // A session saved before public keys and labels existed gets them now.
  ensureParticipantIdentity(session);
  return session;
}

/** Expired sessions reserve their same code until actual deletion. */
function unreservedSessionCode(): string {
  let code = generateSessionCode();
  while (sessionCodeIndex.has(code)) code = generateSessionCode();
  return code;
}

/** Create a new Session in LOBBY state */
export function createSession(week: string, mode: SessionMode): Session {
  const now = Date.now();
  return {
    availability: { schemaVersion: 1, availableUntil: now + DEFAULT_SESSION_AVAILABILITY_MS, generation: 1 },
    policy: defaultSessionPolicy(),
    policyFrozen: false,
    releasedQuestionIndexes: new Set<number>(),
    sessionId: crypto.randomUUID(),
    sessionCode: unreservedSessionCode(),
    week,
    mode,
    state: "LOBBY",
    currentQuestionIndex: -1,
    revealedQuestionIndexes: new Set<number>(),
    participants: new Map<string, Participant>(),
    submissions: [],
    openResponsesHiddenByDefault: true,
    createdAt: now,
  };
}

/**
 * Transition a session to the next state.
 * Throws StateTransitionError if the transition is invalid.
 */
export function transitionState(session: Session, to: SessionState): void {
  const allowed = STATE_TRANSITIONS[session.state];
  if (!allowed.includes(to)) {
    throw new StateTransitionError(session.state, to);
  }
  session.state = to;
}

/**
 * Repair the impossible state produced when an expired question timer closes a
 * slide after the instructor has navigated away from the timed question.
 */
export function repairClosedSlideState(session: Session, quiz: Quiz): boolean {
  const currentQuestion = quiz.questions[session.currentQuestionIndex];
  if (session.state !== "QUESTION_CLOSED" || !isSlideType(currentQuestion?.questionType)) {
    return false;
  }

  session.state = "QUESTION_OPEN";
  return true;
}

/**
 * Add a participant to the session.
 * Returns the participant and whether this is a reconnection.
 */
export function addParticipant(
  session: Session,
  studentId: string,
  socketId: string,
  displayName?: string,
  sessionToken?: string,
  clientInstanceId?: string,
): { participant: Participant; isReconnect: boolean } {
  const phase = sessionAvailabilityPhase(session, Date.now());
  const existing = session.participants.get(studentId);
  if (phase === "ended" || phase === "deleted") throw new Error("Session has ended or been deleted.");
  if (phase === "expired" && (!existing || existing.released || !sessionToken || sessionToken !== existing.sessionToken)) throw new Error("Availability ended. Valid existing seat credentials are required.");

  if (existing) {
    // Reconnect attempt: validate token
    if (sessionToken && sessionToken === existing.sessionToken) {
      // Valid reconnect
      existing.socketId = socketId;
      existing.connected = true;
      if (displayName) {
        existing.displayName = displayName;
      }
      if (clientInstanceId) {
        existing.clientInstanceId = clientInstanceId;
      }
      return { participant: existing, isReconnect: true };
    }

    // Token-less reconnect fallback for same browser client only.
    // This supports page-close/QR-rescan rejoin while blocking ID takeover.
    if (
      !existing.connected
      && clientInstanceId
      && existing.clientInstanceId
      && clientInstanceId === existing.clientInstanceId
    ) {
      existing.socketId = socketId;
      existing.connected = true;
      if (displayName) {
        existing.displayName = displayName;
      }
      return { participant: existing, isReconnect: true };
    }

    // Different token or no token: conflict
    throw new Error(
      `Participant ID "${studentId}" is already in use with a different session token.`,
    );
  }

  // New participant
  const { label, labelNote } = assignLabel(session, normalizeDisplayName(displayName));
  const participant: Participant = {
    studentId,
    displayName,
    publicKey: newPublicKey(),
    label,
    labelNote,
    sessionToken: crypto.randomUUID(),
    clientInstanceId,
    socketId,
    joinedAt: Date.now(),
    connected: true,
  };
  session.participants.set(studentId, participant);
  return { participant, isReconnect: false };
}

/**
 * Record a submission. Returns true if accepted, throws if rejected.
 */
export function recordSubmission(
  session: Session,
  studentId: string,
  questionIndex: number,
  response: { selectedOptions?: string[]; responseText?: string } | string[],
): Submission {
  if (sessionAvailabilityPhase(session, Date.now()) !== "active") throw new Error("Availability ended or session has ended.");
  if (session.policy) throw new Error("Versioned sessions require the authenticated answerSubmit engine command.");
  const normalizedSelectedOptions = normalizeOptionSet(Array.isArray(response) ? response : (response.selectedOptions || []));
  const normalizedResponseText = normalizeResponseText(Array.isArray(response) ? undefined : response.responseText);
  const isOpenResponseSubmission = normalizedSelectedOptions.length === 0 && typeof normalizedResponseText === "string";

  if (session.state !== "QUESTION_OPEN") {
    throw new Error("Submissions only accepted during QUESTION_OPEN state.");
  }
  if (questionIndex !== session.currentQuestionIndex) {
    throw new Error(
      `Question index mismatch: expected ${session.currentQuestionIndex}, got ${questionIndex}.`,
    );
  }
  if (session.revealedQuestionIndexes?.has(questionIndex)) {
    throw new Error("Revealed questions do not accept answers.");
  }
  if (normalizedSelectedOptions.length === 0 && !normalizedResponseText) {
    throw new Error("A response is required.");
  }
  if (!session.participants.has(studentId)) {
    throw new Error(`Student "${studentId}" is not a participant in this session.`);
  }

  const now = Date.now();
  const timing = session.questionTiming?.[String(questionIndex)];
  const deadline = timing ? timing.deadlineAt : session.questionDeadlineAt;
  if (deadline !== undefined && deadline !== null && now >= deadline) {
    throw new Error("The question deadline has passed.");
  }
  const existingSubmission = session.submissions.find(
    (s) => s.studentId === studentId && s.questionIndex === questionIndex,
  );

  if (existingSubmission) {
    if (!isOpenResponseSubmission) {
      throw new Error("Already submitted an answer for this question.");
    }

    existingSubmission.selectedOptions = [];
    existingSubmission.responseText = normalizedResponseText;
    existingSubmission.submittedAt = now;
    existingSubmission.responseTimeMs = session.questionStartedAt !== undefined ? now - session.questionStartedAt : 0;
    return existingSubmission;
  }

  const submission: Submission = {
    studentId,
    questionIndex,
    selectedOptions: normalizedSelectedOptions,
    responseText: normalizedResponseText,
    submittedAt: now,
    responseTimeMs: session.questionStartedAt !== undefined ? now - session.questionStartedAt : 0,
  };
  session.submissions.push(submission);
  return submission;
}

/**
 * Get the answer distribution for a question.
 */
export function getDistribution(
  session: Session,
  questionIndex: number,
): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const sub of session.submissions) {
    if (sub.questionIndex === questionIndex) {
      for (const opt of sub.selectedOptions) {
        dist[opt] = (dist[opt] || 0) + 1;
      }
    }
  }
  return dist;
}

/** Whether the presenter has hidden this participant's response to a question from the projector. */
export function isResponseHidden(session: Session, questionIndex: number, publicKey: string): boolean {
  if (session.openResponsesHiddenByDefault === true) {
    return session.shownResponses?.[String(questionIndex)]?.includes(publicKey) !== true;
  }
  return session.hiddenResponses?.[String(questionIndex)]?.includes(publicKey) === true;
}

/** Every open response to a question, newest first, each marked hidden or not. Instructor data: it carries IDs. */
export function getOpenResponses(
  session: Session,
  questionIndex: number,
): OpenResponseEntry[] {
  return session.submissions
    .filter((sub) => sub.questionIndex === questionIndex && typeof sub.responseText === "string" && sub.responseText.length > 0)
    .map((sub) => ({
      publicKey: session.participants.get(sub.studentId)?.publicKey ?? "",
      label: session.participants.get(sub.studentId)?.label ?? "",
      studentId: sub.studentId,
      displayName: session.participants.get(sub.studentId)?.displayName,
      responseText: sub.responseText!,
      submittedAt: sub.submittedAt,
    }))
    .map((entry) => ({ ...entry, hidden: isResponseHidden(session, questionIndex, entry.publicKey) }))
    .sort((a, b) => b.submittedAt - a.submittedAt || (a.publicKey < b.publicKey ? -1 : a.publicKey > b.publicKey ? 1 : 0));
}

/**
 * Get the submission count for a question.
 */
export function getSubmissionCount(
  session: Session,
  questionIndex: number,
): { submitted: number; total: number } {
  const submitted = session.submissions.filter(
    (s) => s.questionIndex === questionIndex,
  ).length;
  const total = countConnectedParticipants(session);
  return { submitted, total };
}

/**
 * Count connected participants.
 */
export function countConnectedParticipants(session: Session): number {
  let count = 0;
  for (const p of session.participants.values()) {
    if (p.connected) count++;
  }
  return count;
}

/**
 * Get questions answered by a specific student.
 */
export function getAnsweredQuestions(session: Session, studentId: string): number[] {
  return session.submissions
    .filter((s) => s.studentId === studentId)
    .map((s) => s.questionIndex);
}

function normalizeOptionSet(options: string[]): string[] {
  return [...new Set(options)].sort();
}

function normalizeResponseText(responseText?: string): string | undefined {
  const trimmed = responseText?.trim();
  return trimmed ? trimmed : undefined;
}

export function isExactOptionMatch(selectedOptions: string[], correctOptions: string[]): boolean {
  const selected = normalizeOptionSet(selectedOptions);
  const correct = normalizeOptionSet(correctOptions);

  return selected.length === correct.length && selected.every((option, index) => option === correct[index]);
}

/**
 * Compute leaderboard for a session given correct answers per question.
 */
export function computeLeaderboard(
  session: Session,
  correctAnswersMap: Map<number, string[]>,
  ranking: "correctness" | "speed" | "legacy" = session.policy ? "correctness" : "legacy",
): { rank: number; studentId: string; displayName?: string; correctCount: number; totalTimeMs: number }[] {
  const studentStats = new Map<
    string,
    { correctCount: number; totalTimeMs: number; displayName?: string }
  >();

  // Initialize all participants
  for (const [studentId, participant] of session.participants) {
    studentStats.set(studentId, {
      correctCount: 0,
      totalTimeMs: 0,
      displayName: participant.displayName,
    });
  }

  // Tally correct answers and times
  for (const sub of session.submissions) {
    const correct = correctAnswersMap.get(sub.questionIndex);
    if (!correct) continue;

    const stats = studentStats.get(sub.studentId);
    if (!stats) continue;

    const isCorrect = isExactOptionMatch(sub.selectedOptions, correct);

    if (isCorrect) {
      stats.correctCount++;
      stats.totalTimeMs += sub.responseTimeMs;
    }
  }

  // Sort: correct count desc, then total time asc, then studentId asc (deterministic tie-break)
  const entries = [...studentStats.entries()]
    .map(([studentId, stats]) => ({
      rank: 0,
      studentId,
      displayName: stats.displayName,
      correctCount: stats.correctCount,
      totalTimeMs: stats.totalTimeMs,
    }))
    .sort((a, b) => {
      if (b.correctCount !== a.correctCount) return b.correctCount - a.correctCount;
      if (ranking !== "correctness" && a.totalTimeMs !== b.totalTimeMs) return a.totalTimeMs - b.totalTimeMs;
      return a.studentId.localeCompare(b.studentId);
    });

  // Assign ranks
  entries.forEach((entry, i) => {
    const previous = entries[i - 1];
    entry.rank = ranking !== "legacy" && previous && previous.correctCount === entry.correctCount
      && (ranking === "correctness" || previous.totalTimeMs === entry.totalTimeMs) ? previous.rank : i + 1;
  });

  return entries;
}

// ── In-memory session store ─────────────────

const sessionStore = new Map<string, Session>();
const sessionCodeIndex = new Map<string, string>(); // code -> sessionId

export function storeSession(session: Session): void {
  sessionStore.set(session.sessionId, session);
  sessionCodeIndex.set(session.sessionCode, session.sessionId);
}

export function getSession(sessionId: string): Session | undefined {
  return sessionStore.get(sessionId);
}

export function getSessionByCode(code: string): Session | undefined {
  const id = sessionCodeIndex.get(code);
  return id ? sessionStore.get(id) : undefined;
}

export function getActiveSessions(): { sessionId: string; sessionCode: string; state: string; availability: import("@mdq/shared").SessionAvailabilityPayload }[] {
  const results: { sessionId: string; sessionCode: string; state: string; availability: import("@mdq/shared").SessionAvailabilityPayload }[] = [];
  for (const session of sessionStore.values()) {
    if (session.state !== "ENDED" && sessionAvailabilityPhase(session, Date.now()) !== "deleted") {
      results.push({ sessionId: session.sessionId, sessionCode: session.sessionCode, state: session.state, availability: availabilityPayload(session, Date.now()) });
    }
  }
  return results;
}

/** Remove only the exact stored identity, so stale purges cannot delete a replacement. */
export function deleteSession(session: Session): boolean {
  if (sessionStore.get(session.sessionId) !== session) return false;
  sessionStore.delete(session.sessionId);
  if (sessionCodeIndex.get(session.sessionCode) === session.sessionId) sessionCodeIndex.delete(session.sessionCode);
  return true;
}
export function clearAllSessions(): void {
  sessionStore.clear();
  sessionCodeIndex.clear();
}
