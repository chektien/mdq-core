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
  onSetAllHidden,
  hiddenByDefault = false,
  total = responses.length,
  live = false,
}: {
  responses: OpenResponseEntry[];
  title?: string;
  emptyLabel?: string;
  showStudentIds?: boolean;
  onToggleHidden?: (response: OpenResponseEntry, hidden: boolean) => void;
  onSetAllHidden?: (hidden: boolean) => void;
  hiddenByDefault?: boolean;
  /** All submitted responses, including ones omitted from a display payload. */
  total?: number;
  /** Projector summary before reveal, with no empty list when all are hidden. */
  live?: boolean;
  /** A short message about the last hide or show, such as why it did not work. */
  notice?: string | null;
}) {
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  const hiddenCount = Math.max(0, total - responses.filter((response) => !response.hidden).length);

  const toggleRow = (rowKey: string) => {
    setExpandedRows((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }));
  };

  return (
    <div className="open-response-list w-full max-w-3xl rounded-2xl border p-4">
      {live ? (
        <p className="open-response-count-label mb-3 text-lg">{total} {total === 1 ? "response" : "responses"}{responses.length > 0 && ` · ${responses.length} shown`}</p>
      ) : <div className="open-response-heading mb-3 flex items-center justify-between gap-3">
        <h3 className="open-response-title text-sm font-semibold uppercase tracking-[0.2em]">
          {title}<span className="open-response-inline-count"> · {total}</span>
        </h3>
        <span className="open-response-count text-xs tabular-nums">{total}</span>
      </div>}
      {hiddenCount > 0 && <p className="open-response-empty mb-3 text-sm">{hiddenCount} hidden</p>}
      {onToggleHidden && hiddenByDefault && <p className="open-response-empty mb-3 text-sm">Responses start hidden. Show the ones you want on the projector.</p>}
      {onSetAllHidden && (
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" className="open-response-toggle" disabled={total === 0} onClick={() => onSetAllHidden(false)}>Show all</button>
          <button type="button" className="open-response-toggle" disabled={total === 0} onClick={() => onSetAllHidden(true)}>Hide all</button>
        </div>
      )}
      {notice && <p role="alert" className="open-response-notice mb-3 text-sm">{notice}</p>}
      {responses.length === 0 ? (
        !live && <p className="open-response-empty text-sm">{total === 0 ? emptyLabel : "All responses are hidden from the projector."}</p>
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
                className={`open-response-entry${hidden ? " open-response-entry-hidden" : ""} w-full min-w-0 rounded-xl border px-3 py-3 text-left transition-colors`}
              >
                <div className="open-response-identity flex items-center gap-3 overflow-hidden text-xs">
                  {showStudentIds && response.studentId && (
                    <span className="open-response-student-id shrink-0 font-mono font-semibold">{response.studentId}</span>
                  )}
                  <span className="open-response-display-name truncate">{participantLabel}</span>
                  {hidden && <span className="open-response-hidden-note shrink-0 font-semibold">Hidden from the projector</span>}
                </div>
                <p
                  className={`open-response-text mt-2 text-sm leading-relaxed ${expanded ? "whitespace-pre-wrap break-words" : "truncate whitespace-nowrap"}`}
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
                  data-hidden={hidden}
                  aria-label={`${hidden ? "Show" : "Hide"} response from ${participantLabel}`}
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

/** The projector's live total and the responses explicitly shown by the presenter. */
export function OpenResponseCount({ count, responses = [] }: { count: number; responses?: OpenResponseEntry[] }) {
  return <OpenResponseList responses={responses} total={count} showStudentIds={false} live />;
}
