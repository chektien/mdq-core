// ──────────────────────────────────────────────
// mdq shared contracts
// Single source of truth for types, events, REST
// paths, and session state transitions.
// ──────────────────────────────────────────────

// ── Session States ──────────────────────────
export const SESSION_STATES = [
  "LOBBY",
  "QUESTION_OPEN",
  "QUESTION_CLOSED",
  "REVEAL",
  "LEADERBOARD",
  "ENDED",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

/**
 * Valid state transitions. Key = current state, value = set of allowed next states.
 * Transitions are instructor-controlled except QUESTION_OPEN -> QUESTION_CLOSED
 * which also happens automatically when the timer expires.
 */
export const STATE_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  LOBBY: ["QUESTION_OPEN"],
  QUESTION_OPEN: ["QUESTION_CLOSED", "ENDED"],
  QUESTION_CLOSED: ["REVEAL"],
  REVEAL: ["QUESTION_OPEN", "LEADERBOARD"],
  LEADERBOARD: ["REVEAL", "ENDED"],
  ENDED: [],
};

// ── Socket.IO Event Names ───────────────────
export const SocketEvents = {
  // Client -> Server
  STUDENT_JOIN: "student:join",
  ANSWER_SUBMIT: "answer:submit",

  // Server -> Client (targeted)
  STUDENT_JOINED: "student:joined",
  STUDENT_REJECTED: "student:rejected",
  ANSWER_ACCEPTED: "answer:accepted",
  ANSWER_REJECTED: "answer:rejected",

  // Server -> Instructor
  SESSION_PARTICIPANTS: "session:participants",
  ANSWER_COUNT: "answer:count",
  RESULTS_DISTRIBUTION: "results:distribution",

  // Server -> All
  QUESTION_OPEN: "question:open",
  QUESTION_TICK: "question:tick",
  QUESTION_CLOSE: "question:close",
  RESULTS_REVEAL: "results:reveal",
  LEADERBOARD_UPDATE: "leaderboard:update",
  SESSION_STATE: "session:state",
} as const;

// ── Socket.IO Payload Types ─────────────────

export interface StudentJoinPayload {
  studentId: string;
  displayName?: string;
  sessionToken?: string;
  clientInstanceId?: string;
}

export interface StudentJoinedPayload {
  participantId: string;
  sessionToken: string;
  sessionState: SessionState;
  currentQuestion?: number;
  answeredQuestions?: number[]; // question indices already answered
}

export interface StudentRejectedPayload {
  reason: string;
}

export type QuestionType = "multiple_choice" | "poll" | "open_response" | "slide";
export type DeckTheme = "dark" | "light";

export interface FoldoutNote {
  id: string;
  scope: "section" | "bullet";
  audience: "presenter" | "attendee";
  title?: string;
  bodyMd: string;
  bodyHtml: string;
}

export type MediaPosition = "right" | "left" | "top" | "bottom" | "background";

/**
 * Presenter notes delivered to the instructor controller only, via the
 * instructor-authenticated GET /api/deck/:week/presenter-notes endpoint.
 * They are never broadcast on any session/socket payload. When the
 * `presenterNotes` runtime config is disabled the server returns
 * `enabled: false` with an empty `items` list so no UI can render.
 */
export interface PresenterNoteItem {
  questionIndex: number;
  notes: FoldoutNote[];
}

export interface PresenterNotesResponse {
  enabled: boolean;
  defaultOpen: boolean;
  items: PresenterNoteItem[];
}

/**
 * A contained, clickable playable-video card for a slide. Rendered as a
 * poster thumbnail with a visible fallback link; clicking opens a modal
 * player. Audience-safe (public embed URL), so it is carried on the
 * question:open payload for the projector, unlike presenter notes.
 */
export interface SlideVideo {
  embedUrl: string;
  thumbnail?: string;
  caption?: string;
  label?: string;
}

