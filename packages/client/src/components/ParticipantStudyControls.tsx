import type { useParticipantStudy } from "../hooks/useParticipantStudy";

/** Released items only. Browsing never advances the shared presentation. */
export default function ParticipantStudyControls({ study }: { study: ReturnType<typeof useParticipantStudy> }) {
  if (!study.canBrowse) return study.error ? (
    <div role="alert" className="participant-study student-screen p-4">{study.error} <button type="button" onClick={study.refresh}>Retry</button></div>
  ) : null;
  const position = study.items.findIndex(item => item.questionIndex === study.question?.questionIndex);
  const previous = study.items[position - 1];
  const next = study.items[position + 1];
  return (
    <nav data-question-index={study.question?.questionIndex} aria-label="Available session items" className="participant-study student-screen p-4 border-b border-zinc-700 space-y-3">
      <p role="status" className="student-screen-quiet text-sm text-zinc-400">
        {study.progressLabel ?? "No questions available yet"}{study.upToDate ? ". You're up to date." : ""}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="rounded-lg border border-zinc-600 px-3 py-2 disabled:opacity-40" disabled={!previous} onClick={() => previous && study.browse(previous.questionIndex)}>Previous available item</button>
        <button type="button" className="rounded-lg border border-zinc-600 px-3 py-2 disabled:opacity-40" disabled={!next} onClick={() => next && study.browse(next.questionIndex)}>Next available item</button>
        <button type="button" className="rounded-lg border border-zinc-600 px-3 py-2" onClick={study.backToPresenter}>Back to presenter</button>
      </div>
      <p className="student-screen-quiet text-sm text-zinc-400">{study.following ? "Following presenter" : "Browsing available items"}</p>
      {study.error && <p role="alert">{study.error} <button type="button" onClick={study.refresh}>Retry</button></p>}
    </nav>
  );
}
