/**
 * The steps a question screen takes to fit the room it has. The component
 * measures the content against the room, and these plain functions decide what
 * to do about it so they can be tested without a browser.
 *
 * A density that overflows is remembered for the room it overflowed in. The
 * fit does not step back up to it until the room grows or the content
 * changes. Without that memory a screen whose next density down fits easily
 * (two option columns instead of one, say) but whose own density overflows
 * would step down, see the spare room, step up, overflow and repeat for as
 * long as anything caused a measurement, such as a timer ticking.
 */

export type FitDensity = "comfortable" | "compact" | "tight" | "scaled";

export const DENSITY_ORDER: FitDensity[] = ["comfortable", "compact", "tight", "scaled"];

/** Content taller than the room steps down. Content under this share of the room may step up. */
export const FIT_STEP_UP_BELOW = 0.78;

/** How much more room than the room that overflowed counts as the room growing, in CSS pixels. A page scrollbar coming and going is about 15 px. */
export const FIT_GROWTH_TOLERANCE = 24;

export interface FitRoom {
  width: number;
  height: number;
}

export interface FitState {
  density: FitDensity;
  /** Index in DENSITY_ORDER of the loosest density that may be tried. The densities before it overflowed. */
  floor: number;
  /** The room the last overflow happened in, or null while nothing is remembered. */
  overflowRoom: FitRoom | null;
  /** What the screen shows. A change to it forgets what overflowed. */
  contentKey: string;
}

export function initialFitState(contentKey = ""): FitState {
  return { density: "comfortable", floor: 0, overflowRoom: null, contentKey };
}

export function nextDensity(current: FitDensity): FitDensity {
  return DENSITY_ORDER[Math.min(DENSITY_ORDER.indexOf(current) + 1, DENSITY_ORDER.length - 1)];
}

export function previousDensity(current: FitDensity): FitDensity {
  return DENSITY_ORDER[Math.max(DENSITY_ORDER.indexOf(current) - 1, 0)];
}

export function roomGrew(remembered: FitRoom, room: FitRoom): boolean {
  return room.width > remembered.width + FIT_GROWTH_TOLERANCE || room.height > remembered.height + FIT_GROWTH_TOLERANCE;
}

/**
 * The state after one measurement. `ratio` is the content height over the room
 * height, `room` the size of the room and `contentKey` names what is shown.
 */
export function stepFit(state: FitState, measurement: { ratio: number; room: FitRoom; contentKey: string }): FitState {
  const { ratio, room, contentKey } = measurement;
  let { floor, overflowRoom } = state;
  if (contentKey !== state.contentKey || (overflowRoom && roomGrew(overflowRoom, room))) {
    floor = 0;
    overflowRoom = null;
  }

  const index = DENSITY_ORDER.indexOf(state.density);
  if (ratio > 1) {
    if (index >= DENSITY_ORDER.length - 1) return { ...state, floor, overflowRoom, contentKey };
    // This density overflowed in this room, so it is not tried again until the room grows.
    return { density: DENSITY_ORDER[index + 1], floor: index + 1, overflowRoom: room, contentKey };
  }
  if (ratio < FIT_STEP_UP_BELOW && index - 1 >= floor) {
    return { density: DENSITY_ORDER[index - 1], floor, overflowRoom, contentKey };
  }
  return { ...state, floor, overflowRoom, contentKey };
}

/** A short, stable hash of some text, so a changed question can be told from the one before without keeping its words. */
function shortHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
}

/**
 * Names what a question screen shows: which question, the session state, whether
 * the presenter is looking back at an earlier one, and a short hash of the
 * question's text and options. A new question, a new state or an edit to the
 * question under the same index gives a new key, and the fit starts afresh.
 */
export function quizFitKey(
  question: { questionIndex: number; text?: string; options?: Array<{ label: string; text: string }> } | null | undefined,
  state: string | null | undefined,
  reviewing = false,
): string {
  const content = question ? `${question.text ?? ""}\u0000${(question.options ?? []).map((option) => `${option.label}\u0001${option.text}`).join("\u0000")}` : "";
  return `${question?.questionIndex ?? ""}:${state ?? ""}:${reviewing ? "review" : "live"}:${shortHash(content)}`;
}