export interface SlideMedia {
  src: string;
  alt: string;
  title?: string;
  position?: MediaPosition;
  opacity?: number;
  /**
   * Optional grouping label. Images sharing a group render together under a
   * group heading (e.g. a "BEFORE" cluster next to an "AFTER" result). Set on
   * a slide with the `media-group: <label>` directive, which applies to every
   * image that follows it until the next directive. Generic and deck-agnostic.
   */
  group?: string;
}

export interface SlideBackground {
  src: string;
  position?: string;
  size?: string;
}

export interface SlideReference {
  id: string;
  textMd: string;
  html: string;
}

export interface SlideLiveEmbed {
  url: string;
  titleOverlay?: boolean;
  interactive?: boolean;
}

export interface OpenResponseEntry {
  studentId: string;
  displayName?: string;
  responseText: string;
  submittedAt: number;
}

export interface QuestionOpenPayload {
  questionIndex: number;
  topic: string;
  text: string; // rendered HTML
  questionType?: QuestionType;
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
  isPoll?: boolean;
  timeLimitSec: number;
  startedAt: number; // unix ms
}

export interface QuestionTickPayload {
  remainingSec: number;
}

export interface AnswerSubmitPayload {
  questionIndex: number;
  selectedOptions?: string[];
  responseText?: string;
}

export interface AnswerAcceptedPayload {
  questionIndex: number;
}

export interface AnswerRejectedPayload {
  questionIndex: number;
  reason: string;
}

export interface AnswerCountPayload {
  questionIndex: number;
  submitted: number;
  total: number;
  openResponses?: OpenResponseEntry[];
}

export interface QuestionClosePayload {
  questionIndex: number;
}

export interface ResultsDistributionPayload {
  questionIndex: number;
  distribution: Record<string, number>;
}

export interface ResultsRevealPayload {
  questionIndex: number;
  questionType?: QuestionType;
  correctOptions: string[];
  explanation: string;
  distribution: Record<string, number>;
  isPoll?: boolean;
  openResponses?: OpenResponseEntry[];
}

export interface LeaderboardEntry {
  rank: number;
  studentId: string;
  displayName?: string;
  correctCount: number;
  totalTimeMs: number;
}

export interface LeaderboardUpdatePayload {
  entries: LeaderboardEntry[];
  totalQuestions: number;
}

export interface SessionStatePayload {
  state: SessionState;
  questionIndex?: number;
}

export interface SessionParticipantsPayload {
  count: number;
  participants: { studentId: string; displayName?: string }[];
}

// ── REST API Paths ──────────────────────────
export const API = {
  HEALTH: "/api/health",
  INSTRUCTOR_LOGIN: "/api/instructor/login",
  INSTRUCTOR_SESSION: "/api/instructor/session",
  INSTRUCTOR_LOGOUT: "/api/instructor/logout",
  DECKS: "/api/decks",
  DECKS_RELOAD: "/api/decks/reload",
  DECK: "/api/deck/:week",
  DECK_PRESENTER_NOTES: "/api/deck/:week/presenter-notes",
  QUIZZES: "/api/quizzes",
  QUIZZES_RELOAD: "/api/quizzes/reload",
  QUIZ: "/api/quiz/:week",
  SESSION_CREATE: "/api/session",
  SESSION_START: "/api/session/:id/start",
  SESSION_PREV: "/api/session/:id/prev",
  SESSION_NEXT: "/api/session/:id/next",
  SESSION_CLOSE: "/api/session/:id/close",
  SESSION_REVEAL: "/api/session/:id/reveal",
  SESSION_END: "/api/session/:id/end",
  SESSION_LEADERBOARD: "/api/session/:id/leaderboard",
  SESSION_LEADERBOARD_SHOW: "/api/session/:id/leaderboard-show",
  SESSION_LEADERBOARD_HIDE: "/api/session/:id/leaderboard-hide",
  SESSION_STATE_RESTORE: "/api/session/:id/state",
  SESSION_ACCESS_INFO: "/api/session/:id/access-info",
  SESSION_PRESENTATION: "/api/session/:id/presentation",
  SESSION_BY_CODE: "/api/session/by-code/:code",
  ACCESS_INFO: "/api/access-info",
  QR_CODE: "/api/qr/:sessionId.png",
  CUMULATIVE_LEADERBOARD: "/api/leaderboard/cumulative",
} as const;

