import express, { type Request, type Response } from "express";
import cors from "cors";
import { API, AccessInfo, CumulativeLeaderboardEntry, PublicCumulativeLeaderboardEntry, DeckPalette, DeckTheme, JoinLockRequest, Quiz, ReleaseSeatRequest, ResponseVisibilityRequest, Session, SessionState, usesStudentIds } from "@mdq/shared";
import {
  createSession,
  storeSession,
  getSession,
  getSessionByCode,
  StateTransitionError,
  getActiveSessions,
  getDistribution,
  getOpenResponses,
} from "./session";
import { parseQuizMarkdown } from "./parser";
import { apply, leaderboardRows, questionPosition, responsesFor, EngineCommandError, type Command, type EngineResult } from "./engine";
import {
  persistSessionOnEnd,
  computeCumulativeLeaderboard,
  persistSessionProgressOnReveal,
  buildSessionResultsCsv,
} from "./persistence";
import { getQuestionType, getScoredQuestionCount, isOpenResponseQuestion } from "./scoring";
import { getCachedAccessInfo, generateQrDataUrl, generateShortUrl, type ShortUrlProvider } from "./access-info";
import {
  INSTRUCTOR_SESSION_COOKIE,
  isInstructorAuthEnabled,
  verifyInstructorPassword,
  createInstructorSession,
  revokeInstructorSession,
  getInstructorSessionFromCookie,
  hasValidInstructorSession,
} from "./instructor-auth";
import * as fs from "fs";
import * as path from "path";

export interface AppOptions {
  quizDir?: string;
  dataDir?: string;
  instanceId?: string;
  theme?: "dark" | "light";
  palette?: DeckPalette;
  autoGenerateStudentIds?: boolean;
  presenterNotes?: boolean;
  presenterNotesDefaultOpen?: boolean;
  shortUrlProviders?: ShortUrlProvider[];
  /** Called after a successful REST-driven state transition */
  onStateChange?: (session: Session, sessionId: string, newState: SessionState, quiz?: Quiz, result?: EngineResult) => void;
  /** Called with the messages of a REST-driven change that is not a state transition, so the timers stay as they are. */
  onMessages?: (session: Session, sessionId: string, result: EngineResult) => void;
}

function resolveDeckTheme(q: Quiz, fallbackTheme: DeckTheme): DeckTheme {
  return q.theme ?? fallbackTheme;
}

function resolveDeckPalette(q: Quiz, fallbackPalette: DeckPalette): DeckPalette {
  return q.palette ?? fallbackPalette;
}

function summarizeQuizForList(q: Quiz, fallbackTheme: DeckTheme, fallbackPalette: DeckPalette) {
  const slideCount = q.questions.filter((question) => question.questionType === "slide").length;
  return {
    week: q.week,
    title: q.title,
    theme: resolveDeckTheme(q, fallbackTheme),
    palette: resolveDeckPalette(q, fallbackPalette),
    questionCount: q.questions.length,
    liveQuestionCount: q.questions.length - slideCount,
    slideCount,
  };
}

function normalizeDeckTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasWeekPrefix(deckId: string): boolean {
  return /^week\d+(?:-|$)/i.test(deckId);
}

function compareDecksForList(a: Quiz, b: Quiz): number {
  if (a.week === "featured-demo" && b.week !== "featured-demo") return -1;
  if (b.week === "featured-demo" && a.week !== "featured-demo") return 1;

  const aWeek = a.week.match(/^week(\d+)/i)?.[1];
  const bWeek = b.week.match(/^week(\d+)/i)?.[1];
  if (aWeek && bWeek && aWeek !== bWeek) {
    return Number(aWeek) - Number(bWeek);
  }
  if (aWeek && !bWeek) return -1;
  if (!aWeek && bWeek) return 1;
  return a.title.localeCompare(b.title, undefined, { numeric: true }) || a.week.localeCompare(b.week, undefined, { numeric: true });
}

function shouldReplaceDuplicateDeck(existing: Quiz, candidate: Quiz): boolean {
  const existingHasWeekPrefix = hasWeekPrefix(existing.week);
  const candidateHasWeekPrefix = hasWeekPrefix(candidate.week);
  if (existingHasWeekPrefix !== candidateHasWeekPrefix) {
    return !candidateHasWeekPrefix;
  }
  return candidate.week.localeCompare(existing.week, undefined, { numeric: true }) < 0;
}

