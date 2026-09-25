import { useEffect, useMemo, useState } from "react";
import type { DeckPalette, DeckTheme, SessionState } from "@mdq/shared";
import InstructorLoginPrompt from "../components/InstructorLoginPrompt";
import { fetchPresentationSession, type PresentationSessionResponse } from "../hooks/api";
import { useSocket, type QuestionState, type RevealState } from "../hooks/useSocket";
import Timer from "../components/Timer";
import Leaderboard from "../components/Leaderboard";
import OpenResponseList from "../components/OpenResponseList";
import QRPanel from "../components/QRPanel";
import SessionCodeCard from "../components/SessionCodeCard";
import InlineMarkdownText from "../components/InlineMarkdownText";
import QuizHtml from "../components/QuizHtml";
import LiveSurface from "../components/LiveSurface";
import ResponsiveQuizSurface from "../components/ResponsiveQuizSurface";
import SlideContent, { SlideContentBody } from "../components/SlideContent";
import SlideBackgroundLayer from "../components/SlideBackgroundLayer";
import { getQuestionModeText } from "../questionMode";
import { applyClientPalette, applyClientTheme } from "../theme";

const EMPTY_QUESTION_HEADINGS: string[] = [];

function formatQuizLabel(quizKey: string): string {
  const normalized = quizKey.trim();
  if (!normalized) return "MDQ";
  if (/\bmdq\b/i.test(normalized)) return normalized;
  return `${normalized} MDQ`;
}

function formatPositionLabel(questionIndex: number, totalQuestions: number): string {
  return totalQuestions > 0 ? `${questionIndex + 1}/${totalQuestions}` : `${questionIndex + 1}`;
}

function isInstructorLoginRequired(message: string | null): boolean {
  return (message || "").toLowerCase().includes("login required");
}

