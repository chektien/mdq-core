/**
 * Keyboard navigation for the presenter view. Kept free of React and the DOM
 * so the decision can be tested on plain objects.
 *
 * Next: ArrowRight, ArrowDown, PageDown, l, j. Previous: ArrowLeft, ArrowUp,
 * PageUp, h, k. PageUp and PageDown are the keys a presentation clicker sends.
 * Space is left out on purpose: it activates whichever button has focus.
 */

export type PresenterDirection = "next" | "previous";

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown", "l", "j"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "h", "k"]);

/** The parts of a keyboard event the decision reads. */
export interface PresenterKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/** The parts of an event target the decision reads. */
export interface PresenterKeyTarget {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
}

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "listbox", "slider"]);

/** True when a key press is meant for a field, so it must not move the slides. */
export function isEditableTarget(target: PresenterKeyTarget | null | undefined): boolean {
  if (!target) return false;
  if (target.tagName && EDITABLE_TAGS.has(target.tagName.toUpperCase())) return true;
  if (target.isContentEditable) return true;
  const contentEditable = target.getAttribute?.("contenteditable");
  if (contentEditable !== null && contentEditable !== undefined && contentEditable !== "false") return true;
  const role = target.getAttribute?.("role");
  return !!role && EDITABLE_ROLES.has(role);
}

/** Which way a key moves the slides, ignoring where focus is. */
export function directionForKey(key: string): PresenterDirection | null {
  const normal = key.length === 1 ? key.toLowerCase() : key;
  if (NEXT_KEYS.has(normal)) return "next";
  if (PREVIOUS_KEYS.has(normal)) return "previous";
  return null;
}

export interface PresenterKeyDecision {
  /** The direction the key stands for, or null when it is not a navigation key or must be left alone. */
  direction: PresenterDirection | null;
  /** True when the key is a navigation key the page should take over, so the browser does not scroll. */
  consume: boolean;
  /** True when the slides should actually move now. */
  act: boolean;
}

const IGNORE: PresenterKeyDecision = { direction: null, consume: false, act: false };

/**
 * Decides what a key press does. A held key (`repeat`) is consumed but does
 * not act, so it cannot run through slides and open questions. Nothing happens
 * with Ctrl, Meta or Alt held, in a field, while a dialog is open, or during
 * text composition.
 */
export function decidePresenterKey(
  event: PresenterKeyEvent,
  target: PresenterKeyTarget | null | undefined,
  dialogOpen: boolean,
): PresenterKeyDecision {
  if (event.defaultPrevented || event.isComposing) return IGNORE;
  if (event.ctrlKey || event.metaKey || event.altKey) return IGNORE;
  const direction = directionForKey(event.key);
  if (!direction) return IGNORE;
  if (dialogOpen || isEditableTarget(target)) return IGNORE;
  return { direction, consume: true, act: !event.repeat };
}

/** The action a direction stands for, or null when there is none or it is disabled (such as while reconnecting). */
export function pickNavAction<T extends { label: string; disabled?: boolean; onClick?: unknown }>(
  actions: readonly T[],
  direction: PresenterDirection,
): T | null {
  const label = direction === "next" ? "next" : "prev";
  const action = actions.find((candidate) => candidate.label.trim().toLowerCase() === label);
  if (!action || action.disabled || !action.onClick) return null;
  return action;
}

const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog[open]';

/** True when any dialog, such as the participants list or an expanded image, is showing. */
export function documentHasOpenDialog(root: { querySelector: (selector: string) => unknown }): boolean {
  return root.querySelector(DIALOG_SELECTOR) !== null;
}