/** Saved-results rows for callers who may not see Student IDs: a label instead of the ID, in the same rank order. */
export function publicCumulativeEntries(entries: CumulativeLeaderboardEntry[]): PublicCumulativeLeaderboardEntry[] {
  const used = new Set<string>();
  return entries.map(({ studentId: _studentId, displayName, ...rest }) => {
    const base = displayName?.trim() || `Participant ${rest.rank}`;
    let label = base;
    for (let n = 2; used.has(label.toLowerCase()); n++) label = `${base} (${n})`;
    used.add(label.toLowerCase());
    return { ...rest, label };
  });
}

/** A safe download name from the deck title and the session's date, e.g. `week-1-quiz-results-2026-03-04.csv`. */
export function resultsFileName(title: string, createdAt: number): string {
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  const d = new Date(createdAt);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${slug || "session"}-results-${date}.csv`;
}

/** A participant's public key is a UUID; anything much longer is not one. */
const MAX_PUBLIC_KEY_LENGTH = 128;

export function createApp(quizDirOrOpts?: string | AppOptions) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  /**
   * True only for a request that proved it is the instructor: a login is
   * configured and this request carries a valid instructor cookie. Without a
   * configured login nobody can prove it, so this is false for everyone.
   * Student IDs only go out over REST when this is true.
   */
  function isAuthenticatedInstructor(req: express.Request): boolean {
    if (!isInstructorAuthEnabled()) return false;
    const sessionToken = getInstructorSessionFromCookie(req.header("cookie"));
    return !!sessionToken && hasValidInstructorSession(sessionToken);
  }

  function requireInstructorAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (!isInstructorAuthEnabled()) {
      next();
      return;
    }

    if (!isAuthenticatedInstructor(req)) {
      res.status(401).json({ error: "Instructor login required" });
      return;
    }

    next();
  }

  // Parse options
  let quizDir: string | undefined;
  let dataDir: string | undefined;
  let instanceId: string | undefined;
  let theme: "dark" | "light" = "dark";
  let palette: DeckPalette = "classic";
  let autoGenerateStudentIds = false;
  let presenterNotesEnabled = false;
  let presenterNotesDefaultOpen = false;
  let shortUrlProviders: ShortUrlProvider[] | undefined;
  let onStateChange: AppOptions["onStateChange"];
  let onMessages: AppOptions["onMessages"];
  if (typeof quizDirOrOpts === "string") {
    quizDir = quizDirOrOpts;
  } else if (quizDirOrOpts) {
    quizDir = quizDirOrOpts.quizDir;
    dataDir = quizDirOrOpts.dataDir;
    instanceId = quizDirOrOpts.instanceId;
    theme = quizDirOrOpts.theme || "dark";
    palette = quizDirOrOpts.palette || "classic";
    autoGenerateStudentIds = quizDirOrOpts.autoGenerateStudentIds || false;
    presenterNotesEnabled = quizDirOrOpts.presenterNotes || false;
    presenterNotesDefaultOpen = quizDirOrOpts.presenterNotesDefaultOpen || false;
    shortUrlProviders = quizDirOrOpts.shortUrlProviders;
    onStateChange = quizDirOrOpts.onStateChange;
    onMessages = quizDirOrOpts.onMessages;
  }
  const resolvedInstanceId = (instanceId || process.env.MDQ_INSTANCE_ID || "").trim() || `pid-${process.pid}`;
  const imagesDir = dataDir ? path.join(dataDir, "images") : undefined;
  const videosDir = dataDir ? path.join(dataDir, "videos") : undefined;

  app.use((_req, res, next) => {
    res.setHeader("x-mdq-instance-id", resolvedInstanceId);
    next();
  });

  if (imagesDir && fs.existsSync(imagesDir)) {
    app.use("/data/images", express.static(imagesDir, {
      fallthrough: true,
      index: false,
      immutable: false,
      maxAge: 0,
    }));
  }

  if (videosDir && fs.existsSync(videosDir)) {
    app.use("/data/videos", express.static(videosDir, {
      fallthrough: true,
      index: false,
      immutable: false,
      maxAge: 0,
    }));
  }

  // ── Quiz store ──────────────────────────────
  const quizzes = new Map<string, Quiz>();
  let quizValidationErrors: ReturnType<typeof parseQuizMarkdown>["errors"] = [];

  function getQuestionHeading(question: Quiz["questions"][number]): string {
    return question.subtopic ? `${question.topic}: ${question.subtopic}` : question.topic;
  }

  function getQuestionHeadings(quiz: Quiz): string[] {
    return quiz.questions.map(getQuestionHeading);
  }

  function getQuestionSummaries(quiz: Quiz) {
    return quiz.questions.map((question) => ({
      heading: getQuestionHeading(question),
      questionType: getQuestionType(question),
    }));
  }

  function getReviewQuestions(session: Session, quiz: Quiz) {
    if (session.currentQuestionIndex < 0) {
      return [];
    }

    return quiz.questions.slice(0, session.currentQuestionIndex + 1).map((question, questionIndex) => ({
      questionIndex,
      topic: question.topic,
      text: question.textHtml,
      questionType: getQuestionType(question),
      ...questionPosition(quiz, questionIndex),
      attendeeNotes: question.attendeeNotes && question.attendeeNotes.length > 0
        ? question.attendeeNotes
        : undefined,
      slideMedia: question.slideMedia,
      slideBackground: question.slideBackground,
      slideLiveEmbed: question.slideLiveEmbed,
      slideVideo: question.slideVideo,
      slideReferences: question.slideReferences,
      ...(quiz.style ? { deckStyle: quiz.style } : {}),
      options: question.options.map((option) => ({ label: option.label, text: option.textHtml })),
      allowsMultiple: question.allowsMultiple,
      isPoll: question.isPoll === true,
      timeLimitSec: question.timeLimitSec,
      startedAt: questionIndex === session.currentQuestionIndex
        ? session.questionStartedAt || Date.now()
        : session.questionStartedAt || session.createdAt,
    }));
  }

  function getReviewReveals(session: Session, quiz: Quiz, view: "control" | "display") {
    if (session.currentQuestionIndex < 0) {
      return [];
    }

    const revealedThroughIndex =
      session.state === "QUESTION_OPEN" || session.state === "QUESTION_CLOSED"
        ? session.currentQuestionIndex - 1
        : session.currentQuestionIndex;

    if (revealedThroughIndex < 0) {
      return [];
    }

    return quiz.questions
      .slice(0, revealedThroughIndex + 1)
      .map((question, questionIndex) => ({ question, questionIndex }))
      .filter(({ question }) => getQuestionType(question) !== "slide")
      .map(({ question, questionIndex }) => ({
        questionIndex,
        questionType: getQuestionType(question),
        correctOptions: question.correctOptions,
        explanation: question.explanation,
        distribution: getDistribution(session, questionIndex),
        isPoll: question.isPoll === true,
        openResponses: isOpenResponseQuestion(question) ? responsesFor(getOpenResponses(session, questionIndex), view) : undefined,
      }));
  }

  function describeQuizValidationDetail(detail: string): string {
    if (detail.startsWith("No answer options found")) {
      return "This question has no answer choices, so MDQ cannot run it safely as a quiz question.";
    }
    if (detail.startsWith("Missing correct answer line")) {
      return "This question does not say which answer is correct.";
    }
    if (detail.includes("must not define correct answers")) {
      return "This open-ended or poll question still has a marked correct answer.";
    }
    if (detail.includes("must not define answer options")) {
      return "This open-ended question still has multiple-choice answer options.";
    }
    if (/must not use multi[-_]select/.test(detail)) {
      return "This open-ended question is using a multiple-choice setting that does not apply here.";
    }
    if (detail.startsWith("Unsupported type") || detail.startsWith("Unsupported question_type")) {
      return "This question uses a question type that MDQ does not support.";
    }
    if (detail.startsWith("Correct answer")) {
      return "This question points to an answer choice that does not exist.";
    }
    return "This quiz question has a formatting problem that needs to be fixed before class.";
  }

  function buildQuizValidationMessage(errors: ReturnType<typeof parseQuizMarkdown>["errors"]): string {
    const [firstError, ...rest] = errors;
    if (!firstError) {
      return "We couldn't load the quiz because a quiz file needs fixing.";
    }

    const location = `${firstError.sourceFile}:${firstError.lineNumber ?? 1}`;
    const extraCount = rest.length;
    const extraSuffix = extraCount > 0
      ? ` There ${extraCount === 1 ? "is 1 more issue" : `are ${extraCount} more issues`} after that.`
      : "";

    return `We couldn't load the deck because ${location} needs attention. ${describeQuizValidationDetail(firstError.detail)} Fix the markdown file and reload decks before starting a session.${extraSuffix}`;
  }

  function getQuizValidationMessage(): string | null {
    return quizValidationErrors.length > 0 ? buildQuizValidationMessage(quizValidationErrors) : null;
  }

  function loadQuizzesFromDir(dirPath: string): number {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      return 0;
    }
    const files = fs
      .readdirSync(dirPath)
      .filter((f) => f.endsWith(".md") && !f.startsWith("."))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const next = new Map<string, Quiz>();
    const deckIdByTitle = new Map<string, string>();
    const nextValidationErrors: ReturnType<typeof parseQuizMarkdown>["errors"] = [];

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const md = fs.readFileSync(filePath, "utf-8");
        const result = parseQuizMarkdown(md, file);
        if (result.errors.length > 0) {
          nextValidationErrors.push(...result.errors);
          console.warn(`Parse errors for ${file}:`, result.errors.map((e) => e.message));
          continue;
        }
        if (result.quiz) {
          const normalizedTitle = normalizeDeckTitle(result.quiz.title);
          const existingDeckId = normalizedTitle ? deckIdByTitle.get(normalizedTitle) : undefined;
          if (existingDeckId) {
            const existing = next.get(existingDeckId);
            if (existing && shouldReplaceDuplicateDeck(existing, result.quiz)) {
              next.delete(existingDeckId);
              next.set(result.quiz.week, result.quiz);
              deckIdByTitle.set(normalizedTitle, result.quiz.week);
            }
            continue;
          }
          next.set(result.quiz.week, result.quiz);
          if (normalizedTitle) {
            deckIdByTitle.set(normalizedTitle, result.quiz.week);
          }
        }
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code || "")
            : "";
        if (code === "ENOENT") {
          console.warn(`Skipping deleted deck file during load: ${file}`);
          continue;
        }
        throw error;
      }
    }

    quizzes.clear();
    for (const [week, quiz] of next.entries()) {
      quizzes.set(week, quiz);
    }
    quizValidationErrors = nextValidationErrors;
    return quizzes.size;
  }

  // Load quizzes from directory if provided
  if (quizDir) {
    loadQuizzesFromDir(quizDir);
  }

  /** Helper to get quiz for a session */
  function getQuizForSession(week: string): Quiz | undefined {
    return quizzes.get(week);
  }

  /** Notify state change if callback is set */
  function notifyStateChange(session: Session, sessionId: string, quiz?: Quiz, result?: EngineResult): void {
    if (onStateChange) {
      onStateChange(session, sessionId, session.state, quiz, result);
    }
  }

  function logActivity(message: string): void {
    console.log(`[mdq activity] ${message}`);
  }

  function buildJoinUrl(baseUrl: string, sessionCode: string): string {
    const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    // Use a clean path instead of hash-based URL so QR scanners don't strip
    // the fragment. The server redirects /join/:code to /#/join/:code.
    return `${normalized}/join/${sessionCode}`;
  }

  function buildPresentationUrl(baseUrl: string, sessionId: string): string {
    const normalized = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
    return `${normalized}/#/present/${sessionId}`;
  }

  async function buildSessionAccessInfo(baseUrl: string, sessionId: string, sessionCode: string): Promise<AccessInfo> {
    const baseInfo = getCachedAccessInfo() || {
      fullUrl: baseUrl,
      shortUrl: "",
      qrCodeDataUrl: "",
      qrTargetUrl: baseUrl,
      source: "lan-fallback" as const,
      warning: "Access info not yet detected. Server may still be starting.",
      detectedAt: Date.now(),
    };

    const joinFullUrl = buildJoinUrl(baseInfo.fullUrl, sessionCode);
    const joinShortUrl = await generateShortUrl(joinFullUrl, shortUrlProviders);
    const qrCodeDataUrl = await generateQrDataUrl(joinFullUrl);

    return {
      fullUrl: joinFullUrl,
      shortUrl: joinShortUrl,
      qrCodeDataUrl,
      qrTargetUrl: joinFullUrl,
      presentationUrl: buildPresentationUrl(baseInfo.fullUrl, sessionId),
      source: baseInfo.source,
      warning: baseInfo.warning,
      detectedAt: Date.now(),
    };
  }

  function getRequestBaseUrl(req: express.Request): string {
    const host = req.get("x-forwarded-host") || req.get("host");
    const forwardedProto = req.get("x-forwarded-proto");
    const protocol = (forwardedProto ? forwardedProto.split(",")[0] : req.protocol) || "http";

    if (host) {
      return `${protocol}://${host}`;
    }

    return `http://localhost:${process.env.PORT || 3000}`;
  }

  // Expose for testing and socket setup
  (app as unknown as { _quizzes: Map<string, Quiz>; _dataDir?: string })._quizzes = quizzes;
  (app as unknown as { _quizzes: Map<string, Quiz>; _dataDir?: string })._dataDir = dataDir;

  // ── Health ────────────────────────────────
  const startTime = Date.now();
  app.get(API.HEALTH, (_req, res) => {
    res.json({
      status: "ok",
      uptime: Date.now() - startTime,
      instanceId: resolvedInstanceId,
      pid: process.pid,
    });
  });

  app.get("/api/sessions/active", requireInstructorAuth, (_req, res) => {
    res.json(getActiveSessions());
  });

  app.get("/api/runtime-config", (_req, res) => {
    res.json({
      theme,
      palette,
      autoGenerateStudentIds,
      presenterNotes: presenterNotesEnabled,
      presenterNotesDefaultOpen,
    });
  });

  app.get(API.INSTRUCTOR_SESSION, (req, res) => {
    if (!isInstructorAuthEnabled()) {
      return res.json({ authenticated: true, configured: false });
    }
    const sessionToken = getInstructorSessionFromCookie(req.header("cookie"));
    return res.json({
      authenticated: !!sessionToken && hasValidInstructorSession(sessionToken),
      configured: true,
    });
  });

  app.post(API.INSTRUCTOR_LOGIN, (req, res) => {
    if (!isInstructorAuthEnabled()) {
      return res.status(400).json({ error: "Instructor password is not configured" });
    }
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!verifyInstructorPassword(password)) {
      return res.status(401).json({ error: "Invalid instructor password" });
    }

    const token = createInstructorSession();
    const forwardedProto = req.get("x-forwarded-proto");
    const protocol = (forwardedProto ? forwardedProto.split(",")[0] : req.protocol) || "http";
    const secure = protocol === "https";

    res.cookie(INSTRUCTOR_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
    });
    return res.status(204).send();
  });

  app.post(API.INSTRUCTOR_LOGOUT, (req, res) => {
    const sessionToken = getInstructorSessionFromCookie(req.header("cookie"));
    if (sessionToken) {
      revokeInstructorSession(sessionToken);
    }
    res.clearCookie(INSTRUCTOR_SESSION_COOKIE, { path: "/" });
    return res.status(204).send();
  });

  // ── Deck endpoints ────────────────────────
  const listDecksHandler = (_req: Request, res: Response) => {
    const validationMessage = getQuizValidationMessage();
    if (validationMessage) {
      return res.status(409).json({ error: validationMessage });
    }
    const list = [...quizzes.values()].sort(compareDecksForList).map((quiz) => summarizeQuizForList(quiz, theme, palette));
    return res.json(list);
  };

  const reloadDecksHandler = (_req: Request, res: Response) => {
    if (!quizDir) {
      return res.status(400).json({ error: "Deck directory is not configured" });
    }
    try {
      const loaded = loadQuizzesFromDir(quizDir);
      const validationMessage = getQuizValidationMessage();
      if (validationMessage) {
        return res.status(409).json({ error: validationMessage });
      }
      const list = [...quizzes.values()].sort(compareDecksForList).map((quiz) => summarizeQuizForList(quiz, theme, palette));
      return res.json({ loaded, quizzes: list });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to reload decks";
      return res.status(500).json({ error: message });
    }
  };

  app.get(API.DECKS, listDecksHandler);
  app.get(API.QUIZZES, listDecksHandler);
  app.post(API.DECKS_RELOAD, requireInstructorAuth, reloadDecksHandler);
  app.post(API.QUIZZES_RELOAD, requireInstructorAuth, reloadDecksHandler);

  const getDeckHandler = (req: Request, res: Response) => {
    const quiz = quizzes.get(req.params.week);
    if (!quiz) {
      return res.status(404).json({ error: `Deck not found: ${req.params.week}` });
    }
    res.json({
      week: quiz.week,
      title: quiz.title,
      theme: resolveDeckTheme(quiz, theme),
      palette: resolveDeckPalette(quiz, palette),
      questionCount: quiz.questions.length,
    });
  };

  app.get(API.DECK, getDeckHandler);
  app.get(API.QUIZ, getDeckHandler);

  // Instructor-only presenter notes. Never broadcast on any socket/session
  // payload. When disabled by config, returns enabled:false with no note
  // bodies so the client cannot render any presenter-notes UI.
  const getPresenterNotesHandler = (req: Request, res: Response) => {
    // Presenter notes are only served when the feature is enabled AND an
    // instructor password is configured. Without configured auth we cannot
    // guarantee the notes stay instructor-only (any LAN client could call
    // this endpoint), so we serve nothing rather than risk a leak.
    if (!presenterNotesEnabled || !isInstructorAuthEnabled()) {
      return res.json({ enabled: false, defaultOpen: false, items: [] });
    }
    const quiz = quizzes.get(req.params.week);
    if (!quiz) {
      return res.status(404).json({ error: `Deck not found: ${req.params.week}` });
    }
    // A deck may opt out of a globally enabled notes feature. It cannot opt in
    // when the global privacy gate or instructor authentication is unavailable.
    if (quiz.presenterNotes === false) {
      return res.json({ enabled: false, defaultOpen: false, items: [] });
    }
    const items = quiz.questions.map((question, index) => ({
      questionIndex: question.index ?? index,
      notes: question.presenterNotes ?? [],
    }));
    return res.json({
      enabled: true,
      defaultOpen: quiz.presenterNotesDefaultOpen ?? presenterNotesDefaultOpen,
      items,
    });
  };
  app.get(API.DECK_PRESENTER_NOTES, requireInstructorAuth, getPresenterNotesHandler);

  // ── Session lifecycle ─────────────────────
  app.post(API.SESSION_CREATE, requireInstructorAuth, (req, res) => {
    const validationMessage = getQuizValidationMessage();
    if (validationMessage) {
      return res.status(409).json({ error: validationMessage });
    }
    const { week, mode = "open" } = req.body;
    if (!week) {
      return res.status(400).json({ error: "Missing required field: week" });
    }
    const quiz = quizzes.get(week);
    if (!quiz) {
      return res.status(404).json({ error: `Quiz not found: ${week}` });
    }
    const session = createSession(week, mode);
    storeSession(session);
    logActivity(`instructor created session id=${session.sessionId} code=${session.sessionCode} week=${week}`);
    res.status(201).json({
      sessionId: session.sessionId,
      sessionCode: session.sessionCode,
      joinUrl: `/join/${session.sessionCode}`,
      theme: resolveDeckTheme(quiz, theme),
      palette: resolveDeckPalette(quiz, palette),
      questionHeadings: getQuestionHeadings(quiz),
      questionSummaries: getQuestionSummaries(quiz),
      // Whether the deck uses Student IDs (its `student-id` setting, on by default). The instructor
      // view hides its Student ID controls when this is false, because the name is the ID.
      studentIds: usesStudentIds(quiz),
    });
  });

  // ── Session lookup by code ─────────────────
  app.get(API.SESSION_BY_CODE, (req, res) => {
    const normalizedCode = (req.params.code || "").trim().toUpperCase();
    const session = getSessionByCode(normalizedCode);
    if (!session) {
      return res.status(404).json({ error: "Session not found for that code" });
    }
    const quiz = getQuizForSession(session.week);
    res.json({
      sessionId: session.sessionId,
      sessionCode: session.sessionCode,
      state: session.state,
      week: session.week,
      title: quiz?.title || undefined,
      theme: quiz ? resolveDeckTheme(quiz, theme) : theme,
      palette: quiz ? resolveDeckPalette(quiz, palette) : palette,
      // Whether the join form asks for a Student ID (the deck's `student-id` setting, on by default).
      studentIds: usesStudentIds(quiz),
    });
  });

  app.get(API.SESSION_STATE_RESTORE, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      if (session.state === "ENDED") {
        return res.status(410).json({ error: "Session has ended" });
      }

      const quiz = getQuizForSession(session.week);
      if (!quiz) {
        return res.status(500).json({ error: "Quiz data not found" });
      }

      const repaired = apply(session, quiz, { type: "repairClosedSlide" }, Date.now());
      if (repaired.session.state !== session.state) {
        Object.assign(session, repaired.session);
        notifyStateChange(session, req.params.id, quiz, repaired);
        logActivity(`repaired closed slide session=${req.params.id} q=${session.currentQuestionIndex} state=${session.state}`);
      }

      return res.json({
        sessionId: session.sessionId,
        sessionCode: session.sessionCode,
        week: session.week,
        title: quiz.title || undefined,
        theme: resolveDeckTheme(quiz, theme),
        palette: resolveDeckPalette(quiz, palette),
        state: session.state,
        joinLocked: session.joinLocked === true,
        currentQuestionIndex: session.currentQuestionIndex,
        questionCount: quiz.questions.length,
        questionHeadings: getQuestionHeadings(quiz),
        questionSummaries: getQuestionSummaries(quiz),
        studentIds: usesStudentIds(quiz),
        reviewQuestions: getReviewQuestions(session, quiz),
        // Student IDs and names only go to a logged-in instructor. With no login set, anyone can
        // reach this route, so restored open responses carry labels only.
        reviewReveals: getReviewReveals(session, quiz, isAuthenticatedInstructor(req) ? "control" : "display"),
      });
    });
  });

  // Helper middleware to get session by :id param
  function withSession(
    req: express.Request,
    res: express.Response,
    callback: (session: ReturnType<typeof getSession> & object) => void,
  ) {
    const session = getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    callback(session);
  }

  const actions: { path: string; type: Command["type"] }[] = [
    { path: API.SESSION_START, type: "start" },
    { path: API.SESSION_PREV, type: "previous" },
    { path: API.SESSION_NEXT, type: "next" },
    { path: API.SESSION_CLOSE, type: "close" },
    { path: API.SESSION_REVEAL, type: "reveal" },
    { path: API.SESSION_END, type: "end" },
    { path: API.SESSION_LEADERBOARD_SHOW, type: "leaderboardShow" },
    { path: API.SESSION_LEADERBOARD_HIDE, type: "leaderboardHide" },
  ];
  for (const action of actions) {
    app.post(action.path, requireInstructorAuth, (req, res) => {
      withSession(req, res, (current) => {
        const quiz = getQuizForSession(current.week);
        if (!quiz) return res.status(500).json({ error: "Quiz data not found" });
        try {
          // A session ended from the lobby has no results, so it must not replace saved ones.
          const endedUnstarted = action.type === "end" && current.state === "LOBBY";
          const result = apply(current, quiz, { type: action.type } as Command, Date.now());
          const session = current;
          Object.assign(session, result.session);
          const lockedOnLeaderboard = action.type === "leaderboardHide" && session.state === "LEADERBOARD"
            && session.currentQuestionIndex >= quiz.questions.length - 1;
          if (lockedOnLeaderboard) {
            return res.json({ state: session.state, questionIndex: session.currentQuestionIndex, lockedOnLeaderboard: true });
          }
          storeSession(session);
          if (action.type === "reveal") {
            try {
              const saved = persistSessionProgressOnReveal(session, quiz, dataDir);
              if (saved.status === "written" && saved.csv) {
                console.log(`[mdq persistence] session=${session.sessionId} code=${session.sessionCode} reveal_q=${saved.questionIndex + 1} csv_${saved.csv.action} path=${saved.csv.filePath} rows=${saved.csv.rowCount} questions=${saved.csv.questionCount}`);
              } else {
                console.warn(`[mdq persistence] session=${session.sessionId} code=${session.sessionCode} reveal_q=${saved.questionIndex + 1} csv_skipped reason=${saved.reason || "unknown"}`);
              }
            } catch (e) {
              console.error(`Failed to persist reveal progress for ${session.sessionId}:`, e);
            }
          }
          if (action.type === "end" && !endedUnstarted) persistSessionOnEnd(session, quiz, dataDir);
          notifyStateChange(session, req.params.id, quiz, result);
          logActivity(`instructor ${action.type} session=${req.params.id} q=${session.currentQuestionIndex} state=${session.state}`);
          if (action.type === "end" || action.type === "leaderboardShow") return res.json({ state: session.state });
          return res.json({ state: session.state, questionIndex: session.currentQuestionIndex });
        } catch (e) {
          if (e instanceof StateTransitionError || e instanceof EngineCommandError) return res.status(400).json({ error: e.message });
          throw e;
        }
      });
    });
  }

  // ── Hide or show one open response on the projector ──
  app.post(API.SESSION_RESPONSE_VISIBILITY, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      const quiz = getQuizForSession(session.week);
      if (!quiz) return res.status(500).json({ error: "Quiz data not found" });
      const { questionIndex, publicKey, hidden } = (req.body ?? {}) as Partial<ResponseVisibilityRequest>;
      if (!Number.isInteger(questionIndex) || typeof publicKey !== "string" || !publicKey || typeof hidden !== "boolean") {
        return res.status(400).json({ error: "Send questionIndex, publicKey and hidden." });
      }
      try {
        const result = apply(session, quiz, { type: "responseVisibility", role: "control", questionIndex: questionIndex as number, publicKey, hidden }, Date.now());
        Object.assign(session, result.session);
        storeSession(session);
        onMessages?.(session, req.params.id, result);
        logActivity(`instructor ${hidden ? "hid" : "showed"} a response session=${req.params.id} q=${questionIndex}`);
        return res.json({ questionIndex, publicKey, hidden });
      } catch (e) {
        if (e instanceof EngineCommandError) return res.status(400).json({ error: e.message });
        throw e;
      }
    });
  });

  // ── Free a participant's seat so they can rejoin from a new device ──
  app.post(API.SESSION_RELEASE_SEAT, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      const quiz = getQuizForSession(session.week);
      if (!quiz) return res.status(500).json({ error: "Quiz data not found" });
      const { publicKey } = (req.body ?? {}) as Partial<ReleaseSeatRequest>;
      if (typeof publicKey !== "string" || !publicKey || publicKey.length > MAX_PUBLIC_KEY_LENGTH) return res.status(400).json({ error: "Send publicKey." });
      try {
        const result = apply(session, quiz, { type: "releaseSeat", role: "control", publicKey, newToken: crypto.randomUUID() }, Date.now());
        Object.assign(session, result.session);
        storeSession(session);
        onMessages?.(session, req.params.id, result);
        logActivity(`instructor released a seat session=${req.params.id}`);
        return res.json({ publicKey, released: true });
      } catch (e) {
        if (e instanceof EngineCommandError) return res.status(400).json({ error: e.message });
        throw e;
      }
    });
  });

  // ── Stop new participants joining, or allow them again ──
  app.post(API.SESSION_JOIN_LOCK, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      const quiz = getQuizForSession(session.week);
      if (!quiz) return res.status(500).json({ error: "Quiz data not found" });
      const { locked } = (req.body ?? {}) as Partial<JoinLockRequest>;
      if (typeof locked !== "boolean") return res.status(400).json({ error: "Send locked as true or false." });
      try {
        const result = apply(session, quiz, { type: "joinLock", role: "control", locked }, Date.now());
        Object.assign(session, result.session);
        storeSession(session);
        onMessages?.(session, req.params.id, result);
        logActivity(`instructor ${locked ? "locked" : "unlocked"} joining session=${req.params.id}`);
        return res.json({ locked });
      } catch (e) {
        if (e instanceof EngineCommandError) return res.status(400).json({ error: e.message });
        throw e;
      }
    });
  });

  // ── Results download ──
  // The file names people by Student ID, so only the instructor may read it.
  app.get(API.SESSION_RESULTS_CSV, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      const quiz = getQuizForSession(session.week);
      if (!quiz) return res.status(500).json({ error: "Quiz data not found" });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${resultsFileName(quiz.title, session.createdAt)}"`);
      res.setHeader("Cache-Control", "no-store");
      res.send(buildSessionResultsCsv(session, quiz));
    });
  });

  app.get(API.SESSION_LEADERBOARD, (req, res) => {
    withSession(req, res, (session) => {
      const quiz = getQuizForSession(session.week);
      if (!quiz) {
        return res.status(500).json({ error: "Quiz data not found" });
      }
      // Anyone with the session ID can read this, so it names people by label and public key only.
      res.json({
        entries: leaderboardRows(session, quiz, "public"),
        totalQuestions: getScoredQuestionCount(quiz),
      });
    });
  });

  // ── Cumulative leaderboard ────────────────
  // Saved results name people by Student ID. A logged-in instructor gets those rows. With a
  // login configured everyone else gets 401. With no login configured nobody can prove they
  // are the instructor, so every caller gets labels only, never Student IDs.
  app.get(API.CUMULATIVE_LEADERBOARD, requireInstructorAuth, (req, res) => {
    try {
      const entries = computeCumulativeLeaderboard(dataDir);
      res.json({ entries: isAuthenticatedInstructor(req) ? entries : publicCumulativeEntries(entries) });
    } catch {
      res.json({ entries: [] });
    }
  });

  // ── Access info ───────────────────────────
  app.get(API.ACCESS_INFO, (req, res) => {
    const info = getCachedAccessInfo();
    if (info) {
      res.json(info);
    } else {
      // Fallback: not yet detected
      const fallbackBase = getRequestBaseUrl(req);
      res.json({
        fullUrl: fallbackBase,
        shortUrl: "",
        qrCodeDataUrl: "",
        qrTargetUrl: fallbackBase,
        source: "lan-fallback",
        warning: "Access info not yet detected. Server may still be starting.",
        detectedAt: Date.now(),
      });
    }
  });

  app.get(API.SESSION_ACCESS_INFO, requireInstructorAuth, async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const fallbackBase = getRequestBaseUrl(req);
    return res.json(await buildSessionAccessInfo(fallbackBase, session.sessionId, session.sessionCode));
  });

  app.get(API.SESSION_PRESENTATION, requireInstructorAuth, async (req, res) => {
    const session = getSession(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    if (session.state === "ENDED") {
      return res.status(410).json({ error: "Session has ended" });
    }

    const quiz = getQuizForSession(session.week);
    if (!quiz) {
      return res.status(500).json({ error: "Quiz data not found" });
    }

    const fallbackBase = getRequestBaseUrl(req);
    const accessInfo = await buildSessionAccessInfo(fallbackBase, session.sessionId, session.sessionCode);

    return res.json({
      sessionId: session.sessionId,
      sessionCode: session.sessionCode,
      week: session.week,
      title: quiz.title || undefined,
      theme: resolveDeckTheme(quiz, theme),
      palette: resolveDeckPalette(quiz, palette),
      state: session.state,
      joinLocked: session.joinLocked === true,
      questionCount: quiz.questions.length,
      questionHeadings: getQuestionHeadings(quiz),
      questionSummaries: getQuestionSummaries(quiz),
      accessInfo,
    });
  });

  // Keep unknown API requests out of the production SPA fallback. Express's
  // final handler would normally return a 404, but index.ts mounts a catch-all
  // route after this app to serve the client. Without an explicit API fallback,
  // that catch-all leaves /api requests unresolved and holds the connection
  // open indefinitely.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });

  return app;
}
