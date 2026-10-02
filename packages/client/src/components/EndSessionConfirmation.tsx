import { useCallback } from "react";
import type { EndSessionAdvisory } from "@mdq/shared";
import { mountParticipantsDialog } from "../participantsDialog";

/** Native modal owns focus/Escape. Counts are advisory and never block deliberate End. */
export default function EndSessionConfirmation({ advisory, busy, endDisabled = false, error, opener, onKeepOpen, onEnd }: {
  advisory: EndSessionAdvisory | null;
  busy: boolean;
  endDisabled?: boolean;
  error?: string | null;
  opener?: HTMLElement | null;
  onKeepOpen: () => void;
  onEnd: () => void;
}) {
  const mount = useCallback((dialog: HTMLDialogElement | null) => dialog ? mountParticipantsDialog(dialog, opener ?? null) : undefined, [opener]);
  return (
    <dialog ref={mount} className="end-session-overlay participants-overlay fixed inset-0 z-[10000] flex items-center justify-center bg-[#07060b]/80 px-5 backdrop-blur-sm"
      aria-labelledby="end-session-title" aria-describedby="end-session-description" onCancel={event => { event.preventDefault(); if (!busy) onKeepOpen(); }}>
      <div className="end-session-card w-full max-w-lg rounded-2xl border border-[color-mix(in_srgb,var(--mdq-danger-line)_40%,transparent)] bg-[var(--mdq-dialog)] p-6 text-white">
        <h2 id="end-session-title" className="text-2xl font-semibold">End session and show results?</h2>
        <p id="end-session-description" className="end-session-desc mt-3 text-sm leading-6 text-zinc-300">Answers will close and results will be available. This cannot be reopened.</p>
        <div role="status" className="end-session-desc mt-3 space-y-2 text-sm text-zinc-300">
          {!!advisory?.unfinishedParticipantCount && <p>{advisory.unfinishedParticipantCount} participant{advisory.unfinishedParticipantCount === 1 ? " hasn’t" : "s haven’t"} answered all available questions.</p>}
          {!!advisory?.unshownQuestionCount && <p>{advisory.unshownQuestionCount} question{advisory.unshownQuestionCount === 1 ? " hasn’t" : "s haven’t"} been shown and won’t count in results.</p>}
          {advisory && (advisory.unfinishedParticipantCount > 0 || advisory.unshownQuestionCount > 0) && <p>These counts may change while the session is open.</p>}
        </div>
        {error && <p role="alert" className="end-session-desc mt-3 text-sm text-zinc-300">{error}</p>}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
          <button type="button" onClick={onKeepOpen} disabled={busy} autoFocus className="end-session-keep rounded-xl border border-zinc-600 px-5 py-3 text-sm font-semibold text-zinc-100">Keep session open</button>
          <button type="button" onClick={onEnd} disabled={busy || endDisabled} className="end-session-end rounded-xl bg-red-600 px-5 py-3 text-sm font-semibold text-white disabled:bg-zinc-700">{busy ? "Ending…" : "End and show results"}</button>
        </div>
      </div>
    </dialog>
  );
}
