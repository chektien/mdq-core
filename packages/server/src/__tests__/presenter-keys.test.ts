import fs from "fs";
import path from "path";
import {
  decidePresenterKey,
  directionForKey,
  documentHasOpenDialog,
  isEditableTarget,
  pickNavAction,
  type PresenterKeyEvent,
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

describe("presenter view wiring", () => {
  const instructor = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "client", "src", "views", "InstructorView.tsx"), "utf-8");

  it("runs the same Prev and Next handlers as the buttons", () => {
    expect(instructor).toContain("pickNavAction(navActionsRef.current, decision.direction)");
    expect(instructor).toContain("decidePresenterKey(event, event.target as Element | null, documentHasOpenDialog(document))");
  });
});