export default function PresentationView({
  sessionId,
  loginHref,
  autoGenerateStudentIds = false,
  defaultTheme = "dark",
  defaultPalette = "classic",
}: {
  sessionId: string;
  loginHref: string;
  autoGenerateStudentIds?: boolean;
  defaultTheme?: DeckTheme;
  defaultPalette?: DeckPalette;
}) {
  const [meta, setMeta] = useState<PresentationSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const sock = useSocket(meta ? sessionId : null, "presentation");

  useEffect(() => {
    applyClientTheme(meta?.theme, defaultTheme);
  }, [defaultTheme, meta?.theme]);

  useEffect(() => {
    applyClientPalette(meta?.palette, defaultPalette);
  }, [defaultPalette, meta?.palette]);

  useEffect(() => {
    let cancelled = false;

    fetchPresentationSession(sessionId)
      .then((data) => {
        if (cancelled) return;
        setMeta(data);
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMsg(error instanceof Error ? error.message : "Unable to load presentation session.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function retryPresentationFetch() {
    setLoading(true);
    setErrorMsg(null);

    try {
      const data = await fetchPresentationSession(sessionId);
      setMeta(data);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "Unable to load presentation session.");
      setMeta(null);
      throw error;
    } finally {
      setLoading(false);
    }
  }

  const state = (sock.sessionState || meta?.state || null) as SessionState | null;
  const quizLabel = formatQuizLabel(meta?.week || "");
  const accessInfo = meta?.accessInfo || null;
  const questionHeadings = meta?.questionHeadings || EMPTY_QUESTION_HEADINGS;
  const totalQuestions = meta?.questionCount || 0;
  const currentQuestion = sock.currentQuestion as QuestionState | null;
  const reveal = sock.reveal as RevealState | null;
  const currentReveal =
    reveal && currentQuestion && reveal.questionIndex === currentQuestion.questionIndex
      ? reveal
      : null;
  const liveOpenResponses = currentQuestion?.questionType === "open_response"
    ? sock.answerCount?.openResponses ?? []
    : [];

  const currentHeading = useMemo(() => {
    if (!currentQuestion) return null;
    return questionHeadings[currentQuestion.questionIndex] || currentQuestion.topic || null;
  }, [currentQuestion, questionHeadings]);

  const nextHeading = useMemo(() => {
    if (!currentQuestion) return questionHeadings[0] || null;
    return questionHeadings[currentQuestion.questionIndex + 1] || null;
  }, [currentQuestion, questionHeadings]);
  const isSlideDisplay = currentQuestion?.questionType === "slide" && !currentReveal && (state === "QUESTION_OPEN" || state === "QUESTION_CLOSED");
  const isQuizSurfaceDisplay = !!currentQuestion && currentQuestion.questionType !== "slide" && state !== "LEADERBOARD";
  const isLeaderboardDisplay = state === "LEADERBOARD";
  const isLiveSurfaceDisplay = isSlideDisplay || isQuizSurfaceDisplay || isLeaderboardDisplay;
  const isLiveEmbedSlideDisplay = isSlideDisplay && !!currentQuestion?.slideLiveEmbed;
  const participantCount = sock.participants?.count ?? 0;
  const positionLabel = currentQuestion
    ? formatPositionLabel(currentQuestion.questionIndex, totalQuestions)
    : undefined;
  const quizStatusLabel = (() => {
    if (!currentQuestion || currentQuestion.questionType === "slide") return null;
    if (currentReveal) return currentReveal.isPoll ? "Results open" : "Answer revealed";
    if (state === "QUESTION_CLOSED") return "Time's up";
    if (sock.answerCount && state === "QUESTION_OPEN") {
      return `${sock.answerCount.submitted}/${sock.answerCount.total} answered`;
    }
    return null;
  })();

  if (loading) {
    return (
      <div className="min-h-dvh flex items-center justify-center p-6 text-zinc-300">
        Loading presentation mode...
      </div>
    );
  }

  if (errorMsg || !meta || !state) {
    if (isInstructorLoginRequired(errorMsg)) {
      return (
        <div className="min-h-dvh flex flex-col items-center justify-center gap-8 p-6">
          <div className="text-center space-y-3">
            <p className="text-sm uppercase tracking-[0.22em] text-zinc-500">Presentation Mode</p>
            <p className="max-w-xl text-zinc-400">
              This presenter view is protected when instructor auth is enabled. Sign in here and presentation mode will continue automatically.
            </p>
          </div>

          <InstructorLoginPrompt
            title="Instructor login required"
            description="Enter the instructor password to continue into presenter mode."
            submitLabel="Sign In to Open Presentation"
            onSuccess={retryPresentationFetch}
            backHref="#/"
            backLabel="Back home"
            secondaryHref={loginHref}
            secondaryLabel="Open full sign-in page"
          />
        </div>
      );
    }

    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-3xl font-bold text-white">Presentation unavailable</h1>
        <p className="max-w-lg text-zinc-400">{errorMsg || "The presentation session could not be loaded."}</p>
        <a href="#/" className="rounded-xl bg-zinc-800 px-6 py-3 font-semibold text-white transition-colors hover:bg-zinc-700">
          Back home
        </a>
      </div>
    );
  }

  if (state === "LOBBY") {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-8 p-8">
        <div className="text-center">
          <p className="text-sm uppercase tracking-[0.22em] text-zinc-500">Presentation Mode</p>
          <h1 className="mt-2 text-3xl font-bold text-white">Waiting for Students</h1>
          <p className="mt-3 text-zinc-400">Read-only projector view, controls stay on the instructor device.</p>
        </div>

        {accessInfo && (
          <QRPanel
            qrDataUrl={accessInfo.qrCodeDataUrl}
            fullUrl={accessInfo.fullUrl}
            shortUrl={accessInfo.shortUrl}
            sessionCode={meta.sessionCode}
          />
        )}

        <div className="text-center">
          <span className="text-5xl font-bold text-white tabular-nums">{sock.participants?.count ?? 0}</span>
          <span className="ml-2 text-lg text-zinc-400">students joined</span>
        </div>

        {sock.participants && sock.participants.count > 0 && (
          <div className="max-h-48 w-full max-w-lg overflow-y-auto rounded-xl bg-zinc-800/50 p-4">
            <div className="flex flex-wrap gap-2">
              {sock.participants.participants.map((participant) => (
                <span key={participant.studentId} className="rounded-full bg-zinc-700 px-3 py-1 text-sm text-zinc-200">
                  {participant.displayName || participant.studentId}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (state === "ENDED") {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-8 p-8">
        <div className="text-center">
          <p className="text-sm uppercase tracking-[0.22em] text-zinc-500">Presentation Mode</p>
          <h1 className="mt-2 text-3xl font-bold text-white">Session Ended</h1>
        </div>
        <Leaderboard
          entries={sock.leaderboard}
          totalQuestions={sock.totalQuestions ?? totalQuestions}
          maxRows={15}
          showStudentIds={!autoGenerateStudentIds}
        />
      </div>
    );
  }

  const liveSurfaceStatusLabel = isLeaderboardDisplay
    ? quizLabel ? `Leaderboard for ${quizLabel.toUpperCase()}` : "Leaderboard"
    : quizStatusLabel;
  const liveSurfaceContent = (() => {
    if (currentQuestion && (state === "QUESTION_OPEN" || state === "QUESTION_CLOSED")) {
      if (currentQuestion.questionType === "slide") {
        return (
          <SlideContentBody
            title={currentHeading || currentQuestion.topic}
            html={currentQuestion.text}
            attendeeNotes={currentQuestion.attendeeNotes}
            slideMedia={currentQuestion.slideMedia}
            slideMediaPosition={currentQuestion.slideMediaPosition}
            slideMediaOpacity={currentQuestion.slideMediaOpacity}
            slideLiveEmbed={currentQuestion.slideLiveEmbed}
            slideVideo={currentQuestion.slideVideo}
            slideReferences={currentQuestion.slideReferences}
          />
        );
      }

      return (
        <ResponsiveQuizSurface>
          {state === "QUESTION_OPEN" && (
            <Timer remainingSec={sock.remainingSec} totalSec={currentQuestion.timeLimitSec} size={140} />
          )}
          {state === "QUESTION_CLOSED" && <div className="text-2xl font-bold text-amber-400">Time&apos;s up</div>}

          <QuizHtml
            className="quiz-html max-w-5xl text-center text-2xl leading-relaxed text-white lg:text-3xl"
            html={currentQuestion.text}
          />

          <div className={`selection-mode-chip ${currentQuestion.questionType === "open_response" || currentQuestion.allowsMultiple ? "selection-mode-chip-multi" : "selection-mode-chip-single"}`}>
            {getQuestionModeText(currentQuestion.questionType, currentQuestion.allowsMultiple)}
          </div>

          {currentQuestion.questionType === "open_response" ? (
            <OpenResponseList
              responses={liveOpenResponses}
              title={state === "QUESTION_CLOSED" ? "Submitted Responses" : "Live Responses"}
              showStudentIds={!autoGenerateStudentIds}
            />
          ) : (() => {
            const dist = state === "QUESTION_CLOSED" ? sock.distribution?.distribution : null;
            const totalResponses = sock.answerCount?.submitted ?? 0;
            const maxCount = dist ? Math.max(1, ...Object.values(dist)) : 0;
            return (
              <div className={`w-full max-w-4xl ${dist ? "space-y-3" : "grid grid-cols-1 gap-3 sm:grid-cols-2"}`}>
                {currentQuestion.options.map((option) => {
                  const count = dist?.[option.label] ?? 0;
                  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                  const pctOfTotal = totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0;
                  return (
                    <div key={option.label} className="relative rounded-xl border border-zinc-700 bg-zinc-800 overflow-hidden">
                      {dist && (
                        <div
                          className="bar-fill absolute inset-0 bg-indigo-500/30 rounded-xl"
                          style={{ width: `${Math.max(pct, 2)}%` }}
                        />
                      )}
                      <div className="relative flex items-center gap-3 px-5 py-4">
                        <span className={`flex h-9 w-9 shrink-0 items-center justify-center bg-zinc-700 text-lg font-bold text-zinc-300 ${currentQuestion.allowsMultiple ? "rounded-lg" : "rounded-full"}`}>
                          {option.label}
                        </span>
                        <QuizHtml className="quiz-html text-left text-lg text-zinc-200 flex-1" html={option.text} as="span" />
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
          })()}
        </ResponsiveQuizSurface>
      );
    }

    if (currentReveal && currentQuestion && state === "REVEAL") {
      return (
        <ResponsiveQuizSurface reveal>
          <QuizHtml
            className="quiz-html max-w-5xl text-center text-xl leading-relaxed text-zinc-300 lg:text-2xl"
            html={currentQuestion.text}
          />

          {currentQuestion.questionType === "open_response" ? (
            <OpenResponseList responses={currentReveal.openResponses} title="Responses" emptyLabel="No responses were submitted." showStudentIds={!autoGenerateStudentIds} />
          ) : (() => {
            const dist = currentReveal.distribution;
            const maxCount = Math.max(1, ...Object.values(dist));
            const totalSelections = Object.values(dist).reduce((sum, c) => sum + c, 0);
            return (
              <div className="w-full max-w-4xl space-y-2">
                {currentQuestion.options.map((option) => {
                  const isCorrect = currentReveal.correctOptions.includes(option.label);
                  const count = dist[option.label] ?? 0;
                  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                  const pctOfTotal = totalSelections > 0 ? Math.round((count / totalSelections) * 100) : 0;

                  const borderClass = currentReveal.isPoll
                    ? "border-zinc-800"
                    : isCorrect
                      ? "border-emerald-500/60"
                      : "border-zinc-800";
                  const barColor = currentReveal.isPoll
                    ? "bg-indigo-500/30"
                    : isCorrect
                      ? "bg-emerald-500/25"
                      : "bg-zinc-600/25";
                  const markerClass = currentReveal.isPoll
                    ? "bg-zinc-700 text-zinc-300"
                    : isCorrect
                      ? "bg-emerald-600 text-white"
                      : "bg-zinc-700 text-zinc-300";
                  const textClass = currentReveal.isPoll
                    ? "text-zinc-200"
                    : isCorrect
                      ? "text-emerald-100"
                      : "text-zinc-200";

                  return (
                    <div
                      key={option.label}
                      className={`relative rounded-xl border bg-zinc-900/60 overflow-hidden ${borderClass}`}
                    >
                      <div
                        className={`bar-fill absolute inset-0 rounded-xl ${barColor}`}
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                      <div className="relative flex items-center gap-3 px-4 py-3">
                        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-mono text-sm font-bold ${markerClass}`}>
                          {option.label}
                        </span>
                        <QuizHtml className={`quiz-html text-left pt-0.5 flex-1 ${textClass}`} html={option.text} as="span" />
                        {count > 0 && (
                          <span className={`text-sm font-semibold tabular-nums shrink-0 ${isCorrect && !currentReveal.isPoll ? "text-emerald-300" : "text-zinc-300"}`}>
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

          {currentReveal.explanation && (
            <div className="w-full max-w-4xl rounded-xl border border-emerald-700/50 bg-emerald-900/30 p-6 text-left">
              <h3 className="mb-2 font-semibold text-emerald-400">Explanation</h3>
              <InlineMarkdownText text={currentReveal.explanation} className="text-lg leading-relaxed text-emerald-100" />
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
            totalQuestions={sock.totalQuestions ?? totalQuestions}
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
      <div className="slide-live-shell">
        <div className="slide-live-main">
          <LiveSurface
            surfaceClassName={isLiveEmbedSlideDisplay ? "slide-surface-live-embed" : isSlideDisplay ? undefined : "quiz-surface"}
            backgroundLayer={isSlideDisplay && currentQuestion?.slideBackground ? <SlideBackgroundLayer background={currentQuestion.slideBackground} /> : undefined}
            nextLabel={isLeaderboardDisplay ? null : nextHeading}
            qrDataUrl={accessInfo?.qrCodeDataUrl}
            sessionCode={meta.sessionCode}
            participantCount={participantCount}
            joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
            shortUrl={accessInfo?.shortUrl}
            joinCardDefaultExpanded={isLiveEmbedSlideDisplay && currentQuestion?.questionIndex === 0}
            positionLabel={isLeaderboardDisplay ? undefined : positionLabel}
            statusLabel={liveSurfaceStatusLabel}
          >
            {liveSurfaceContent}
          </LiveSurface>
        </div>

        {sock.error && (
          <div className="slide-page-error rounded-xl border border-red-700 bg-red-900/50 px-4 py-3 text-center text-red-200">
            {sock.error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={isLiveSurfaceDisplay ? "slide-live-shell" : `min-h-dvh flex flex-col p-6 lg:p-10 ${accessInfo && meta.sessionCode ? "lg:pr-56" : ""}`}>
      {!isLiveSurfaceDisplay && (
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          {currentQuestion && (
            <span className="text-lg font-medium text-zinc-400">
              Q{currentQuestion.questionIndex + 1}/{totalQuestions}
            </span>
          )}
          {currentHeading && <span className="text-sm text-zinc-600">{currentHeading}</span>}
        </div>
        <div className="flex items-center gap-4">
          {sock.answerCount && currentQuestion?.questionType !== "slide" && (state === "QUESTION_OPEN" || state === "QUESTION_CLOSED") && (
            <span className="font-mono tabular-nums text-zinc-400">
              {sock.answerCount.submitted}/{sock.answerCount.total} answered
            </span>
          )}
          <span className="tabular-nums text-zinc-500">{sock.participants?.count ?? 0} online</span>
        </div>
      </div>
      )}

      <div className={isLiveSurfaceDisplay ? "slide-live-main" : "mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-8"}>
        {nextHeading && !isLiveSurfaceDisplay && (
          <div className="w-full max-w-3xl rounded-2xl border border-sky-500/30 bg-sky-500/10 px-5 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-sky-200/80">Next up</p>
            <p className="mt-2 text-lg text-sky-50">{nextHeading}</p>
          </div>
        )}

        {currentQuestion && (state === "QUESTION_OPEN" || state === "QUESTION_CLOSED") && (
          <>
            {currentQuestion.questionType === "slide" ? (
              <SlideContent
                title={currentHeading || currentQuestion.topic}
                html={currentQuestion.text}
                attendeeNotes={currentQuestion.attendeeNotes}
                slideMedia={currentQuestion.slideMedia}
                slideMediaPosition={currentQuestion.slideMediaPosition}
                slideMediaOpacity={currentQuestion.slideMediaOpacity}
                slideBackground={currentQuestion.slideBackground}
                slideLiveEmbed={currentQuestion.slideLiveEmbed}
                slideVideo={currentQuestion.slideVideo}
                slideReferences={currentQuestion.slideReferences}
                positionLabel={positionLabel}
                nextLabel={nextHeading}
                qrDataUrl={accessInfo?.qrCodeDataUrl}
                sessionCode={meta.sessionCode}
                participantCount={participantCount}
                joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
                shortUrl={accessInfo?.shortUrl}
                joinCardDefaultExpanded={true}
              />
            ) : (
              <LiveSurface
                surfaceClassName="quiz-surface"
                nextLabel={nextHeading}
                qrDataUrl={accessInfo?.qrCodeDataUrl}
                sessionCode={meta.sessionCode}
                participantCount={participantCount}
                joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
                shortUrl={accessInfo?.shortUrl}
                joinCardDefaultExpanded={true}
                positionLabel={positionLabel}
                statusLabel={quizStatusLabel}
              >
                <ResponsiveQuizSurface>
                  {state === "QUESTION_OPEN" && (
                    <Timer remainingSec={sock.remainingSec} totalSec={currentQuestion.timeLimitSec} size={140} />
                  )}
                  {state === "QUESTION_CLOSED" && <div className="text-2xl font-bold text-amber-400">Time&apos;s up</div>}

                  <QuizHtml
                    className="quiz-html max-w-5xl text-center text-2xl leading-relaxed text-white lg:text-3xl"
                    html={currentQuestion.text}
                  />

                  <div className={`selection-mode-chip ${currentQuestion.questionType === "open_response" || currentQuestion.allowsMultiple ? "selection-mode-chip-multi" : "selection-mode-chip-single"}`}>
                    {getQuestionModeText(currentQuestion.questionType, currentQuestion.allowsMultiple)}
                  </div>

                  {currentQuestion.questionType === "open_response" ? (
                    <OpenResponseList
                      responses={liveOpenResponses}
                      title={state === "QUESTION_CLOSED" ? "Submitted Responses" : "Live Responses"}
                      showStudentIds={!autoGenerateStudentIds}
                    />
                  ) : (() => {
                    const dist = state === "QUESTION_CLOSED" ? sock.distribution?.distribution : null;
                    const totalResponses = sock.answerCount?.submitted ?? 0;
                    const maxCount = dist ? Math.max(1, ...Object.values(dist)) : 0;
                    return (
                      <div className={`w-full max-w-4xl ${dist ? "space-y-3" : "grid grid-cols-1 gap-3 sm:grid-cols-2"}`}>
                        {currentQuestion.options.map((option) => {
                          const count = dist?.[option.label] ?? 0;
                          const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                          const pctOfTotal = totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0;
                          return (
                            <div key={option.label} className="relative rounded-xl border border-zinc-700 bg-zinc-800 overflow-hidden">
                              {dist && (
                                <div
                                  className="bar-fill absolute inset-0 bg-indigo-500/30 rounded-xl"
                                  style={{ width: `${Math.max(pct, 2)}%` }}
                                />
                              )}
                              <div className="relative flex items-center gap-3 px-5 py-4">
                                <span className={`flex h-9 w-9 shrink-0 items-center justify-center bg-zinc-700 text-lg font-bold text-zinc-300 ${currentQuestion.allowsMultiple ? "rounded-lg" : "rounded-full"}`}>
                                  {option.label}
                                </span>
                                <QuizHtml className="quiz-html text-left text-lg text-zinc-200 flex-1" html={option.text} as="span" />
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
                  })()}
                </ResponsiveQuizSurface>
              </LiveSurface>
            )}
          </>
        )}

        {currentReveal && currentQuestion && state === "REVEAL" && (
          <LiveSurface
            surfaceClassName="quiz-surface"
            nextLabel={nextHeading}
            qrDataUrl={accessInfo?.qrCodeDataUrl}
            sessionCode={meta.sessionCode}
            participantCount={participantCount}
            joinUrl={accessInfo?.shortUrl || accessInfo?.fullUrl}
            shortUrl={accessInfo?.shortUrl}
            joinCardDefaultExpanded={true}
            positionLabel={positionLabel}
            statusLabel={quizStatusLabel}
          >
            <ResponsiveQuizSurface reveal>
              <QuizHtml
                className="quiz-html max-w-5xl text-center text-xl leading-relaxed text-zinc-300 lg:text-2xl"
                html={currentQuestion.text}
              />

              {currentQuestion.questionType === "open_response" ? (
                <OpenResponseList responses={currentReveal.openResponses} title="Responses" emptyLabel="No responses were submitted." showStudentIds={!autoGenerateStudentIds} />
              ) : (() => {
                const dist = currentReveal.distribution;
                const maxCount = Math.max(1, ...Object.values(dist));
                const totalSelections = Object.values(dist).reduce((sum, c) => sum + c, 0);
                return (
                  <div className="w-full max-w-4xl space-y-2">
                    {currentQuestion.options.map((option) => {
                      const isCorrect = currentReveal.correctOptions.includes(option.label);
                      const count = dist[option.label] ?? 0;
                      const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
                      const pctOfTotal = totalSelections > 0 ? Math.round((count / totalSelections) * 100) : 0;

                      const borderClass = currentReveal.isPoll
                        ? "border-zinc-800"
                        : isCorrect
                          ? "border-emerald-500/60"
                          : "border-zinc-800";
                      const barColor = currentReveal.isPoll
                        ? "bg-indigo-500/30"
                        : isCorrect
                          ? "bg-emerald-500/25"
                          : "bg-zinc-600/25";
                      const markerClass = currentReveal.isPoll
                        ? "bg-zinc-700 text-zinc-300"
                        : isCorrect
                          ? "bg-emerald-600 text-white"
                          : "bg-zinc-700 text-zinc-300";
                      const textClass = currentReveal.isPoll
                        ? "text-zinc-200"
                        : isCorrect
                          ? "text-emerald-100"
                          : "text-zinc-200";

                      return (
                        <div
                          key={option.label}
                          className={`relative rounded-xl border bg-zinc-900/60 overflow-hidden ${borderClass}`}
                        >
                          <div
                            className={`bar-fill absolute inset-0 rounded-xl ${barColor}`}
                            style={{ width: `${Math.max(pct, 2)}%` }}
                          />
                          <div className="relative flex items-center gap-3 px-4 py-3">
                            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg font-mono text-sm font-bold ${markerClass}`}>
                              {option.label}
                            </span>
                            <QuizHtml className={`quiz-html text-left pt-0.5 flex-1 ${textClass}`} html={option.text} as="span" />
                            {count > 0 && (
                              <span className={`text-sm font-semibold tabular-nums shrink-0 ${isCorrect && !currentReveal.isPoll ? "text-emerald-300" : "text-zinc-300"}`}>
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

              {currentReveal.explanation && (
                <div className="w-full max-w-4xl rounded-xl border border-emerald-700/50 bg-emerald-900/30 p-6 text-left">
                  <h3 className="mb-2 font-semibold text-emerald-400">Explanation</h3>
                  <InlineMarkdownText text={currentReveal.explanation} className="text-lg leading-relaxed text-emerald-100" />
                </div>
              )}
            </ResponsiveQuizSurface>
          </LiveSurface>
        )}

      </div>

      {sock.error && (
        <div className={`${isLiveSurfaceDisplay ? "slide-page-error" : "mt-4"} rounded-xl border border-red-700 bg-red-900/50 px-4 py-3 text-center text-red-200`}>
          {sock.error}
        </div>
      )}

      {accessInfo && meta.sessionCode && !isLiveSurfaceDisplay && (
        <SessionCodeCard
          className="fixed-session-code-card"
          qrDataUrl={accessInfo.qrCodeDataUrl}
          sessionCode={meta.sessionCode}
          participantCount={sock.participants?.count ?? 0}
          joinUrl={accessInfo.shortUrl || accessInfo.fullUrl}
          shortUrl={accessInfo.shortUrl}
          defaultExpanded={true}
        />
      )}
    </div>
  );
}
