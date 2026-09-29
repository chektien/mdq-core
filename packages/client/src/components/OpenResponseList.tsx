import { useState } from "react";
import type { OpenResponseEntry } from "@mdq/shared";

const rowKeyOf = (response: OpenResponseEntry) => `${response.publicKey}-${response.submittedAt}`;

/**
 * The open responses to one question. When `onToggleHidden` is given (the
 * instructor's view), every response has a Hide / Show button, and a hidden
 * response stays in the list, dimmed and marked as hidden from the projector.
 */
export default function OpenResponseList({
  responses,
  title = "Responses",
  emptyLabel = "No responses yet.",
  showStudentIds = true,
  onToggleHidden,
  notice,
}: {
  responses: OpenResponseEntry[];
  title?: string;
  emptyLabel?: string;
  showStudentIds?: boolean;
  onToggleHidden?: (response: OpenResponseEntry, hidden: boolean) => void;
  /** A short message about the last hide or show, such as why it did not work. */
  notice?: string | null;
}) {
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  const toggleRow = (rowKey: string) => {
    setExpandedRows((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }));
  };

  return (
    <div className="open-response-list w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="open-response-title text-sm font-semibold uppercase tracking-[0.2em] text-zinc-400">{title}</h3>
        <span className="open-response-count text-xs tabular-nums text-zinc-500">{responses.length}</span>
      </div>
      {notice && <p role="alert" className="open-response-notice mb-3 text-sm">{notice}</p>}
      {responses.length === 0 ? (
        <p className="open-response-empty text-sm text-zinc-500">{emptyLabel}</p>
      ) : (
        <div className="max-h-[340px] space-y-2 overflow-y-auto pr-1">
          {responses.map((response) => {
            const rowKey = rowKeyOf(response);
            const expanded = !!expandedRows[rowKey];
            const hidden = response.hidden === true;
            const participantLabel = response.label || response.displayName || "Participant";
            const entry = (
              <button
                key={onToggleHidden ? undefined : rowKey}
                type="button"
                onClick={() => toggleRow(rowKey)}
                className={`open-response-entry${hidden ? " open-response-entry-hidden" : ""} w-full min-w-0 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-3 text-left transition-colors hover:border-zinc-700`}
              >
                <div className="open-response-identity flex items-center gap-3 overflow-hidden text-xs text-zinc-500">
                  {showStudentIds && response.studentId && (
                    <span className="open-response-student-id shrink-0 font-mono font-semibold text-zinc-300">{response.studentId}</span>
                  )}
                  <span className="open-response-display-name truncate">{participantLabel}</span>
                  {hidden && <span className="open-response-hidden-note shrink-0 font-semibold">Hidden from the projector</span>}
                </div>
                <p
                  className={`open-response-text mt-2 text-sm leading-relaxed text-zinc-100 ${expanded ? "whitespace-pre-wrap break-words" : "truncate whitespace-nowrap"}`}
                  title={expanded ? undefined : response.responseText}
                >
                  {response.responseText}
                </p>
              </button>
            );
            if (!onToggleHidden) return entry;
            return (
              <div key={rowKey} className="open-response-row flex items-stretch gap-2">
                {entry}
                <button
                  type="button"
                  className="open-response-toggle shrink-0"
                  aria-pressed={hidden}
                  aria-label={`Hide response from ${participantLabel}`}
                  onClick={() => onToggleHidden(response, !hidden)}
                >
                  {hidden ? "Show" : "Hide"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * What the projector shows while an open question is running: how many
 * responses are in, and that they appear after the reveal.
 */
export function OpenResponseCount({ count }: { count: number }) {
  return (
    <div className="open-response-list open-response-count-card w-full max-w-3xl rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6 text-center">
      <p className="open-response-count-number text-5xl font-semibold tabular-nums">{count}</p>
      <p className="open-response-count-label mt-2 text-lg">{count === 1 ? "response in" : "responses in"}</p>
      <p className="open-response-empty mt-3 text-sm">Responses appear after the reveal.</p>
    </div>
  );
}
