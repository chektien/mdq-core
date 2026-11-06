/** Same-browser browsing only, isolated by the session and existing seat credential. */
const positionKey = (seatKey: string) => `mdq_position_v1:${encodeURIComponent(seatKey)}`;

export function readStudyPosition(seatKey: string): number | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(positionKey(seatKey)) ?? "null");
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch { return null; }
}

export function writeStudyPosition(seatKey: string, index: number | null): void {
  try {
    if (index === null) localStorage.removeItem(positionKey(seatKey));
    else localStorage.setItem(positionKey(seatKey), JSON.stringify(index));
  } catch { /* Browsing still works when storage is unavailable. */ }
}
