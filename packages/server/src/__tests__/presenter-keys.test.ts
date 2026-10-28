import fs from "fs";
import path from "path";
import {
  decidePresenterKey,
  directionForKey,
  documentHasOpenDialog,
  isEditableTarget,
  isShieldedTarget,
  navBlockedReason,
  pickNavAction,
  type PresenterDirection,
  type PresenterKeyEvent,
  type PresenterNavContext,
} from "../../../client/src/presenterKeys";

const press = (key: string, extra: Partial<PresenterKeyEvent> = {}): PresenterKeyEvent => ({
  key, ctrlKey: false, metaKey: false, altKey: false, repeat: false, ...extra,
});
const body = { tagName: "BODY" };

describe("presenter key directions", () => {
  it("moves next on ArrowRight, ArrowDown, PageDown, l and j", () => {
    for (const key of ["ArrowRight", "ArrowDown", "PageDown", "l", "j"]) {
      expect(directionForKey(key)).toBe("next");
    }
  });

  it("moves back on ArrowLeft, ArrowUp, PageUp, h and k", () => {
    for (const key of ["ArrowLeft", "ArrowUp", "PageUp", "h", "k"]) {
      expect(directionForKey(key)).toBe("previous");
    }
  });

  it("reads letters the same with Caps Lock on", () => {
    expect(directionForKey("L")).toBe("next");
    expect(directionForKey("H")).toBe("previous");
  });

  it("leaves Space, Enter, Home, End and other keys alone", () => {
    for (const key of [" ", "Enter", "Home", "End", "Tab", "Escape", "a", "n", "p"]) {
      expect(directionForKey(key)).toBeNull();
    }
  });
});

describe("presenter key decision", () => {
  it("acts on a plain navigation key and takes it from the browser", () => {
    expect(decidePresenterKey(press("PageDown"), body, false)).toEqual({ direction: "next", consume: true, act: true });
    expect(decidePresenterKey(press("k"), body, false)).toEqual({ direction: "previous", consume: true, act: true });
  });

  it("ignores a held key so it cannot run through slides and open questions", () => {
    const held = decidePresenterKey(press("ArrowRight", { repeat: true }), body, false);
    expect(held.act).toBe(false);
    // Still consumed, so a held clicker key does not scroll the page either.
    expect(held.consume).toBe(true);
  });

  it("does nothing with Ctrl, Meta or Alt held", () => {
    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      const decision = decidePresenterKey(press("ArrowLeft", { [modifier]: true }), body, false);
      expect(decision).toEqual({ direction: null, consume: false, act: false });
    }
  });

  it("does nothing while a dialog is open", () => {
    expect(decidePresenterKey(press("ArrowRight"), body, true).act).toBe(false);
    expect(decidePresenterKey(press("ArrowRight"), body, true).consume).toBe(false);
  });

  it("does nothing while focus is in an input, textarea, select or contenteditable", () => {
    for (const target of [
      { tagName: "INPUT" },
      { tagName: "textarea" },
      { tagName: "SELECT" },
      { tagName: "DIV", isContentEditable: true },
    ]) {
      expect(decidePresenterKey(press("j"), target, false)).toEqual({ direction: null, consume: false, act: false });
    }
  });

  it("does nothing during text composition or when another handler already took the key", () => {
    expect(decidePresenterKey(press("l", { isComposing: true }), body, false).act).toBe(false);
    expect(decidePresenterKey(press("ArrowRight", { defaultPrevented: true }), body, false).act).toBe(false);
  });

  it("still navigates from a focused button, as Space is not a navigation key", () => {
    expect(decidePresenterKey(press("ArrowRight"), { tagName: "BUTTON" }, false).act).toBe(true);
    expect(decidePresenterKey(press(" "), { tagName: "BUTTON" }, false).act).toBe(false);
  });
});

