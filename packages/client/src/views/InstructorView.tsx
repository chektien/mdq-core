import { useState, useEffect, useCallback, useRef } from "react";
import { useSocket } from "../hooks/useSocket";
import { resolveSlideBackground, type QuestionState, type RevealState } from "../hooks/useSocket";
import {
  fetchDecks,
  reloadDecks,
  createSession,
  startSession,
  prevQuestion,
  nextQuestion,
  closeQuestion,
  revealAnswer,
  endSession,
  showLeaderboard,
  hideLeaderboard,
  fetchSessionAccessInfo,
  fetchSessionStateForRestore,
  fetchPresenterNotes,
  type DeckSummary,
  type QuestionSummary,
  type CreateSessionResponse,
  type SessionRestoreResponse,
} from "../hooks/api";
import type { AccessInfo, DeckPalette, DeckTheme, FoldoutNote, QuestionType, SessionState } from "@mdq/shared";
import { applyClientPalette, applyClientTheme } from "../theme";
import Timer from "../components/Timer";
import Leaderboard from "../components/Leaderboard";
import OpenResponseList from "../components/OpenResponseList";
import QRPanel from "../components/QRPanel";
import SessionCodeCard from "../components/SessionCodeCard";
import InlineMarkdownText from "../components/InlineMarkdownText";
import QuizHtml from "../components/QuizHtml";
import LiveSurface, { type LiveSurfaceAction } from "../components/LiveSurface";
import ResponsiveQuizSurface from "../components/ResponsiveQuizSurface";
import SlideContent, { SlideContentBody } from "../components/SlideContent";
import SlideBackgroundLayer from "../components/SlideBackgroundLayer";
import PresenterNotesPanel from "../components/PresenterNotesPanel";
import { getQuestionModeText, getRevealActionLabel } from "../questionMode";

type InstructorPhase = "setup" | "lobby" | "live" | "ended";
const INSTRUCTOR_RESTORE_KEY = "mdquiz_instructor_session";
const INSTRUCTOR_RESTORE_SUCCESS_NOTICE = "Resumed active session after refresh.";

interface StoredInstructorRestore {
  sessionId: string;
  sessionCode: string;
  week: string;
  createdAt: number;
}

function formatQuizLabel(quizKey: string): string {
  const normalized = quizKey.trim();
  if (!normalized) return "MDQ";
  if (/\bmdq\b/i.test(normalized)) return normalized;
  return `${normalized} MDQ`;
}

