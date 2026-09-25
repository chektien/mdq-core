import express, { type Request, type Response } from "express";
import cors from "cors";
import { API, AccessInfo, DeckPalette, DeckTheme, Quiz, Session, SessionState } from "@mdq/shared";
import {
  createSession,
  storeSession,
  getSession,
  getSessionByCode,
  transitionState,
  StateTransitionError,
  computeLeaderboard,
  getActiveSessions,
  getDistribution,
  getOpenResponses,
  repairClosedSlideState,
} from "./session";
import { parseQuizMarkdown } from "./parser";
import {
  persistSessionOnEnd,
  computeCumulativeLeaderboard,
  persistSessionProgressOnReveal,
} from "./persistence";
import { buildScoredCorrectAnswersMap, getQuestionType, getScoredQuestionCount, isOpenResponseQuestion } from "./scoring";
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
  onStateChange?: (session: Session, sessionId: string, newState: SessionState, quiz?: Quiz) => void;
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

export function createApp(quizDirOrOpts?: string | AppOptions) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  function requireInstructorAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
    if (!isInstructorAuthEnabled()) {
      next();
      return;
    }

    const sessionToken = getInstructorSessionFromCookie(req.header("cookie"));
    if (!sessionToken || !hasValidInstructorSession(sessionToken)) {
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
      attendeeNotes: question.attendeeNotes && question.attendeeNotes.length > 0
        ? question.attendeeNotes
        : undefined,
      slideMedia: question.slideMedia,
      slideBackground: question.slideBackground,
      slideLiveEmbed: question.slideLiveEmbed,
      slideVideo: question.slideVideo,
      slideReferences: question.slideReferences,
      options: question.options.map((option) => ({ label: option.label, text: option.textHtml })),
      allowsMultiple: question.allowsMultiple,
      isPoll: question.isPoll === true,
      timeLimitSec: question.timeLimitSec,
      startedAt: questionIndex === session.currentQuestionIndex
        ? session.questionStartedAt || Date.now()
        : session.questionStartedAt || session.createdAt,
    }));
  }

  function getReviewReveals(session: Session, quiz: Quiz) {
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
        openResponses: isOpenResponseQuestion(question) ? getOpenResponses(session, questionIndex) : undefined,
      }));
  }

  function markQuestionReviewed(session: Session, questionIndex: number): void {
    if (questionIndex < 0) {
      return;
    }
    if (!session.revealedQuestionIndexes) {
      session.revealedQuestionIndexes = new Set<number>();
    }
    session.revealedQuestionIndexes.add(questionIndex);
  }

  function isQuestionReviewed(session: Session, questionIndex: number): boolean {
    return session.revealedQuestionIndexes?.has(questionIndex) === true;
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
    if (detail.includes("must not use multi_select")) {
      return "This open-ended question is using a multiple-choice setting that does not apply here.";
    }
    if (detail.startsWith("Unsupported question_type")) {
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
  function notifyStateChange(session: Session, sessionId: string, quiz?: Quiz): void {
    if (onStateChange) {
      onStateChange(session, sessionId, session.state, quiz);
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
      theme: quiz ? resolveDeckTheme(quiz, theme) : theme,
      palette: quiz ? resolveDeckPalette(quiz, palette) : palette,
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

      if (repairClosedSlideState(session, quiz)) {
        notifyStateChange(session, req.params.id, quiz);
        logActivity(`repaired closed slide session=${req.params.id} q=${session.currentQuestionIndex} state=${session.state}`);
      }

      return res.json({
        sessionId: session.sessionId,
        sessionCode: session.sessionCode,
        week: session.week,
        theme: resolveDeckTheme(quiz, theme),
        palette: resolveDeckPalette(quiz, palette),
        state: session.state,
        currentQuestionIndex: session.currentQuestionIndex,
        questionCount: quiz.questions.length,
        questionHeadings: getQuestionHeadings(quiz),
        questionSummaries: getQuestionSummaries(quiz),
        reviewQuestions: getReviewQuestions(session, quiz),
        reviewReveals: getReviewReveals(session, quiz),
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

  app.post(API.SESSION_START, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      try {
        transitionState(session, "QUESTION_OPEN");
        session.currentQuestionIndex = 0;
        session.questionStartedAt = Date.now();
        const quiz = getQuizForSession(session.week);
        notifyStateChange(session, req.params.id, quiz);
        logActivity(`instructor start session=${req.params.id} q=0 state=${session.state}`);
        res.json({ state: session.state, questionIndex: 0 });
      } catch (e) {
        if (e instanceof StateTransitionError) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    });
  });

  app.post(API.SESSION_PREV, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      const quiz = getQuizForSession(session.week);
      if (!quiz) {
        return res.status(500).json({ error: "Quiz data not found" });
      }
      const prevIndex = session.currentQuestionIndex - 1;
      if (session.state === "LOBBY") {
        return res.status(400).json({ error: "Start the session before going back." });
      }
      if (prevIndex < 0) {
        return res.status(400).json({ error: "Already at the first item" });
      }

      const previousQuestion = quiz.questions[prevIndex];
      const previousQuestionType = getQuestionType(previousQuestion);

      session.state = previousQuestionType === "slide" ? "QUESTION_OPEN" : "REVEAL";
      session.currentQuestionIndex = prevIndex;
      if (session.state === "QUESTION_OPEN") {
        session.questionStartedAt = Date.now();
      } else {
        markQuestionReviewed(session, prevIndex);
      }
      notifyStateChange(session, req.params.id, quiz);
      logActivity(`instructor prev session=${req.params.id} q=${prevIndex} state=${session.state}`);
      res.json({ state: session.state, questionIndex: prevIndex });
    });
  });

  app.post(API.SESSION_NEXT, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      const quiz = getQuizForSession(session.week);
      if (!quiz) {
        return res.status(500).json({ error: "Quiz data not found" });
      }
      const nextIndex = session.currentQuestionIndex + 1;
      if (nextIndex >= quiz.questions.length) {
        return res.status(400).json({ error: "No more questions" });
      }
      try {
        const currentQuestion = quiz.questions[session.currentQuestionIndex];
        if (session.state === "LOBBY") {
          return res.status(400).json({ error: "Start the session before advancing." });
        }
        if (session.state === "QUESTION_OPEN") {
          if (getQuestionType(currentQuestion) !== "slide") {
            return res.status(400).json({ error: "Close and reveal the current question before advancing." });
          }
        } else {
          transitionState(session, "QUESTION_OPEN");
        }

        const nextQuestion = quiz.questions[nextIndex];
        const nextQuestionType = getQuestionType(nextQuestion);
        if (nextQuestionType !== "slide" && isQuestionReviewed(session, nextIndex)) {
          session.state = "REVEAL";
        }

        session.currentQuestionIndex = nextIndex;
        if (session.state === "QUESTION_OPEN") {
          session.questionStartedAt = Date.now();
        }
        notifyStateChange(session, req.params.id, quiz);
        logActivity(`instructor next session=${req.params.id} q=${nextIndex} state=${session.state}`);
        res.json({ state: session.state, questionIndex: nextIndex });
      } catch (e) {
        if (e instanceof StateTransitionError) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    });
  });

  app.post(API.SESSION_CLOSE, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      try {
        const quiz = getQuizForSession(session.week);
        const currentQuestion = quiz?.questions[session.currentQuestionIndex];
        if (getQuestionType(currentQuestion) === "slide") {
          return res.status(400).json({ error: "Slides do not close; advance to the next item." });
        }
        transitionState(session, "QUESTION_CLOSED");
        notifyStateChange(session, req.params.id, quiz);
        logActivity(`instructor close session=${req.params.id} q=${session.currentQuestionIndex} state=${session.state}`);
        res.json({ state: session.state, questionIndex: session.currentQuestionIndex });
      } catch (e) {
        if (e instanceof StateTransitionError) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    });
  });

  app.post(API.SESSION_REVEAL, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      try {
        const quiz = getQuizForSession(session.week);
        const currentQuestion = quiz?.questions[session.currentQuestionIndex];
        if (getQuestionType(currentQuestion) === "slide") {
          return res.status(400).json({ error: "Slides do not reveal answers; advance to the next item." });
        }
        transitionState(session, "REVEAL");
        markQuestionReviewed(session, session.currentQuestionIndex);

        if (quiz) {
          try {
            const revealPersistence = persistSessionProgressOnReveal(session, quiz, dataDir);
            if (revealPersistence.status === "written" && revealPersistence.csv) {
              console.log(
                `[mdq persistence] session=${session.sessionId} code=${session.sessionCode} reveal_q=${revealPersistence.questionIndex + 1} csv_${revealPersistence.csv.action} path=${revealPersistence.csv.filePath} rows=${revealPersistence.csv.rowCount} questions=${revealPersistence.csv.questionCount}`,
              );
            } else {
              console.warn(
                `[mdq persistence] session=${session.sessionId} code=${session.sessionCode} reveal_q=${revealPersistence.questionIndex + 1} csv_skipped reason=${revealPersistence.reason || "unknown"}`,
              );
            }
          } catch (e) {
            console.error(`Failed to persist reveal progress for ${session.sessionId}:`, e);
          }
        } else {
          console.warn(
            `[mdq persistence] session=${session.sessionId} code=${session.sessionCode} csv_skipped reason=quiz_not_found week=${session.week}`,
          );
        }

        notifyStateChange(session, req.params.id, quiz);
        logActivity(`instructor reveal session=${req.params.id} q=${session.currentQuestionIndex} state=${session.state}`);
        res.json({ state: session.state, questionIndex: session.currentQuestionIndex });
      } catch (e) {
        if (e instanceof StateTransitionError) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    });
  });

  app.post(API.SESSION_END, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      try {
        // Allow ending from any live panel state while preserving transition rules.
        if (session.state === "QUESTION_CLOSED") {
          transitionState(session, "REVEAL");
        }
        if (session.state === "REVEAL") {
          transitionState(session, "LEADERBOARD");
        }
        transitionState(session, "ENDED");

        // Persist session data on end
        const quiz = getQuizForSession(session.week);
        if (quiz) {
          persistSessionOnEnd(session, quiz, dataDir);
        }

        notifyStateChange(session, req.params.id, quiz);
        logActivity(`instructor end session=${req.params.id} state=ENDED`);
        res.json({ state: "ENDED" });
      } catch (e) {
        if (e instanceof StateTransitionError) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    });
  });

  // Show leaderboard (REVEAL -> LEADERBOARD, without ending)
  app.post(API.SESSION_LEADERBOARD_SHOW, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      try {
        if (session.state === "QUESTION_CLOSED") {
          transitionState(session, "REVEAL");
        }
        transitionState(session, "LEADERBOARD");
        const quiz = getQuizForSession(session.week);
        notifyStateChange(session, req.params.id, quiz);
        logActivity(`instructor leaderboard-show session=${req.params.id} q=${session.currentQuestionIndex} state=${session.state}`);
        res.json({ state: session.state });
      } catch (e) {
        if (e instanceof StateTransitionError) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    });
  });

  // Hide leaderboard (LEADERBOARD -> REVEAL, continue quiz flow)
  app.post(API.SESSION_LEADERBOARD_HIDE, requireInstructorAuth, (req, res) => {
    withSession(req, res, (session) => {
      try {
        const quiz = getQuizForSession(session.week);
        if (!quiz) {
          return res.status(500).json({ error: "Quiz data not found" });
        }

        const isLastQuestion = session.currentQuestionIndex >= quiz.questions.length - 1;
        if (isLastQuestion) {
          return res.json({
            state: session.state,
            questionIndex: session.currentQuestionIndex,
            lockedOnLeaderboard: true,
          });
        }

        transitionState(session, "REVEAL");
        notifyStateChange(session, req.params.id, quiz);
        logActivity(`instructor leaderboard-hide session=${req.params.id} q=${session.currentQuestionIndex} state=${session.state}`);
        res.json({ state: session.state, questionIndex: session.currentQuestionIndex });
      } catch (e) {
        if (e instanceof StateTransitionError) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    });
  });

  app.get(API.SESSION_LEADERBOARD, (req, res) => {
    withSession(req, res, (session) => {
      const quiz = getQuizForSession(session.week);
      if (!quiz) {
        return res.status(500).json({ error: "Quiz data not found" });
      }
      const correctAnswersMap = buildScoredCorrectAnswersMap(quiz);
      const entries = computeLeaderboard(session, correctAnswersMap);
      res.json({
        entries,
        totalQuestions: getScoredQuestionCount(quiz),
      });
    });
  });

  // ── Cumulative leaderboard ────────────────
  app.get(API.CUMULATIVE_LEADERBOARD, (_req, res) => {
    try {
      const entries = computeCumulativeLeaderboard(dataDir);
      res.json({ entries });
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
      theme: resolveDeckTheme(quiz, theme),
      palette: resolveDeckPalette(quiz, palette),
      state: session.state,
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
