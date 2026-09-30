import fs from "fs";
import path from "path";
import {
  SWIPE_BLOCKING_SELECTOR,
  canBeginSwipe,
  isSwipePointer,
  resolveSwipe,
  scrollerCanStillScroll,
  startsInEdgeGuard,
  swipeDirection,
  type SwipeStart,
} from "../../../client/src/presenterSwipe";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string => fs.readFileSync(path.join(clientSrc, rel), "utf-8");

const start = (extra: Partial<SwipeStart> = {}): SwipeStart => ({
  x: 600, y: 400, pointerType: "touch", viewportWidth: 1180, onBlockedTarget: false, scrollers: [], ...extra,
});

describe("swipe direction", () => {
  it("moves next on a swipe left and previous on a swipe right", () => {
    expect(swipeDirection(-120, 0)).toBe("next");
    expect(swipeDirection(120, 10)).toBe("previous");
  });

  it("needs at least 60 px of sideways travel", () => {
    expect(swipeDirection(-59, 0)).toBeNull();
    expect(swipeDirection(-60, 0)).toBe("next");
    expect(swipeDirection(60, 0)).toBe("previous");
  });

  it("needs the sideways travel to be at least twice the vertical travel", () => {
    expect(swipeDirection(-100, 51)).toBeNull();
    expect(swipeDirection(-100, 50)).toBe("next");
    expect(swipeDirection(-100, -50)).toBe("next");
    expect(swipeDirection(-100, 120)).toBeNull();
    expect(swipeDirection(0, 200)).toBeNull();
  });
});

describe("swipe pointers and edges", () => {
  it("takes touch and pen but not the mouse", () => {
    expect(isSwipePointer("touch")).toBe(true);
    expect(isSwipePointer("pen")).toBe(true);
    expect(isSwipePointer("mouse")).toBe(false);
  });

  it("leaves the outer 24 px of each side to the system back and forward gestures", () => {
    expect(startsInEdgeGuard(0, 1180)).toBe(true);
    expect(startsInEdgeGuard(23, 1180)).toBe(true);
    expect(startsInEdgeGuard(24, 1180)).toBe(false);
    expect(startsInEdgeGuard(1156, 1180)).toBe(false);
    expect(startsInEdgeGuard(1157, 1180)).toBe(true);
    expect(startsInEdgeGuard(1180, 1180)).toBe(true);
  });
});

describe("scrollers that can still scroll sideways", () => {
  const table = { scrollLeft: 0, scrollWidth: 900, clientWidth: 400 };

  it("claims a drag that moves its content further", () => {
    expect(scrollerCanStillScroll(table, -100)).toBe(true);
    expect(scrollerCanStillScroll({ ...table, scrollLeft: 250 }, 100)).toBe(true);
  });

  it("lets go once it is at the end the drag heads for", () => {
    expect(scrollerCanStillScroll(table, 100)).toBe(false);
    expect(scrollerCanStillScroll({ ...table, scrollLeft: 500 }, -100)).toBe(false);
  });

  it("ignores an element that does not overflow", () => {
    expect(scrollerCanStillScroll({ scrollLeft: 0, scrollWidth: 400, clientWidth: 400 }, -100)).toBe(false);
  });
});

describe("resolving a finished gesture", () => {
  it("returns the direction of a clean swipe", () => {
    expect(resolveSwipe(start(), 480, 410)).toBe("next");
    expect(resolveSwipe(start(), 720, 390)).toBe("previous");
  });

  it("ignores a tap, a short drag and a vertical scroll", () => {
    expect(resolveSwipe(start(), 602, 402)).toBeNull();
    expect(resolveSwipe(start(), 560, 400)).toBeNull();
    expect(resolveSwipe(start(), 590, 700)).toBeNull();
  });

  it("ignores gestures that start on a control, link, field, the join card or in a dialog", () => {
    expect(resolveSwipe(start({ onBlockedTarget: true }), 400, 400)).toBeNull();
    expect(canBeginSwipe(start({ onBlockedTarget: true }))).toBe(false);
  });

  it("ignores gestures that start at a screen edge", () => {
    expect(resolveSwipe(start({ x: 10 }), -100, 400)).toBeNull();
    expect(resolveSwipe(start({ x: 10 }), 200, 400)).toBeNull();
    expect(resolveSwipe(start({ x: 1170 }), 900, 400)).toBeNull();
  });

  it("ignores a mouse drag", () => {
    expect(resolveSwipe(start({ pointerType: "mouse" }), 400, 400)).toBeNull();
  });

  it("hands a drag to a table or code block that can still scroll that way", () => {
    const scrollers = [{ scrollLeft: 0, scrollWidth: 900, clientWidth: 400 }];
    expect(resolveSwipe(start({ scrollers }), 400, 400)).toBeNull();
    expect(resolveSwipe(start({ scrollers }), 800, 400)).toBe("previous");
  });

  it("names the elements a swipe must not start on", () => {
    for (const part of ["button", "a,", "input", "textarea", "select", ".slide-join-panel", "[role=\"dialog\"]", "[contenteditable]"]) {
      expect(SWIPE_BLOCKING_SELECTOR).toContain(part);
    }
  });
});

describe("swipe wiring", () => {
  const surface = read("components/LiveSurface.tsx");
  const index = read("index.css");

  it("swipes only where Prev and Next actions are supplied, so phones and the projector never do", () => {
    expect(surface).toContain("if (!surface || !hasNavActions) return undefined;");
    expect(surface).toContain('hasNavActions ? "slide-surface-swipe" : null');
    for (const view of ["views/StudentView.tsx", "views/PresentationView.tsx"]) {
      expect(read(view)).not.toContain("navActions=");
    }
  });

  it("runs the same handlers as the buttons and ignores a second finger", () => {
    expect(surface).toContain("pickNavAction(navActionsRef.current, direction)");
    expect(surface).toContain("touches.size > 1");
  });

  it("counts only fingers and pens, and cannot be left off by a lost pointerup", () => {
    expect(surface).toContain("if (!isSwipePointer(event.pointerType)) return;");
    expect(surface).toContain("if (event.isPrimary) touches.clear();");
    expect(surface).toContain('surface.addEventListener("lostpointercapture", onPointerCancel);');
    expect(surface).toContain('surface.removeEventListener("lostpointercapture", onPointerCancel);');
  });

  it("keeps vertical scrolling and pinching on the swipe surface only", () => {
    expect(index).toMatch(/\.slide-surface-swipe \{\s*touch-action: pan-y pinch-zoom;\s*\}/);
  });
});
