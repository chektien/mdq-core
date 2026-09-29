import { useState } from "react";
import type { OpenResponseEntry } from "@mdq/shared";

export default function OpenResponseList({
  responses,
  title = "Responses",
  emptyLabel = "No responses yet.",
  showStudentIds = true,
}: {
  responses: OpenResponseEntry[];
  title?: string;
  emptyLabel?: string;
  showStudentIds?: boolean;
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
      {responses.length === 0 ? (
        <p className="open-response-empty text-sm text-zinc-500">{emptyLabel}</p>
      ) : (
        <div className="max-h-[340px] space-y-2 overflow-y-auto pr-1">
          {responses.map((response) => {
            const rowKey = `${response.publicKey}-${response.submittedAt}`;
            const expanded = !!expandedRows[rowKey];
            const participantLabel = response.label || response.displayName || "Participant";
            return (
              <button
                key={rowKey}
                type="button"
                onClick={() => toggleRow(rowKey)}
                className="open-response-entry w-full rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-3 text-left transition-colors hover:border-zinc-700"
              >
                <div className="open-response-identity flex items-center gap-3 overflow-hidden text-xs text-zinc-500">
                  {showStudentIds && response.studentId && (
                    <span className="open-response-student-id shrink-0 font-mono font-semibold text-zinc-300">{response.studentId}</span>
                  )}
                  <span className="open-response-display-name truncate">{participantLabel}</span>
                </div>
                <p
                  className={`open-response-text mt-2 text-sm leading-relaxed text-zinc-100 ${expanded ? "whitespace-pre-wrap break-words" : "truncate whitespace-nowrap"}`}
                  title={expanded ? undefined : response.responseText}
                >
                  {response.responseText}
                </p>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
