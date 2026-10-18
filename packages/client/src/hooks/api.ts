import { API } from "@mdq/shared";
import type {
  SessionPolicy,
  SessionAvailabilityPayload,
  ParseDiagnostic,
  AccessInfo,
  DeckPalette,
  DeckTheme,
  PresenterNotesResponse,
  QuestionOpenPayload,
  QuestionType,
  ResultsRevealPayload,
} from "@mdq/shared";

const BASE = "";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Safari can leave a fetch pending indefinitely when the phone changes network
 * or wakes from the background. Bound every API request so UI busy states can
 * always recover and the caller can reconcile against the server afterwards.
 */
async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new Error("Connection timed out. Check your connection and try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

function apiPath(template: string, params: Record<string, string> = {}): string {
  let path = template;
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`:${key}`, value);
  }
  return `${BASE}${path}`;
}

export interface DeckSummary {
  week: string;
  title: string;
  /** Effective theme after applying the runtime fallback. */
  theme: DeckTheme;
  /** Effective slide palette after applying the runtime fallback. */
  palette: DeckPalette;
  /** Total live items, including slides. Kept for progress/restore compatibility. */
  questionCount: number;
  /** Interactive quiz/poll/open-response items, excluding slides. */
  liveQuestionCount?: number;
  slideCount?: number;
  /** Header settings the deck wrote that were ignored. The deck still loads. */
  diagnostics?: ParseDiagnostic[];
}

export type QuizSummary = DeckSummary;

export interface QuestionSummary {
  timeLimitSec?: number | null;
  heading: string;
  questionType: QuestionType;
}

export interface CreateSessionResponse {
  policy?: SessionPolicy;
  availability?: SessionAvailabilityPayload;
  sessionId: string;
  sessionCode: string;
  joinUrl: string;
  theme: DeckTheme;
  palette: DeckPalette;
  questionHeadings: string[];
  questionSummaries: QuestionSummary[];
  /** False when the deck turns Student IDs off, so the name is the ID. Absent means true. */
  studentIds?: boolean;
}

export interface SessionRestoreResponse {
  availability?: SessionAvailabilityPayload;
  policy?: SessionPolicy | null;
  policyFrozen?: boolean;
  effectiveRanking?: "correctness" | "speed" | "legacy";
  sessionId: string;
  sessionCode: string;
  week: string;
  /** The deck's title, when it has one. */
  title?: string;
  theme: DeckTheme;
  palette: DeckPalette;
  state: string;
  currentQuestionIndex: number;
  questionCount: number;
  questionHeadings: string[];
  questionSummaries: QuestionSummary[];
  /** False when the deck turns Student IDs off, so the name is the ID. Absent means true. */
  studentIds?: boolean;
  reviewQuestions?: QuestionOpenPayload[];
  reviewReveals?: ResultsRevealPayload[];
}

export interface PresentationSessionResponse {
  availability?: SessionAvailabilityPayload;
  sessionId: string;
  sessionCode: string;
  week: string;
  /** The deck's title, when it has one. */
  title?: string;
  theme: DeckTheme;
  palette: DeckPalette;
  state: string;
  questionCount: number;
  questionHeadings: string[];
  questionSummaries: QuestionSummary[];
  accessInfo: AccessInfo;
}

export interface InstructorSessionStatus {
  authenticated: boolean;
  configured: boolean;
}

export interface RuntimeClientConfig {
  theme?: "dark" | "light";
  palette?: DeckPalette;
  autoGenerateStudentIds?: boolean;
  presenterNotes?: boolean;
  presenterNotesDefaultOpen?: boolean;
}

export async function fetchRuntimeClientConfig(): Promise<RuntimeClientConfig> {
  const res = await fetchWithTimeout("/api/runtime-config");
  if (!res.ok) throw new Error("Failed to fetch runtime config");
  return res.json();
}

