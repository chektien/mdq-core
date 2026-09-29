/** Space the bar keeps around a label drawn inside it (pr-3 plus a matching left margin). */
export const BAR_LABEL_PADDING_PX = 24;

/**
 * Whether a count label fits inside its bar. The bar's width is a share of
 * the track, so a narrow share keeps its true length and the label moves
 * outside it instead of stretching the bar to fit.
 */
export function labelFitsInBar(trackPx: number, widthPct: number, labelPx: number): boolean {
  return (trackPx * widthPct) / 100 >= labelPx + BAR_LABEL_PADDING_PX;
}