function formatPositionLabel(questionIndex: number, totalQuestions: number): string {
  return totalQuestions > 0 ? `${questionIndex + 1}/${totalQuestions}` : `${questionIndex + 1}`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatDeckChooserSummary(deck: DeckSummary): string {
  const slideCount = deck.slideCount ?? 0;
  const liveQuestionCount = deck.liveQuestionCount ?? Math.max(deck.questionCount - slideCount, 0);
  const parts = [pluralize(liveQuestionCount, "question")];
  if (slideCount > 0) {
    parts.push(pluralize(slideCount, "slide"));
  }
  return parts.join(", ");
}

function questionStateFromRestore(data: NonNullable<SessionRestoreResponse["reviewQuestions"]>[number]): QuestionState {
  const resolvedBackground = resolveSlideBackground(data.text, data.slideBackground);
  return {
    questionIndex: data.questionIndex,
    topic: data.topic,
    text: resolvedBackground.text,
    questionType: data.questionType ?? (data.isPoll ? "poll" : "multiple_choice"),
    attendeeNotes: data.attendeeNotes,
    slideMedia: data.slideMedia,
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
}

function revealStateFromRestore(data: NonNullable<SessionRestoreResponse["reviewReveals"]>[number]): RevealState {
  return {
    questionIndex: data.questionIndex,
    questionType: data.questionType ?? (data.isPoll ? "poll" : "multiple_choice"),
    correctOptions: data.correctOptions,
    explanation: data.explanation,
    distribution: data.distribution,
    isPoll: data.isPoll ?? false,
    openResponses: data.openResponses ?? [],
  };
}

function clearInstructorRestore(): void {
  try {
    sessionStorage.removeItem(INSTRUCTOR_RESTORE_KEY);
  } catch {
    // ignore
  }
}

function saveInstructorRestore(restore: StoredInstructorRestore): void {
  try {
    sessionStorage.setItem(INSTRUCTOR_RESTORE_KEY, JSON.stringify(restore));
  } catch {
    // ignore
  }
}

export default function InstructorView({
  autoGenerateStudentIds = false,
  defaultTheme = "dark",
  defaultPalette = "classic",
}: {
  autoGenerateStudentIds?: boolean;
  defaultTheme?: DeckTheme;
  defaultPalette?: DeckPalette;
}) {
  // Setup state
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [selectedWeek, setSelectedWeek] = useState<string>("");
  const [deckFilter, setDeckFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Session state
  const [sessionInfo, setSessionInfo] = useState<CreateSessionResponse | null>(null);
  const [accessInfo, setAccessInfo] = useState<AccessInfo | null>(null);
  const [phase, setPhase] = useState<InstructorPhase>("setup");
  const [totalQuestionsInQuiz, setTotalQuestionsInQuiz] = useState(0);
  const [questionHeadings, setQuestionHeadings] = useState<string[]>([]);
  const [questionSummaries, setQuestionSummaries] = useState<QuestionSummary[]>([]);
  const [quizLabel, setQuizLabel] = useState("");
  const [sessionTheme, setSessionTheme] = useState<DeckTheme | undefined>();
  const [sessionPalette, setSessionPalette] = useState<DeckPalette | undefined>();
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [restoredQuestionCache, setRestoredQuestionCache] = useState<Record<number, QuestionState>>({});
  const [restoredRevealCache, setRestoredRevealCache] = useState<Record<number, RevealState>>({});
  const [pendingRestore, setPendingRestore] = useState<StoredInstructorRestore | null>(null);
  const restoreAttemptedRef = useRef(false);
  const actionInFlightRef = useRef(false);
  // Presenter notes (instructor-only). Populated from the instructor-
  // authenticated endpoint; empty/disabled means no panel renders.
  const [presenterNotesEnabled, setPresenterNotesEnabled] = useState(false);
  const [presenterNotesByIndex, setPresenterNotesByIndex] = useState<Record<number, FoldoutNote[]>>({});
  const [presenterNotesOpen, setPresenterNotesOpen] = useState(false);

  // Socket connection (instructor role)
  const sock = useSocket(sessionInfo?.sessionId ?? null, "instructor");

  // Derive phase from socket session state
  useEffect(() => {
    if (!sock.sessionState) return;
    const s = sock.sessionState;
    if (s === "LOBBY") setPhase("lobby");
    else if (s === "ENDED") setPhase("ended");
    else setPhase("live");
  }, [sock.sessionState]);

  // Load decks on mount
  useEffect(() => {
    fetchDecks()
      .then((loadedDecks) => {
        setDecks(loadedDecks);
        if (loadedDecks.length > 0) setSelectedWeek(loadedDecks[0].week);
      })
      .catch((e) => setErrorMsg(e.message));
  }, []);

  // Load presenter notes for the selected deck (instructor-only endpoint).
  useEffect(() => {
    if (!selectedWeek) {
      setPresenterNotesEnabled(false);
      setPresenterNotesByIndex({});
      return;
    }
    let cancelled = false;
    fetchPresenterNotes(selectedWeek)
      .then((data) => {
        if (cancelled) return;
        setPresenterNotesEnabled(data.enabled);
        const byIndex: Record<number, FoldoutNote[]> = {};
        for (const item of data.items) byIndex[item.questionIndex] = item.notes;
        setPresenterNotesByIndex(byIndex);
        if (data.enabled) setPresenterNotesOpen(data.defaultOpen);
      })
      .catch(() => {
        if (cancelled) return;
        setPresenterNotesEnabled(false);
        setPresenterNotesByIndex({});
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWeek]);

  const restoreInstructorSession = useCallback(async (stored: StoredInstructorRestore) => {
    setLoading(true);
    setErrorMsg(null);
    setRestoreNotice(null);

    try {
      const snapshot = await fetchSessionStateForRestore(stored.sessionId);
      const restoredInfo: CreateSessionResponse = {
        sessionId: snapshot.sessionId,
        sessionCode: snapshot.sessionCode,
        joinUrl: `/join/${snapshot.sessionCode}`,
        theme: snapshot.theme,
        palette: snapshot.palette,
        questionHeadings: snapshot.questionHeadings || [],
        questionSummaries: snapshot.questionSummaries || [],
      };

      setSessionInfo(restoredInfo);
      setSelectedWeek(snapshot.week);
      setTotalQuestionsInQuiz(snapshot.questionCount);
      setQuestionHeadings(snapshot.questionHeadings || []);
      setQuestionSummaries(snapshot.questionSummaries || []);
      setQuizLabel(formatQuizLabel(snapshot.week));
      setSessionTheme(snapshot.theme);
      setSessionPalette(snapshot.palette);
      setRestoredQuestionCache(
        Object.fromEntries(
          (snapshot.reviewQuestions || []).map((question) => {
            const restored = questionStateFromRestore(question);
            return [restored.questionIndex, restored];
          }),
        ),
      );
      setRestoredRevealCache(
        Object.fromEntries(
          (snapshot.reviewReveals || []).map((reveal) => {
            const restored = revealStateFromRestore(reveal);
            return [restored.questionIndex, restored];
          }),
        ),
      );

      setPhase(snapshot.state === "LOBBY" ? "lobby" : "live");
      setPendingRestore(null);

      try {
        const ai = await fetchSessionAccessInfo(snapshot.sessionId);
        setAccessInfo(ai);
      } catch {
        // Non-critical. The socket and controls can recover without join info.
      }

      setRestoreNotice(INSTRUCTOR_RESTORE_SUCCESS_NOTICE);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to resume previous session.";
      if (/ended|not found|missing/i.test(message)) {
        clearInstructorRestore();
        setPendingRestore(null);
        setRestoreNotice("Previous session is no longer active. Start a new session when ready.");
      } else {
        // A mobile network transition is temporary. Keep the restore record
        // and offer an in-place retry instead of losing the live session.
        saveInstructorRestore(stored);
        setPendingRestore(stored);
        setRestoreNotice(`${message} Your live session is preserved; retry when connected.`);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;

    let stored: StoredInstructorRestore | null = null;
    try {
      const raw = sessionStorage.getItem(INSTRUCTOR_RESTORE_KEY);
      if (raw) {
        stored = JSON.parse(raw) as StoredInstructorRestore;
      }
    } catch {
      clearInstructorRestore();
      return;
    }

    if (stored?.sessionId) {
      void restoreInstructorSession(stored);
    }
  }, [restoreInstructorSession]);

  useEffect(() => {
    if (!sessionInfo) {
      return;
    }

    if (phase === "ended" || phase === "setup") {
      clearInstructorRestore();
      return;
    }

    saveInstructorRestore({
      sessionId: sessionInfo.sessionId,
      sessionCode: sessionInfo.sessionCode,
      week: selectedWeek,
      createdAt: Date.now(),
    });
  }, [sessionInfo, phase, selectedWeek]);

  // ── Actions ──────────────────────────────

  const handleCreateSession = useCallback(async () => {
    if (!selectedWeek) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const info = await createSession(selectedWeek);
      setSessionInfo(info);
      const deck = decks.find((q) => q.week === selectedWeek);
      if (deck) setTotalQuestionsInQuiz(deck.questionCount);
      setQuestionHeadings(info.questionHeadings || []);
      setQuestionSummaries(info.questionSummaries || []);
      setQuizLabel(formatQuizLabel(deck?.week || selectedWeek));
      setSessionTheme(info.theme);
      setSessionPalette(info.palette);
      setRestoreNotice(null);
      setPhase("lobby");

      // Fetch session-specific access info for QR/URL display
      try {
        const ai = await fetchSessionAccessInfo(info.sessionId);
        setAccessInfo(ai);
      } catch {
        // Non-critical
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to create session");
    } finally {
      setLoading(false);
    }
  }, [selectedWeek, decks]);

  const handleReloadDecks = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const result = await reloadDecks();
      setDecks(result.quizzes);
      if (!result.quizzes.find((q) => q.week === selectedWeek) && result.quizzes.length > 0) {
        setSelectedWeek(result.quizzes[0].week);
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Failed to reload decks");
    } finally {
      setLoading(false);
    }
  }, [selectedWeek]);

  const handleAction = useCallback(
    async (action: () => Promise<unknown>, label: string) => {
      if (actionInFlightRef.current) return;
      actionInFlightRef.current = true;
      setRestoreNotice((current) => (
        current === INSTRUCTOR_RESTORE_SUCCESS_NOTICE ? null : current
      ));
      setLoading(true);
      setErrorMsg(null);
      try {
        await action();
      } catch (e) {
        const message = e instanceof Error ? e.message : `Failed to ${label}`;
        setErrorMsg(`${message} Reconnecting to sync the current session state.`);
        sock.reconnect();
      } finally {
        actionInFlightRef.current = false;
        setLoading(false);
      }
    },
    [sock],
  );

  const handleBackToSetup = useCallback(() => {
    sock.disconnect();
    clearInstructorRestore();
    setSessionInfo(null);
    setAccessInfo(null);
    setTotalQuestionsInQuiz(0);
    setQuestionHeadings([]);
    setQuestionSummaries([]);
    setQuizLabel("");
    setSessionTheme(undefined);
    setSessionPalette(undefined);
    setRestoreNotice(null);
    setErrorMsg(null);
    setPhase("setup");
  }, [sock]);

  const sid = sessionInfo?.sessionId ?? "";
  const selectedDeck = decks.find((deck) => deck.week === selectedWeek);
  useEffect(() => {
    applyClientTheme(sessionTheme ?? selectedDeck?.theme, defaultTheme);
  }, [defaultTheme, selectedDeck?.theme, sessionTheme]);
  useEffect(() => {
    applyClientPalette(sessionPalette ?? selectedDeck?.palette, defaultPalette);
  }, [defaultPalette, selectedDeck?.palette, sessionPalette]);
  const filteredDecks = decks.filter((deck) => {
    const query = deckFilter.trim().toLowerCase();
    if (!query) return true;
    return `${deck.title} ${deck.week}`.toLowerCase().includes(query);
  });

  // ── Setup Phase ──────────────────────────
  if (phase === "setup") {
    return (
      <div className="instructor-phase-shell instructor-setup-shell min-h-dvh flex flex-col items-center justify-center gap-8 p-8">
        <a href="#/" className="instructor-phase-back absolute top-6 left-6 text-zinc-500 hover:text-zinc-300 text-sm">
          &larr; Back
        </a>
        <h1 className="instructor-phase-title text-3xl font-bold text-white">Start a Deck Session</h1>

        {errorMsg && (
          <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-xl max-w-md w-full text-center">
            {errorMsg}
          </div>
        )}

        {restoreNotice && (
          <div className={`${pendingRestore ? "bg-amber-900/40 border-amber-700 text-amber-100" : "bg-emerald-900/40 border-emerald-700 text-emerald-100"} border px-4 py-3 rounded-xl max-w-2xl w-full text-center text-sm`}>
            <p>{restoreNotice}</p>
            {pendingRestore && (
              <button
                type="button"
                className="mt-3 rounded-lg bg-amber-200 px-4 py-2 font-semibold text-amber-950 disabled:opacity-60"
                disabled={loading}
                onClick={() => void restoreInstructorSession(pendingRestore)}
              >
                {loading ? "Reconnecting..." : "Retry Session"}
              </button>
            )}
          </div>
        )}

        {decks.length === 0 ? (
          <p className="text-zinc-400">No decks found. Add markdown deck files to the data/decks directory.</p>
        ) : (
          <div className="w-full max-w-2xl space-y-6">
            <div className="space-y-3">
              <div className="flex items-end justify-between gap-4">
                <label htmlFor="deck-filter" className="block text-zinc-400 text-sm font-medium">Select Deck</label>
                {selectedDeck && (
                  <span className="text-xs text-zinc-500 font-mono">{selectedDeck.week}</span>
                )}
              </div>
              <input
                id="deck-filter"
                value={deckFilter}
                onChange={(e) => setDeckFilter(e.target.value)}
                placeholder="Search decks"
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 text-white text-base focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
              <div className="max-h-80 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900/70">
                {filteredDecks.length === 0 ? (
                  <p className="px-4 py-5 text-sm text-zinc-400">No matching decks.</p>
                ) : (
                  filteredDecks.map((deck) => {
                    const isSelected = deck.week === selectedWeek;
                    return (
                      <button
                        key={deck.week}
                        type="button"
                        onClick={() => setSelectedWeek(deck.week)}
                        className={`w-full border-b border-zinc-800 px-4 py-3 text-left transition-colors last:border-b-0 ${
                          isSelected
                            ? "bg-indigo-600/20 text-white"
                            : "text-zinc-200 hover:bg-zinc-800/80"
                        }`}
                        aria-pressed={isSelected}
                      >
                        <span className="flex items-start gap-3">
                          <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${isSelected ? "bg-indigo-300" : "bg-zinc-600"}`} />
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-base font-medium leading-snug">{deck.title}</span>
                            <span className="mt-1 block text-sm text-zinc-400">
                              {formatDeckChooserSummary(deck)}
                              <span className="mx-2 text-zinc-600">/</span>
                              <span className="font-mono text-xs text-zinc-500">{deck.week}</span>
                            </span>
                          </span>
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            <button
              onClick={handleReloadDecks}
              disabled={loading}
              className="w-full bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-700 disabled:text-zinc-500 border border-zinc-700 text-zinc-200 font-medium py-3 rounded-xl transition-colors"
            >
              {loading ? "Reloading..." : "Reload Decks"}
            </button>
            <button
              onClick={handleCreateSession}
              disabled={loading || !selectedWeek}
              className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-semibold py-4 rounded-xl transition-colors text-lg"
            >
              {loading ? "Creating..." : "Create Session"}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Lobby Phase ──────────────────────────
  if (phase === "lobby") {
    return (
      <div className="instructor-phase-shell instructor-lobby-shell min-h-dvh flex flex-col items-center justify-center gap-8 p-8">
        <button
          onClick={handleBackToSetup}
          className="instructor-phase-back absolute top-6 left-6 text-zinc-500 hover:text-zinc-300 text-sm"
        >
          &larr; Back to Setup
        </button>
        <h1 className="instructor-phase-title text-2xl font-bold text-white">Waiting for Students</h1>

        {/* QR + Join Info */}
        {accessInfo && sessionInfo && (
          <QRPanel
            qrDataUrl={accessInfo.qrCodeDataUrl}
            fullUrl={accessInfo.fullUrl}
            shortUrl={accessInfo.shortUrl}
            sessionCode={sessionInfo.sessionCode}
            presentationUrl={accessInfo.presentationUrl}
          />
        )}
        {!accessInfo && sessionInfo && (
          <div className="text-center">
            <p className="text-zinc-400 text-sm mb-1">Session Code</p>
            <p className="text-5xl font-mono font-bold text-white tracking-[0.2em]">
              {sessionInfo.sessionCode}
            </p>
          </div>
        )}

        {/* Participant count */}
        <div className="instructor-participant-count text-center">
          <span className="instructor-participant-count-value text-5xl font-bold text-white tabular-nums">
            {sock.participants?.count ?? 0}
          </span>
          <span className="instructor-participant-count-label text-zinc-400 text-lg ml-2">students joined</span>
        </div>

        {/* Participant list */}
        {sock.participants && sock.participants.count > 0 && (
          <div className="bg-zinc-800/50 rounded-xl p-4 max-w-lg w-full max-h-48 overflow-y-auto">
            <div className="flex flex-wrap gap-2">
              {sock.participants.participants.map((p) => (
                <span
                  key={p.studentId}
                  className="bg-zinc-700 text-zinc-200 px-3 py-1 rounded-full text-sm"
                >
                  {p.displayName || p.studentId}
                </span>
              ))}
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-xl">
            {errorMsg}
          </div>
        )}

        {restoreNotice && (
          <div className="bg-emerald-900/40 border border-emerald-700 text-emerald-100 px-4 py-3 rounded-xl text-sm text-center max-w-2xl w-full">
            {restoreNotice}
          </div>
        )}

        <button
          onClick={() => handleAction(() => startSession(sid), "start")}
          disabled={loading || !sock.connected}
          className="instructor-start-button bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 text-white font-semibold py-4 px-12 rounded-xl transition-colors text-xl"
        >
          {loading ? "Starting..." : sock.connected ? "Start Session" : "Reconnecting..."}
        </button>
        {!sock.connected && (
          <button
            type="button"
            className="rounded-lg border border-zinc-600 px-4 py-2 text-sm font-semibold text-zinc-200"
            onClick={sock.reconnect}
          >
            Retry Connection
          </button>
        )}
      </div>
    );
  }

  // ── Ended Phase ──────────────────────────
  if (phase === "ended") {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-8 p-8">
        <h1 className="text-3xl font-bold text-white">Session Ended</h1>
        {quizLabel && (
          <h2 className="text-xl font-semibold text-zinc-300 text-center">
            Leaderboard for {quizLabel.toUpperCase()}
          </h2>
        )}
        <Leaderboard
          entries={sock.leaderboard}
          totalQuestions={sock.totalQuestions ?? totalQuestionsInQuiz}
          maxRows={15}
          showStudentIds={!autoGenerateStudentIds}
        />
        <a
          href="#/"
          className="bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-3 px-8 rounded-xl transition-colors"
        >
          Back to Home
        </a>
      </div>
    );
  }

  // ── Live Phase (QUESTION_OPEN, QUESTION_CLOSED, REVEAL, LEADERBOARD) ──
  return (
    <LiveView
      sock={sock}
      sessionId={sid}
      sessionCode={sessionInfo?.sessionCode || ""}
      accessInfo={accessInfo}
      totalQuestionsInQuiz={totalQuestionsInQuiz}
      questionHeadings={questionHeadings}
      questionSummaries={questionSummaries}
      quizLabel={quizLabel}
      restoredQuestionCache={restoredQuestionCache}
      restoredRevealCache={restoredRevealCache}
      loading={loading}
      errorMsg={errorMsg}
      restoreNotice={restoreNotice}
      autoGenerateStudentIds={autoGenerateStudentIds}
      presenterNotesEnabled={presenterNotesEnabled}
      presenterNotesByIndex={presenterNotesByIndex}
      presenterNotesOpen={presenterNotesOpen}
      onPresenterNotesToggle={setPresenterNotesOpen}
      onAction={handleAction}
    />
  );
}

// ── Live sub-view ──────────────────────────

function LiveView({
  sock,
  sessionId,
  sessionCode,
  accessInfo,
  totalQuestionsInQuiz,
  questionHeadings,
  questionSummaries,
  quizLabel,
  restoredQuestionCache,
  restoredRevealCache,
  loading,
  errorMsg,
  restoreNotice,
  autoGenerateStudentIds,
  presenterNotesEnabled,
  presenterNotesByIndex,
  presenterNotesOpen,
  onPresenterNotesToggle,
  onAction,
}: {
  sock: ReturnType<typeof useSocket>;
  sessionId: string;
  sessionCode: string;
  accessInfo: AccessInfo | null;
  totalQuestionsInQuiz: number;
  questionHeadings: string[];
  questionSummaries: QuestionSummary[];
  quizLabel: string;
  restoredQuestionCache: Record<number, QuestionState>;
  restoredRevealCache: Record<number, RevealState>;
  loading: boolean;
  errorMsg: string | null;
  restoreNotice: string | null;
  autoGenerateStudentIds: boolean;
  presenterNotesEnabled: boolean;
  presenterNotesByIndex: Record<number, FoldoutNote[]>;
  presenterNotesOpen: boolean;
  onPresenterNotesToggle: (open: boolean) => void;
  onAction: (action: () => Promise<unknown>, label: string) => void;
}) {
  const state = sock.sessionState as SessionState;
  const q = sock.currentQuestion as QuestionState | null;
  const rev = sock.reveal as RevealState | null;

  const [reviewQuestionIndex, setReviewQuestionIndex] = useState<number | null>(null);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [questionCache, setQuestionCache] = useState<Record<number, QuestionState>>({});
  const [revealCache, setRevealCache] = useState<Record<number, RevealState>>({});

  useEffect(() => {
    setQuestionCache((prev) => ({ ...restoredQuestionCache, ...prev }));
  }, [restoredQuestionCache]);

  useEffect(() => {
    setRevealCache((prev) => ({ ...restoredRevealCache, ...prev }));
  }, [restoredRevealCache]);

  useEffect(() => {
    if (!q) return;
    setQuestionCache((prev) => ({ ...prev, [q.questionIndex]: q }));
  }, [q]);

  useEffect(() => {
    if (!rev) return;
    setRevealCache((prev) => ({ ...prev, [rev.questionIndex]: rev }));
  }, [rev]);

  const isReviewing = reviewQuestionIndex !== null;
  const liveQuestionIndex = q?.questionIndex ?? rev?.questionIndex ?? -1;
  const availableQuestionIndices = Object.keys(questionCache)
    .map((idx) => parseInt(idx, 10))
    .filter((idx) => !Number.isNaN(idx))
    .sort((a, b) => a - b);
  const availableReviewIndices = availableQuestionIndices.filter((idx) => (
    liveQuestionIndex >= 0 ? idx <= liveQuestionIndex : true
  ));

  const displayQuestion = isReviewing && reviewQuestionIndex !== null
    ? questionCache[reviewQuestionIndex] ?? null
    : q;
  const displayReveal = isReviewing && reviewQuestionIndex !== null
    ? revealCache[reviewQuestionIndex] ?? null
    : rev && q && rev.questionIndex === q.questionIndex
      ? rev
      : null;
  const showDetailedRevealChoices = !!displayReveal && !!displayQuestion;
  const currentPresenterNotes = presenterNotesEnabled
    ? presenterNotesByIndex[displayQuestion?.questionIndex ?? -1] ?? []
    : [];
  const getQuestionHeading = useCallback((questionIndex: number | null | undefined): string | null => {
    if (questionIndex === null || questionIndex === undefined || questionIndex < 0) {
      return null;
    }
    return questionHeadings[questionIndex] || null;
  }, [questionHeadings]);
  const displayHeading = getQuestionHeading(displayQuestion?.questionIndex) || displayQuestion?.topic || null;
  const nextQuestionHeading = isReviewing
    ? null
    : getQuestionHeading(liveQuestionIndex >= 0 ? liveQuestionIndex + 1 : 0);

  // Determine which controls to show
  const liveIsSlide = q?.questionType === "slide";
  const canClose = state === "QUESTION_OPEN" && !liveIsSlide;
  const canReveal = state === "QUESTION_CLOSED" && !liveIsSlide;
  const canNext =
    (state === "REVEAL" || (state === "QUESTION_OPEN" && liveIsSlide)) &&
    q &&
    q.questionIndex < totalQuestionsInQuiz - 1;
  const canPrev = !isReviewing && state !== "LOBBY" && state !== "ENDED" && liveQuestionIndex > 0;
  const canShowLeaderboard = state === "REVEAL" && !liveIsSlide;
  const isFinalQuestion = liveQuestionIndex >= totalQuestionsInQuiz - 1;
  const displayQuestionModeText = displayQuestion
    ? getQuestionModeText(displayQuestion.questionType, displayQuestion.allowsMultiple)
    : "";
  const liveRevealActionLabel = getRevealActionLabel(q?.questionType ?? "multiple_choice");
  const liveOpenResponses = displayQuestion?.questionType === "open_response"
    ? sock.answerCount?.openResponses ?? []
    : [];
  const revealOpenResponses = displayReveal?.questionType === "open_response"
    ? displayReveal.openResponses
    : [];
  const isSlideDisplay = displayQuestion?.questionType === "slide" && !displayReveal;
  const isQuizSurfaceDisplay = !!displayQuestion && displayQuestion.questionType !== "slide" && state !== "LEADERBOARD";
  const isLeaderboardDisplay = state === "LEADERBOARD" && !isReviewing;
  const isReviewSurfaceDisplay = isReviewing && !!displayQuestion;
  const isLiveSurfaceDisplay = isSlideDisplay || isQuizSurfaceDisplay || isLeaderboardDisplay || isReviewSurfaceDisplay;
  const isLiveEmbedSlideDisplay = isSlideDisplay && !!displayQuestion?.slideLiveEmbed;
  const participantCount = sock.participants?.count ?? 0;
  const liveConnectionNoticeLabel = !sock.connected
    ? sock.error ? "Connection lost; tap Reconnect" : "Reconnecting..."
    : null;
  const liveRestoreNoticeLabel = restoreNotice && isLiveSurfaceDisplay
    ? restoreNotice === INSTRUCTOR_RESTORE_SUCCESS_NOTICE
      ? "Session resumed"
      : restoreNotice.replace(/\.$/, "")
    : null;
  const liveStatusTone: "neutral" | "success" | "warning" = liveConnectionNoticeLabel
    ? "warning"
    : liveRestoreNoticeLabel
    ? "success"
    : isReviewing
      ? "warning"
      : "neutral";
  const slideStatusLabel = liveConnectionNoticeLabel ?? liveRestoreNoticeLabel ?? (isReviewing && reviewQuestionIndex !== null
    ? `Reviewing ${formatPositionLabel(reviewQuestionIndex, totalQuestionsInQuiz)}; students stay live`
    : null);
  const quizStatusLabel = (() => {
    if (liveConnectionNoticeLabel) return liveConnectionNoticeLabel;
    if (liveRestoreNoticeLabel) return liveRestoreNoticeLabel;
    if (!displayQuestion || displayQuestion.questionType === "slide") return null;
    if (isReviewing && reviewQuestionIndex !== null) {
      return `Reviewing ${formatPositionLabel(reviewQuestionIndex, totalQuestionsInQuiz)}; students stay live`;
    }
    if (displayReveal) return displayReveal.isPoll ? "Results open" : "Answer revealed";
    if (state === "QUESTION_CLOSED") return "Time's up";
    if (sock.answerCount && state === "QUESTION_OPEN") {
      return `${sock.answerCount.submitted}/${sock.answerCount.total} answered`;
    }
    return null;
  })();
  const displayPositionLabel = displayQuestion
    ? formatPositionLabel(displayQuestion.questionIndex, totalQuestionsInQuiz)
    : undefined;
  const currentReviewListIndex = isReviewing && reviewQuestionIndex !== null
    ? availableReviewIndices.findIndex((v) => v === reviewQuestionIndex)
    : -1;
  const itemSummaries = questionSummaries.length > 0
    ? questionSummaries
    : questionHeadings.map((heading) => ({
      heading,
      questionType: "multiple_choice" as QuestionType,
    }));
  const activeItemStillPending = state === "QUESTION_OPEN" || state === "QUESTION_CLOSED";
  const remainingStartIndex = liveQuestionIndex >= 0
    ? liveQuestionIndex + (activeItemStillPending ? 0 : 1)
    : 0;
  const remainingItems = itemSummaries.slice(Math.max(0, Math.min(remainingStartIndex, itemSummaries.length)));
  const remainingSlideCount = remainingItems.filter((item) => item.questionType === "slide").length;
  const remainingQuizQuestionCount = Math.max(remainingItems.length - remainingSlideCount, 0);
  const remainingItemCount = remainingQuizQuestionCount + remainingSlideCount;
  const remainingVerb = remainingItemCount === 1 ? "remains" : "remain";
  const controlsUnavailable = loading || !sock.connected;

  useEffect(() => {
    if (!showEndConfirm) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowEndConfirm(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showEndConfirm]);

  const requestEndSession = useCallback(() => {
    setShowEndConfirm(true);
  }, []);

  const confirmEndSession = useCallback(() => {
    setShowEndConfirm(false);
    onAction(() => endSession(sessionId), "end");
  }, [onAction, sessionId]);

  const liveSurfaceNavActions: LiveSurfaceAction[] = (() => {
    if (state === "LEADERBOARD") {
      return [];
    }

    if (isReviewing && reviewQuestionIndex !== null) {
      return [
        {
          label: "Prev",
          onClick: () => {
            if (currentReviewListIndex > 0) {
              setReviewQuestionIndex(availableReviewIndices[currentReviewListIndex - 1]);
            }
          },
          disabled: currentReviewListIndex <= 0,
        },
        {
          label: "Next",
          onClick: () => {
            if (currentReviewListIndex >= 0 && currentReviewListIndex < availableReviewIndices.length - 1) {
              setReviewQuestionIndex(availableReviewIndices[currentReviewListIndex + 1]);
            }
          },
          disabled: currentReviewListIndex >= availableReviewIndices.length - 1,
        },
      ];
    }

    return [
      {
        label: "Prev",
        onClick: () => onAction(() => prevQuestion(sessionId), "previous"),
        disabled: !canPrev || controlsUnavailable,
      },
      {
        label: "Next",
        detail: nextQuestionHeading,
        onClick: () => onAction(() => nextQuestion(sessionId), "next"),
        disabled: !canNext || controlsUnavailable,
        tone: canNext ? "primary" : "neutral",
      },
    ];
  })();

  const liveSurfaceActions: LiveSurfaceAction[] = (() => {
    if (!sock.connected) {
      return [{
        label: "Reconnect",
        onClick: sock.reconnect,
        tone: "primary",
      }];
    }

    if (isReviewing && reviewQuestionIndex !== null) {
      return [
        {
          label: "Back to Live",
          onClick: () => setReviewQuestionIndex(null),
          tone: "primary",
        },
        {
          label: "End Session",
          onClick: requestEndSession,
          disabled: controlsUnavailable,
          tone: "danger",
        },
      ];
    }

    if (state === "LEADERBOARD") {
      return [
        {
          label: isFinalQuestion ? "Review Final" : "Back to Quiz",
          onClick: () => {
            if (isFinalQuestion) {
              setReviewQuestionIndex(liveQuestionIndex);
              return;
            }
            onAction(() => hideLeaderboard(sessionId), "resume");
          },
          disabled: controlsUnavailable,
        },
        {
          label: "End Session",
          onClick: requestEndSession,
          disabled: controlsUnavailable,
          tone: "danger",
        },
      ];
    }

    const actions: LiveSurfaceAction[] = [];
    if (canClose) {
      actions.push({
        label: "Close Question",
        onClick: () => onAction(() => closeQuestion(sessionId), "close"),
        disabled: controlsUnavailable,
        tone: "warning",
      });
    }
    if (canReveal) {
      actions.push({
        label: liveRevealActionLabel,
        onClick: () => onAction(() => revealAnswer(sessionId), "reveal"),
        disabled: controlsUnavailable,
        tone: "primary",
      });
    }
    if (canShowLeaderboard) {
      actions.push({
        label: "Show Leaderboard",
        onClick: () => onAction(() => showLeaderboard(sessionId), "leaderboard"),
        disabled: controlsUnavailable,
        tone: "primary",
      });
    }
    actions.push({
      label: "End Session",
      onClick: requestEndSession,
      disabled: controlsUnavailable,
      tone: "danger",
    });
    return actions;
  })();

  const endSessionConfirmDialog = showEndConfirm ? (
    <div
      className="end-session-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-[#07060b]/80 px-5 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          setShowEndConfirm(false);
        }
      }}
    >
      <div
        className="end-session-card w-full max-w-lg rounded-2xl border border-red-300/25 bg-[#201d28] p-6 text-white shadow-2xl shadow-black/50"
        role="dialog"
        aria-modal="true"
        aria-labelledby="end-session-title"
      >
        <p className="end-session-eyebrow text-xs font-semibold uppercase tracking-[0.22em] text-red-200/80">End live session</p>
        <h2 id="end-session-title" className="mt-3 text-2xl font-semibold">Are you sure?</h2>
        <p className="end-session-desc mt-3 text-sm leading-6 text-zinc-300">
          Ending now will close the live room for everyone. If you continue, {pluralize(remainingQuizQuestionCount, "quiz question")} and {pluralize(remainingSlideCount, "slide")} {remainingVerb}.
        </p>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="end-session-stat rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3">
            <p className="end-session-stat-value text-3xl font-semibold tabular-nums text-white">{remainingQuizQuestionCount}</p>
            <p className="end-session-stat-label mt-1 text-xs uppercase tracking-[0.18em] text-zinc-400">Quiz questions left</p>
          </div>
          <div className="end-session-stat rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3">
            <p className="end-session-stat-value text-3xl font-semibold tabular-nums text-white">{remainingSlideCount}</p>
            <p className="end-session-stat-label mt-1 text-xs uppercase tracking-[0.18em] text-zinc-400">Slides left</p>
          </div>
        </div>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            className="end-session-keep rounded-xl border border-white/12 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-zinc-100 transition-colors hover:bg-white/[0.08]"
            onClick={() => setShowEndConfirm(false)}
            autoFocus
          >
            Keep Session
          </button>
          <button
            type="button"
            className="end-session-end rounded-xl border border-red-300/35 bg-red-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-red-950/25 transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-zinc-700 disabled:text-zinc-400 disabled:shadow-none"
            onClick={confirmEndSession}
            disabled={controlsUnavailable}
          >
            End Session
          </button>
        </div>
      </div>
    </div>
  ) : null;

  const liveSurfaceStatusLabel = isLeaderboardDisplay
    ? quizLabel ? `Leaderboard for ${quizLabel.toUpperCase()}` : "Leaderboard"
    : isSlideDisplay
      ? slideStatusLabel
      : quizStatusLabel;
  const liveSurfaceContent = (() => {
    if (displayQuestion && (((state === "QUESTION_OPEN" || state === "QUESTION_CLOSED") && !isReviewing) || (isReviewing && !displayReveal))) {
      if (displayQuestion.questionType === "slide") {
        return (
          <SlideContentBody
            title={displayHeading || displayQuestion.topic}
            html={displayQuestion.text}
            attendeeNotes={displayQuestion.attendeeNotes}
            slideMedia={displayQuestion.slideMedia}
            slideMediaPosition={displayQuestion.slideMediaPosition}
            slideMediaOpacity={displayQuestion.slideMediaOpacity}
            slideLiveEmbed={displayQuestion.slideLiveEmbed}
            slideVideo={displayQuestion.slideVideo}
            slideReferences={displayQuestion.slideReferences}
          />
        );
      }

      return (
        <ResponsiveQuizSurface>
          {state === "QUESTION_OPEN" && !isReviewing && (
            <Timer
              remainingSec={sock.remainingSec}
              totalSec={displayQuestion.timeLimitSec}
              size={140}
            />
          )}
          {state === "QUESTION_CLOSED" && !isReviewing && (
            <div className="text-amber-400 text-2xl font-bold">Time's up</div>
          )}
          {isReviewing && (
            <div className="text-amber-300 text-lg font-semibold">Review Mode</div>
          )}

          <QuizHtml
            className="quiz-html text-2xl lg:text-3xl text-white text-center leading-relaxed max-w-5xl"
            html={displayQuestion.text}
          />

          <div className={`selection-mode-chip ${displayQuestion.questionType === "open_response" || displayQuestion.allowsMultiple ? "selection-mode-chip-multi" : "selection-mode-chip-single"}`}>
            {displayQuestionModeText}
          </div>

          {displayQuestion.questionType === "open_response" ? (
            <OpenResponseList
              responses={liveOpenResponses}
              title={state === "QUESTION_CLOSED" ? "Submitted Responses" : "Live Responses"}
              showStudentIds={!autoGenerateStudentIds}
            />
          ) : (
            (() => {
              const dist = state === "QUESTION_CLOSED" && !isReviewing ? sock.distribution?.distribution : null;
              const totalResponses = sock.answerCount?.submitted ?? 0;
              const maxCount = dist ? Math.max(1, ...Object.values(dist)) : 0;
              return (
                <div className={`w-full max-w-4xl ${dist ? "space-y-3" : "grid grid-cols-1 sm:grid-cols-2 gap-3"}`}>
                  {displayQuestion.options.map((opt) => {
                    const count = dist?.[opt.label] ?? 0;
                    const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                    const pctOfTotal = totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0;
                    return (
                      <div key={opt.label} className="relative rounded-xl border border-zinc-700 bg-zinc-800 overflow-hidden">
                        {dist && (
                          <div
                            className="bar-fill absolute inset-0 bg-indigo-500/30 rounded-xl"
                            style={{ width: `${Math.max(pct, 2)}%` }}
                          />
                        )}
                        <div className="relative flex items-center gap-3 px-5 py-4">
                          <span className={`bg-zinc-700 text-zinc-300 font-mono font-bold w-9 h-9 flex items-center justify-center shrink-0 text-lg ${displayQuestion.allowsMultiple ? "rounded-lg" : "rounded-full"}`}>
                            {opt.label}
                          </span>
                          <QuizHtml className="quiz-html text-left text-zinc-200 text-lg flex-1" html={opt.text} as="span" />
                          {dist && count > 0 && (
                            <span className="text-sm font-semibold tabular-nums text-zinc-300 shrink-0">
                              {count} ({pctOfTotal}%)
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })()
          )}
        </ResponsiveQuizSurface>
      );
    }

    if (displayReveal && displayQuestion && (((state === "REVEAL") && !isReviewing) || isReviewing)) {
      return (
        <ResponsiveQuizSurface reveal>
          <QuizHtml
            className={`quiz-html text-center leading-relaxed max-w-5xl ${isReviewing ? "text-2xl lg:text-3xl text-white" : "text-xl lg:text-2xl text-zinc-300"}`}
            html={displayQuestion.text}
          />

          {displayQuestion.questionType === "open_response" ? (
            <OpenResponseList responses={revealOpenResponses} title="Responses" emptyLabel="No responses were submitted." showStudentIds={!autoGenerateStudentIds} />
          ) : showDetailedRevealChoices && (() => {
            const dist = displayReveal.distribution;
            const maxCount = Math.max(1, ...Object.values(dist));
            const totalSelections = Object.values(dist).reduce((sum, c) => sum + c, 0);
            return (
              <div className="w-full max-w-4xl space-y-2">
                {displayQuestion.options.map((opt) => {
                  const isCorrect = displayReveal.correctOptions.includes(opt.label);
                  const count = dist[opt.label] ?? 0;
                  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                  const pctOfTotal = totalSelections > 0 ? Math.round((count / totalSelections) * 100) : 0;

                  const borderClass = displayReveal.isPoll
                    ? "border-zinc-800"
                    : isCorrect
                      ? "border-emerald-500/60"
                      : "border-zinc-800";
                  const barColor = displayReveal.isPoll
                    ? "bg-indigo-500/30"
                    : isCorrect
                      ? "bg-emerald-500/25"
                      : "bg-zinc-600/25";
                  const markerClass = displayReveal.isPoll
                    ? "bg-zinc-700 text-zinc-300"
                    : isCorrect
                      ? "bg-emerald-600 text-white"
                      : "bg-zinc-700 text-zinc-300";
                  const textClass = displayReveal.isPoll
                    ? "text-zinc-200"
                    : isCorrect
                      ? "text-emerald-100"
                      : "text-zinc-200";

                  return (
                    <div
                      key={opt.label}
                      className={`relative rounded-xl border bg-zinc-900/60 overflow-hidden ${borderClass}`}
                    >
                      <div
                        className={`bar-fill absolute inset-0 rounded-xl ${barColor}`}
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                      <div className="relative flex items-center gap-3 px-4 py-3">
                        <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 font-mono font-bold text-sm ${markerClass}`}>
                          {opt.label}
                        </span>
                        <QuizHtml className={`quiz-html text-left pt-0.5 flex-1 ${textClass}`} html={opt.text} as="span" />
                        {count > 0 && (
                          <span className={`text-sm font-semibold tabular-nums shrink-0 ${isCorrect && !displayReveal.isPoll ? "text-emerald-300" : "text-zinc-300"}`}>
                            {count} ({pctOfTotal}%)
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {displayReveal.explanation && (
            <div className="bg-emerald-900/30 border border-emerald-700/50 rounded-xl p-6 max-w-4xl w-full text-left">
              <h3 className="text-emerald-400 font-semibold mb-2">Explanation</h3>
              <InlineMarkdownText text={displayReveal.explanation} className="text-emerald-100 text-lg leading-relaxed" />
            </div>
          )}
        </ResponsiveQuizSurface>
      );
    }

    if (isLeaderboardDisplay) {
      return (
        <ResponsiveQuizSurface leaderboard>
          <Leaderboard
            entries={sock.leaderboard}
            totalQuestions={sock.totalQuestions ?? totalQuestionsInQuiz}
            maxRows={10}
            showStudentIds={!autoGenerateStudentIds}
          />
        </ResponsiveQuizSurface>
      );
    }

    return null;
  })();

  if (isLiveSurfaceDisplay) {
    return (
      <div className="slide-live-shell slide-live-shell-controls">
        <div className="slide-live-main">
          <LiveSurface
            mode={isReviewing ? "review" : "projector"}
            surfaceClassName={isLiveEmbedSlideDisplay ? "slide-surface-live-embed" : isSlideDisplay ? undefined : "quiz-surface"}
            backgroundLayer={isSlideDisplay && displayQuestion?.slideBackground ? <SlideBackgroundLayer background={displayQuestion.slideBackground} /> : undefined}
            nextLabel={null}
            qrDataUrl={accessInfo?.qrCodeDataUrl}
            sessionCode={sessionCode}
            participantCount={participantCount}
            presentationUrl={accessInfo?.presentationUrl}
            joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
            shortUrl={accessInfo?.shortUrl}
            joinCardDefaultExpanded={isLiveEmbedSlideDisplay && displayQuestion?.questionIndex === 0}
            positionLabel={isLeaderboardDisplay ? undefined : displayPositionLabel}
            statusLabel={liveSurfaceStatusLabel}
            statusTone={liveStatusTone}
            navActions={liveSurfaceNavActions}
            actions={liveSurfaceActions}
          >
            {liveSurfaceContent}
          </LiveSurface>
        </div>
        {presenterNotesEnabled && currentPresenterNotes.length > 0 && (
          <PresenterNotesPanel
            notes={currentPresenterNotes}
            open={presenterNotesOpen}
            onToggle={onPresenterNotesToggle}
            positionLabel={displayPositionLabel}
          />
        )}

        {errorMsg && (
          <div className="slide-page-error bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-xl text-center">
            {errorMsg}
          </div>
        )}
        {endSessionConfirmDialog}
      </div>
    );
  }

  return (
    <div className={isLiveSurfaceDisplay ? "slide-live-shell slide-live-shell-controls" : `min-h-dvh flex flex-col p-6 lg:p-10 ${accessInfo && sessionCode ? "lg:pr-56" : ""}`}>
      {/* Top bar: question progress + timer + participant count */}
      {!isLiveSurfaceDisplay && (
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          {displayQuestion && (
            <span className="text-zinc-400 text-lg font-medium">
              Q{displayQuestion.questionIndex + 1}/{totalQuestionsInQuiz}
            </span>
          )}
          {displayQuestion && (
            <span className="text-zinc-600 text-sm">
              {displayHeading}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {/* Answered count */}
          {sock.answerCount && (state === "QUESTION_OPEN" || state === "QUESTION_CLOSED") && (
            <span className="text-zinc-400 font-mono tabular-nums">
              {sock.answerCount.submitted}/{sock.answerCount.total} answered
            </span>
          )}
          <span className="text-zinc-500 tabular-nums">
            {sock.participants?.count ?? 0} online
          </span>
          {isReviewing && reviewQuestionIndex !== null && (
            <span className="text-amber-300 text-sm font-medium">
              Reviewing Q{reviewQuestionIndex + 1} (students stay on live state)
            </span>
          )}
        </div>
      </div>
      )}

      {/* Main content */}
      <div className={isLiveSurfaceDisplay ? "slide-live-main" : "flex-1 flex flex-col items-center justify-center gap-8 mx-auto w-full max-w-3xl"}>
        {nextQuestionHeading && !isLiveSurfaceDisplay && (
          <div className="w-full max-w-3xl rounded-2xl border border-sky-500/30 bg-sky-500/10 px-5 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-200/80">Next up</p>
            <p className="mt-2 text-lg text-sky-50">{nextQuestionHeading}</p>
          </div>
        )}

        {/* Question display (for QUESTION_OPEN, QUESTION_CLOSED) */}
        {displayQuestion && (((state === "QUESTION_OPEN" || state === "QUESTION_CLOSED") && !isReviewing) || (isReviewing && !displayReveal)) && (
          <>
            {displayQuestion.questionType === "slide" ? (
              <SlideContent
                title={displayHeading || displayQuestion.topic}
                html={displayQuestion.text}
                attendeeNotes={displayQuestion.attendeeNotes}
                slideMedia={displayQuestion.slideMedia}
                slideMediaPosition={displayQuestion.slideMediaPosition}
                slideMediaOpacity={displayQuestion.slideMediaOpacity}
                slideBackground={displayQuestion.slideBackground}
                slideLiveEmbed={displayQuestion.slideLiveEmbed}
                slideVideo={displayQuestion.slideVideo}
                slideReferences={displayQuestion.slideReferences}
                positionLabel={displayPositionLabel}
                nextLabel={null}
                qrDataUrl={accessInfo?.qrCodeDataUrl}
                sessionCode={sessionCode}
                participantCount={participantCount}
                presentationUrl={accessInfo?.presentationUrl}
                joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
                shortUrl={accessInfo?.shortUrl}
                joinCardDefaultExpanded={false}
                statusLabel={slideStatusLabel}
                statusTone={liveStatusTone}
                navActions={liveSurfaceNavActions}
                actions={liveSurfaceActions}
              />
            ) : (
              <LiveSurface
                surfaceClassName="quiz-surface"
                nextLabel={null}
                qrDataUrl={accessInfo?.qrCodeDataUrl}
                sessionCode={sessionCode}
                participantCount={participantCount}
                presentationUrl={accessInfo?.presentationUrl}
                joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
                shortUrl={accessInfo?.shortUrl}
                joinCardDefaultExpanded={false}
                positionLabel={displayPositionLabel}
                statusLabel={quizStatusLabel}
                statusTone={liveStatusTone}
                navActions={liveSurfaceNavActions}
                actions={liveSurfaceActions}
              >
                <ResponsiveQuizSurface>
                  {/* Timer */}
                  {state === "QUESTION_OPEN" && !isReviewing && (
                    <Timer
                      remainingSec={sock.remainingSec}
                      totalSec={displayQuestion.timeLimitSec}
                      size={140}
                    />
                  )}
                  {state === "QUESTION_CLOSED" && !isReviewing && (
                    <div className="text-amber-400 text-2xl font-bold">Time's up</div>
                  )}
                  {isReviewing && (
                    <div className="text-amber-300 text-lg font-semibold">Review Mode</div>
                  )}

                  {/* Question text */}
                  <QuizHtml
                    className="quiz-html text-2xl lg:text-3xl text-white text-center leading-relaxed max-w-5xl"
                    html={displayQuestion.text}
                  />

                  <div className={`selection-mode-chip ${displayQuestion.questionType === "open_response" || displayQuestion.allowsMultiple ? "selection-mode-chip-multi" : "selection-mode-chip-single"}`}>
                    {displayQuestionModeText}
                  </div>

                  {displayQuestion.questionType === "open_response" ? (
                    <OpenResponseList
                      responses={liveOpenResponses}
                      title={state === "QUESTION_CLOSED" ? "Submitted Responses" : "Live Responses"}
                      showStudentIds={!autoGenerateStudentIds}
                    />
                  ) : (
                    (() => {
                      const dist = state === "QUESTION_CLOSED" && !isReviewing ? sock.distribution?.distribution : null;
                      const totalResponses = sock.answerCount?.submitted ?? 0;
                      const maxCount = dist ? Math.max(1, ...Object.values(dist)) : 0;
                      return (
                        <div className={`w-full max-w-4xl ${dist ? "space-y-3" : "grid grid-cols-1 sm:grid-cols-2 gap-3"}`}>
                          {displayQuestion.options.map((opt) => {
                            const count = dist?.[opt.label] ?? 0;
                            const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                            const pctOfTotal = totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0;
                            return (
                              <div key={opt.label} className="relative rounded-xl border border-zinc-700 bg-zinc-800 overflow-hidden">
                                {dist && (
                                  <div
                                    className="bar-fill absolute inset-0 bg-indigo-500/30 rounded-xl"
                                    style={{ width: `${Math.max(pct, 2)}%` }}
                                  />
                                )}
                                <div className="relative flex items-center gap-3 px-5 py-4">
                                  <span className={`bg-zinc-700 text-zinc-300 font-mono font-bold w-9 h-9 flex items-center justify-center shrink-0 text-lg ${displayQuestion.allowsMultiple ? "rounded-lg" : "rounded-full"}`}>
                                    {opt.label}
                                  </span>
                                  <QuizHtml className="quiz-html text-left text-zinc-200 text-lg flex-1" html={opt.text} as="span" />
                                  {dist && count > 0 && (
                                    <span className="text-sm font-semibold tabular-nums text-zinc-300 shrink-0">
                                      {count} ({pctOfTotal}%)
                                    </span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })()
                  )}
                </ResponsiveQuizSurface>
              </LiveSurface>
            )}
          </>
        )}

        {/* Reveal view */}
        {displayReveal && (((state === "REVEAL" && displayQuestion && !isReviewing) || (isReviewing && displayQuestion))) && (
          <LiveSurface
            surfaceClassName="quiz-surface"
            nextLabel={null}
            qrDataUrl={accessInfo?.qrCodeDataUrl}
            sessionCode={sessionCode}
            participantCount={participantCount}
            presentationUrl={accessInfo?.presentationUrl}
            joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
            shortUrl={accessInfo?.shortUrl}
            joinCardDefaultExpanded={false}
            positionLabel={displayPositionLabel}
            statusLabel={quizStatusLabel}
            statusTone={liveStatusTone}
            navActions={liveSurfaceNavActions}
            actions={liveSurfaceActions}
          >
            <ResponsiveQuizSurface reveal>
              <QuizHtml
                className={`quiz-html text-center leading-relaxed max-w-5xl ${isReviewing ? "text-2xl lg:text-3xl text-white" : "text-xl lg:text-2xl text-zinc-300"}`}
                html={displayQuestion.text}
              />

              {displayQuestion.questionType === "open_response" ? (
                <OpenResponseList responses={revealOpenResponses} title="Responses" emptyLabel="No responses were submitted." showStudentIds={!autoGenerateStudentIds} />
              ) : showDetailedRevealChoices && (() => {
                const dist = displayReveal.distribution;
                const maxCount = Math.max(1, ...Object.values(dist));
                const totalSelections = Object.values(dist).reduce((sum, c) => sum + c, 0);
                return (
                  <div className="w-full max-w-4xl space-y-2">
                    {displayQuestion.options.map((opt) => {
                      const isCorrect = displayReveal.correctOptions.includes(opt.label);
                      const count = dist[opt.label] ?? 0;
                      const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                      const pctOfTotal = totalSelections > 0 ? Math.round((count / totalSelections) * 100) : 0;

                      const borderClass = displayReveal.isPoll
                        ? "border-zinc-800"
                        : isCorrect
                          ? "border-emerald-500/60"
                          : "border-zinc-800";
                      const barColor = displayReveal.isPoll
                        ? "bg-indigo-500/30"
                        : isCorrect
                          ? "bg-emerald-500/25"
                          : "bg-zinc-600/25";
                      const markerClass = displayReveal.isPoll
                        ? "bg-zinc-700 text-zinc-300"
                        : isCorrect
                          ? "bg-emerald-600 text-white"
                          : "bg-zinc-700 text-zinc-300";
                      const textClass = displayReveal.isPoll
                        ? "text-zinc-200"
                        : isCorrect
                          ? "text-emerald-100"
                          : "text-zinc-200";

                      return (
                        <div
                          key={opt.label}
                          className={`relative rounded-xl border bg-zinc-900/60 overflow-hidden ${borderClass}`}
                        >
                          <div
                            className={`bar-fill absolute inset-0 rounded-xl ${barColor}`}
                            style={{ width: `${Math.max(pct, 2)}%` }}
                          />
                          <div className="relative flex items-center gap-3 px-4 py-3">
                            <span className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 font-mono font-bold text-sm ${markerClass}`}>
                              {opt.label}
                            </span>
                            <QuizHtml className={`quiz-html text-left pt-0.5 flex-1 ${textClass}`} html={opt.text} as="span" />
                            {count > 0 && (
                              <span className={`text-sm font-semibold tabular-nums shrink-0 ${isCorrect && !displayReveal.isPoll ? "text-emerald-300" : "text-zinc-300"}`}>
                                {count} ({pctOfTotal}%)
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              {displayReveal.explanation && (
                <div className="bg-emerald-900/30 border border-emerald-700/50 rounded-xl p-6 max-w-4xl w-full text-left">
                  <h3 className="text-emerald-400 font-semibold mb-2">Explanation</h3>
                  <InlineMarkdownText text={displayReveal.explanation} className="text-emerald-100 text-lg leading-relaxed" />
                </div>
              )}
            </ResponsiveQuizSurface>
          </LiveSurface>
        )}

        {isLeaderboardDisplay && (
          <LiveSurface
            surfaceClassName="quiz-surface"
            qrDataUrl={accessInfo?.qrCodeDataUrl}
            sessionCode={sessionCode}
            participantCount={participantCount}
            presentationUrl={accessInfo?.presentationUrl}
            joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
            shortUrl={accessInfo?.shortUrl}
            joinCardDefaultExpanded={false}
            statusLabel={quizLabel ? `Leaderboard for ${quizLabel.toUpperCase()}` : "Leaderboard"}
            navActions={liveSurfaceNavActions}
            actions={liveSurfaceActions}
          >
            <ResponsiveQuizSurface leaderboard>
              <Leaderboard
                entries={sock.leaderboard}
                totalQuestions={sock.totalQuestions ?? totalQuestionsInQuiz}
                maxRows={10}
                showStudentIds={!autoGenerateStudentIds}
              />
            </ResponsiveQuizSurface>
          </LiveSurface>
        )}
      </div>

      {/* Error */}
      {errorMsg && (
        <div className={`${isLiveSurfaceDisplay ? "slide-page-error" : "mt-4"} bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-xl text-center`}>
          {errorMsg}
        </div>
      )}

      {restoreNotice && !isLiveSurfaceDisplay && (
        <div className="mt-4 bg-emerald-900/40 border border-emerald-700 text-emerald-100 px-4 py-3 rounded-xl text-center text-sm">
          {restoreNotice}
        </div>
      )}

      {accessInfo && sessionCode && !isLiveSurfaceDisplay && (
        <SessionCodeCard
          className="fixed-session-code-card"
          qrDataUrl={accessInfo.qrCodeDataUrl}
          sessionCode={sessionCode}
          participantCount={sock.participants?.count ?? 0}
          presentationUrl={accessInfo.presentationUrl}
          joinUrl={accessInfo.shortUrl || accessInfo.fullUrl}
          shortUrl={accessInfo.shortUrl}
          defaultExpanded={false}
        />
      )}
      {endSessionConfirmDialog}
    </div>
  );
}
