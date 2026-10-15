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
import { mergeOwnAnswers, seedSubmittedAnswer, toOptionIndexes } from "../ownAnswers";
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
}

export interface UseSocketReturn {
  // Connection
  connected: boolean;
  error: string | null;

  // Session
  availability?: SessionAvailabilityPayload | null;
  sessionState: SessionState | null;
  policy: SessionPolicy | null;
  effectiveRanking: "correctness" | "speed" | "legacy" | null;
  sessionToken: string | null;
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
  // Server clock minus this device's, so the countdown can run on while offline.
  const clockOffsetRef = useRef(0);
  // The token this screen joined with, and whether another device has since taken its seat.
  const joinedTokenRef = useRef<string | null>(null);
  const seatTakenRef = useRef(false);
  const [seatTaken, setSeatTaken] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const [reveal, setReveal] = useState<RevealState | null>(null);
  const [distribution, setDistribution] = useState<ResultsDistributionPayload | null>(null);
  const [pollLive, setPollLive] = useState<Readonly<Record<number, PollLivePayload>>>({});

  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
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
    setSessionToken(null);
    setCredentialSessionId(null);
    setSessionState(null);
    setSocketAvailability(null);
    setPolicy(null); setEffectiveRanking(null);
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
      if (joinedTokenRef.current && joinedTokenRef.current !== data.sessionToken) {
        ownAnswersRef.current = new Map(); pendingAnswerRef.current.clear();
      }
      joinedTokenRef.current = data.sessionToken;
      setCredentialSessionId(sessionId);
      if (data.availability) setSocketAvailability({ id: sessionId, value: data.availability });
      setSessionToken(data.sessionToken);
      setStudentIdState(data.participantId);
      setPublicKey(data.publicKey ?? null);
      setLabel(data.label ?? null);
      setLabelNote(data.labelNote ?? null);
      setDeckTitle(data.deckTitle?.trim() || null);
      setSessionState(data.sessionState);
      setAnsweredQuestions(data.answeredQuestions || []);
      setPollLive({});
      answeredQuestionsRef.current = data.answeredQuestions || [];
      pendingAnswerRef.current.clear();
      ownAnswersRef.current = mergeOwnAnswers(new Map(), data.answers);
      setOwnAnswers(new Map(ownAnswersRef.current));
      setError(null);

