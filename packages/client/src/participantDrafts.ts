/** Same-device drafts only. Seat credentials isolate changes of participant. */
export interface ParticipantDraft { selectedOptions: string[]; responseText: string; revision: number }
export const emptyDraft = (): ParticipantDraft => ({ selectedOptions: [], responseText: "", revision: 0 });
export function draftStorageKey(sessionId: string, seatToken: string, index: number): string {
  return `mdq_draft_v1:${encodeURIComponent(sessionId)}:${encodeURIComponent(seatToken)}:${index}`;
}
export function readDraft(key: string): ParticipantDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value && Array.isArray(value.selectedOptions) && value.selectedOptions.every((v: unknown) => typeof v === "string")
      && typeof value.responseText === "string" && Number.isInteger(value.revision) ? value : null;
  } catch { return null; }
}
export function writeDraft(key: string, draft: ParticipantDraft): boolean {
  try { localStorage.setItem(key, JSON.stringify(draft)); return true; } catch { return false; }
}