describe("editable targets", () => {
  it("recognises fields, contenteditable regions and text-like roles", () => {
    expect(isEditableTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", getAttribute: (name) => (name === "contenteditable" ? "" : null) })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", getAttribute: (name) => (name === "contenteditable" ? "false" : null) })).toBe(false);
    expect(isEditableTarget({ tagName: "DIV", getAttribute: (name) => (name === "role" ? "textbox" : null) })).toBe(true);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe("widgets that keep their arrow keys", () => {
  const withRole = (role: string) => ({ tagName: "DIV", getAttribute: (name: string) => (name === "role" ? role : null) });

  it("leaves tabs, radios, menus, sliders, listboxes and comboboxes alone", () => {
    for (const role of ["tab", "radio", "menu", "menuitem", "slider", "listbox", "combobox"]) {
      expect(isEditableTarget(withRole(role))).toBe(true);
      expect(decidePresenterKey(press("ArrowRight"), withRole(role), false).act).toBe(false);
    }
    expect(isEditableTarget(withRole("button"))).toBe(false);
  });

  it("leaves a player with controls and the notes panel to their own keys", () => {
    const inside = (selectors: string[]) => ({ tagName: "VIDEO", closest: (selector: string) => (selectors.some((s) => selector.includes(s)) ? {} : null) });
    expect(isShieldedTarget(inside(["video[controls]"]))).toBe(true);
    expect(isShieldedTarget(inside(["audio[controls]"]))).toBe(true);
    expect(isShieldedTarget(inside([".presenter-notes-panel"]))).toBe(true);
    expect(isShieldedTarget(inside([]))).toBe(false);
    expect(isShieldedTarget(null)).toBe(false);
    expect(decidePresenterKey(press("ArrowRight"), inside([".presenter-notes-panel"]), false)).toEqual({ direction: null, consume: false, act: false });
  });
});

describe("the stacked layout, where the slide scrolls", () => {
  const scrolling = { arrowsScroll: true };

  it("leaves ArrowUp and ArrowDown to scroll", () => {
    for (const key of ["ArrowUp", "ArrowDown"]) {
      expect(decidePresenterKey(press(key), body, false, scrolling)).toEqual({ direction: null, consume: false, act: false });
    }
  });

  it("keeps h, j, k, l, ArrowLeft, ArrowRight, PageUp and PageDown for navigation", () => {
    for (const key of ["h", "j", "k", "l", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"]) {
      expect(decidePresenterKey(press(key), body, false, scrolling).act).toBe(true);
    }
  });

  it("still takes ArrowUp and ArrowDown on the wide layout", () => {
    expect(decidePresenterKey(press("ArrowDown"), body, false, { arrowsScroll: false }).act).toBe(true);
  });
});

describe("Prev and Next actions", () => {
  const onClick = () => undefined;
  const actions = [
    { label: "Prev", onClick, disabled: false },
    { label: "Next", onClick, disabled: false },
  ];

  it("picks the button a direction stands for", () => {
    expect(pickNavAction(actions, "next")?.label).toBe("Next");
    expect(pickNavAction(actions, "previous")?.label).toBe("Prev");
  });

  it("skips a disabled button, such as while reconnecting or at the first slide", () => {
    expect(pickNavAction([{ label: "Prev", onClick, disabled: true }, actions[1]], "previous")).toBeNull();
    expect(pickNavAction([actions[0], { label: "Next", onClick, disabled: true }], "next")).toBeNull();
  });

  it("finds nothing when the surface has no navigation buttons", () => {
    expect(pickNavAction([], "next")).toBeNull();
  });
});

describe("open dialogs", () => {
  it("looks for dialog roles, modal markers and open dialog elements", () => {
    const seen: string[] = [];
    const root = { querySelector: (selector: string) => { seen.push(selector); return null; } };
    expect(documentHasOpenDialog(root)).toBe(false);
    expect(seen[0]).toContain('[role="dialog"]');
    expect(seen[0]).toContain('[aria-modal="true"]');
    expect(seen[0]).toContain("dialog[open]");
    expect(documentHasOpenDialog({ querySelector: () => ({}) })).toBe(true);
  });
});

describe("blocked presenter navigation reasons", () => {
  const ready: PresenterNavContext = {
    state: "REVEAL", selfPaced: false, liveIsSlide: false, isReviewing: false,
    isFirst: false, isLast: false, loading: false, waitingReason: null,
    revealActionLabel: "Reveal Answer",
  };
  const cases: [string, PresenterDirection, Partial<PresenterNavContext>, string | null][] = [
    ["lobby Next", "next", { state: "LOBBY" }, "Press Start Session to begin."],
    ["lobby Previous", "previous", { state: "LOBBY" }, "Press Start Session to begin."],
    ["open presenter-paced question", "next", { state: "QUESTION_OPEN" }, "Close the question first, then reveal the answer to move on."],
    ["open poll", "next", { state: "QUESTION_OPEN", revealActionLabel: "Show Poll Results" }, "Close the question first, then press Show Poll Results to move on."],
    ["open responses", "next", { state: "QUESTION_OPEN", revealActionLabel: "Reveal Responses" }, "Close the question first, then press Reveal Responses to move on."],
    ["closed question", "next", { state: "QUESTION_CLOSED" }, "Reveal Answer first to move on."],
    ["closed poll", "next", { state: "QUESTION_CLOSED", revealActionLabel: "Show Poll Results" }, "Show Poll Results first to move on."],
    ["closed responses", "next", { state: "QUESTION_CLOSED", revealActionLabel: "Reveal Responses" }, "Reveal Responses first to move on."],
    ["leaderboard Next", "next", { state: "LEADERBOARD" }, "Press Back to Quiz to continue."],
    ["leaderboard Previous", "previous", { state: "LEADERBOARD" }, "Press Back to Quiz to continue."],
    ["final leaderboard", "next", { state: "LEADERBOARD", isLast: true }, "Press Review Final to review the final question."],
    ["review opened from final leaderboard", "next", { state: "LEADERBOARD", isReviewing: true, isLast: true }, "Press Back to Live to return to the leaderboard."],
    ["first slide", "previous", { state: "QUESTION_OPEN", liveIsSlide: true, isFirst: true }, "This is the first slide."],
    ["first question", "previous", { isFirst: true }, "This is the first question."],
    ["last slide", "next", { state: "QUESTION_OPEN", liveIsSlide: true, isLast: true }, "This is the last slide."],
    ["last revealed question", "next", { isLast: true }, "This is the last question."],
    ["last self-paced question", "next", { state: "QUESTION_OPEN", selfPaced: true, isLast: true }, "This is the last question."],
    ["last question still needs closing", "next", { state: "QUESTION_OPEN", isLast: true }, "Close the question first, then reveal the answer to move on."],
    ["last question still needs reveal", "next", { state: "QUESTION_CLOSED", isLast: true }, "Reveal Answer first to move on."],
    ["reconnecting Next", "next", { waitingReason: "Reconnecting..." }, "Reconnecting..."],
    ["reconnecting Previous", "previous", { waitingReason: "Reconnecting..." }, "Reconnecting..."],
    ["reconnecting at a boundary", "previous", { isFirst: true, waitingReason: "Reconnecting..." }, "Reconnecting..."],
    ["reconnecting lobby", "next", { state: "LOBBY", waitingReason: "Reconnecting..." }, "Reconnecting..."],
    ["reconnecting leaderboard", "next", { state: "LEADERBOARD", waitingReason: "Reconnecting..." }, "Reconnecting..."],
    ["busy Next", "next", { loading: true }, "Please wait for the current action to finish."],
    ["busy Previous", "previous", { loading: true }, "Please wait for the current action to finish."],
    ["first review item", "previous", { isReviewing: true, isFirst: true }, "This is the first one to review."],
    ["last review item", "next", { isReviewing: true, isLast: true }, "This is the last one to review."],
    ["single review item Previous", "previous", { isReviewing: true, isFirst: true, isLast: true }, "This is the first one to review."],
    ["single review item Next", "next", { isReviewing: true, isFirst: true, isLast: true }, "This is the last one to review."],
    ["ended session", "next", { state: "ENDED" }, "The session has ended."],
    ["revealed question with a following item", "next", {}, null],
    ["open slide with a following item", "next", { state: "QUESTION_OPEN", liveIsSlide: true }, null],
    ["self-paced open question with a following item", "next", { state: "QUESTION_OPEN", selfPaced: true }, null],
    ["Previous after the first item", "previous", {}, null],
    ["Previous on an open question", "previous", { state: "QUESTION_OPEN" }, null],
    ["Previous on a closed question", "previous", { state: "QUESTION_CLOSED" }, null],
    ["review Next before the end", "next", { isReviewing: true }, null],
    ["review Previous past the start", "previous", { isReviewing: true }, null],
    ["review Next while reconnecting and busy", "next", { isReviewing: true, loading: true, waitingReason: "Reconnecting..." }, null],
    ["review Previous while reconnecting and busy", "previous", { isReviewing: true, loading: true, waitingReason: "Reconnecting..." }, null],
  ];
  it.each(cases)("%s", (_name, direction, overrides, expected) => {
    expect(navBlockedReason(direction, { ...ready, ...overrides })).toBe(expected);
  });
});

describe("presenter view wiring", () => {
  const instructor = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "client", "src", "views", "InstructorView.tsx"), "utf-8");

  it("runs the same Prev and Next handlers as the buttons", () => {
    expect(instructor).toContain("pickNavAction(navActionsRef.current, decision.direction)");
    expect(instructor).toContain("documentHasOpenDialog(document),");
    expect(instructor).toContain('{ arrowsScroll: window.matchMedia("(max-width: 760px)").matches }');
  });

  it("explains only fresh blocked presses, after trying the matching button", () => {
    const listener = instructor.slice(instructor.indexOf("const handleKeyDown ="), instructor.indexOf('window.addEventListener("keydown"'));
    expect(listener).toMatch(/if \(!decision\.act\) return;[\s\S]*const action = pickNavAction/);
    expect(listener).toMatch(/if \(action\) \{\s*clearNotice\(\);\s*void action\.onClick\?\.\(\);\s*return;\s*\}\s*const reason = navBlockedReason\(decision.direction, navContextRef.current\)/);
    expect(listener).toContain("window.clearTimeout(timer)");
    expect(listener).toContain("window.setTimeout(clearNotice, 4000)");
    expect(listener).toContain("press: ++pressRef.current");
  });

  it("keeps one polite status in the lobby and in each live layout, floating so nothing moves, never focused", () => {
    expect(instructor).toContain('<p role="status" aria-live="polite" aria-atomic="true" className="presenter-nav-status fixed bottom-4 left-1/2 z-50 w-max max-w-[90vw] -translate-x-1/2 pointer-events-none text-center text-sm">');
    expect(instructor.split("<PresenterNavigationStatus notice={lobbyNavNotice} />")).toHaveLength(2);
    // The live view has two layouts, the slide surface and the classic one; each renders it once.
    expect(instructor.split("<PresenterNavigationStatus notice={navNotice} />")).toHaveLength(3);
    const surfaceBranch = instructor.slice(instructor.indexOf("if (isLiveSurfaceDisplay) {"), instructor.indexOf("{participantsDialog}", instructor.indexOf("if (isLiveSurfaceDisplay) {")));
    expect(surfaceBranch).toContain("<PresenterNavigationStatus notice={navNotice} />");
    expect(instructor).toContain('}, phase === "lobby")');
    expect(instructor).not.toMatch(/PresenterNavigationStatus[^\n]*\.focus\(/);
    const surface = fs.readFileSync(path.resolve(__dirname, "../../../client/src/components/LiveSurface.tsx"), "utf-8");
    expect(surface).not.toContain("navigationStatus");
  });
});
