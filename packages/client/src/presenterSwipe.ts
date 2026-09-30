/**
 * Swipe navigation for the presenter's slide area. The decisions are plain
 * functions so they can be tested without a browser. A swipe left moves to the
 * next item and a swipe right to the previous one, the same as flicking pages.
 */

export type SwipeDirection = "next" | "previous";

/** Shortest horizontal travel that counts as a swipe, in CSS pixels. */
export const SWIPE_MIN_DISTANCE = 60;
/** How much further sideways than up or down a swipe must travel. */
export const SWIPE_HORIZONTAL_RATIO = 2;
/** A touch this close to the left or right screen edge belongs to the system back and forward gestures. */
export const SWIPE_EDGE_GUARD = 24;

/** Elements a gesture must never steal from: controls, links, fields, media, the join card and dialogs. */
export const SWIPE_BLOCKING_SELECTOR = [
  "button", "a", "input", "textarea", "select", "summary", "label",
  "video", "audio", "iframe", "canvas",
  "[contenteditable]:not([contenteditable=\"false\"])",
  "[role=\"button\"]", "[role=\"link\"]", "[role=\"dialog\"]", "[role=\"slider\"]", "[role=\"textbox\"]",
  ".slide-join-panel",
].join(", ");

/** Only a finger or a pen swipes. A mouse drag selects text. */
export function isSwipePointer(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

/** True when a touch begins too near a side of the screen. */
export function startsInEdgeGuard(x: number, viewportWidth: number, guard: number = SWIPE_EDGE_GUARD): boolean {
  return x < guard || x > viewportWidth - guard;
}

/** The horizontal scroll position of one scrollable ancestor when the gesture began. */
export interface HorizontalScroller {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * True when the ancestor could still scroll the way this swipe drags it, so
 * the swipe belongs to the ancestor. Dragging left scrolls its content
 * towards the right end, and dragging right towards the left end.
 */
export function scrollerCanStillScroll(scroller: HorizontalScroller, dx: number): boolean {
  const room = scroller.scrollWidth - scroller.clientWidth;
  if (room <= 1) return false;
  return dx < 0 ? scroller.scrollLeft < room - 1 : scroller.scrollLeft > 1;
}

/** The direction a finished gesture stands for, or null when it is too short or too diagonal. */
export function swipeDirection(dx: number, dy: number): SwipeDirection | null {
  if (Math.abs(dx) < SWIPE_MIN_DISTANCE) return null;
  if (Math.abs(dx) < SWIPE_HORIZONTAL_RATIO * Math.abs(dy)) return null;
  return dx < 0 ? "next" : "previous";
}

export interface SwipeStart {
  x: number;
  y: number;
  pointerType: string;
  viewportWidth: number;
  /** True when the touch began on a control, link, field, the join card or in a dialog. */
  onBlockedTarget: boolean;
  /** Horizontal scrollers around the touch, as they stood at the start. */
  scrollers: readonly HorizontalScroller[];
}

/** Whether a gesture that just began may turn into a swipe. */
export function canBeginSwipe(start: SwipeStart): boolean {
  if (!isSwipePointer(start.pointerType)) return false;
  if (start.onBlockedTarget) return false;
  return !startsInEdgeGuard(start.x, start.viewportWidth);
}

/** The swipe a finished gesture produces, or null when it should be left alone. */
export function resolveSwipe(start: SwipeStart, endX: number, endY: number): SwipeDirection | null {
  if (!canBeginSwipe(start)) return null;
  const dx = endX - start.x;
  const dy = endY - start.y;
  const direction = swipeDirection(dx, dy);
  if (!direction) return null;
  if (start.scrollers.some((scroller) => scrollerCanStillScroll(scroller, dx))) return null;
  return direction;
}
