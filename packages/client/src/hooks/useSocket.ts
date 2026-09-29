import { io, type Socket } from "socket.io-client";
import { useState, useEffect, useCallback, useRef } from "react";
import type {
  SessionState,
  StudentJoinedPayload,
  QuestionOpenPayload,
  QuestionTickPayload,
  QuestionClosePayload,
  AnswerCountPayload,
  ResultsRevealPayload,
  ResultsDistributionPayload,
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
  DeckPalette,
  DeckTheme,
  StudentAnswer,
} from "@mdq/shared";
import { SocketEvents } from "@mdq/shared";
import { clockOffsetFromTick, localRemainingSec } from "../countdown";
import { mergeOwnAnswers, seedSubmittedAnswer, toOptionIndexes } from "../ownAnswers";
import { isSameOpening } from "../questionOpening";

// ── localStorage helpers ─────────────────────
const STORAGE_KEY = "mdquiz_session";
const CLIENT_INSTANCE_KEY = "mdquiz_client_instance_id";

interface StoredSession {
  sessionId: string;
  studentId: string;
  sessionToken: string;
  sessionWeek?: string;
  sessionTheme?: DeckTheme;
  sessionPalette?: DeckPalette;
}

function appendAnsweredQuestion(current: number[], questionIndex: number): number[] {
  return current.includes(questionIndex) ? current : [...current, questionIndex];
}

function loadStoredSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveStoredSession(data: StoredSession) {
  const existing = loadStoredSession();
  const retainedMetadata = existing?.sessionId === data.sessionId
    ? {
      sessionWeek: existing.sessionWeek,
      sessionTheme: existing.sessionTheme,
      sessionPalette: existing.sessionPalette,
    }
    : {};
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...retainedMetadata, ...data }));
}

function clearStoredSession() {
  localStorage.removeItem(STORAGE_KEY);
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
  options: { label: string; text: string }[];
  allowsMultiple: boolean;
  isPoll: boolean;
  timeLimitSec: number;
  startedAt: number;
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
  sessionState: SessionState | null;
  sessionToken: string | null;
  studentId: string | null;
  /** This participant's random key; leaderboard and response rows carry it instead of the Student ID. */
  publicKey: string | null;
  /** The name others see for this participant, and why it may differ from what they typed. */
  label: string | null;
  labelNote: string | null;
  answeredQuestions: number[];

  // Question
  currentQuestion: QuestionState | null;
  remainingSec: number;
  /** True when the open question closed because its timer ran out, false when it was closed early. */
  timedOut: boolean;
  answerCount: AnswerCountPayload | null;
  submitted: boolean;
  submittedOptions: string[];
  submittedResponseText: string | null;

  // Reveal
  reveal: RevealState | null;
  distribution: ResultsDistributionPayload | null;

  // Leaderboard
  leaderboard: LeaderboardRow[];
  totalQuestions: number;

  // Participants
  participants: SessionParticipantsPayload | null;

  // Actions
  joinSession: (studentId: string | undefined, displayName?: string) => void;
  submitAnswer: (payload: AnswerSubmitPayload) => void;
  reconnect: () => void;
  disconnect: () => void;
}

