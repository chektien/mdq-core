/** Show m:ss for a minute or more (e.g. a 5-minute prompt), raw seconds below 60. */
export function timerLabel(remainingSec: number): string {
  return remainingSec >= 60
    ? `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")}`
    : `${remainingSec}`;
}

/** Reserve space inside the stroke for both the text's width and height.
 * Budget 0.65em per monospace glyph (including font fallback/bold ink) and
 * keep the text diagonal within 75% of the inner diameter. This leaves clear
 * space around even a five-character label at the small phone diameter. */
export function timerFontSize(size: number, label: string): number {
  const innerDiameter = Math.max(0, size - 20);
  const fit = (0.75 * innerDiameter) / Math.hypot(label.length * 0.65, 1);
  return Math.min(size * 0.32, fit);
}
