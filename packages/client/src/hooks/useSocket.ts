import { io, type Socket } from "socket.io-client";
import { useState, useEffect, useCallback, useRef } from "react";
import type {
  SessionState,
  StudentJoinedPayload,
  QuestionOpenPayload,
  QuestionTickPayload,
  AnswerCountPayload,
  ResultsRevealPayload,
  ResultsDistributionPayload,
  LeaderboardUpdatePayload,
  SessionStatePayload,
  SessionParticipantsPayload,
  LeaderboardEntry,
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
} from "@mdq/shared";
import { SocketEvents } from "@mdq/shared";

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
      const match = line.match(/^(slide_background|slide_background_position|slide_background_size):\s*(.+)$/i);
      if (!match) return whole;
      paragraphValues.set(match[1].toLowerCase(), match[2].trim().replace(/^['"]|['"]$/g, ""));
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
  answeredQuestions: number[];

  // Question
  currentQuestion: QuestionState | null;
  remainingSec: number;
  answerCount: AnswerCountPayload | null;
  submitted: boolean;
  submittedOptions: string[];
  submittedResponseText: string | null;

  // Reveal
  reveal: RevealState | null;
  distribution: ResultsDistributionPayload | null;

  // Leaderboard
  leaderboard: LeaderboardEntry[];
  totalQuestions: number;

  // Participants
  participants: SessionParticipantsPayload | null;

  // Actions
  joinSession: (studentId: string, displayName?: string) => void;
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
  const submittedOptionsRef = useRef<string[]>([]);
  const submittedResponseTextRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [studentIdState, setStudentIdState] = useState<string | null>(null);
  const [answeredQuestions, setAnsweredQuestions] = useState<number[]>([]);

  const [currentQuestion, setCurrentQuestion] = useState<QuestionState | null>(null);
  const [remainingSec, setRemainingSec] = useState(0);
  const [answerCount, setAnswerCount] = useState<AnswerCountPayload | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submittedOptions, setSubmittedOptions] = useState<string[]>([]);
  const [submittedResponseText, setSubmittedResponseText] = useState<string | null>(null);

  const [reveal, setReveal] = useState<RevealState | null>(null);
  const [distribution, setDistribution] = useState<ResultsDistributionPayload | null>(null);

  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [totalQuestions, setTotalQuestions] = useState(0);

  const [participants, setParticipants] = useState<SessionParticipantsPayload | null>(null);

  useEffect(() => {
    currentQuestionRef.current = currentQuestion;
  }, [currentQuestion]);

  useEffect(() => {
    studentIdRef.current = studentIdState;
  }, [studentIdState]);

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
      setSessionState(data.sessionState);
      setAnsweredQuestions(data.answeredQuestions || []);
      answeredQuestionsRef.current = data.answeredQuestions || [];
      setError(null);

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
      currentQuestionRef.current = nextQuestion;
      setCurrentQuestion(nextQuestion);
      setSessionState("QUESTION_OPEN");
      setReveal(null);
      setDistribution(null);
      // Reveal/reconnect snapshots replay question context before reveal details.
      // Preserve the local answer when that replay is for the same question.
      const alreadyAnswered = answeredQuestionsRef.current.includes(data.questionIndex);
      const shouldPreserveSubmission = isSameQuestion && alreadyAnswered;
      setSubmitted(alreadyAnswered);
      setSubmittedOptions(shouldPreserveSubmission ? submittedOptionsRef.current : []);
      setSubmittedResponseText(shouldPreserveSubmission ? submittedResponseTextRef.current : null);
      setRemainingSec(data.timeLimitSec);
    });

    socket.on(SocketEvents.QUESTION_TICK, (data: QuestionTickPayload) => {
      setRemainingSec(data.remainingSec);
    });

    socket.on(SocketEvents.QUESTION_CLOSE, () => {
      setSessionState("QUESTION_CLOSED");
      setRemainingSec(0);
    });

    socket.on(SocketEvents.ANSWER_ACCEPTED, (data: { questionIndex: number }) => {
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
        const participantId = studentIdRef.current;
        if (
          !participantId
          || !current
          || current.questionType !== "open_response"
          || current.questionIndex !== data.questionIndex
        ) {
          return prev;
        }

        const ownResponse = data.openResponses?.find((entry) => entry.studentId === participantId);
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

  const joinSession = useCallback(
    (studentId: string, displayName?: string) => {
      if (!socketRef.current) return;
      const stored = loadStoredSession();
      const token = stored?.sessionId === sessionId ? stored.sessionToken : undefined;
      socketRef.current.emit(SocketEvents.STUDENT_JOIN, {
        studentId: studentId.trim(),
        displayName: displayName?.trim() || undefined,
        sessionToken: token,
        clientInstanceId: getClientInstanceId(),
      });
      setStudentIdState(studentId.trim());
    },
    [sessionId],
  );

  const submitAnswer = useCallback(
    (payload: AnswerSubmitPayload) => {
      if (!socketRef.current) return;
      socketRef.current.emit(SocketEvents.ANSWER_SUBMIT, payload);
      const nextSubmittedOptions = payload.selectedOptions ?? [];
      const nextSubmittedResponseText = payload.responseText?.trim() || null;
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
  }, []);

  return {
    connected,
    error,
    sessionState,
    sessionToken,
    studentId: studentIdState,
    answeredQuestions,
    currentQuestion,
    remainingSec,
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