// ── Data Model Types ────────────────────────

export interface QuestionOption {
  label: string;
  textMd: string;
  textHtml: string;
}

export interface Question {
  index: number;
  topic: string;
  subtopic?: string;
  textMd: string;
  textHtml: string;
  questionType?: QuestionType;
  attendeeNotes?: FoldoutNote[];
  presenterNotes?: FoldoutNote[];
  slideMedia?: SlideMedia[];
  slideMediaPosition?: MediaPosition;
  slideMediaOpacity?: number;
  slideBackground?: SlideBackground;
  slideLiveEmbed?: SlideLiveEmbed;
  slideVideo?: SlideVideo;
  slideReferences?: SlideReference[];
  options: QuestionOption[];
  correctOptions: string[];
  allowsMultiple: boolean;
  isPoll?: boolean;
  explanation: string;
  timeLimitSec: number;
}

export interface Quiz {
  week: string;
  title: string;
  /** Optional per-deck color theme. The runtime theme remains the fallback. */
  theme?: DeckTheme;
  /** Optional per-deck override. `false` disables globally enabled presenter notes. */
  presenterNotes?: boolean;
  /** Optional per-deck override for the panel's initial expanded state. */
  presenterNotesDefaultOpen?: boolean;
  questions: Question[];
  sourceFile: string;
}

export type SessionMode = "strict" | "open";

export interface Participant {
  studentId: string;
  displayName?: string;
  sessionToken: string;
  clientInstanceId?: string;
  socketId: string;
  joinedAt: number;
  connected: boolean;
}

export interface Submission {
  studentId: string;
  questionIndex: number;
  selectedOptions: string[];
  responseText?: string;
  submittedAt: number;
  responseTimeMs: number;
}

export interface Session {
  sessionId: string;
  sessionCode: string;
  week: string;
  mode: SessionMode;
  state: SessionState;
  currentQuestionIndex: number;
  questionStartedAt?: number;
  revealedQuestionIndexes?: Set<number>;
  participants: Map<string, Participant>;
  submissions: Submission[];
  createdAt: number;
}

// ── Persistence Types ───────────────────────

/** Snapshot of a session written to data/sessions/<id>.json on session end */
export interface SessionSnapshot {
  sessionId: string;
  sessionCode: string;
  week: string;
  mode: SessionMode;
  questionCount: number;
  participantCount: number;
  participants: { studentId: string; displayName?: string; joinedAt: number }[];
  createdAt: number;
  endedAt: number;
}

/** Per-week leaderboard results written to data/winners/weekNN.json */
export interface WeeklyResult {
  week: string;
  sessionId: string;
  totalQuestions: number;
  completedAt: number;
  entries: LeaderboardEntry[];
}

/** Cumulative leaderboard entry derived from all weekly results */
export interface CumulativeLeaderboardEntry {
  rank: number;
  studentId: string;
  displayName?: string;
  totalCorrect: number;
  totalTimeMs: number;
  weeksParticipated: number;
}

/** Access info returned by /api/access-info */
export interface AccessInfo {
  fullUrl: string;
  shortUrl: string;
  qrCodeDataUrl: string;
  qrTargetUrl: string;
  presentationUrl?: string;
  source: "public-override" | "tailscale" | "lan-fallback";
  warning?: string;
  detectedAt: number;
}

// ── REST API Paths (additional) ─────────────
// (The API object above includes ACCESS_INFO and QR_CODE already)

// ── Constants ───────────────────────────────
export const DEFAULT_TIME_LIMIT_SEC = 35;
export const SESSION_CODE_LENGTH = 6;
export const DEFAULT_PORT = 3000;
export const TICK_INTERVAL_MS = 1000;
export const DATA_DIR = "data";

export * from "./setting-keys";
