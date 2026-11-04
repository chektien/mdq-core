import { useSessionAvailability } from "./useSessionAvailability";
import { isSlideType } from "@mdq/shared";
import { hasResultsAnswers, updateResultsEvidence, type ResultsEvidence } from "../instructorResults";
import { io, type Socket } from "socket.io-client";
import { useState, useEffect, useCallback, useRef } from "react";
import type {
  SessionState,
  SessionPolicy,
  SessionAvailabilityPayload,
  StudentJoinedPayload,
  QuestionOpenPayload,
  QuestionTickPayload,
  QuestionClosePayload,
  AnswerCountPayload,
  ResultsRevealPayload,
  ResultsDistributionPayload,
  PollLivePayload,
  LeaderboardUpdatePayload,
  SessionStatePayload,
  SessionParticipantsPayload,
  LeaderboardRow,
  QuestionType,
  OpenResponseEntry,
  FoldoutNote,
  AnswerSubmitPayload,
  AnswerAcceptedPayload,
  MediaPosition,
  SlideMedia,
  SlideBackground,
  SlideLiveEmbed,
  SlideVideo,
  SlideReference,
  DeckStyle,
  StudentAnswer,
} from "@mdq/shared";
import { SocketEvents } from "@mdq/shared";
import { clockOffsetFromTick, localRemainingSec } from "../countdown";
import { type SubmittedAnswer, shouldReplaceAcceptedAnswer, isLaterAttempt, mergeOwnAnswers, seedSubmittedAnswer, toOptionIndexes, toOptionLabels } from "../ownAnswers";
import { isSameOpening } from "../questionOpening";
import { loadStoredSession, saveStoredSession, clearStoredSession } from "../participantSessionStorage";

// ── localStorage helpers ─────────────────────
const CLIENT_INSTANCE_KEY = "mdquiz_client_instance_id";

function appendAnsweredQuestion(current: number[], questionIndex: number): number[] {
  return current.includes(questionIndex) ? current : [...current, questionIndex];
}

function getClientInstanceId(): string {
  const existing = localStorage.getItem(CLIENT_INSTANCE_KEY);
  if (existing) {
    return existing;
  }
  const generated =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(CLIENT_INSTANCE_KEY, generated);
  return generated;
}

// ── Socket state types ───────────────────────

export interface QuestionState {
  questionIndex: number;
  topic: string;
  text: string;
  questionType: QuestionType;
  attendeeNotes?: FoldoutNote[];
  slideMedia?: SlideMedia[];
  slideMediaPosition?: MediaPosition;
  slideMediaOpacity?: number;
  slideBackground?: SlideBackground;
  slideLiveEmbed?: SlideLiveEmbed;
  slideVideo?: SlideVideo;
  slideReferences?: SlideReference[];
  /** The deck's header appearance settings as slide-surface custom properties. */
  deckStyle?: DeckStyle;
  options: { label: string; text: string }[];
  allowsMultiple: boolean;
  isPoll: boolean;
  liveResults?: boolean;
  timeLimitSec: number | null;
  deadlineAt?: number | null;
  firstOpenedAt?: number;
  startedAt: number;
  /** Position among the deck's questions, slides not counted; absent on a slide or from an older server. */
  questionNumber?: number;
  /** How many questions the deck has, slides not counted. */
  questionTotal?: number;
  /** Which time this question is asked. It is 2 or more after a re-run and absent the first time. */
  attempt?: number;
}

/**
 * Compatibility path for a newly deployed client talking to an older running
 * server during an active classroom session. Older parsers leave the opt-in
 * background directive in the rendered HTML; consume it client-side so the
 * visual can deploy without restarting the in-memory session server.
 */
