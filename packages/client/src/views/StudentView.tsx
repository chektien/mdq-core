import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useSocket } from "../hooks/useSocket";
import type { QuestionState, RevealState } from "../hooks/useSocket";
import { API, MAX_OPEN_RESPONSE_LENGTH, SEAT_TAKEN_MESSAGE } from "@mdq/shared";
import type { DeckPalette, DeckTheme, SessionState } from "@mdq/shared";
import Timer from "../components/Timer";
import Leaderboard from "../components/Leaderboard";
import DistributionChart from "../components/DistributionChart";
import InlineMarkdownText from "../components/InlineMarkdownText";
import QuizHtml from "../components/QuizHtml";
import SlideContent from "../components/SlideContent";
import { getQuestionModeText } from "../questionMode";
import { clampOpenResponse, countCharacters, sentenceStop } from "../responseText";
import { SESSION_MISSING_MESSAGE, checkJoinValues, errorField, extraLabelNote, fieldElementId, joinFormSpec, joinIdentity, joinRefusalMessage } from "../joinForm";
import { deckLabel, resultsHeading } from "../deckLabel";
import type { JoinFieldName, JoinFieldSpec } from "../joinForm";
import { applyClientPalette, applyClientTheme, resolveClientPalette, resolveClientTheme } from "../theme";

function clearSessionArtifacts(): void {
  try {
    localStorage.removeItem("mdquiz_session");
    localStorage.removeItem("mdquiz_pending_join");
  } catch {
    // ignore
  }
}

/** How long to show "Reconnecting…" before falling back to the join form. */
const REJOIN_GRACE_MS = 10_000;

/**
 * True when this page will rejoin with a stored seat on load: the same rule
 * the restore effect and the socket auto-rejoin use.
 */
function hasStoredSeat(initialSessionId?: string, initialSessionCode?: string): boolean {
  try {
    const raw = localStorage.getItem("mdquiz_session");
    if (!raw) return false;
    const stored = JSON.parse(raw);
    if (typeof stored?.sessionToken !== "string" || !stored.sessionToken || typeof stored.sessionId !== "string") return false;
    const targetSessionId = (initialSessionId || "").trim();
    return targetSessionId ? stored.sessionId === targetSessionId : !initialSessionCode && Boolean(stored.sessionId);
  } catch {
    return false;
  }
}

function createGeneratedStudentId(): string {
  const randomPart =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `anon-${randomPart}`;
}

function getGeneratedStudentId(): string {
  const storageKey = "mdquiz_generated_student_id";
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing && existing.trim()) return existing;
    const generated = createGeneratedStudentId();
    localStorage.setItem(storageKey, generated);
    return generated;
  } catch {
    return createGeneratedStudentId();
  }
}