/**
 * Instructor-only presenter notes for a deck. Requires an authenticated
 * instructor session when instructor auth is enabled. Returns
 * `{ enabled: false, items: [] }` when the feature is disabled by config,
 * so callers render no presenter-notes UI in that case.
 */
export async function fetchPresenterNotes(week: string): Promise<PresenterNotesResponse> {
  const res = await fetchWithTimeout(apiPath(API.DECK_PRESENTER_NOTES, { week }), {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error("Failed to fetch presenter notes");
  return res.json();
}

export async function fetchInstructorSessionStatus(): Promise<InstructorSessionStatus> {
  const res = await fetchWithTimeout(apiPath(API.INSTRUCTOR_SESSION), { credentials: "same-origin" });
  if (!res.ok) throw new Error("Failed to verify instructor session");
  return res.json();
}

export async function loginInstructor(password: string): Promise<void> {
  const res = await fetchWithTimeout(apiPath(API.INSTRUCTOR_LOGIN), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to log in as instructor");
  }
}

export async function fetchDecks(): Promise<DeckSummary[]> {
  const res = await fetchWithTimeout(apiPath(API.DECKS));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to fetch decks");
  }
  return res.json();
}

export const fetchQuizzes = fetchDecks;

export interface ReloadDecksResponse {
  loaded: number;
  quizzes: DeckSummary[];
}

export type ReloadQuizzesResponse = ReloadDecksResponse;

export async function reloadDecks(): Promise<ReloadDecksResponse> {
  const res = await fetchWithTimeout(apiPath(API.DECKS_RELOAD), {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to reload decks");
  }
  return res.json();
}

export const reloadQuizzes = reloadDecks;

export async function createSession(week: string, mode: string = "open", options?: number | { pacing: SessionPolicy["pacing"]; availableUntil?: number; availableForMs?: number }): Promise<CreateSessionResponse> {
  const res = await fetchWithTimeout(apiPath(API.SESSION_CREATE), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ week, mode, ...(typeof options === "number" ? { availableUntil: options } : options ?? {}) }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to create session");
  }
  return res.json();
}

async function sessionAction(sessionId: string, action: string, body?: object): Promise<Record<string, unknown>> {
  const pathTemplate = (API as Record<string, string>)[`SESSION_${action.toUpperCase()}`];
  if (!pathTemplate) throw new Error(`Unknown action: ${action}`);
  const res = await fetchWithTimeout(apiPath(pathTemplate, { id: sessionId }), {
    method: "POST",
    credentials: "same-origin",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to ${action}`);
  }
  return res.json();
}

export async function configureSessionPolicy(sessionId: string, pacing: SessionPolicy["pacing"], ranking?: "correctness" | "speed") {
  const response = await fetchWithTimeout(apiPath(API.SESSION_POLICY, { id: sessionId }), {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pacing, ...(ranking !== undefined ? { ranking } : {}) }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Session pacing could not be saved");
  }
  return response.json();
}

export async function startSession(sessionId: string) {
  return sessionAction(sessionId, "START");
}

export async function prevQuestion(sessionId: string) {
  return sessionAction(sessionId, "PREV");
}

export async function nextQuestion(sessionId: string) {
  return sessionAction(sessionId, "NEXT");
}

export async function closeQuestion(sessionId: string, opening?: { questionIndex: number; startedAt: number }) {
  return sessionAction(sessionId, "CLOSE", opening);
}

export async function restartCountdown(sessionId: string) {
  return sessionAction(sessionId, "RESTART_COUNTDOWN");
}

export async function revealAnswer(sessionId: string) {
  return sessionAction(sessionId, "REVEAL");
}

export async function endSession(sessionId: string) {
  return sessionAction(sessionId, "END");
}

/** Hide one open response from the projector, or show it again. */
export async function setResponseHidden(sessionId: string, questionIndex: number, publicKey: string, hidden: boolean): Promise<void> {
  const res = await fetchWithTimeout(apiPath(API.SESSION_RESPONSE_VISIBILITY, { id: sessionId }), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionIndex, publicKey, hidden }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "That did not work. Please try again.");
  }
}

/** Show or hide all responses already submitted to the current item. */
export async function setAllResponsesHidden(sessionId: string, questionIndex: number, hidden: boolean): Promise<void> {
  const res = await fetchWithTimeout(apiPath(API.SESSION_RESPONSES_VISIBILITY, { id: sessionId }), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionIndex, hidden }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "That did not work. Please try again.");
  }
}

/** Show or hide a poll's live results for the room. */
export async function setLiveResults(sessionId: string, questionIndex: number, visible: boolean): Promise<void> {
  const res = await fetchWithTimeout(apiPath(API.SESSION_LIVE_RESULTS, { id: sessionId }), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ questionIndex, visible }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "That did not work. Please try again.");
  }
}

/** Free one participant's seat so the next join with their ID (or name) from any device takes it over. */
export async function releaseSeat(sessionId: string, publicKey: string): Promise<void> {
  const res = await fetchWithTimeout(apiPath(API.SESSION_RELEASE_SEAT, { id: sessionId }), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "That did not work. Please try again.");
  }
}

/** Stop new participants joining (or allow them again). Anyone who already has a seat can still rejoin it. */
export async function setJoinLocked(sessionId: string, locked: boolean): Promise<void> {
  const res = await fetchWithTimeout(apiPath(API.SESSION_JOIN_LOCK, { id: sessionId }), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locked }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "That did not work. Please try again.");
  }
}

/** Where the instructor downloads the session's results as a CSV file. */
export function resultsCsvUrl(sessionId: string): string {
  return apiPath(API.SESSION_RESULTS_CSV, { id: sessionId });
}

export async function showLeaderboard(sessionId: string): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(apiPath(API.SESSION_LEADERBOARD_SHOW, { id: sessionId }), {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to show leaderboard");
  }
  return res.json();
}

export async function hideLeaderboard(sessionId: string): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(apiPath(API.SESSION_LEADERBOARD_HIDE, { id: sessionId }), {
    method: "POST",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to return to quiz");
  }
  return res.json();
}

export async function fetchLeaderboard(sessionId: string) {
  const res = await fetchWithTimeout(apiPath(API.SESSION_LEADERBOARD, { id: sessionId }));
  if (!res.ok) throw new Error("Failed to fetch leaderboard");
  return res.json();
}

export async function fetchAccessInfo(): Promise<AccessInfo> {
  const res = await fetchWithTimeout(apiPath(API.ACCESS_INFO));
  if (!res.ok) throw new Error("Failed to fetch access info");
  return res.json();
}

export async function fetchSessionAccessInfo(sessionId: string): Promise<AccessInfo> {
  const res = await fetchWithTimeout(apiPath(API.SESSION_ACCESS_INFO, { id: sessionId }), {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error("Failed to fetch session access info");
  return res.json();
}

export async function fetchSessionStateForRestore(sessionId: string): Promise<SessionRestoreResponse> {
  const res = await fetchWithTimeout(apiPath(API.SESSION_STATE_RESTORE, { id: sessionId }), {
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to restore session state");
  }
  return res.json();
}

export async function fetchPresentationSession(sessionId: string): Promise<PresentationSessionResponse> {
  const res = await fetchWithTimeout(apiPath(API.SESSION_PRESENTATION, { id: sessionId }), {
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to load projector session");
  }
  return res.json();
}

export async function configureSessionAvailability(sessionId: string, choice: number | { availableUntil: number } | { extendForMs: number }): Promise<SessionAvailabilityPayload> {
  const response = await fetchWithTimeout(apiPath(API.SESSION_AVAILABILITY, { id: sessionId }), {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(typeof choice === "number" ? { availableUntil: choice } : choice),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Availability could not be updated");
  }
  return response.json();
}