      // Fill in the question already on screen if this page lost its answer.
      const shown = currentQuestionRef.current;
      if (shown && answeredQuestionsRef.current.includes(shown.questionIndex)) {
        const seeded = seedSubmittedAnswer({
          questionIndex: shown.questionIndex,
          options: shown.options,
          alreadyAnswered: true,
          isSameQuestion: true,
          current: { selectedOptions: submittedOptionsRef.current, responseText: submittedResponseTextRef.current },
          known: ownAnswersRef.current,
        });
        submittedOptionsRef.current = seeded.selectedOptions;
        submittedResponseTextRef.current = seeded.responseText;
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
      const questionType = data.questionType ?? (data.isPoll ? "poll" : "multiple_choice");
      const resolvedBackground = resolveSlideBackground(data.text, data.slideBackground);
      const previousQuestion = currentQuestionRef.current;
      const isSameQuestion = previousQuestion?.questionIndex === data.questionIndex;
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
      };
      // A snapshot that repeats the opening on screen keeps the same object, so
      // the student view does not clear an option chosen while offline.
      const shownQuestion = isSameOpening(previousQuestion, nextQuestion) && previousQuestion.liveResults === nextQuestion.liveResults ? previousQuestion : nextQuestion;
      currentQuestionRef.current = shownQuestion;
      setCurrentQuestion(shownQuestion);
      setSessionState("QUESTION_OPEN");
      setReveal(null);
      setDistribution(null);
      // Reveal/reconnect snapshots replay question context before reveal details.
      // Preserve the local answer when that replay is for the same question,
      // and otherwise restore a known earlier answer to this question.
      const alreadyAnswered = answeredQuestionsRef.current.includes(data.questionIndex);
      const seeded = seedSubmittedAnswer({
        questionIndex: data.questionIndex,
        options: data.options,
        alreadyAnswered,
        isSameQuestion,
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

    socket.on(SocketEvents.ANSWER_ACCEPTED, (data: { questionIndex: number }) => {
      const pending = pendingAnswerRef.current.get(data.questionIndex)?.shift();
      if (pending) {
        ownAnswersRef.current = mergeOwnAnswers(ownAnswersRef.current, [pending]);
        setOwnAnswers(new Map(ownAnswersRef.current));
      }
      setAnswerRevision(previous => previous + 1);
      // An ACK for an explored item must never mark the presenter item submitted.
      if (currentQuestionRef.current?.questionIndex === data.questionIndex) setSubmitted(true);
      setAnsweredQuestions(prev => {
        const next = appendAnsweredQuestion(prev, data.questionIndex);
        answeredQuestionsRef.current = next;
        return next;
      });
    });

    socket.on(SocketEvents.ANSWER_REJECTED, (data: { questionIndex: number; reason: string }) => {
      pendingAnswerRef.current.get(data.questionIndex)?.shift();
      setError(`Answer rejected: ${data.reason}`);
      // Clear error after 3 seconds
      setTimeout(() => setError(null), 3000);
    });

    // ── Answer count (instructor) ─────────
    socket.on(SocketEvents.ANSWER_COUNT, (data: AnswerCountPayload) => {
      setAnswerCount(data);
      setResultsEvidence(previous => updateResultsEvidence(previous, sessionId, data.hasAnswers === true));
      setAnsweredQuestions((prev) => {
        const current = currentQuestionRef.current;
        const ownKey = publicKeyRef.current;
        if (
          !ownKey
          || !current
          || current.questionType !== "open_response"
          || current.questionIndex !== data.questionIndex
        ) {
          return prev;
        }

        const ownResponse = data.openResponses?.find((entry) => entry.publicKey === ownKey);
        if (!ownResponse) {
          return prev;
        }

        setSubmitted(true);
        setSubmittedResponseText(ownResponse.responseText);

        const next = appendAnsweredQuestion(prev, data.questionIndex);
        answeredQuestionsRef.current = next;
        return next;
      });
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
      if (currentQuestionRef.current?.questionIndex !== data.questionIndex) {
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
      });
      setSessionState("REVEAL");
    });

    // ── Leaderboard ───────────────────────
    socket.on(SocketEvents.LEADERBOARD_UPDATE, (data: LeaderboardUpdatePayload) => {
      setLeaderboard(data.entries);
      setTotalQuestions(data.totalQuestions);
      setSessionState("LEADERBOARD");
    });

    socket.on(SocketEvents.SESSION_AVAILABILITY, (data: SessionAvailabilityPayload) => setSocketAvailability({ id: sessionId, value: data }));

    // ── Session state broadcasts ──────────
    socket.on(SocketEvents.SESSION_STATE, (data: SessionStatePayload) => {
      if (data.policy) setPolicy(data.policy);
      if (data.effectiveRanking) setEffectiveRanking(data.effectiveRanking);
      if (data.availability) setSocketAvailability({ id: sessionId, value: data.availability });
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
    };
  }, [sessionId, role]);

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
      const pending = pendingAnswerRef.current.get(payload.questionIndex) ?? [];
      pending.push({
        questionIndex: payload.questionIndex,
        selectedOptions: toOptionIndexes(nextSubmittedOptions, options ?? (shown?.questionIndex === payload.questionIndex ? shown.options : [])),
        ...(nextSubmittedResponseText ? { responseText: nextSubmittedResponseText } : {}),
      });
      pendingAnswerRef.current.set(payload.questionIndex, pending);
      socketRef.current.emit(SocketEvents.ANSWER_SUBMIT, payload);
      if (shown?.questionIndex !== payload.questionIndex) return;
      submittedOptionsRef.current = nextSubmittedOptions;
      submittedResponseTextRef.current = nextSubmittedResponseText;
      setSubmittedOptions(nextSubmittedOptions);
      setSubmittedResponseText(nextSubmittedResponseText);
    },
    [],
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
    if (role === "student" && !options?.preserveSession) clearStoredSession(sessionId, joinedTokenRef.current ?? undefined);
    socketRef.current?.disconnect();
    setConnected(false);
    setSessionState(null);
    setSessionToken(null);
    setStudentIdState(null);
    setPublicKey(null);
    setLabel(null);
    setLabelNote(null);
    setDeckTitle(null);
  }, [role, sessionId]);

  return {
    connected: socketSessionId === sessionId && connected,
    error: socketSessionId === sessionId ? error : null,
    availability,
    sessionState: socketSessionId === sessionId ? sessionState : null,
    policy: socketSessionId === sessionId ? policy : null,
    effectiveRanking: socketSessionId === sessionId ? effectiveRanking : null,
    sessionToken: credentialSessionId === sessionId ? sessionToken : null,
    seatTaken: socketSessionId === sessionId && seatTaken,
    studentId: studentIdState,
    publicKey,
    label,
    labelNote,
    deckTitle,
    answeredQuestions,
    ownAnswers,
    answerRevision,
    currentQuestion,
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
    totalQuestions,
    participants,
    joinSession,
    submitAnswer,
    reconnect,
    disconnect,
  };
}
