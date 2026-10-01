import { isSlideType } from "@mdq/shared";
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
  setResponseHidden,
  releaseSeat,
  setJoinLocked,
  resultsCsvUrl,
  fetchSessionAccessInfo,
  fetchSessionStateForRestore,
  fetchPresenterNotes,
  type DeckSummary,
  type QuestionSummary,
  type CreateSessionResponse,
  type SessionRestoreResponse,
} from "../hooks/api";
import { formatDiagnostic } from "@mdq/shared";
import type { AccessInfo, DeckPalette, DeckTheme, FoldoutNote, OpenResponseEntry, QuestionType, SessionState } from "@mdq/shared";
import { applyClientPalette, applyClientTheme } from "../theme";
import Timer from "../components/Timer";
import Leaderboard from "../components/Leaderboard";
import { deckLabel, resultsHeading } from "../deckLabel";
import OpenResponseList from "../components/OpenResponseList";
import ParticipantList from "../components/ParticipantList";
import QRPanel from "../components/QRPanel";
import SessionCodeCard from "../components/SessionCodeCard";
import JoinLockToggle from "../components/JoinLockToggle";
import SettingSwitch from "../components/SettingSwitch";
import { mountParticipantsDialog } from "../participantsDialog";
import InlineMarkdownText from "../components/InlineMarkdownText";
import QuizHtml from "../components/QuizHtml";
import LiveSurface, { type LiveSurfaceAction } from "../components/LiveSurface";
import ResponsiveQuizSurface from "../components/ResponsiveQuizSurface";
import { quizFitKey } from "../quizFit";
import SlideContent, { SlideContentBody } from "../components/SlideContent";
import SlideBackgroundLayer from "../components/SlideBackgroundLayer";
import PresenterNotesPanel from "../components/PresenterNotesPanel";
import { getQuestionModeText, getRevealActionLabel } from "../questionMode";
import { decidePresenterKey, documentHasOpenDialog, pickNavAction } from "../presenterKeys";
import { readShowStudentIds, saveShowStudentIds } from "../showStudentIds";
import { closedLabel as closedLabelFor, formatRemaining, pluralize, positionLabel as positionLabelFor } from "../instructorText";

type InstructorPhase = "setup" | "lobby" | "live" | "ended";
const INSTRUCTOR_RESTORE_KEY = "mdquiz_instructor_session";
const INSTRUCTOR_RESTORE_SUCCESS_NOTICE = "Resumed active session after refresh.";
/** How long the "session resumed" notice stays before it fades away. */
const RESTORE_NOTICE_MS = 5000;
const STUDENT_IDS_DESCRIPTION = "Show each ID beside the name, on this screen only.";