export function resolveSlideBackground(
  text: string,
  explicitBackground?: SlideBackground,
): { text: string; slideBackground?: SlideBackground } {
  if (explicitBackground) {
    return { text, slideBackground: explicitBackground };
  }

  const values = new Map<string, string>();
  const cleanedText = text.replace(/\s*<p>\s*([\s\S]*?)\s*<\/p>\s*/gi, (whole, paragraph: string) => {
    const lines = paragraph
      .split(/\r?\n|<br\s*\/?\s*>/i)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return whole;

    const paragraphValues = new Map<string, string>();
    for (const line of lines) {
      // Dashed (`slide-background:`) or earlier underscored spelling.
      const match = line.match(/^(slide[-_]background(?:[-_]position|[-_]size)?):\s*(.+)$/i);
      if (!match) return whole;
      paragraphValues.set(match[1].toLowerCase().replace(/-/g, "_"), match[2].trim().replace(/^['"]|['"]$/g, ""));
    }

    for (const [key, value] of paragraphValues) values.set(key, value);
    return "";
  }).trim();
  const rawSrc = values.get("slide_background");
  if (!rawSrc) {
    return { text };
  }

  const src = rawSrc.startsWith("../images/")
    ? `/data/images/${rawSrc.slice("../images/".length)}`
    : rawSrc;
  return {
    text: cleanedText,
    slideBackground: {
      src,
      ...(values.get("slide_background_position") ? { position: values.get("slide_background_position") } : {}),
      ...(values.get("slide_background_size") ? { size: values.get("slide_background_size") } : {}),
    },
  };
}

export interface RevealState {
  questionIndex: number;
  questionType: QuestionType;
  correctOptions: string[];
  explanation: string;
  distribution: Record<string, number>;
  isPoll: boolean;
  openResponses: OpenResponseEntry[];
  openResponseTotal?: number;
  /** Accepted voters, on polls only: the percentage base. */
  voters?: number;
}

export interface AnswerRejection {
  questionIndex: number;
  reason: string;
}

export interface UseSocketReturn {
  // Connection
  connected: boolean;
  error: string | null;
  /** Most recent outstanding refusal in this session/seat; no reading timeout. */
  answerRejection: AnswerRejection | null;
  /** Feedback for the shown item. Other items' refusals never replace this entry. */
  answerRejectionFor: (questionIndex: number) => AnswerRejection | null;
  /** Clear one item (resubmit, departure or matching ACK), or all items if omitted.
   * Session/seat changes clear all entries; same-seat reconnect preserves them. */
  clearAnswerRejection: (questionIndex?: number) => void;

  // Session
  availability?: SessionAvailabilityPayload | null;
  sessionState: SessionState | null;
  policy: SessionPolicy | null;
  effectiveRanking: "correctness" | "speed" | "legacy" | null;
  sessionToken: string | null;
  /** Whether these credentials still belong to the socket's current participant. */
  hasParticipantCredentials: (sessionId: string, sessionToken: string) => boolean;
  /** True once the presenter's Let rejoin was used from another device: this screen has lost the seat. */
  seatTaken: boolean;
  studentId: string | null;
  /** This participant's random key; leaderboard and response rows carry it instead of the Student ID. */
  publicKey: string | null;
  /** The name others see for this participant, and why it may differ from what they typed. */
  label: string | null;
  labelNote: string | null;
  /** The deck's title, when the deck has one. */
  deckTitle: string | null;
  answeredQuestions: number[];
  ownAnswers: ReadonlyMap<number, StudentAnswer>;
  /** Changes after an accepted answer, including an update to open text. */
  answerRevision: number;
  /** Synchronous ACK epoch for requests that may finish before React renders. */
  getAnswerAcceptanceEpoch: () => number;
  /** Latest known attempts, including announcements whose content is still being refreshed. */
  questionAttempts: ReadonlyMap<number, number>;
  /** Record a question attempt from item lists, socket state, openings or accepted answers.
   * A later attempt clears this page's answer to the earlier attempt. */
  noteQuestionAttempt: (questionIndex: number, attempt?: number) => void;
  /** Reconcile accepted own answers by server attempt and revision from any participant source. */
  reconcileOwnAnswers: (answers: StudentAnswer[], requestAcceptanceEpoch?: number) => void;
  /** Latest pending content for this item and attempt, separate from accepted answers. */
  pendingSubmittedAnswer: (question: Pick<QuestionState, "questionIndex" | "attempt" | "options">) => SubmittedAnswer | undefined;

  // Question
  currentQuestion: QuestionState | null;
  remainingSec: number | null;
  /** True when the open question closed because its timer ran out, false when it was closed early. */
  timedOut: boolean;
  answerCount: AnswerCountPayload | null;
  hasSessionAnswers: boolean;
  submitted: boolean;
  submittedOptions: string[];
  submittedResponseText: string | null;

  // Reveal
  reveal: RevealState | null;
  distribution: ResultsDistributionPayload | null;
  pollLive: Readonly<Record<number, PollLivePayload>>;

  // Leaderboard
  leaderboard: LeaderboardRow[];
  /** A leaderboard delivered since the latest known attempt advance. */
  leaderboardReady: boolean;
  /** Cached scores were invalidated by an attempt advance and need a fresh delivery. */
  leaderboardInvalidated: boolean;
  totalQuestions: number;

  // Participants
  participants: SessionParticipantsPayload | null;

  // Actions
  joinSession: (studentId: string | undefined, displayName?: string) => void;
  submitAnswer: (payload: AnswerSubmitPayload, options?: readonly { label: string }[]) => void;
  reconnect: () => void;
  disconnect: (options?: { preserveSession?: boolean }) => void;
}

/** One empty value, so a hidden feed does not change identity on every render. */
const NO_POLL_LIVE: Readonly<Record<number, PollLivePayload>> = Object.freeze({});

export function useSocket(
  sessionId: string | null,
  role: "student" | "instructor" | "presentation",
): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const [socketSessionId, setSocketSessionId] = useState<string | null>(null);
  const answeredQuestionsRef = useRef<number[]>([]);
  const currentQuestionRef = useRef<QuestionState | null>(null);
  const studentIdRef = useRef<string | null>(null);
  const publicKeyRef = useRef<string | null>(null);
  const submittedOptionsRef = useRef<string[]>([]);
  const submittedResponseTextRef = useRef<string | null>(null);
  // This student's own answers by question index, from the server on join and
  // from accepted submissions, so a revisited or reloaded question shows them.
  const ownAnswersRef = useRef<Map<number, StudentAnswer>>(new Map());
  const pendingAnswerRef = useRef<Map<number, StudentAnswer[]>>(new Map());
  const [ownAnswers, setOwnAnswers] = useState<ReadonlyMap<number, StudentAnswer>>(new Map());
  const [answerRevision, setAnswerRevision] = useState(0);
  const answerAcceptanceEpoch = useRef(0);
  const getAnswerAcceptanceEpoch = useCallback(() => answerAcceptanceEpoch.current, []);
  const [questionAttempts, setQuestionAttempts] = useState<ReadonlyMap<number, number>>(new Map());
  // Server clock minus this device's, so the countdown can run on while offline.
  const clockOffsetRef = useRef(0);
  // The token this screen joined with, and whether another device has since taken its seat.
  const joinedTokenRef = useRef<string | null>(null);
  const participantCredentialsRef = useRef<{ sessionId: string; sessionToken: string } | null>(null);
  const seatTakenRef = useRef(false);
  const hasParticipantCredentials = useCallback((id: string, token: string) =>
    !seatTakenRef.current && participantCredentialsRef.current?.sessionId === id && participantCredentialsRef.current.sessionToken === token, []);
  const [seatTaken, setSeatTaken] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answerRejections, setAnswerRejections] = useState<ReadonlyMap<number, AnswerRejection>>(new Map());
  const clearAnswerRejection = useCallback((questionIndex?: number) => {
    setAnswerRejections(previous => {
      if (questionIndex === undefined) return previous.size ? new Map() : previous;
      if (!previous.has(questionIndex)) return previous;
      const next = new Map(previous);
      next.delete(questionIndex);
      return next;
    });
  }, []);
  const answerRejectionFor = useCallback((questionIndex: number) =>
    socketSessionId === sessionId && !seatTaken ? answerRejections.get(questionIndex) ?? null : null,
  [socketSessionId, sessionId, seatTaken, answerRejections]);
  const answerRejection = Array.from(answerRejections.values()).at(-1) ?? null;

  const [socketAvailability, setSocketAvailability] = useState<{ id: string; value: SessionAvailabilityPayload } | null>(null);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [policy, setPolicy] = useState<SessionPolicy | null>(null);
  const [effectiveRanking, setEffectiveRanking] = useState<"correctness" | "speed" | "legacy" | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [credentialSessionId, setCredentialSessionId] = useState<string | null>(null);
  const scopedAvailability = socketAvailability?.id === sessionId ? socketAvailability.value : null;
  const retainedToken = role === "student" && !seatTaken ? credentialSessionId === sessionId && sessionToken ? sessionToken : loadStoredSession(sessionId)?.sessionToken : null;
  const { availability } = useSessionAvailability(sessionId, scopedAvailability, retainedToken);
  const [studentIdState, setStudentIdState] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [labelNote, setLabelNote] = useState<string | null>(null);
  const [deckTitle, setDeckTitle] = useState<string | null>(null);
  const [answeredQuestions, setAnsweredQuestions] = useState<number[]>([]);

  const [currentQuestion, setCurrentQuestion] = useState<QuestionState | null>(null);
  const [remainingSec, setRemainingSec] = useState<number | null>(0);
  const [timedOut, setTimedOut] = useState(false);
  const [resultsEvidence, setResultsEvidence] = useState<ResultsEvidence | null>(null);
  const [answerCount, setAnswerCount] = useState<AnswerCountPayload | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submittedOptions, setSubmittedOptions] = useState<string[]>([]);
  const [submittedResponseText, setSubmittedResponseText] = useState<string | null>(null);
  // A re-run asks a question again as a new attempt. This page's answer to the earlier attempt no longer counts, so
  // it is never shown as submitted or as a selection. The attempt each question
  // was last seen at is kept here. Same-seat joins retain the highest known attempt.
  const attemptSeenRef = useRef<Map<number, number>>(new Map());
  const pendingSubmittedAnswer = useCallback((shown: Pick<QuestionState, "questionIndex" | "attempt" | "options">) => {
    if ((shown.attempt ?? 1) < (attemptSeenRef.current.get(shown.questionIndex) ?? 1)) return undefined;
    const pending = pendingAnswerRef.current.get(shown.questionIndex)?.filter(answer => (answer.attempt ?? 1) === (shown.attempt ?? 1)).at(-1);
    return pending ? { selectedOptions: toOptionLabels(pending.selectedOptions, shown.options), responseText: pending.responseText?.trim() || null } : undefined;
  }, []);
  const noteQuestionAttempt = useCallback((questionIndex: number, attempt = 1) => {
    setQuestionAttempts(previous => (previous.get(questionIndex) ?? 1) >= attempt ? previous : new Map(previous).set(questionIndex, attempt));
    if (attempt > (attemptSeenRef.current.get(questionIndex) ?? 1)) {
      setLeaderboard([]); setLeaderboardReady(false); setLeaderboardInvalidated(true);
    }
    if (!isLaterAttempt(attemptSeenRef.current, questionIndex, attempt)) return;
    setPollLive(previous => {
      if (!previous[questionIndex]) return previous;
      const next = { ...previous }; delete next[questionIndex]; return next;
    });
    if (ownAnswersRef.current.has(questionIndex)) {
      ownAnswersRef.current = new Map([...ownAnswersRef.current].filter(([index]) => index !== questionIndex));
      setOwnAnswers(new Map(ownAnswersRef.current));
    }
    if (answeredQuestionsRef.current.includes(questionIndex)) {
      answeredQuestionsRef.current = answeredQuestionsRef.current.filter((index) => index !== questionIndex);
      setAnsweredQuestions(answeredQuestionsRef.current);
    }
    if (currentQuestionRef.current?.questionIndex === questionIndex) {
      submittedOptionsRef.current = []; submittedResponseTextRef.current = null;
      setSubmitted(false); setSubmittedOptions([]); setSubmittedResponseText(null);
      if ((currentQuestionRef.current.attempt ?? 1) < attempt) {
        setReveal(null); setDistribution(null);
      }
    }
  }, []);

  const reconcileOwnAnswers = useCallback((answers: StudentAnswer[], requestAcceptanceEpoch?: number) => {
    const current = answers.filter(answer => {
      const attempt = answer.attempt ?? 1;
      if (attempt < (attemptSeenRef.current.get(answer.questionIndex) ?? 1)) return false;
      const known = ownAnswersRef.current.get(answer.questionIndex);
      // An unordered HTTP answer captured before an ACK cannot replace its accepted content.
      if (requestAcceptanceEpoch !== undefined && requestAcceptanceEpoch < answerAcceptanceEpoch.current
        && known && attempt === (known.attempt ?? 1)
        && (answer.acceptedRevision === undefined || known.acceptedRevision === undefined)) return false;
      return shouldReplaceAcceptedAnswer(answer, known);
    });
    if (current.length) {
      for (const answer of current) noteQuestionAttempt(answer.questionIndex, answer.attempt ?? 1);
      ownAnswersRef.current = mergeOwnAnswers(ownAnswersRef.current, current);
      setOwnAnswers(new Map(ownAnswersRef.current));
      answeredQuestionsRef.current = [...new Set([...answeredQuestionsRef.current, ...current.map(answer => answer.questionIndex)])];
      setAnsweredQuestions(answeredQuestionsRef.current);
    }
    // A replay can restore display after disconnect dropped pending correlation,
    // even when it adds no newer accepted knowledge. Matching pending content is
    // shown first, and otherwise the reconciled accepted answer is restored.
    const shown = currentQuestionRef.current;
    if (!shown || (shown.attempt ?? 1) < (attemptSeenRef.current.get(shown.questionIndex) ?? 1)
      || !ownAnswersRef.current.has(shown.questionIndex)
      || !answers.some(answer => answer.questionIndex === shown.questionIndex && (answer.attempt ?? 1) === (shown.attempt ?? 1))) return;
    const seeded = pendingSubmittedAnswer(shown) ?? seedSubmittedAnswer({
      questionIndex: shown.questionIndex,
      options: shown.options,
      alreadyAnswered: true,
      isSameQuestion: false,
      current: { selectedOptions: submittedOptionsRef.current, responseText: submittedResponseTextRef.current },
      known: ownAnswersRef.current,
    });
    submittedOptionsRef.current = seeded.selectedOptions;
    submittedResponseTextRef.current = seeded.responseText;
    setSubmitted(true);
    setSubmittedOptions(seeded.selectedOptions);
    setSubmittedResponseText(seeded.responseText);
  }, [noteQuestionAttempt, pendingSubmittedAnswer]);

  const [reveal, setReveal] = useState<RevealState | null>(null);
  const [distribution, setDistribution] = useState<ResultsDistributionPayload | null>(null);
  const [pollLive, setPollLive] = useState<Readonly<Record<number, PollLivePayload>>>({});

  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [leaderboardReady, setLeaderboardReady] = useState(false);
  const [leaderboardInvalidated, setLeaderboardInvalidated] = useState(false);
  const [totalQuestions, setTotalQuestions] = useState(0);

  const [participants, setParticipants] = useState<SessionParticipantsPayload | null>(null);

  useEffect(() => {
    currentQuestionRef.current = currentQuestion;
  }, [currentQuestion]);

  useEffect(() => {
    studentIdRef.current = studentIdState;
  }, [studentIdState]);

  useEffect(() => {
    publicKeyRef.current = publicKey;
  }, [publicKey]);

  useEffect(() => {
    submittedOptionsRef.current = submittedOptions;
  }, [submittedOptions]);

  useEffect(() => {
    submittedResponseTextRef.current = submittedResponseText;
  }, [submittedResponseText]);

  // Connect socket when sessionId is available
  useEffect(() => {
    setSocketSessionId(sessionId);
    setConnected(false);
    setError(null);
    clearAnswerRejection();
    setSessionToken(null);
    setCredentialSessionId(null);
    participantCredentialsRef.current = null;
    setLeaderboard([]); setLeaderboardReady(false); setLeaderboardInvalidated(false);
    setSessionState(null);
    setSocketAvailability(null);
    setPolicy(null); setEffectiveRanking(null);
    setQuestionAttempts(new Map());
    currentQuestionRef.current = null;
    setCurrentQuestion(null);
    setReveal(null); setDistribution(null);
    setPollLive({});
    if (!sessionId) return;

    const socket = io({
      auth: { sessionId, role },
      query: { sessionId },
      transports: ["websocket", "polling"],
      autoConnect: false,
    });

    socketRef.current = socket;
    seatTakenRef.current = false;
    joinedTokenRef.current = null;
    setSeatTaken(false);
    attemptSeenRef.current = new Map();
    ownAnswersRef.current = new Map();
    pendingAnswerRef.current = new Map();
    setOwnAnswers(new Map());

    socket.on("connect", () => {
      setConnected(true);
      setError(null);

      // Auto-rejoin for students with stored token
      if (role === "student" && !seatTakenRef.current) {
        const stored = loadStoredSession(sessionId);
        if (stored && stored.sessionId === sessionId && stored.sessionToken) {
          socket.emit(SocketEvents.STUDENT_JOIN, {
            studentId: stored.studentId,
            sessionToken: stored.sessionToken,
            clientInstanceId: getClientInstanceId(),
          });
        }
      }
    });

    socket.on("disconnect", () => {
      // A transport's lost ACK cannot be matched to a later submission after rejoin.
      pendingAnswerRef.current.clear();
      setConnected(false);
    });

    socket.on("connect_error", (err) => {
      setError(`Connection failed: ${err.message}`);
    });

    // ── Student join response ──────────────
    socket.on(SocketEvents.STUDENT_JOINED, (data: StudentJoinedPayload) => {
      if (seatTakenRef.current) return;
      const previousAttempts = joinedTokenRef.current === data.sessionToken ? attemptSeenRef.current : new Map<number, number>();
      const retainedAnswers = joinedTokenRef.current === data.sessionToken ? [...ownAnswersRef.current.values()] : [];
      if (joinedTokenRef.current !== data.sessionToken) clearAnswerRejection();
      if (joinedTokenRef.current && joinedTokenRef.current !== data.sessionToken) {
        ownAnswersRef.current = new Map(); pendingAnswerRef.current.clear();
        setLeaderboard([]); setLeaderboardReady(false); setLeaderboardInvalidated(false);
        currentQuestionRef.current = null;
        setCurrentQuestion(null);
        setReveal(null); setDistribution(null);
        setQuestionAttempts(new Map());
      }
      for (const [index, attempt] of Object.entries(data.questionAttempts ?? {})) {
        if (attempt > (previousAttempts.get(Number(index)) ?? 1)) {
          setLeaderboard([]); setLeaderboardReady(false); setLeaderboardInvalidated(true);
        }
        previousAttempts.set(Number(index), Math.max(attempt, previousAttempts.get(Number(index)) ?? 1));
      }
      joinedTokenRef.current = data.sessionToken;
      participantCredentialsRef.current = { sessionId, sessionToken: data.sessionToken };
      setCredentialSessionId(sessionId);
      if (data.availability) setSocketAvailability({ id: sessionId, value: data.availability });
      setSessionToken(data.sessionToken);
      setStudentIdState(data.participantId);
      setPublicKey(data.publicKey ?? null);
      setLabel(data.label ?? null);
      setLabelNote(data.labelNote ?? null);
      setDeckTitle(data.deckTitle?.trim() || null);
      setSessionState(data.sessionState);
      setPollLive({});
      ownAnswersRef.current = mergeOwnAnswers(new Map(), retainedAnswers);
      ownAnswersRef.current = mergeOwnAnswers(ownAnswersRef.current, data.answers);
      ownAnswersRef.current = new Map([...ownAnswersRef.current].filter(([index, answer]) => (answer.attempt ?? 1) >= (previousAttempts.get(index) ?? 1)));
      answeredQuestionsRef.current = [...new Set([...(data.answeredQuestions || []), ...retainedAnswers.map(answer => answer.questionIndex)])]
        .filter(index => (ownAnswersRef.current.get(index)?.attempt ?? 1) >= (previousAttempts.get(index) ?? 1));
      setAnsweredQuestions(answeredQuestionsRef.current);
      attemptSeenRef.current = new Map(answeredQuestionsRef.current.map(index => [index, ownAnswersRef.current.get(index)?.attempt ?? 1]));
      for (const [index, attempt] of previousAttempts) {
        attemptSeenRef.current.set(index, Math.max(attempt, attemptSeenRef.current.get(index) ?? 1));
      }
      setQuestionAttempts(new Map(attemptSeenRef.current));
      setOwnAnswers(new Map(ownAnswersRef.current));
      setError(null);

      // Fill in the question already on screen only from the same attempt.
      const shown = currentQuestionRef.current;
      if (shown) {
        const alreadyAnswered = answeredQuestionsRef.current.includes(shown.questionIndex)
          && (shown.attempt ?? 1) === (ownAnswersRef.current.get(shown.questionIndex)?.attempt ?? 1);
        const seeded = pendingSubmittedAnswer(shown) ?? seedSubmittedAnswer({
          questionIndex: shown.questionIndex,
          options: shown.options,
          alreadyAnswered,
          isSameQuestion: !ownAnswersRef.current.has(shown.questionIndex),
          current: { selectedOptions: submittedOptionsRef.current, responseText: submittedResponseTextRef.current },
          known: ownAnswersRef.current,
        });
        submittedOptionsRef.current = seeded.selectedOptions;
        submittedResponseTextRef.current = seeded.responseText;
        setSubmitted(alreadyAnswered);
        setSubmittedOptions(seeded.selectedOptions);
        setSubmittedResponseText(seeded.responseText);
      }

      // Persist for reconnection
      saveStoredSession({
        sessionId,
        studentId: data.participantId,
        sessionToken: data.sessionToken,
      });
    });

    // The seat was freed and another device took it: stop here, and do not rejoin with the old token.
    socket.on(SocketEvents.SEAT_TAKEN, () => {
      seatTakenRef.current = true;
      clearAnswerRejection();
      // The other device may share this browser's storage, so only clear a seat this screen still holds.
      clearStoredSession(sessionId, joinedTokenRef.current);
      setSeatTaken(true);
      setError(null);
      socket.disconnect();
    });

    socket.on(SocketEvents.STUDENT_REJECTED, (data: { reason: string }) => {
      setError(data.reason);
      const reason = data.reason.toLowerCase();
      if (reason.includes("ended")) setSessionState("ENDED");
      // Preserve the retained seat credential when sockets close at End.
      if (reason.includes("not found")) clearStoredSession(sessionId);
    });

    // ── Question lifecycle ─────────────────
    socket.on(SocketEvents.QUESTION_OPEN, (data: QuestionOpenPayload) => {
      if ((data.attempt ?? 1) < (attemptSeenRef.current.get(data.questionIndex) ?? 1)) return;
      const questionType = data.questionType ?? (data.isPoll ? "poll" : "multiple_choice");
      const resolvedBackground = resolveSlideBackground(data.text, data.slideBackground);
      const previousQuestion = currentQuestionRef.current;
      const isSameQuestion = previousQuestion?.questionIndex === data.questionIndex
        && (previousQuestion.attempt ?? 1) === (data.attempt ?? 1);
      const nextQuestion = {
        questionIndex: data.questionIndex,
        topic: data.topic,
        text: resolvedBackground.text,
        questionType,
        attendeeNotes: data.attendeeNotes,
        slideMedia: data.slideMedia,
        slideMediaPosition: data.slideMediaPosition,
        slideMediaOpacity: data.slideMediaOpacity,
        slideBackground: resolvedBackground.slideBackground,
        slideLiveEmbed: data.slideLiveEmbed,
        slideVideo: data.slideVideo,
        slideReferences: data.slideReferences,
        deckStyle: data.deckStyle,
        options: data.options,
        allowsMultiple: data.allowsMultiple,
        isPoll: data.isPoll ?? false,
        liveResults: data.liveResults,
        timeLimitSec: data.timeLimitSec,
        startedAt: data.startedAt,
        deadlineAt: data.deadlineAt,
        firstOpenedAt: data.firstOpenedAt,
        questionNumber: data.questionNumber,
        questionTotal: data.questionTotal,
        attempt: data.attempt,
      };
      // A snapshot that repeats the opening on screen keeps the same object, so
      // the student view does not clear an option chosen while offline.
      const openedQuestion = isSameOpening(previousQuestion, nextQuestion) ? previousQuestion : nextQuestion;
      // A repeated opening still brings the presenter's current live-results setting.
      const shownQuestion = openedQuestion.liveResults === nextQuestion.liveResults ? openedQuestion : { ...openedQuestion, liveResults: nextQuestion.liveResults };
      currentQuestionRef.current = shownQuestion;
      setCurrentQuestion(shownQuestion);
      setSessionState("QUESTION_OPEN");
      setReveal(null);
      setDistribution(null);
      // Reveal/reconnect snapshots replay question context before reveal details.
      // A pending submission for this attempt is shown first. Otherwise a question
      // not marked answered shows no answer. A marked repeat of the same question
      // with no known accepted answer keeps the local answer, and a known accepted
      // answer to the current attempt is restored.
      noteQuestionAttempt(data.questionIndex, data.attempt ?? 1);
      const alreadyAnswered = answeredQuestionsRef.current.includes(data.questionIndex);
      const seeded = pendingSubmittedAnswer(data) ?? seedSubmittedAnswer({
        questionIndex: data.questionIndex,
        options: data.options,
        alreadyAnswered,
        isSameQuestion: isSameQuestion && !ownAnswersRef.current.has(data.questionIndex),
        current: { selectedOptions: submittedOptionsRef.current, responseText: submittedResponseTextRef.current },
        known: ownAnswersRef.current,
      });
      submittedOptionsRef.current = seeded.selectedOptions;
      submittedResponseTextRef.current = seeded.responseText;
      setSubmitted(alreadyAnswered);
      setSubmittedOptions(seeded.selectedOptions);
      setSubmittedResponseText(seeded.responseText);
      setRemainingSec(localRemainingSec(data, data.serverNow ?? Date.now()));
      setTimedOut(false);
      // Observational openings carry the same deadline, not a fresh countdown.
      if (data.serverNow !== undefined) clockOffsetRef.current = data.serverNow - Date.now();
    });

    socket.on(SocketEvents.QUESTION_TICK, (data: QuestionTickPayload) => {
      setRemainingSec(data.remainingSec);
      const shown = currentQuestionRef.current;
      if (shown) clockOffsetRef.current = clockOffsetFromTick(shown, data.remainingSec, Date.now());
    });

    socket.on(SocketEvents.QUESTION_CLOSE, (data?: QuestionClosePayload) => {
      setSessionState("QUESTION_CLOSED");
      setRemainingSec(0);
      setTimedOut(data?.timedOut === true);
    });

    socket.on(SocketEvents.ANSWER_ACCEPTED, (data: AnswerAcceptedPayload) => {
      const pending = pendingAnswerRef.current.get(data.questionIndex)?.shift();
      // Consume the transport's outcome without reviving an archived attempt.
      if (!pending || (pending.attempt ?? 1) < (attemptSeenRef.current.get(data.questionIndex) ?? 1)) return;
      clearAnswerRejection(data.questionIndex);
      noteQuestionAttempt(data.questionIndex, pending.attempt ?? 1);
      const accepted = { ...pending, ...(data.acceptedRevision !== undefined ? { acceptedRevision: data.acceptedRevision } : {}) };
      if ((data.attempt ?? pending.attempt ?? 1) !== (pending.attempt ?? 1)) return;
      answerAcceptanceEpoch.current += 1;
      ownAnswersRef.current = mergeOwnAnswers(ownAnswersRef.current, [accepted]);
      setOwnAnswers(new Map(ownAnswersRef.current));
      const shown = currentQuestionRef.current;
      if (pending && shown?.questionIndex === data.questionIndex && (shown.attempt ?? 1) === (pending.attempt ?? 1)
        && !pendingAnswerRef.current.get(data.questionIndex)?.length) {
        const known = ownAnswersRef.current.get(data.questionIndex)!;
        const selectedOptions = toOptionLabels(known.selectedOptions, shown.options);
        const responseText = known.responseText?.trim() || null;
        submittedOptionsRef.current = selectedOptions;
        submittedResponseTextRef.current = responseText;
        setSubmittedOptions(selectedOptions);
        setSubmittedResponseText(responseText);
      }
      setAnswerRevision(previous => previous + 1);
      // An ACK for an explored item must never mark the presenter item submitted.
      if (shown?.questionIndex === data.questionIndex && (shown.attempt ?? 1) === (pending.attempt ?? 1)) setSubmitted(true);
      answeredQuestionsRef.current = appendAnsweredQuestion(answeredQuestionsRef.current, data.questionIndex);
      setAnsweredQuestions(answeredQuestionsRef.current);
    });

    socket.on(SocketEvents.ANSWER_REJECTED, (data: { questionIndex: number; reason: string }) => {
      pendingAnswerRef.current.get(data.questionIndex)?.shift();
      setAnswerRejections(previous => {
        const next = new Map(previous);
        // Reinsert so iteration order also records the most recent refusal.
        next.delete(data.questionIndex);
        next.set(data.questionIndex, { questionIndex: data.questionIndex, reason: data.reason });
        return next;
      });
      setError(`Answer rejected: ${data.reason}`);
      // Preserve the join-error behaviour; answer feedback has no reading timeout.
      setTimeout(() => setError(null), 3000);
    });

    // ── Answer count (instructor) ─────────
    socket.on(SocketEvents.ANSWER_COUNT, (data: AnswerCountPayload) => {
      setAnswerCount(data);
      setResultsEvidence(previous => updateResultsEvidence(previous, sessionId, data.hasAnswers === true));
      // Counts are staff projections without participant acceptance order.
      // Own answers are reconciled only through ACKs, joins, snapshots and HTTP.
    });

    // ── Results ───────────────────────────
    socket.on(SocketEvents.RESULTS_DISTRIBUTION, (data: ResultsDistributionPayload) => {
      setDistribution(data);
    });

    socket.on(SocketEvents.POLL_LIVE, (data: PollLivePayload) => {
      if (!data || typeof data !== "object" || !Number.isInteger(data.questionIndex) || data.questionIndex < 0) return;
      setPollLive(previous => ({ ...previous, [data.questionIndex]: data }));
    });

    socket.on(SocketEvents.RESULTS_REVEAL, (data: ResultsRevealPayload) => {
      if (currentQuestionRef.current?.questionIndex !== data.questionIndex
        || (currentQuestionRef.current.attempt ?? 1) < (attemptSeenRef.current.get(data.questionIndex) ?? 1)) {
        return;
      }

      setReveal({
        questionIndex: data.questionIndex,
        questionType: data.questionType ?? (data.isPoll ? "poll" : "multiple_choice"),
        correctOptions: data.correctOptions,
        explanation: data.explanation,
        distribution: data.distribution,
        isPoll: data.isPoll ?? false,
        openResponses: data.openResponses ?? [],
        openResponseTotal: data.openResponseTotal,
        ...(Number.isSafeInteger(data.voters) && data.voters! >= 0 ? { voters: data.voters } : {}),
      });
      setSessionState("REVEAL");
    });

    // ── Leaderboard ───────────────────────
    socket.on(SocketEvents.LEADERBOARD_UPDATE, (data: LeaderboardUpdatePayload) => {
      setLeaderboard(data.entries);
      setLeaderboardReady(true);
      setLeaderboardInvalidated(false);
      setTotalQuestions(data.totalQuestions);
      setSessionState("LEADERBOARD");
    });

    socket.on(SocketEvents.SESSION_AVAILABILITY, (data: SessionAvailabilityPayload) => setSocketAvailability({ id: sessionId, value: data }));

    // ── Session state broadcasts ──────────
    socket.on(SocketEvents.SESSION_STATE, (data: SessionStatePayload) => {
      if (data.policy) setPolicy(data.policy);
      if (data.effectiveRanking) setEffectiveRanking(data.effectiveRanking);
      if (data.availability) setSocketAvailability({ id: sessionId, value: data.availability });
      if (data.questionAttempts) {
        for (const [index, attempt] of Object.entries(data.questionAttempts)) noteQuestionAttempt(Number(index), attempt);
        setAnswerRevision(previous => previous + 1);
      }
      if (data.answers) reconcileOwnAnswers(data.answers);
      setSessionState(data.state);
      setResultsEvidence(previous => updateResultsEvidence(previous, sessionId, data.hasAnswers === true));
    });

    // ── Participants (instructor) ─────────
    socket.on(SocketEvents.SESSION_PARTICIPANTS, (data: SessionParticipantsPayload) => {
      setParticipants(data);
    });

    socket.connect();

    let foregroundReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const reconnectAfterForeground = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        return;
      }

      if (foregroundReconnectTimer) {
        clearTimeout(foregroundReconnectTimer);
      }

      foregroundReconnectTimer = setTimeout(() => {
        const currentSocket = socketRef.current;
        if (!currentSocket || currentSocket !== socket || seatTakenRef.current) {
          return;
        }

        // iOS Safari can leave Socket.IO thinking it is connected after a
        // background/foreground cycle. Reconnecting asks the server to replay
        // the authoritative session snapshot before the next instructor action.
        currentSocket.disconnect();
        currentSocket.connect();
      }, 100);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        reconnectAfterForeground();
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener("pageshow", reconnectAfterForeground);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      if (foregroundReconnectTimer) {
        clearTimeout(foregroundReconnectTimer);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("pageshow", reconnectAfterForeground);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      socket.disconnect();
      socketRef.current = null;
      participantCredentialsRef.current = null;
    };
  }, [sessionId, role, clearAnswerRejection]);

  // Ticks stop while offline, so keep the countdown moving from the question's
  // start time until the rejoin snapshot's tick takes over again.
  useEffect(() => {
    if (connected || sessionState !== "QUESTION_OPEN" || !currentQuestion || isSlideType(currentQuestion.questionType)) return;
    const update = () => setRemainingSec(localRemainingSec(currentQuestion, Date.now(), clockOffsetRef.current));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [connected, sessionState, currentQuestion]);

  const joinSession = useCallback(
    (studentId: string | undefined, displayName?: string) => {
      if (!socketRef.current) return;
      const stored = loadStoredSession(sessionId);
      const token = stored?.sessionId === sessionId ? stored.sessionToken : undefined;
      // Clear the last refusal first, so a second refusal for the same reason is shown again.
      setError(null);
      socketRef.current.emit(SocketEvents.STUDENT_JOIN, {
        studentId: studentId?.trim() || undefined,
        displayName: displayName?.trim() || undefined,
        sessionToken: token,
        clientInstanceId: getClientInstanceId(),
      });
      if (studentId?.trim()) setStudentIdState(studentId.trim());
    },
    [sessionId],
  );

  const submitAnswer = useCallback(
    (payload: AnswerSubmitPayload, options?: readonly { label: string }[]) => {
      clearAnswerRejection(payload.questionIndex);
      if (!socketRef.current) return;
      // Socket.IO would buffer this and send it on reconnect before the rejoin,
      // where the server rejects it, so an offline answer is not sent at all.
      if (!socketRef.current.connected) {
        setError("Not connected. Your answer was not sent; submit it again once you are reconnected.");
        setTimeout(() => setError(null), 3000);
        return;
      }
      const nextSubmittedOptions = payload.selectedOptions ?? [];
      const nextSubmittedResponseText = payload.responseText?.trim() || null;
      const shown = currentQuestionRef.current;
      const attempt = payload.attempt ?? (shown?.questionIndex === payload.questionIndex ? shown.attempt : undefined) ?? 1;
      if (payload.attempt === undefined && attempt > 1) payload = { ...payload, attempt };
      if (payload.attempt === 1) { payload = { ...payload }; delete payload.attempt; }
      const pending = pendingAnswerRef.current.get(payload.questionIndex) ?? [];
      pending.push({
        questionIndex: payload.questionIndex,
        ...(attempt > 1 ? { attempt } : {}),
        selectedOptions: toOptionIndexes(nextSubmittedOptions, options ?? (shown?.questionIndex === payload.questionIndex ? shown.options : [])),
        ...(nextSubmittedResponseText ? { responseText: nextSubmittedResponseText } : {}),
      });
      pendingAnswerRef.current.set(payload.questionIndex, pending);
      socketRef.current.emit(SocketEvents.ANSWER_SUBMIT, payload);
      if (shown?.questionIndex !== payload.questionIndex || (shown.attempt ?? 1) !== attempt
        || attempt < (attemptSeenRef.current.get(payload.questionIndex) ?? 1)) return;
      submittedOptionsRef.current = nextSubmittedOptions;
      submittedResponseTextRef.current = nextSubmittedResponseText;
      setSubmittedOptions(nextSubmittedOptions);
      setSubmittedResponseText(nextSubmittedResponseText);
    },
    [clearAnswerRejection],
  );

  const reconnect = useCallback(() => {
    const socket = socketRef.current;
    if (!socket || seatTakenRef.current) return;

    // Force a fresh transport rather than trusting a stale iOS Safari socket.
    // The server sends an authoritative state snapshot on every connection.
    socket.disconnect();
    socket.connect();
  }, []);

  const disconnect = useCallback((options?: { preserveSession?: boolean }) => {
    clearAnswerRejection();
    if (role === "student" && !options?.preserveSession) clearStoredSession(sessionId, joinedTokenRef.current ?? undefined);
    socketRef.current?.disconnect();
    setConnected(false);
    setSessionState(null);
    setSessionToken(null);
    participantCredentialsRef.current = null;
    setStudentIdState(null);
    setPublicKey(null);
    setLabel(null);
    setLabelNote(null);
    setDeckTitle(null);
  }, [role, sessionId, clearAnswerRejection]);

  return {
    connected: socketSessionId === sessionId && connected,
    error: socketSessionId === sessionId ? error : null,
    answerRejection: socketSessionId === sessionId && !seatTaken ? answerRejection : null,
    answerRejectionFor,
    clearAnswerRejection,
    availability,
    sessionState: socketSessionId === sessionId ? sessionState : null,
    policy: socketSessionId === sessionId ? policy : null,
    effectiveRanking: socketSessionId === sessionId ? effectiveRanking : null,
    sessionToken: credentialSessionId === sessionId ? sessionToken : null,
    hasParticipantCredentials,
    seatTaken: socketSessionId === sessionId && seatTaken,
    studentId: studentIdState,
    publicKey,
    label,
    labelNote,
    deckTitle,
    answeredQuestions,
    ownAnswers,
    answerRevision,
    getAnswerAcceptanceEpoch,
    questionAttempts: socketSessionId === sessionId ? questionAttempts : new Map(),
    noteQuestionAttempt,
    reconcileOwnAnswers,
    pendingSubmittedAnswer,
    currentQuestion: socketSessionId === sessionId ? currentQuestion : null,
    remainingSec,
    timedOut,
    answerCount,
    hasSessionAnswers: hasResultsAnswers(resultsEvidence, sessionId),
    submitted,
    submittedOptions,
    submittedResponseText,
    reveal: role !== "instructor" && (availability?.phase === "expired" || availability?.phase === "deleted") ? null : reveal,
    distribution: role !== "instructor" && (availability?.phase === "expired" || availability?.phase === "deleted") ? null : distribution,
    pollLive: role !== "instructor" && (availability?.phase === "expired" || availability?.phase === "deleted") ? NO_POLL_LIVE : pollLive,
    leaderboard: role !== "instructor" && (availability?.phase === "expired" || availability?.phase === "deleted") ? [] : leaderboard,
    leaderboardReady: socketSessionId === sessionId && leaderboardReady,
    leaderboardInvalidated: socketSessionId === sessionId && leaderboardInvalidated,
    totalQuestions,
    participants,
    joinSession,
    submitAnswer,
    reconnect,
    disconnect,
  };
}