export function useSocket(
  sessionId: string | null,
  role: "student" | "instructor" | "presentation",
): UseSocketReturn {
  const socketRef = useRef<Socket | null>(null);
  const answeredQuestionsRef = useRef<number[]>([]);
  const currentQuestionRef = useRef<QuestionState | null>(null);
  const studentIdRef = useRef<string | null>(null);
  const publicKeyRef = useRef<string | null>(null);
  const submittedOptionsRef = useRef<string[]>([]);
  const submittedResponseTextRef = useRef<string | null>(null);
  // This student's own answers by question index, from the server on join and
  // from accepted submissions, so a revisited or reloaded question shows them.
  const ownAnswersRef = useRef<Map<number, StudentAnswer>>(new Map());
  const pendingAnswerRef = useRef<StudentAnswer | null>(null);
  // Server clock minus this device's, so the countdown can run on while offline.
  const clockOffsetRef = useRef(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [studentIdState, setStudentIdState] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [label, setLabel] = useState<string | null>(null);
  const [labelNote, setLabelNote] = useState<string | null>(null);
  const [answeredQuestions, setAnsweredQuestions] = useState<number[]>([]);

  const [currentQuestion, setCurrentQuestion] = useState<QuestionState | null>(null);
  const [remainingSec, setRemainingSec] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const [answerCount, setAnswerCount] = useState<AnswerCountPayload | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submittedOptions, setSubmittedOptions] = useState<string[]>([]);
  const [submittedResponseText, setSubmittedResponseText] = useState<string | null>(null);

  const [reveal, setReveal] = useState<RevealState | null>(null);
  const [distribution, setDistribution] = useState<ResultsDistributionPayload | null>(null);

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
    if (!sessionId) return;

    const socket = io({
      auth: { sessionId, role },
      query: { sessionId },
      transports: ["websocket", "polling"],
      autoConnect: false,
    });

    socketRef.current = socket;
    ownAnswersRef.current = new Map();
    pendingAnswerRef.current = null;

    socket.on("connect", () => {
      setConnected(true);
      setError(null);

      // Auto-rejoin for students with stored token
      if (role === "student") {
        const stored = loadStoredSession();
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
      setConnected(false);
    });

    socket.on("connect_error", (err) => {
      setError(`Connection failed: ${err.message}`);
    });

    // ── Student join response ──────────────
    socket.on(SocketEvents.STUDENT_JOINED, (data: StudentJoinedPayload) => {
      setSessionToken(data.sessionToken);
      setStudentIdState(data.participantId);
      setPublicKey(data.publicKey ?? null);
      setLabel(data.label ?? null);
      setLabelNote(data.labelNote ?? null);
      setSessionState(data.sessionState);
      setAnsweredQuestions(data.answeredQuestions || []);
      answeredQuestionsRef.current = data.answeredQuestions || [];
      ownAnswersRef.current = mergeOwnAnswers(ownAnswersRef.current, data.answers);
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

    socket.on(SocketEvents.STUDENT_REJECTED, (data: { reason: string }) => {
      setError(data.reason);
      const reason = data.reason.toLowerCase();
      if (reason.includes("ended") || reason.includes("not found")) {
        clearStoredSession();
      }
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
        options: data.options,
        allowsMultiple: data.allowsMultiple,
        isPoll: data.isPoll ?? false,
        timeLimitSec: data.timeLimitSec,
        startedAt: data.startedAt,
      };
      // A snapshot that repeats the opening on screen keeps the same object, so
      // the student view does not clear an option chosen while offline.
      const shownQuestion = isSameOpening(previousQuestion, nextQuestion) ? previousQuestion : nextQuestion;
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
      setRemainingSec(data.timeLimitSec);
      setTimedOut(false);
      // A live open arrives as the question starts; a replayed one is followed by a tick that corrects this.
      clockOffsetRef.current = data.startedAt - Date.now();
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
      const pending = pendingAnswerRef.current;
      if (pending?.questionIndex === data.questionIndex) {
        ownAnswersRef.current = mergeOwnAnswers(ownAnswersRef.current, [pending]);
        pendingAnswerRef.current = null;
      }
      setSubmitted(true);
      setAnsweredQuestions(prev => {
        const next = appendAnsweredQuestion(prev, data.questionIndex);
        answeredQuestionsRef.current = next;
        return next;
      });
    });

    socket.on(SocketEvents.ANSWER_REJECTED, (data: { questionIndex: number; reason: string }) => {
      setError(`Answer rejected: ${data.reason}`);
      // Clear error after 3 seconds
      setTimeout(() => setError(null), 3000);
    });

    // ── Answer count (instructor) ─────────
    socket.on(SocketEvents.ANSWER_COUNT, (data: AnswerCountPayload) => {
      setAnswerCount(data);
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

    // ── Session state broadcasts ──────────
    socket.on(SocketEvents.SESSION_STATE, (data: SessionStatePayload) => {
      setSessionState(data.state);
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
        if (!currentSocket || currentSocket !== socket) {
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
    if (connected || sessionState !== "QUESTION_OPEN" || !currentQuestion || currentQuestion.questionType === "slide") return;
    const update = () => setRemainingSec(localRemainingSec(currentQuestion, Date.now(), clockOffsetRef.current));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [connected, sessionState, currentQuestion]);

  const joinSession = useCallback(
    (studentId: string | undefined, displayName?: string) => {
      if (!socketRef.current) return;
      const stored = loadStoredSession();
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
    (payload: AnswerSubmitPayload) => {
      if (!socketRef.current) return;
      // Socket.IO would buffer this and send it on reconnect before the rejoin,
      // where the server rejects it, so an offline answer is not sent at all.
      if (!socketRef.current.connected) {
        setError("Not connected. Your answer was not sent; submit it again once you are reconnected.");
        setTimeout(() => setError(null), 3000);
        return;
      }
      socketRef.current.emit(SocketEvents.ANSWER_SUBMIT, payload);
      const nextSubmittedOptions = payload.selectedOptions ?? [];
      const nextSubmittedResponseText = payload.responseText?.trim() || null;
      const shown = currentQuestionRef.current;
      pendingAnswerRef.current = {
        questionIndex: payload.questionIndex,
        selectedOptions: shown?.questionIndex === payload.questionIndex
          ? toOptionIndexes(nextSubmittedOptions, shown.options)
          : [],
        ...(nextSubmittedResponseText ? { responseText: nextSubmittedResponseText } : {}),
      };
      submittedOptionsRef.current = nextSubmittedOptions;
      submittedResponseTextRef.current = nextSubmittedResponseText;
      setSubmittedOptions(nextSubmittedOptions);
      setSubmittedResponseText(nextSubmittedResponseText);
    },
    [],
  );

  const reconnect = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;

    // Force a fresh transport rather than trusting a stale iOS Safari socket.
    // The server sends an authoritative state snapshot on every connection.
    socket.disconnect();
    socket.connect();
  }, []);

  const disconnect = useCallback(() => {
    clearStoredSession();
    socketRef.current?.disconnect();
    setConnected(false);
    setSessionState(null);
    setSessionToken(null);
    setStudentIdState(null);
    setPublicKey(null);
    setLabel(null);
    setLabelNote(null);
  }, []);

  return {
    connected,
    error,
    sessionState,
    sessionToken,
    studentId: studentIdState,
    publicKey,
    label,
    labelNote,
    answeredQuestions,
    currentQuestion,
    remainingSec,
    timedOut,
    answerCount,
    submitted,
    submittedOptions,
    submittedResponseText,
    reveal,
    distribution,
    leaderboard,
    totalQuestions,
    participants,
    joinSession,
    submitAnswer,
    reconnect,
    disconnect,
  };
}