export default function StudentView({
  initialSessionCode,
  initialSessionId,
  autoGenerateStudentIds = false,
  defaultTheme = "dark",
  defaultPalette = "classic",
}: {
  initialSessionCode?: string;
  initialSessionId?: string;
  autoGenerateStudentIds?: boolean;
  defaultTheme?: DeckTheme;
  defaultPalette?: DeckPalette;
}) {
  const normalizeSessionCode = useCallback(
    (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6),
    [],
  );

  // Join form state
  const [code, setCode] = useState(normalizeSessionCode(initialSessionCode || ""));
  const [studentId, setStudentId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [quizKey, setQuizKey] = useState<string | null>(null);
  // The deck's own appearance once a session is known. Until then (null) the
  // page follows the defaults, including a runtime config that arrives late.
  const [sessionTheme, setSessionTheme] = useState<DeckTheme | null>(null);
  const [sessionPalette, setSessionPalette] = useState<DeckPalette | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  // Which input the message is about, so it can be marked and focused.
  const [joinErrorField, setJoinErrorField] = useState<JoinFieldName | null>(null);
  const [joining, setJoining] = useState(false);
  // What the deck behind the typed code asks for. The fields wait for it, so a
  // student never fills in a form the deck does not use.
  const [codeLookup, setCodeLookup] = useState<{ status: "idle" | "checking" | "found" | "missing" | "failed"; studentIds: boolean }>({ status: "idle", studentIds: true });
  const [lookupAttempt, setLookupAttempt] = useState(0);
  // The session a join has already resolved, so returning to the form after a refusal keeps its code.
  const resolvedSessionRef = useRef<string | null>(null);
  const [completed, setCompleted] = useState(false);
  // A student with a stored seat sees "Reconnecting…" rather than the join
  // form while the automatic rejoin runs.
  const [awaitingRejoin, setAwaitingRejoin] = useState(() => hasStoredSeat(initialSessionId, initialSessionCode));

  // Sync route-provided code to input deterministically.
  useEffect(() => {
    if (initialSessionCode) {
      setCode(normalizeSessionCode(initialSessionCode));
      return;
    }
    if (initialSessionId && resolvedSessionRef.current !== initialSessionId) {
      setCode("");
    }
  }, [initialSessionCode, initialSessionId, normalizeSessionCode]);

  // Clear error when user edits any input field
  const clearJoinError = useCallback(() => {
    setJoinError(null);
    setJoinErrorField(null);
  }, []);

  const handleCodeChange = useCallback((val: string) => {
    setCode(normalizeSessionCode(val));
    if (joinError) clearJoinError();
  }, [clearJoinError, joinError, normalizeSessionCode]);

  const handleStudentIdChange = useCallback((val: string) => {
    setStudentId(val);
    if (joinError) clearJoinError();
  }, [clearJoinError, joinError]);

  const handleDisplayNameChange = useCallback((val: string) => {
    setDisplayName(val);
    if (joinError) clearJoinError();
  }, [clearJoinError, joinError]);

  const sock = useSocket(sessionId, "student");
  const { connected, sessionToken, joinSession, error: sockError } = sock;

  // Hold the theme until the deck's own theme is known (join-link lookup or
  // stored session), so a reload never flashes the default theme first.
  const [appearanceReady, setAppearanceReady] = useState(false);

  useEffect(() => {
    if (!appearanceReady) return;
    applyClientTheme(sessionTheme, defaultTheme);
  }, [appearanceReady, defaultTheme, sessionTheme]);

  useEffect(() => {
    if (!appearanceReady) return;
    applyClientPalette(sessionPalette, defaultPalette);
  }, [appearanceReady, defaultPalette, sessionPalette]);

  const spec = useMemo(() => joinFormSpec(codeLookup.studentIds, autoGenerateStudentIds), [autoGenerateStudentIds, codeLookup.studentIds]);

  // Ask the server what the typed code's deck wants before showing the ID and name fields.
  useEffect(() => {
    if (code.length !== 6) {
      setCodeLookup((prev) => (prev.status === "idle" ? prev : { status: "idle", studentIds: true }));
      return;
    }
    let cancelled = false;
    setCodeLookup({ status: "checking", studentIds: true });
    fetch(API.SESSION_BY_CODE.replace(":code", code))
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 404 || response.status === 410) {
          setCodeLookup({ status: "missing", studentIds: true });
          return;
        }
        if (!response.ok) throw new Error("lookup failed");
        const data = (await response.json()) as { studentIds?: boolean };
        if (!cancelled) setCodeLookup({ status: "found", studentIds: data.studentIds !== false });
      })
      .catch(() => {
        if (!cancelled) setCodeLookup({ status: "failed", studentIds: true });
      });
    return () => {
      cancelled = true;
    };
  }, [code, lookupAttempt]);

  // Resolve QR/join links early so the join form itself uses the deck theme.
  useEffect(() => {
    if (!initialSessionCode) return;
    let cancelled = false;
    setAppearanceReady(false);
    setSessionTheme(null);
    setSessionPalette(null);
    setQuizKey(null);
    const normalizedCode = normalizeSessionCode(initialSessionCode);
    fetch(API.SESSION_BY_CODE.replace(":code", normalizedCode))
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ week?: string; theme?: DeckTheme; palette?: DeckPalette }>;
      })
      .then((data) => {
        if (cancelled || !data) return;
        setSessionTheme(resolveClientTheme(data.theme, defaultTheme));
        setSessionPalette(resolveClientPalette(data.palette, defaultPalette));
        if (typeof data.week === "string" && data.week.trim()) setQuizKey(data.week);
      })
      .catch(() => {
        // The submit path reports lookup errors; theme preloading is best-effort.
      })
      .finally(() => {
        if (!cancelled) setAppearanceReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [defaultPalette, defaultTheme, initialSessionCode, normalizeSessionCode]);

  // Try to restore session from localStorage on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem("mdquiz_session");
      const targetSessionId = (initialSessionId || "").trim();
      if (raw) {
        const stored = JSON.parse(raw);
        const restoresStoredSession = targetSessionId
          ? stored.sessionId === targetSessionId
          : !initialSessionCode && Boolean(stored.sessionId);
        if (targetSessionId && stored.sessionId === targetSessionId) {
          setSessionId(stored.sessionId);
          setStudentId(stored.studentId || "");
        } else if (targetSessionId && stored.sessionId !== targetSessionId) {
          setSessionId(targetSessionId);
          setStudentId(stored.studentId || "");
        } else if (!initialSessionCode && stored.sessionId) {
          setSessionId(stored.sessionId);
          setStudentId(stored.studentId || "");
        }
        if (initialSessionCode && stored.studentId) {
          setStudentId(stored.studentId);
        }
        if (restoresStoredSession && typeof stored.sessionWeek === "string" && stored.sessionWeek.trim().length > 0) {
          setQuizKey(stored.sessionWeek);
        }
        if (restoresStoredSession) {
          setSessionTheme(resolveClientTheme(stored.sessionTheme, defaultTheme));
          setSessionPalette(resolveClientPalette(stored.sessionPalette, defaultPalette));
        }
      } else if (targetSessionId) {
        setSessionId(targetSessionId);
      }
    } catch {
      // ignore
    }
    setCompleted(false);
    if (!initialSessionCode) setAppearanceReady(true);
  }, [defaultPalette, defaultTheme, initialSessionCode, initialSessionId]);

  const handleDone = useCallback(() => {
    clearSessionArtifacts();
    sock.disconnect();
    setCompleted(true);
    setSessionTheme(null);
    setSessionPalette(null);
  }, [sock]);

  // Handle join: first resolve session code to sessionId, then connect socket
  const handleJoin = useCallback(async () => {
    if (codeLookup.status !== "found") return;
    const values = { studentId, displayName };
    const problem = checkJoinValues(spec, values);
    if (problem) {
      setJoinError(problem.message);
      setJoinErrorField(problem.field);
      return;
    }
    const identity = joinIdentity(spec, values, getGeneratedStudentId);

    setJoining(true);
    clearJoinError();

    try {
      // Resolve session code to sessionId via REST endpoint
      const normalizedCode = normalizeSessionCode(code);
      const res = await fetch(API.SESSION_BY_CODE.replace(":code", normalizedCode));
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 404 || res.status === 410) {
          clearSessionArtifacts();
          setSessionId(null);
          setQuizKey(null);
          setSessionTheme(null);
          setSessionPalette(null);
        }
        throw new Error(res.status === 404 || res.status === 410 ? SESSION_MISSING_MESSAGE : data.error || "We could not join that session. Check the code and try again.");
      }
      const data: { sessionId: string; week?: string; theme?: DeckTheme; palette?: DeckPalette } = await res.json();
      const resolvedTheme = resolveClientTheme(data.theme, defaultTheme);
      const resolvedPalette = resolveClientPalette(data.palette, defaultPalette);
      resolvedSessionRef.current = data.sessionId;
      setSessionId(data.sessionId);
      setSessionTheme(resolvedTheme);
      setSessionPalette(resolvedPalette);
      if (typeof data.week === "string" && data.week.trim().length > 0) {
        setQuizKey(data.week);
      }

      // Store pending join info and session for the socket handler
      localStorage.setItem(
        "mdquiz_pending_join",
        JSON.stringify({ studentId: identity.studentId, displayName: identity.displayName }),
      );
      // Also update the session store so page refreshes restore the session
      localStorage.setItem(
        "mdquiz_session",
        JSON.stringify({
          sessionId: data.sessionId,
          studentId: identity.seatKey,
          sessionWeek: data.week,
          sessionTheme: resolvedTheme,
          sessionPalette: resolvedPalette,
          sessionToken:
            (() => {
              try {
                const existingRaw = localStorage.getItem("mdquiz_session");
                if (!existingRaw) return undefined;
                const existing = JSON.parse(existingRaw);
                if (
                  existing
                  && existing.sessionId === data.sessionId
                  && existing.studentId === identity.seatKey
                  && typeof existing.sessionToken === "string"
                ) {
                  return existing.sessionToken;
                }
              } catch {
                // ignore
              }
              return undefined;
            })(),
        }),
      );

      if (connected && !sessionToken && sessionId === data.sessionId) {
        // A second try after a refusal: the socket is already open, so nothing else will send the join.
        localStorage.removeItem("mdquiz_pending_join");
        joinSession(identity.studentId, identity.displayName);
      }
      // The address stays the join address until the join is accepted (see below), so a refusal leaves it as it was.
    } catch (e) {
      const reason = e instanceof Error ? e.message : "Failed to join";
      setJoinError(reason);
      setJoinErrorField(errorField(spec, reason));
      setJoining(false);
    }
  }, [clearJoinError, code, codeLookup.status, connected, defaultPalette, defaultTheme, displayName, joinSession, normalizeSessionCode, sessionId, sessionToken, spec, studentId]);

  // When socket connects and we have pending join, emit student:join
  useEffect(() => {
    if (connected && !sessionToken) {
      try {
        const raw = localStorage.getItem("mdquiz_pending_join");
        if (raw) {
          const pending = JSON.parse(raw);
          joinSession(pending.studentId || undefined, pending.displayName);
          localStorage.removeItem("mdquiz_pending_join");
        }
      } catch {
        // ignore
      }
    }
  }, [connected, sessionToken, joinSession]);

  // Clear joining state when joined or errored
  useEffect(() => {
    if (sessionToken) setJoining(false);
  }, [sessionToken]);

  // Once the join is accepted, a reload comes back to this session. Until then
  // the address stays the join address, so a refused join can be tried again from it.
  useEffect(() => {
    if (sessionToken && sessionId && window.location.hash !== `#/s/${sessionId}`) {
      window.location.hash = `/s/${sessionId}`;
    }
  }, [sessionId, sessionToken]);

  // Stop waiting for the automatic rejoin once it succeeds, fails, or takes too long.
  useEffect(() => {
    if (!awaitingRejoin) return;
    if (sessionToken || sockError) {
      setAwaitingRejoin(false);
      return;
    }
    const timer = setTimeout(() => setAwaitingRejoin(false), REJOIN_GRACE_MS);
    return () => clearTimeout(timer);
  }, [awaitingRejoin, sessionToken, sockError]);

  useEffect(() => {
    if (sockError) {
      const lowered = sockError.toLowerCase();
      if (lowered.includes("ended") || lowered.includes("not found")) {
        clearSessionArtifacts();
        setSessionId(null);
        setQuizKey(null);
      }
      const message = joinRefusalMessage(sockError);
      setJoinError(message);
      setJoinErrorField(errorField(spec, sockError));
      setJoining(false);
    }
  }, [sockError, spec]);

  // Put the cursor in the field a message is about, so the fix is one edit away.
  useEffect(() => {
    if (!joinError || !joinErrorField) return;
    document.getElementById(fieldElementId(spec, joinErrorField))?.focus();
  }, [joinError, joinErrorField, spec]);

  if (completed) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h2 className="text-2xl font-bold text-white">Done</h2>
        <p className="text-zinc-400 text-sm max-w-md">Your session is complete. You can close this tab.</p>
      </div>
    );
  }

  // ── Another device took this seat: nothing here can answer any more ──
  if (sock.seatTaken) {
    return (
      <div className="student-seat-taken min-h-dvh flex flex-col items-center justify-center gap-3 p-6 text-center">
        <h2 className="text-xl font-semibold text-white">You joined on another device</h2>
        <p role="status" className="max-w-xs text-zinc-300 text-sm">{SEAT_TAKEN_MESSAGE}</p>
      </div>
    );
  }

  // ── Rejoining with a stored seat ──
  if (!sock.sessionToken && awaitingRejoin && !joinError) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 p-6" role="status" aria-live="polite">
        <div className="w-12 h-12 border-4 border-zinc-600 border-t-transparent rounded-full animate-spin" />
        <p className="text-zinc-400 text-sm">Reconnecting&hellip;</p>
      </div>
    );
  }

  // ── Not yet connected: show join form ──
  if (!sock.sessionToken) {
    const fieldsReady = codeLookup.status === "found";
    const lookupMessage = codeLookup.status === "missing"
      ? SESSION_MISSING_MESSAGE
      : codeLookup.status === "failed"
        ? "We could not reach the server. Check your connection and try again."
        : null;
    const alertText = joinError ?? lookupMessage;
    const invalid = (field: JoinFieldName) => (joinError ? joinErrorField === field : field === "code" && codeLookup.status === "missing");
    const inputClass = (field: JoinFieldName, extra = "") => `w-full bg-zinc-800 border rounded-xl px-4 py-3 text-white placeholder:text-zinc-600 focus:outline-none focus:ring-2 ${extra} ${
      invalid(field) ? "border-red-500 focus:ring-red-500" : "border-zinc-700 focus:ring-indigo-500"
    }`;
    const fieldProps = (field: JoinFieldName, f: JoinFieldSpec) => ({
      id: f.id,
      name: f.name,
      type: "text" as const,
      required: f.required,
      "aria-required": f.required,
      "aria-invalid": invalid(field) ? true : undefined,
      "aria-describedby": invalid(field) ? "join-error" : undefined,
      placeholder: f.placeholder,
      maxLength: f.maxLength,
      autoComplete: f.autoComplete,
      autoCapitalize: f.autoCapitalize,
      autoCorrect: "off",
      spellCheck: false,
      inputMode: f.inputMode,
      enterKeyHint: f.enterKeyHint,
    });
    const fieldLabel = (f: JoinFieldSpec) => (
      <label htmlFor={f.id} className="block text-zinc-400 text-sm mb-1 font-medium">
        {f.label}{" "}
        {f.required ? <span className="text-red-400" aria-hidden="true">*</span> : <span className="text-zinc-600">(optional)</span>}
      </label>
    );

    return (
      <div className="join-page min-h-dvh flex flex-col items-center justify-start gap-6 px-6 pb-10 pt-[max(3rem,10dvh)]">
        {/* Back goes to the start page, which only makes sense when the form was opened from it. */}
        {!initialSessionCode && !initialSessionId && (
          <a href="#/" className="join-back absolute left-2 top-2 inline-flex min-h-11 min-w-11 items-center px-3 text-zinc-500 hover:text-zinc-300 text-sm">
            &larr; Back
          </a>
        )}

        <div className="text-center">
          <h1 className="text-2xl font-bold text-white mb-1">Join Quiz</h1>
          <p className="text-zinc-400 text-sm">Enter the session code shown on screen</p>
        </div>

        <form
          noValidate
          className="join-form w-full max-w-md space-y-4"
          data-join-mode={fieldsReady ? spec.mode : undefined}
          onSubmit={(event) => {
            event.preventDefault();
            void handleJoin();
          }}
        >
          <div>
            <label htmlFor="join-session-code" className="block text-zinc-400 text-sm mb-1 font-medium">Session Code</label>
            <input
              id="join-session-code"
              name="sessionCode"
              type="text"
              value={code}
              onChange={(e) => handleCodeChange(e.target.value)}
              placeholder="ABC123"
              maxLength={6}
              required
              aria-required={true}
              aria-invalid={invalid("code") ? true : undefined}
              aria-describedby={invalid("code") ? "join-error" : undefined}
              className={inputClass("code", "text-center text-2xl font-mono tracking-[0.15em]")}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              enterKeyHint={fieldsReady ? "next" : "go"}
            />
          </div>

          {codeLookup.status === "checking" && (
            <p role="status" className="text-center text-sm text-zinc-500">Checking the code&hellip;</p>
          )}

          {fieldsReady && spec.studentId && (
            <div>
              {fieldLabel(spec.studentId)}
              <input
                {...fieldProps("studentId", spec.studentId)}
                value={studentId}
                onChange={(e) => handleStudentIdChange(e.target.value)}
                className={inputClass("studentId")}
              />
            </div>
          )}

          {fieldsReady && (
            <div>
              {fieldLabel(spec.displayName)}
              <input
                {...fieldProps("displayName", spec.displayName)}
                value={displayName}
                onChange={(e) => handleDisplayNameChange(e.target.value)}
                className={inputClass("displayName")}
              />
              {spec.mode === "name" && (
                <p className="mt-2 text-sm text-zinc-500">Use the name you want to appear as. Nobody else in the session can use the same one.</p>
              )}
            </div>
          )}

          <div
            id="join-error"
            role="alert"
            className={alertText ? "rounded-xl border border-red-700 bg-red-900/50 px-4 py-3 text-center text-sm text-red-200" : "sr-only"}
          >
            {alertText}
          </div>

          {codeLookup.status === "failed" && !joinError && (
            <button
              type="button"
              onClick={() => setLookupAttempt((attempt) => attempt + 1)}
              className="w-full rounded-xl bg-zinc-800 py-3 text-sm font-semibold text-white hover:bg-zinc-700"
            >
              Try again
            </button>
          )}

          <button
            type="submit"
            disabled={joining || !fieldsReady}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-semibold py-4 rounded-xl transition-colors text-lg"
          >
            {joining ? "Joining..." : "Join"}
          </button>
        </form>
      </div>
    );
  }

  // ── Joined: show session content based on state ──
  const state = sock.sessionState as SessionState;
  const resultsLabel = sock.deckTitle || quizKey ? deckLabel(sock.deckTitle, quizKey || "") : "";
  const lobbyNote = extraLabelNote(sock.label, sock.labelNote);

  // Waiting in lobby
  if (state === "LOBBY") {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 p-6">
        <div className="w-16 h-16 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin" />
        <h2 className="text-xl font-semibold text-white">Waiting for quiz to start...</h2>
        <p className="text-zinc-400 text-sm">The instructor will begin shortly</p>
        {sock.label && (
          <p className="student-lobby-label text-zinc-300 text-sm">
            You are in as <strong className="font-semibold text-white">{sock.label}</strong>{sentenceStop(sock.label)}
          </p>
        )}
        {lobbyNote && (
          <p role="status" className="student-lobby-note max-w-xs text-center text-sm text-amber-200">{lobbyNote}</p>
        )}
      </div>
    );
  }

  // Question open
  if (state === "QUESTION_OPEN" || state === "QUESTION_CLOSED") {
    return (
      <QuestionView
        key={sock.currentQuestion?.questionIndex ?? 0}
        question={sock.currentQuestion}
        state={state}
        remainingSec={sock.remainingSec}
        submitted={sock.submitted}
        submittedOptions={sock.submittedOptions}
        submittedResponseText={sock.submittedResponseText}
        timedOut={sock.timedOut}
        connected={connected}
        onSubmit={sock.submitAnswer}
      />
    );
  }

  // Reveal
  if (state === "REVEAL") {
    return (
      <RevealView
        question={sock.currentQuestion}
        reveal={sock.reveal}
        submittedOptions={sock.submittedOptions}
        submittedResponseText={sock.submittedResponseText}
      />
    );
  }

  // Leaderboard
  if (state === "LEADERBOARD" || state === "ENDED") {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-6 p-6">
        <h2 className="text-center text-2xl font-bold text-white">
          {resultsHeading(state === "ENDED" ? "final" : "leaderboard", resultsLabel)}
        </h2>
        <Leaderboard
          entries={sock.leaderboard}
          totalQuestions={sock.totalQuestions}
          highlightPublicKey={sock.publicKey ?? undefined}
          maxRows={15}
          showStudentIds={!autoGenerateStudentIds}
          compact
        />
        {state === "ENDED" && (
          <button
            onClick={handleDone}
            className="student-done-button bg-zinc-800 hover:bg-zinc-700 text-white font-semibold py-3 px-8 rounded-xl transition-colors text-sm mt-4"
          >
            Done
          </button>
        )}
      </div>
    );
  }

  // Fallback: connecting state
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-4 p-6">
      <div className="w-12 h-12 border-4 border-zinc-600 border-t-transparent rounded-full animate-spin" />
      <p className="text-zinc-400 text-sm">Connecting to session...</p>
    </div>
  );
}

