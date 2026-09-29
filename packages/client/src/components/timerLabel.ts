/** Show m:ss for a minute or more (e.g. a 5-minute prompt), raw seconds below 60. */
export function timerLabel(remainingSec: number): string {
  return remainingSec >= 60
    ? `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")}`
    : `${remainingSec}`;
}

/** Keep the count inside the ring: the inner diameter is size - 20 (radius
    minus half the 8px stroke), and a monospace digit is about 0.6em wide. */
export function timerFontSize(size: number, label: string): number {
  const fit = (0.8 * (size - 20)) / (label.length * 0.6);
  return Math.min(label.length >= 4 ? size * 0.26 : size * 0.32, fit);
}
