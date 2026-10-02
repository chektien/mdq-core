import { useEffect, useRef } from "react";
import type { useParticipantStudy } from "../hooks/useParticipantStudy";

/** Released items only. Browsing never advances the shared presentation. */
export default function ParticipantStudyControls({ study }: { study: ReturnType<typeof useParticipantStudy> }) {
  const followingLabel = useRef<HTMLParagraphElement>(null);
  const returning = useRef(false);
  useEffect(() => {
    if (study.following && returning.current) {
      followingLabel.current?.focus();
      returning.current = false;
    }
  }, [study.following]);
  if (!study.canBrowse) return study.error ? (
    <div role="alert" className="participant-study student-screen p-4">{study.error} <button type="button" onClick={study.refresh}>Retry</button></div>
  ) : null;
  const position = study.items.findIndex(item => item.questionIndex === study.question?.questionIndex);
  const previous = study.items[position - 1];
  const next = study.items[position + 1];
  const positionLabel = position >= 0 ? `Item ${position + 1} of ${study.items.length} shown` : "No items shown yet";
  return (
    <nav data-question-index={study.question?.questionIndex} aria-label="Available session items" className="participant-study student-screen border-b border-zinc-700">
      <div className="participant-study-layout">
        <button type="button" aria-label="Previous available item" aria-disabled={!previous} className="participant-study-button participant-study-previous rounded-lg border border-zinc-600" onClick={() => previous && study.browse(previous.questionIndex)}>
          <span aria-hidden="true">‹</span> Prev
        </button>
        <div className="participant-study-context student-screen-quiet text-zinc-400" aria-live="polite" aria-atomic="true">
          {study.following ? <p ref={followingLabel} tabIndex={-1} className="participant-study-following">
            <span>Following presenter</span><span className="participant-study-position">{positionLabel}</span>
          </p> : <button type="button" aria-label={`Back to presenter, ${positionLabel.toLowerCase()}`} className="participant-study-button participant-study-back rounded-lg border border-zinc-600" onClick={() => {
            returning.current = true;
            study.backToPresenter();
          }}>
            <span>Back to presenter</span><span className="participant-study-position">{positionLabel}</span>
          </button>}
        </div>
        <button type="button" aria-label="Next available item" aria-disabled={!next} className="participant-study-button participant-study-next rounded-lg border border-zinc-600" onClick={() => next && study.browse(next.questionIndex)}>
          Next <span aria-hidden="true">›</span>
        </button>
        <p role="status" className="participant-study-progress student-screen-quiet text-sm text-zinc-400">
          {study.progressLabel ?? "No questions available yet"}{study.upToDate ? ". You're up to date." : ""}
        </p>
        {study.error && <p role="alert" className="participant-study-error">{study.error} <button type="button" onClick={study.refresh}>Retry</button></p>}
      </div>
    </nav>
  );
}