// ── Question sub-view ──────────────────────

function QuestionView({
  question,
  state,
  remainingSec,
  submitted,
  submittedOptions,
  submittedResponseText,
  timedOut,
  connected,
  onSubmit,
}: {
  question: QuestionState | null;
  state: SessionState;
  remainingSec: number;
  submitted: boolean;
  submittedOptions: string[];
  submittedResponseText: string | null;
  timedOut: boolean;
  connected: boolean;
  onSubmit: (payload: { questionIndex: number; selectedOptions?: string[]; responseText?: string }) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [responseText, setResponseText] = useState("");
  const lastSubmittedResponseRef = useRef<string>("");
  const questionIndex = question?.questionIndex ?? -1;
  const questionType = question?.questionType;
  // Something typed or chosen that the server has not been sent, so it can be offered again after a reconnect.
  const hasUnsent = questionType === "open_response"
    ? responseText.trim().length > 0 && responseText.trim() !== (submittedResponseText ?? "").trim()
    : !submitted && selected.length > 0;
  const [reconnectedNote, setReconnectedNote] = useState(false);
  const [wasConnected, setWasConnected] = useState(connected);
  if (connected !== wasConnected) {
    // Going offline clears the note; coming back offers it when something was left unsent.
    setWasConnected(connected);
    setReconnectedNote(connected && hasUnsent);
  }

  useEffect(() => {
    if (!question) {
      return;
    }
    setSelected([]);
    const nextResponse = submittedResponseText || "";
    setResponseText(nextResponse);
    lastSubmittedResponseRef.current = nextResponse;
  }, [question, questionIndex]);

  useEffect(() => {
    if (!question || questionType !== "open_response") {
      return;
    }

    const nextResponse = submittedResponseText || "";
    if (responseText === lastSubmittedResponseRef.current) {
      setResponseText(nextResponse);
    }
    lastSubmittedResponseRef.current = nextResponse;
  }, [question, questionType, responseText, submittedResponseText]);

  if (!question) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-6 text-center">
        <p className="text-zinc-400">
          {state === "QUESTION_CLOSED" ? "Waiting for next question..." : "Loading question..."}
        </p>
      </div>
    );
  }

  const toggleOption = (label: string) => {
    if (submitted || state === "QUESTION_CLOSED") return;
    setReconnectedNote(false);
    setSelected((prev) =>
      question.allowsMultiple
        ? (prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label])
        : (prev.includes(label) ? [] : [label]),
    );
  };

  const handleSubmit = () => {
    if (!connected) return;
    setReconnectedNote(false);
    if (question.questionType === "open_response") {
      if (!responseText.trim()) return;
      onSubmit({ questionIndex: question.questionIndex, responseText });
      return;
    }
    if (submitted) return;
    if (selected.length === 0) return;
    onSubmit({ questionIndex: question.questionIndex, selectedOptions: selected });
  };

  const isClosed = state === "QUESTION_CLOSED";
  const canEditOpenResponse = question.questionType === "open_response" && !isClosed;
  const selectionModeText = getQuestionModeText(question.questionType, question.allowsMultiple);
  const submitLabel = question.questionType === "open_response"
    ? submittedResponseText ? "Update Response" : "Submit Response"
    : question.isPoll
    ? question.allowsMultiple ? "Submit Votes" : "Submit Vote"
    : question.allowsMultiple ? "Submit Selections" : "Submit Answer";
  const submittedLabel = question.questionType === "open_response"
    ? "Response submitted"
    : question.isPoll ? "Vote submitted" : "Answer submitted";
  // Questions are counted without slides, the same on every phone and after a reload; a slide shows no number.
  const positionLabel = question.questionNumber && question.questionTotal
    ? `Question ${question.questionNumber} of ${question.questionTotal}`
    : null;
  const questionTextId = `question-text-${question.questionIndex}`;
  const closedNote = timedOut ? "Time's up. Waiting for the instructor." : "Answers are closed. Waiting for the instructor.";

  if (question.questionType === "slide") {
    const hasStudentVisibleSlideContent = [
      question.topic,
      question.text,
    ].some((value) => value.trim().length > 0)
      || (question.attendeeNotes?.length ?? 0) > 0
      || (question.slideMedia?.length ?? 0) > 0
      || !!question.slideLiveEmbed
      || (question.slideReferences?.length ?? 0) > 0;

    if (!hasStudentVisibleSlideContent) {
      return (
        <div className="slide-live-shell">
          <div className="slide-live-main">
            <div className="slide-student-empty">
              <p>Please view the presentation screen.</p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="slide-live-shell">
        <div className="slide-live-main">
        <SlideContent
          title={question.topic}
          html={question.text}
          attendeeNotes={question.attendeeNotes}
          slideMedia={question.slideMedia}
          slideMediaPosition={question.slideMediaPosition}
          slideMediaOpacity={question.slideMediaOpacity}
          slideLiveEmbed={question.slideLiveEmbed}
          slideVideo={question.slideVideo}
          slideReferences={question.slideReferences}
          mode="student"
          statusLabel="The instructor will advance shortly"
        />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col p-4 pb-safe">
      {/* Header: timer + question number */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-zinc-400 text-sm font-medium">
          {positionLabel}
        </span>
        {!isClosed && (
          <Timer remainingSec={remainingSec} totalSec={question.timeLimitSec} size={64} />
        )}
      </div>

      {/* Question text */}
      <QuizHtml id={questionTextId} className="quiz-html text-lg text-white leading-relaxed mb-6" html={question.text} />

      <div className={`selection-mode-card mb-5 rounded-2xl border px-4 py-3 ${question.questionType === "open_response" || question.allowsMultiple ? "selection-mode-card-multi" : "selection-mode-card-single"}`}>
        <div className="selection-mode-text">{selectionModeText}</div>
      </div>

      {question.questionType === "open_response" ? (
        <div className="flex-1">
          <textarea
            id={`open-response-${question.questionIndex}`}
            name={`open-response-${question.questionIndex}`}
            value={responseText}
            onChange={(e) => {
              setReconnectedNote(false);
              setResponseText(clampOpenResponse(e.target.value));
            }}
            disabled={isClosed}
            placeholder="Type your response here"
            aria-describedby={`open-response-note-${question.questionIndex}`}
            rows={8}
            className="min-h-[220px] w-full resize-y rounded-2xl border border-zinc-700 bg-zinc-800/80 px-4 py-4 text-base leading-relaxed text-white placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-70"
          />
          <p id={`open-response-note-${question.questionIndex}`} className="mt-3 text-sm text-zinc-400">
            Your response is unscored and won&apos;t affect the leaderboard.
          </p>
          {countCharacters(responseText) >= MAX_OPEN_RESPONSE_LENGTH - 200 && (
            <p role="status" className="open-response-length mt-1 text-sm text-zinc-400">
              {countCharacters(responseText) >= MAX_OPEN_RESPONSE_LENGTH
                ? "That is the longest a response can be."
                : `${MAX_OPEN_RESPONSE_LENGTH - countCharacters(responseText)} characters left`}
            </p>
          )}
        </div>
      ) : (
        <div
          className="space-y-3 flex-1"
          role={question.allowsMultiple ? "group" : "radiogroup"}
          aria-labelledby={questionTextId}
        >
          {question.options.map((opt) => {
            const isSelected = selected.includes(opt.label);
            const wasSubmitted = submittedOptions.includes(opt.label);
            const disabled = submitted || isClosed;

            return (
              <button
                key={opt.label}
                type="button"
                role={question.allowsMultiple ? "checkbox" : "radio"}
                aria-checked={wasSubmitted || isSelected}
                onClick={() => toggleOption(opt.label)}
                disabled={disabled}
                className={`
                  option-btn w-full text-left flex items-start gap-3 px-4 py-3 rounded-xl border-2 transition-all
                  ${
                    wasSubmitted
                      ? "border-indigo-500 bg-indigo-600/20"
                      : isSelected
                        ? "border-indigo-500 bg-indigo-600/10"
                        : "border-zinc-700 bg-zinc-800/80"
                  }
                  ${disabled ? "option-btn-locked" : "active:scale-[0.97]"}
                `}
              >
                <span
                  className={`
                    option-marker w-8 h-8 flex items-center justify-center shrink-0 font-mono font-bold text-sm
                    ${question.allowsMultiple ? "rounded-lg" : "rounded-full"}
                    ${
                      wasSubmitted || isSelected
                        ? "bg-indigo-600 text-white"
                        : "bg-zinc-700 text-zinc-300"
                    }
                  `}
                >
                  {opt.label}
                </span>
                <QuizHtml className="quiz-html text-zinc-200 pt-0.5" html={opt.text} as="span" />
              </button>
            );
          })}
        </div>
      )}

      {/* Submit button */}
      <div className="mt-4 pt-4 border-t border-zinc-800">
        {question.questionType === "open_response" && submittedResponseText && canEditOpenResponse ? (
          <div className="mb-3 rounded-2xl border border-emerald-500/40 bg-emerald-600/10 px-4 py-3">
            <span className="text-emerald-400 font-semibold">{submittedLabel}</span>
            <p className="mt-2 text-sm text-zinc-300 whitespace-pre-wrap">{submittedResponseText}</p>
          </div>
        ) : null}
        {submitted && question.questionType !== "open_response" ? (
          <div className="text-center py-3">
            <span className="text-emerald-400 font-semibold">{submittedLabel}</span>
            {isClosed && <p className="student-closed-note mt-1 text-sm text-zinc-400">{closedNote}</p>}
          </div>
        ) : question.questionType === "open_response" && isClosed ? (
          <div className="text-center py-3">
            {submittedResponseText ? (
              <>
                <span className="text-amber-400 font-semibold">Response locked</span>
                <p className="student-closed-note mt-1 text-sm text-zinc-400">{closedNote}</p>
              </>
            ) : (
              <span className="student-closed-note text-amber-400 font-semibold">{closedNote}</span>
            )}
            {submittedResponseText && (
              <p className="mt-2 text-sm text-zinc-400 whitespace-pre-wrap">{submittedResponseText}</p>
            )}
          </div>
        ) : isClosed ? (
          <div className="text-center py-3">
            <span className="student-closed-note text-amber-400 font-semibold">{closedNote}</span>
          </div>
        ) : (
          <>
            {!connected && (
              <p className="student-reconnecting mb-3 text-center text-sm text-amber-400" role="status" aria-live="polite">
                Connection lost. Reconnecting&hellip;
              </p>
            )}
            {connected && reconnectedNote && hasUnsent && (
              <p className="student-reconnected mb-3 text-center text-sm text-emerald-400" role="status" aria-live="polite">
                Reconnected. Tap Submit to send your answer.
              </p>
            )}
            <button
              onClick={handleSubmit}
              disabled={!connected || (question.questionType === "open_response" ? !responseText.trim() : selected.length === 0)}
              className="student-submit-button w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-semibold py-4 rounded-xl transition-colors text-lg"
            >
              {submitLabel}
            </button>
            {question.questionType !== "open_response" && (
              <p className="student-submit-note mt-3 text-center text-sm text-zinc-400">
                {question.isPoll ? "You cannot change your vote after you submit." : "You cannot change your answer after you submit."}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Reveal sub-view ──────────────────────

function RevealView({
  question,
  reveal,
  submittedOptions,
  submittedResponseText,
}: {
  question: QuestionState | null;
  reveal: RevealState | null;
  submittedOptions: string[];
  submittedResponseText: string | null;
}) {
  if (!question || !reveal) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-6">
        <p className="text-zinc-400">Waiting for next question...</p>
      </div>
    );
  }

  const isCorrect =
    submittedOptions.length > 0 &&
    submittedOptions.length === reveal.correctOptions.length &&
    submittedOptions.every((o) => reveal.correctOptions.includes(o));

  const didAnswer = submittedOptions.length > 0;
  const isOpenResponse = question.questionType === "open_response";
  const isPoll = reveal.isPoll || question.isPoll;

  const bannerClass = isOpenResponse
    ? submittedResponseText
      ? "bg-sky-600/15 border border-sky-400/40"
      : "bg-zinc-800 border border-zinc-700"
    : isPoll
    ? didAnswer
      ? "bg-sky-600/15 border border-sky-400/40"
      : "bg-zinc-800 border border-zinc-700"
    : isCorrect
      ? "bg-emerald-600/20 border border-emerald-500/50"
      : didAnswer
        ? "bg-red-600/20 border border-red-500/50"
        : "bg-zinc-800 border border-zinc-700";

  const bannerTextClass = isOpenResponse
    ? submittedResponseText ? "text-sky-300" : "text-zinc-400"
    : isPoll
    ? didAnswer ? "text-sky-300" : "text-zinc-400"
    : isCorrect
      ? "text-emerald-400"
      : didAnswer
        ? "text-red-400"
        : "text-zinc-400";

  const bannerText = isOpenResponse
    ? submittedResponseText ? "Response received" : "No response submitted"
    : isPoll
    ? didAnswer ? "Poll results" : "No vote submitted"
    : isCorrect
      ? "Correct!"
      : didAnswer
        ? "Incorrect"
        : "No answer submitted";

  return (
    <div className="min-h-dvh flex flex-col p-4 pb-safe">
      {/* Result banner */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={`
          reveal-banner text-center py-4 rounded-xl mb-4
          ${bannerClass}
        `}
      >
        <span className={`text-2xl font-bold ${bannerTextClass}`}>{bannerText}</span>
      </div>

      {/* Question text */}
      <QuizHtml className="quiz-html text-base text-zinc-300 leading-relaxed mb-4" html={question.text} />

      {isOpenResponse ? (
        // With no response, the banner above already says so.
        submittedResponseText ? (
          <div className="mb-6 rounded-2xl border border-sky-500/30 bg-sky-500/10 p-5">
            <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-sky-200">Your response</h3>
            <p className="whitespace-pre-wrap text-zinc-100">{submittedResponseText}</p>
          </div>
        ) : null
      ) : (
        <div className="space-y-2 mb-6">
          {question.options.map((opt) => {
            const correct = reveal.correctOptions.includes(opt.label);
            const chosen = submittedOptions.includes(opt.label);
            const optionClass = isPoll
              ? chosen
                ? "border-sky-500/50 bg-sky-600/10"
                : "border-zinc-800 bg-zinc-800/50"
              : correct
                ? "border-emerald-500/50 bg-emerald-600/10"
                : chosen
                  ? "border-red-500/50 bg-red-600/10"
                  : "border-zinc-800 bg-zinc-800/50";
            const markerClass = isPoll
              ? chosen
                ? "bg-sky-600 text-white"
                : "bg-zinc-700 text-zinc-400"
              : correct
                ? "bg-emerald-600 text-white"
                : chosen
                  ? "bg-red-600 text-white"
                  : "bg-zinc-700 text-zinc-400";

            return (
              <div
                key={opt.label}
                className={`
                  flex items-start gap-3 px-4 py-3 rounded-xl border-2
                  ${optionClass}
                `}
              >
                <span
                  className={`
                    w-8 h-8 rounded-lg flex items-center justify-center shrink-0 font-mono font-bold text-sm
                    ${markerClass}
                  `}
                >
                  {opt.label}
                </span>
                <QuizHtml className="quiz-html text-zinc-200 pt-0.5" html={opt.text} as="span" />
              </div>
            );
          })}
        </div>
      )}

      {isPoll && !isOpenResponse && (
        <div className="mb-6">
          <h3 className="mb-3 text-zinc-400 text-sm uppercase tracking-wide font-medium">
            Poll distribution
          </h3>
          <DistributionChart
            distribution={reveal.distribution}
            labels={question.options.map((opt) => opt.label)}
            totalResponses={Object.values(reveal.distribution).reduce((sum, count) => sum + count, 0)}
          />
        </div>
      )}

      {/* Explanation */}
      {reveal.explanation && (
        <div className="bg-zinc-800/80 border border-zinc-700 rounded-xl p-4 text-left">
          <h3 className="text-zinc-400 text-sm uppercase tracking-wide font-medium mb-2">
            Explanation
          </h3>
          <InlineMarkdownText text={reveal.explanation} className="text-zinc-200 text-sm leading-relaxed" />
        </div>
      )}
    </div>
  );
}