interface StoredInstructorRestore {
  sessionId: string;
  sessionCode: string;
  week: string;
  createdAt: number;
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
    deckStyle: data.deckStyle,
    options: data.options,
    allowsMultiple: data.allowsMultiple,
    isPoll: data.isPoll ?? false,
    timeLimitSec: data.timeLimitSec,
    startedAt: data.startedAt,
    questionNumber: data.questionNumber,
    questionTotal: data.questionTotal,
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

/**
 * True when this page load is a reload of the tab. Only then is "resumed after
 * refresh" true; a tab that was opened or duplicated is not resuming anything.
 */
function isPageReload(): boolean {
  try {
    const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    return entry?.type === "reload";
  } catch {
    return false;
  }
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
  // After session end the live opener no longer exists. Focus the new screen
  // once on attachment rather than leaving focus on the removed dialog/body.
  const endedHeadingRef = useCallback((heading: HTMLHeadingElement | null) => {
    heading?.focus({ preventScroll: true });
  }, []);
  const [totalQuestionsInQuiz, setTotalQuestionsInQuiz] = useState(0);
  const [questionHeadings, setQuestionHeadings] = useState<string[]>([]);
  const [questionSummaries, setQuestionSummaries] = useState<QuestionSummary[]>([]);
  const [quizLabel, setQuizLabel] = useState("");
  // Whether the deck uses Student IDs. With `student-id: false` the name is the ID, so the console has no IDs to show.
  const [deckUsesStudentIds, setDeckUsesStudentIds] = useState(true);
  const [sessionTheme, setSessionTheme] = useState<DeckTheme | undefined>();
  const [sessionPalette, setSessionPalette] = useState<DeckPalette | undefined>();
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
  const [restoredQuestionCache, setRestoredQuestionCache] = useState<Record<number, QuestionState>>({});
  const [restoredRevealCache, setRestoredRevealCache] = useState<Record<number, RevealState>>({});
  const [pendingRestore, setPendingRestore] = useState<StoredInstructorRestore | null>(null);
  // While a stored live session restores, keep the current theme instead of
  // flashing the default before the deck's own theme arrives.
  const [holdAppearance, setHoldAppearance] = useState(() => {
    try {
      return Boolean(sessionStorage.getItem(INSTRUCTOR_RESTORE_KEY));
    } catch {
      return false;
    }
  });
  const [showStudentIds, setShowStudentIds] = useState(readShowStudentIds);
  const restoreAttemptedRef = useRef(false);
  const actionInFlightRef = useRef(false);
  // Presenter notes (instructor-only). Populated from the instructor-
  // authenticated endpoint; empty/disabled means no panel renders.
  const [presenterNotesEnabled, setPresenterNotesEnabled] = useState(false);
  const [presenterNotesByIndex, setPresenterNotesByIndex] = useState<Record<number, FoldoutNote[]>>({});
  const [presenterNotesOpen, setPresenterNotesOpen] = useState(false);

  // Socket connection (instructor role)
  const sock = useSocket(sessionInfo?.sessionId ?? null, "instructor");

  // "Session resumed" is good news, not a lasting notice: it goes after a few seconds.
  useEffect(() => {
    if (restoreNotice !== INSTRUCTOR_RESTORE_SUCCESS_NOTICE) return;
    const timer = window.setTimeout(() => {
      setRestoreNotice((current) => (current === INSTRUCTOR_RESTORE_SUCCESS_NOTICE ? null : current));
    }, RESTORE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [restoreNotice]);

  const idsAvailable = deckUsesStudentIds && !autoGenerateStudentIds;
  const idsVisible = idsAvailable && showStudentIds;
  const toggleShowStudentIds = useCallback(() => {
    setShowStudentIds((current) => {
      saveShowStudentIds(!current);
      return !current;
    });
  }, []);
  const handleJoinLock = useCallback(
    (locked: boolean) => setJoinLocked(sessionInfo?.sessionId ?? "", locked),
    [sessionInfo?.sessionId],
  );
  const handleReleaseSeat = useCallback(
    (publicKey: string) => releaseSeat(sessionInfo?.sessionId ?? "", publicKey),
    [sessionInfo?.sessionId],
  );

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
      setQuizLabel(deckLabel(snapshot.title, snapshot.week));
      setDeckUsesStudentIds(snapshot.studentIds !== false);
      setSessionTheme(snapshot.theme);
      setSessionPalette(snapshot.palette);
      setHoldAppearance(false);
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

      // Say "resumed" only after a real reload of a running session, not on a first open.
      setRestoreNotice(isPageReload() ? INSTRUCTOR_RESTORE_SUCCESS_NOTICE : null);
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
      setHoldAppearance(false);
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
      setHoldAppearance(false);
      return;
    }

    if (stored?.sessionId) {
      void restoreInstructorSession(stored);
    } else {
      setHoldAppearance(false);
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
      setQuizLabel(deckLabel(deck?.title, deck?.week || selectedWeek));
      setDeckUsesStudentIds(info.studentIds !== false);
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
    setDeckUsesStudentIds(true);
    setSessionTheme(undefined);
    setSessionPalette(undefined);
    setRestoreNotice(null);
    setErrorMsg(null);
    setPhase("setup");
  }, [sock]);

  const sid = sessionInfo?.sessionId ?? "";
  const selectedDeck = decks.find((deck) => deck.week === selectedWeek);
  useEffect(() => {
    if (holdAppearance) return;
    applyClientTheme(sessionTheme ?? selectedDeck?.theme, defaultTheme);
  }, [defaultTheme, holdAppearance, selectedDeck?.theme, sessionTheme]);
  useEffect(() => {
    if (holdAppearance) return;
    applyClientPalette(sessionPalette ?? selectedDeck?.palette, defaultPalette);
  }, [defaultPalette, holdAppearance, selectedDeck?.palette, sessionPalette]);
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
                            {deck.diagnostics?.map((note) => (
                              <span key={`${note.severity}-${note.lineNumber ?? ""}-${note.message}`} className={`mt-1 block text-sm ${note.severity === "warning" ? "text-amber-300" : "text-zinc-400"}`}>
                                {note.severity === "warning" ? "Ignored" : "Note"}, {formatDiagnostic(note)}
                              </span>
                            ))}
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

        {/* Join details beside the room status on landscape screens, stacked otherwise */}
        <div className="instructor-lobby-body">
          <div className="instructor-lobby-join">
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
          </div>

          <div className="instructor-lobby-side">
            {/* Participant count */}
            <div className="instructor-participant-count text-center">
              <span className="instructor-participant-count-value text-5xl font-bold text-white tabular-nums">
                {sock.participants?.count ?? 0}
              </span>
              <span className="instructor-participant-count-label text-zinc-400 text-lg ml-2">students joined</span>
            </div>

            {/* Participant list */}
            {((sock.participants?.count ?? 0) > 0 || (sock.participants?.offline?.length ?? 0) > 0) && (
              <div className="instructor-participant-panel rounded-xl p-4 max-w-lg w-full max-h-64 overflow-y-auto">
                <ParticipantList
                  participants={sock.participants}
                  showStudentIds={idsVisible}
                  onRelease={handleReleaseSeat}
                  disabled={!sock.connected}
                />
              </div>
            )}
            <div className="session-settings session-settings-lobby" role="group" aria-label="Session settings">
              <JoinLockToggle
                locked={sock.participants?.joinLocked === true}
                onChange={handleJoinLock}
                disabled={!sock.connected}
              />
              {idsAvailable && (
                <SettingSwitch
                  label="Show Student IDs"
                  description={STUDENT_IDS_DESCRIPTION}
                  checked={showStudentIds}
                  onToggle={toggleShowStudentIds}
                />
              )}
            </div>

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
        </div>
      </div>
    );
  }

  // ── Ended Phase ──────────────────────────
  if (phase === "ended") {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-8 p-8">
        <h1 ref={endedHeadingRef} tabIndex={-1} className="text-3xl font-bold text-white">Session Ended</h1>
        {quizLabel && (
          <h2 className="text-xl font-semibold text-zinc-300 text-center">
            {resultsHeading("leaderboard", quizLabel)}
          </h2>
        )}
        <Leaderboard
          entries={sock.leaderboard}
          totalQuestions={sock.totalQuestions ?? totalQuestionsInQuiz}
          maxRows={15}
          showStudentIds={idsVisible}
        />
        {idsAvailable && (
          <button
            type="button"
            className="student-ids-toggle"
            aria-pressed={showStudentIds}
            onClick={toggleShowStudentIds}
          >
            Show Student IDs
          </button>
        )}
        <div className="flex flex-wrap items-center justify-center gap-3">
          {sid && (
            <a
              href={resultsCsvUrl(sid)}
              download
              className="instructor-results-download instructor-ended-link bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-3 px-8 rounded-xl transition-colors"
            >
              Download results (CSV)
            </a>
          )}
          <a
            href="#/"
            className="instructor-ended-link bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-3 px-8 rounded-xl transition-colors"
          >
            Back to Home
          </a>
        </div>
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
      idsAvailable={idsAvailable}
      nameOnly={!deckUsesStudentIds}
      showStudentIds={idsVisible}
      onToggleShowStudentIds={toggleShowStudentIds}
      onReleaseSeat={handleReleaseSeat}
      onJoinLock={handleJoinLock}
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
  idsAvailable,
  nameOnly,
  showStudentIds,
  onToggleShowStudentIds,
  onReleaseSeat,
  onJoinLock,
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
  /** False when the deck hides Student IDs altogether. */
  idsAvailable: boolean;
  /** True when the deck has no Student IDs and the name is the ID. */
  nameOnly: boolean;
  /** Whether Student IDs show beside names on this console. */
  showStudentIds: boolean;
  onToggleShowStudentIds: () => void;
  onReleaseSeat: (publicKey: string) => Promise<void>;
  onJoinLock: (locked: boolean) => Promise<void>;
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
  const [showParticipants, setShowParticipants] = useState(false);
  const participantsOpenerRef = useRef<HTMLElement | null>(null);
  // React runs this ref's cleanup before detaching the node, including when
  // a live update replaces the surface while Participants stays open.
  const participantsDialogRef = useCallback((dialog: HTMLDialogElement | null) => {
    if (!dialog) return;
    return mountParticipantsDialog(dialog, participantsOpenerRef.current);
  }, []);
  const [moderationNotice, setModerationNotice] = useState<string | null>(null);
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
  // What a question screen shows, so its fit starts afresh for a new question, state or edit.
  const fitKey = quizFitKey(displayQuestion, state, isReviewing);
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
  // Prev names the item before the current one, the way Next names the one after.
  const previousQuestionHeading = isReviewing || liveQuestionIndex <= 0
    ? null
    : getQuestionHeading(liveQuestionIndex - 1);

  // Determine which controls to show
  const liveIsSlide = isSlideType(q?.questionType);
  const canClose = state === "QUESTION_OPEN" && !liveIsSlide;
  const canReveal = state === "QUESTION_CLOSED" && !liveIsSlide;
  const canNext =
    (state === "REVEAL" || (state === "QUESTION_OPEN" && liveIsSlide)) &&
    q &&
    q.questionIndex < totalQuestionsInQuiz - 1;
  const canPrev = !isReviewing && state !== "LOBBY" && state !== "ENDED" && liveQuestionIndex > 0;
  // A leaderboard ranks scored questions, so it is offered once one has been revealed.
  const hasRevealedScoredQuestion = Object.values(revealCache).some(
    (reveal) => reveal.questionType === "multiple_choice" && !reveal.isPoll,
  );
  const canShowLeaderboard = state === "REVEAL" && !liveIsSlide && hasRevealedScoredQuestion;
  const isFinalQuestion = liveQuestionIndex >= totalQuestionsInQuiz - 1;
  // "Time's up" only when the timer ran out; closing early just closes the answers.
  const closedLabel = closedLabelFor(sock.timedOut);
  const noVotesClosed = state === "QUESTION_CLOSED" && !isReviewing && displayQuestion?.isPoll === true && (sock.answerCount?.submitted ?? 0) === 0;
  const noVotesRevealed = displayReveal?.isPoll === true && Object.values(displayReveal.distribution).every((count) => count === 0);
  const displayQuestionModeText = displayQuestion
    ? getQuestionModeText(displayQuestion.questionType, displayQuestion.allowsMultiple)
    : "";
  const liveRevealActionLabel = getRevealActionLabel(q?.questionType ?? "multiple_choice");
  // Hide or show one response on the projector; the server sends back the new state.
  const toggleResponseHidden = useCallback(async (response: OpenResponseEntry, hidden: boolean) => {
    if (!displayQuestion) return;
    setModerationNotice(null);
    try {
      await setResponseHidden(sessionId, displayQuestion.questionIndex, response.publicKey, hidden);
    } catch (e) {
      setModerationNotice(e instanceof Error ? e.message : "That did not work. Please try again.");
    }
  }, [displayQuestion, sessionId]);
  const moderationProps = isReviewing || !sock.connected
    ? {}
    : { onToggleHidden: toggleResponseHidden, notice: moderationNotice };
  const liveOpenResponses = displayQuestion?.questionType === "open_response"
    ? sock.answerCount?.openResponses ?? []
    : [];
  const revealOpenResponses = displayReveal?.questionType === "open_response"
    ? displayReveal.openResponses
    : [];
  const isSlideDisplay = isSlideType(displayQuestion?.questionType) && !displayReveal;
  const isQuizSurfaceDisplay = !!displayQuestion && !isSlideType(displayQuestion.questionType) && state !== "LEADERBOARD";
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
  // Questions are counted without slides, the same as on the phones; a slide shows no number.
  const displayPositionLabel = positionLabelFor(displayQuestion);
  const reviewingLabel = displayPositionLabel ? `Reviewing ${displayPositionLabel}` : "Reviewing";
  const slideStatusLabel = liveConnectionNoticeLabel ?? liveRestoreNoticeLabel ?? (isReviewing && reviewQuestionIndex !== null
    ? `${reviewingLabel}; students stay live`
    : null);
  const quizStatusLabel = (() => {
    if (liveConnectionNoticeLabel) return liveConnectionNoticeLabel;
    if (liveRestoreNoticeLabel) return liveRestoreNoticeLabel;
    if (!displayQuestion || isSlideType(displayQuestion.questionType)) return null;
    if (isReviewing && reviewQuestionIndex !== null) {
      return `${reviewingLabel}; students stay live`;
    }
    if (displayReveal) return displayReveal.isPoll ? "Results open" : "Answer revealed";
    if (state === "QUESTION_CLOSED") return closedLabel;
    if (sock.answerCount && state === "QUESTION_OPEN") {
      return `${sock.answerCount.submitted}/${sock.answerCount.total} answered`;
    }
    return null;
  })();
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
  const remainingSlideCount = remainingItems.filter((item) => isSlideType(item.questionType)).length;
  const remainingQuizQuestionCount = Math.max(remainingItems.length - remainingSlideCount, 0);
  const remainingSummary = formatRemaining(remainingQuizQuestionCount, remainingSlideCount);
  const controlsUnavailable = loading || !sock.connected;
  // Why a control is waiting, so a tap that cannot work says so instead of doing nothing.
  const waitingReason = !sock.connected ? "Reconnecting..." : null;

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
        detail: canPrev && waitingReason ? waitingReason : canPrev ? previousQuestionHeading : null,
        onClick: () => onAction(() => prevQuestion(sessionId), "previous"),
        disabled: !canPrev || controlsUnavailable,
        reason: canPrev ? waitingReason : null,
      },
      {
        label: "Next",
        detail: canNext && waitingReason ? waitingReason : nextQuestionHeading,
        onClick: () => onAction(() => nextQuestion(sessionId), "next"),
        disabled: !canNext || controlsUnavailable,
        reason: canNext ? waitingReason : null,
        tone: canNext ? "primary" : "neutral",
      },
    ];
  })();

  // Keys drive the same Prev and Next handlers as the buttons, so a disabled or
  // reconnecting button also stops the key. The ref keeps one listener in place
  // while the handlers are rebuilt on every render.
  const navActionsRef = useRef(liveSurfaceNavActions);
  useEffect(() => {
    navActionsRef.current = liveSurfaceNavActions;
  });
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const decision = decidePresenterKey(
        event,
        event.target as Element | null,
        documentHasOpenDialog(document),
        { arrowsScroll: window.matchMedia("(max-width: 760px)").matches },
      );
      if (!decision.consume || !decision.direction) return;
      event.preventDefault();
      if (!decision.act) return;
      void pickNavAction(navActionsRef.current, decision.direction)?.onClick?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const participantsAction: LiveSurfaceAction = {
    label: "Participants",
    onClick: (event) => {
      // Existing DOM overlays (QR/end confirm) must not be stranded behind
      // this native top-layer modal by activation of a background control.
      if (documentHasOpenDialog(document)) return;
      // Safari pointer clicks do not always focus buttons. Remember the button
      // that invoked this action rather than whichever element had focus.
      participantsOpenerRef.current = event?.currentTarget ?? document.activeElement as HTMLElement | null;
      setShowParticipants(true);
    },
  };
  const liveSurfaceActions: LiveSurfaceAction[] = (() => {
    // Offline, the controls stay where they are but wait, each saying why; Reconnect leads.
    const reconnect: LiveSurfaceAction[] = sock.connected ? [] : [{
      label: "Reconnect",
      onClick: sock.reconnect,
      tone: "primary",
    }];

    if (isReviewing && reviewQuestionIndex !== null) {
      return [
        ...reconnect,
        {
          label: "Back to Live",
          onClick: () => setReviewQuestionIndex(null),
          tone: "primary",
        },
        participantsAction,
        {
          label: "End Session",
          onClick: requestEndSession,
          disabled: controlsUnavailable,
          reason: waitingReason,
          tone: "danger",
        },
      ];
    }

    if (state === "LEADERBOARD") {
      return [
        ...reconnect,
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
          reason: waitingReason,
        },
        participantsAction,
        {
          label: "End Session",
          onClick: requestEndSession,
          disabled: controlsUnavailable,
          reason: waitingReason,
          tone: "danger",
        },
      ];
    }

    const actions: LiveSurfaceAction[] = [...reconnect];
    if (canClose) {
      actions.push({
        label: "Close Question",
        onClick: () => onAction(() => closeQuestion(sessionId), "close"),
        disabled: controlsUnavailable,
        reason: waitingReason,
        tone: "warning",
      });
    }
    if (canReveal) {
      actions.push({
        label: liveRevealActionLabel,
        onClick: () => onAction(() => revealAnswer(sessionId), "reveal"),
        disabled: controlsUnavailable,
        reason: waitingReason,
        tone: "primary",
      });
    }
    if (canShowLeaderboard) {
      actions.push({
        label: "Show Leaderboard",
        onClick: () => onAction(() => showLeaderboard(sessionId), "leaderboard"),
        disabled: controlsUnavailable,
        reason: waitingReason,
        tone: "primary",
      });
    }
    actions.push(participantsAction);
    actions.push({ label: "Download results (CSV)", href: resultsCsvUrl(sessionId) });
    actions.push({
      label: "End Session",
      onClick: requestEndSession,
      disabled: controlsUnavailable,
      reason: waitingReason,
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
        className="end-session-card w-full max-w-lg rounded-2xl border border-[color-mix(in_srgb,var(--mdq-danger-line)_40%,transparent)] bg-[var(--mdq-dialog)] p-6 text-white shadow-2xl shadow-black/50"
        role="dialog"
        aria-modal="true"
        aria-labelledby="end-session-title"
      >
        <p className="end-session-eyebrow text-xs font-semibold uppercase tracking-[0.22em] text-red-200/80">End live session</p>
        <h2 id="end-session-title" className="mt-3 text-2xl font-semibold">End this session?</h2>
        <p className="end-session-desc mt-3 text-sm leading-6 text-zinc-300">
          Everyone&apos;s screen will show the final results.
          {remainingSummary && ` Still to come: ${remainingSummary}.`}
        </p>
        {remainingSummary && (
          <div className="mt-5 flex gap-3">
            {remainingQuizQuestionCount > 0 && (
              <div className="end-session-stat flex-1 rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3">
                <p className="end-session-stat-value text-3xl font-semibold tabular-nums text-white">{remainingQuizQuestionCount}</p>
                <p className="end-session-stat-label mt-1 text-xs uppercase tracking-[0.18em] text-zinc-400">{remainingQuizQuestionCount === 1 ? "Quiz question left" : "Quiz questions left"}</p>
              </div>
            )}
            {remainingSlideCount > 0 && (
              <div className="end-session-stat flex-1 rounded-xl border border-white/10 bg-white/[0.045] px-4 py-3">
                <p className="end-session-stat-value text-3xl font-semibold tabular-nums text-white">{remainingSlideCount}</p>
                <p className="end-session-stat-label mt-1 text-xs uppercase tracking-[0.18em] text-zinc-400">{remainingSlideCount === 1 ? "Slide left" : "Slides left"}</p>
              </div>
            )}
          </div>
        )}
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

  const participantsDialog = showParticipants ? (
    <dialog
      ref={participantsDialogRef}
      className="end-session-overlay participants-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-[#07060b]/80 px-5 backdrop-blur-sm"
      aria-labelledby="participants-title"
      onCancel={(event) => { event.preventDefault(); setShowParticipants(false); }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setShowParticipants(false);
      }}
    >
      <div
        className="participants-card w-full max-w-lg rounded-2xl border border-[color-mix(in_srgb,var(--mdq-line-strong)_60%,transparent)] bg-[var(--mdq-dialog)] p-6 text-white shadow-2xl shadow-black/50"
      >
        <div className="participants-header">
          <h2 id="participants-title" className="text-2xl font-semibold">
            Participants <span className="participants-count tabular-nums">{participantCount} online</span>
          </h2>
          <button
            type="button"
            className="participants-close"
            aria-label="Close"
            onClick={() => setShowParticipants(false)}
            autoFocus
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <p className="participants-help mt-2 text-sm">
          If someone&apos;s phone stops working, choose Let rejoin. The next time they join with their {nameOnly ? "name" : idsAvailable ? "ID" : "ID or name"} from any device, they carry on with their answers.
        </p>
        <div className="participants-body">
          {(sock.participants?.count ?? 0) + (sock.participants?.offline?.length ?? 0) === 0 ? (
            <p className="participants-help text-sm">No one has joined yet.</p>
          ) : (
            <ParticipantList
              participants={sock.participants}
              showStudentIds={showStudentIds}
              onRelease={onReleaseSeat}
              disabled={!sock.connected}
            />
          )}
        </div>
        <div className="session-settings" role="group" aria-labelledby="session-settings-title">
          <h3 id="session-settings-title" className="session-settings-title">Session settings</h3>
          <JoinLockToggle
            locked={sock.participants?.joinLocked === true}
            onChange={onJoinLock}
            disabled={!sock.connected}
          />
          {idsAvailable && (
            <SettingSwitch
              label="Show Student IDs"
              description={STUDENT_IDS_DESCRIPTION}
              checked={showStudentIds}
              onToggle={onToggleShowStudentIds}
            />
          )}
        </div>
      </div>
    </dialog>
  ) : null;

  const liveSurfaceStatusLabel = isLeaderboardDisplay
    ? resultsHeading("leaderboard", quizLabel)
    : isSlideDisplay
      ? slideStatusLabel
      : quizStatusLabel;
  const liveSurfaceContent = (() => {
    if (displayQuestion && (((state === "QUESTION_OPEN" || state === "QUESTION_CLOSED") && !isReviewing) || (isReviewing && !displayReveal))) {
      if (isSlideType(displayQuestion.questionType)) {
        return (
          <SlideContentBody
            slideType={displayQuestion.questionType}
            title={displayHeading || displayQuestion.topic}
            html={displayQuestion.text}
            attendeeNotes={displayQuestion.attendeeNotes}
            slideMedia={displayQuestion.slideMedia}
            slideMediaPosition={displayQuestion.slideMediaPosition}
            slideMediaOpacity={displayQuestion.slideMediaOpacity}
            slideLiveEmbed={displayQuestion.slideLiveEmbed}
            slideVideo={displayQuestion.slideVideo}
            slideKey={displayQuestion.questionIndex}
            slideReferences={displayQuestion.slideReferences}
          />
        );
      }

      return (
        <ResponsiveQuizSurface fitKey={fitKey}>
          {state === "QUESTION_OPEN" && !isReviewing && (
            <Timer
              remainingSec={sock.remainingSec}
              totalSec={displayQuestion.timeLimitSec}
              size={140}
            />
          )}
          {state === "QUESTION_CLOSED" && !isReviewing && (
            <div className="text-amber-400 text-2xl font-bold">{closedLabel}</div>
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

          {noVotesClosed && <p className="no-votes-note">No votes yet</p>}

          {displayQuestion.questionType === "open_response" ? (
            <OpenResponseList
              responses={liveOpenResponses}
              title={state === "QUESTION_CLOSED" ? "Submitted Responses" : "Live Responses"}
              showStudentIds={showStudentIds}
              {...moderationProps}
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
        <ResponsiveQuizSurface reveal fitKey={fitKey}>
          <QuizHtml
            className={`quiz-html text-center leading-relaxed max-w-5xl ${isReviewing ? "text-2xl lg:text-3xl text-white" : "text-xl lg:text-2xl text-zinc-300"}`}
            html={displayQuestion.text}
          />

          {noVotesRevealed && <p className="no-votes-note">No votes yet</p>}

          {displayQuestion.questionType === "open_response" ? (
            <OpenResponseList responses={revealOpenResponses} title="Responses" emptyLabel="No responses were submitted." showStudentIds={showStudentIds} {...moderationProps} />
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
            showStudentIds={showStudentIds}
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
            deckStyle={(displayQuestion ?? q)?.deckStyle}
            mode={isReviewing ? "review" : "projector"}
            surfaceClassName={isLiveEmbedSlideDisplay ? "slide-surface-live-embed" : isSlideDisplay ? undefined : "quiz-surface"}
            backgroundLayer={isSlideDisplay && displayQuestion?.slideBackground ? <SlideBackgroundLayer background={displayQuestion.slideBackground} /> : undefined}
            nextLabel={null}
            qrDataUrl={accessInfo?.qrCodeDataUrl}
            sessionCode={sessionCode}
            participantCount={participantCount}
            offline={!sock.connected}
            presentationUrl={accessInfo?.presentationUrl}
            joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
            shortUrl={accessInfo?.shortUrl}
            joinCardDefaultExpanded={isLiveEmbedSlideDisplay && displayQuestion?.questionIndex === 0}
            positionLabel={isLeaderboardDisplay ? undefined : displayPositionLabel}
            statusLabel={liveSurfaceStatusLabel}
            statusTone={liveStatusTone}
            statusFades={liveStatusTone === "success"}
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
      {participantsDialog}
      </div>
    );
  }

  return (
    <div className={isLiveSurfaceDisplay ? "slide-live-shell slide-live-shell-controls" : `min-h-dvh flex flex-col p-6 lg:p-10 ${accessInfo && sessionCode ? "lg:pr-56" : ""}`}>
      {/* Top bar: question progress + timer + participant count */}
      {!isLiveSurfaceDisplay && (
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          {displayPositionLabel && (
            <span className="text-zinc-400 text-lg font-medium">
              Q{displayPositionLabel}
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
              {displayPositionLabel ? `Reviewing Q${displayPositionLabel}` : "Reviewing"} (students stay on live state)
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
            {isSlideType(displayQuestion.questionType) ? (
              <SlideContent
                slideType={displayQuestion.questionType}
                title={displayHeading || displayQuestion.topic}
                html={displayQuestion.text}
                attendeeNotes={displayQuestion.attendeeNotes}
                slideMedia={displayQuestion.slideMedia}
                slideMediaPosition={displayQuestion.slideMediaPosition}
                slideMediaOpacity={displayQuestion.slideMediaOpacity}
                slideBackground={displayQuestion.slideBackground}
                deckStyle={displayQuestion.deckStyle}
                slideLiveEmbed={displayQuestion.slideLiveEmbed}
                slideVideo={displayQuestion.slideVideo}
                slideKey={displayQuestion.questionIndex}
                slideReferences={displayQuestion.slideReferences}
                positionLabel={displayPositionLabel}
                nextLabel={null}
                qrDataUrl={accessInfo?.qrCodeDataUrl}
                sessionCode={sessionCode}
                participantCount={participantCount}
            offline={!sock.connected}
                presentationUrl={accessInfo?.presentationUrl}
                joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
                shortUrl={accessInfo?.shortUrl}
                joinCardDefaultExpanded={false}
                statusLabel={slideStatusLabel}
                statusTone={liveStatusTone}
            statusFades={liveStatusTone === "success"}
                navActions={liveSurfaceNavActions}
                actions={liveSurfaceActions}
              />
            ) : (
              <LiveSurface
                deckStyle={(displayQuestion ?? q)?.deckStyle}
                surfaceClassName="quiz-surface"
                nextLabel={null}
                qrDataUrl={accessInfo?.qrCodeDataUrl}
                sessionCode={sessionCode}
                participantCount={participantCount}
            offline={!sock.connected}
                presentationUrl={accessInfo?.presentationUrl}
                joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
                shortUrl={accessInfo?.shortUrl}
                joinCardDefaultExpanded={false}
                positionLabel={displayPositionLabel}
                statusLabel={quizStatusLabel}
                statusTone={liveStatusTone}
            statusFades={liveStatusTone === "success"}
                navActions={liveSurfaceNavActions}
                actions={liveSurfaceActions}
              >
                <ResponsiveQuizSurface fitKey={fitKey}>
                  {/* Timer */}
                  {state === "QUESTION_OPEN" && !isReviewing && (
                    <Timer
                      remainingSec={sock.remainingSec}
                      totalSec={displayQuestion.timeLimitSec}
                      size={140}
                    />
                  )}
                  {state === "QUESTION_CLOSED" && !isReviewing && (
                    <div className="text-amber-400 text-2xl font-bold">{closedLabel}</div>
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

                  {noVotesClosed && <p className="no-votes-note">No votes yet</p>}

                  {displayQuestion.questionType === "open_response" ? (
                    <OpenResponseList
                      responses={liveOpenResponses}
                      title={state === "QUESTION_CLOSED" ? "Submitted Responses" : "Live Responses"}
                      showStudentIds={showStudentIds}
                      {...moderationProps}
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
            deckStyle={(displayQuestion ?? q)?.deckStyle}
            surfaceClassName="quiz-surface"
            nextLabel={null}
            qrDataUrl={accessInfo?.qrCodeDataUrl}
            sessionCode={sessionCode}
            participantCount={participantCount}
            offline={!sock.connected}
            presentationUrl={accessInfo?.presentationUrl}
            joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
            shortUrl={accessInfo?.shortUrl}
            joinCardDefaultExpanded={false}
            positionLabel={displayPositionLabel}
            statusLabel={quizStatusLabel}
            statusTone={liveStatusTone}
            statusFades={liveStatusTone === "success"}
            navActions={liveSurfaceNavActions}
            actions={liveSurfaceActions}
          >
            <ResponsiveQuizSurface reveal fitKey={fitKey}>
              <QuizHtml
                className={`quiz-html text-center leading-relaxed max-w-5xl ${isReviewing ? "text-2xl lg:text-3xl text-white" : "text-xl lg:text-2xl text-zinc-300"}`}
                html={displayQuestion.text}
              />

              {noVotesRevealed && <p className="no-votes-note">No votes yet</p>}

              {displayQuestion.questionType === "open_response" ? (
                <OpenResponseList responses={revealOpenResponses} title="Responses" emptyLabel="No responses were submitted." showStudentIds={showStudentIds} {...moderationProps} />
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
            deckStyle={(displayQuestion ?? q)?.deckStyle}
            surfaceClassName="quiz-surface"
            qrDataUrl={accessInfo?.qrCodeDataUrl}
            sessionCode={sessionCode}
            participantCount={participantCount}
            offline={!sock.connected}
            presentationUrl={accessInfo?.presentationUrl}
            joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
            shortUrl={accessInfo?.shortUrl}
            joinCardDefaultExpanded={false}
            statusLabel={resultsHeading("leaderboard", quizLabel)}
            navActions={liveSurfaceNavActions}
            actions={liveSurfaceActions}
          >
            <ResponsiveQuizSurface leaderboard>
              <Leaderboard
                entries={sock.leaderboard}
                totalQuestions={sock.totalQuestions ?? totalQuestionsInQuiz}
                maxRows={10}
                showStudentIds={showStudentIds}
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
      {participantsDialog}
    </div>
  );
}
