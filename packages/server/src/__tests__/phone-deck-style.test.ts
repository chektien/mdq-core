import fs from "fs";
import path from "path";
import { resolveDeckStyleSetting, type DeckStyle } from "@mdq/shared";
import { contrastRatio, mix, phoneScreenAppearance, type PhoneColorEnv, type Rgb } from "../../../client/src/phoneDeckStyle";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string => fs.readFileSync(path.join(clientSrc, rel), "utf-8");

/** The colours these tests use are all hex, so the page can be read without a browser. */
function hex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  const digits = match[1].length === 3 ? match[1].replace(/./g, "$&$&") : match[1];
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as Rgb;
}

const darkPage = (): PhoneColorEnv => ({ resolve: hex, page: hex("#1a1b26") });

/** The style a deck header makes, written the way the server sends it. */
function styleOf(settings: Record<string, string>): DeckStyle {
  const style: DeckStyle = {};
  for (const [key, value] of Object.entries(settings)) {
    const result = resolveDeckStyleSetting(key, value);
    if (!result.ok) throw new Error(result.message);
    Object.assign(style, result.style);
  }
  return style;
}

describe("phone question screen deck appearance", () => {
  it("adds nothing for a deck with no settings", () => {
    expect(phoneScreenAppearance(undefined, darkPage())).toEqual({ attributes: {} });
    expect(phoneScreenAppearance({}, darkPage())).toEqual({ attributes: {} });
    expect(phoneScreenAppearance({ "--not-a-setting": "red", "--mdq-deck-text": "url(x)" }, darkPage())).toEqual({ attributes: {} });
  });

  it("sends a set that is readable when the deck sets a background, text, accent and body size", () => {
    const style = styleOf({ "accent-color": "#0b5394", "background-color": "#fdf6e3", "text-color": "#101820", "body-size": "large" });
    const { style: out, attributes } = phoneScreenAppearance(style, darkPage());
    expect(attributes).toEqual({
      "data-deck-size": "true",
      "data-deck-background": "true",
      "data-deck-text": "true",
      "data-deck-muted": "true",
      "data-deck-accent": "true",
    });
    expect(out?.["--student-text"]).toBe("#101820");
    expect(out?.["--student-accent"]).toBe("#0b5394");
    expect(out?.["--student-on-accent"]).toBe("#ffffff");
    expect(out?.["--mdq-body-scale"]).toBe("1.2");
    // The background and sizes keep the slides' own properties. The colours go out only as checked copies.
    expect(out?.["--mdq-slide-bg"]).toBe("#fdf6e3");
    expect(out).not.toHaveProperty("--mdq-deck-text");
    expect(out).not.toHaveProperty("--mdq-deck-accent");
    // The muted colour is the text colour when the deck gives none, so nothing on the repainted screen keeps the palette's.
    expect(out?.["--student-muted"]).toBe("#101820");
  });

  it("holds the text colour to 4.5:1 against the background, the answer panels and the chips, or replaces it", () => {
    const light = styleOf({ "background-color": "#fdf6e3", "text-color": "#101820" });
    expect(phoneScreenAppearance(light, darkPage()).style?.["--student-text"]).toBe("#101820");
    // Pale text on a pale background cannot be read, so black takes its place.
    const pale = styleOf({ "background-color": "#fdf6e3", "text-color": "#cccccc" });
    expect(phoneScreenAppearance(pale, darkPage()).style?.["--student-text"]).toBe("#000000");
    // A dark background with no text colour gets white.
    const dark = styleOf({ "background-color": "#101820" });
    expect(phoneScreenAppearance(dark, darkPage()).style?.["--student-text"]).toBe("#ffffff");
    // Text just over 4.5:1 against the background dips under it once an answer panel tints it, so it is not kept.
    const marginal = styleOf({ "background-color": "#ffffff", "text-color": "#757575" });
    expect(contrastRatio(hex("#757575")!, hex("#ffffff")!)).toBeGreaterThan(4.5);
    expect(contrastRatio(hex("#757575")!, mix(hex("#757575")!, 0.07, hex("#ffffff")!))).toBeLessThan(4.5);
    expect(phoneScreenAppearance(marginal, darkPage()).style?.["--student-text"]).toBe("#000000");
  });

  it("does not use a text colour the palette's page hides", () => {
    const { style, attributes } = phoneScreenAppearance(styleOf({ "text-color": "#101820" }), darkPage());
    expect(attributes["data-deck-text"]).toBeUndefined();
    expect(style?.["--student-text"]).toBeUndefined();
    // Light text on that page is fine.
    const fine = phoneScreenAppearance(styleOf({ "text-color": "#e6e6e6" }), darkPage());
    expect(fine.attributes["data-deck-text"]).toBe("true");
  });

  it("holds the accent to 3:1 against the background or lets the text colour mark the chosen answer", () => {
    const base = { "background-color": "#fdf6e3", "text-color": "#101820" };
    const good = phoneScreenAppearance(styleOf({ ...base, "accent-color": "#0b5394" }), darkPage());
    expect(good.style?.["--student-accent"]).toBe("#0b5394");
    const weak = phoneScreenAppearance(styleOf({ ...base, "accent-color": "#e6c229" }), darkPage());
    expect(contrastRatio(hex("#e6c229")!, hex("#fdf6e3")!)).toBeLessThan(3);
    expect(weak.style?.["--student-accent"]).toBe("#101820");
    expect(weak.style?.["--student-on-accent"]).toBe("#ffffff");
    // With no deck background there is nothing to fall back on, so a weak accent is dropped.
    const alone = phoneScreenAppearance(styleOf({ "accent-color": "#1a1b2f" }), darkPage());
    expect(alone.attributes["data-deck-accent"]).toBeUndefined();
    expect(alone.style?.["--student-accent"]).toBeUndefined();
  });

  it("draws an answer's edge at 3:1 or more against the background", () => {
    const { style } = phoneScreenAppearance(styleOf({ "background-color": "#fdf6e3", "text-color": "#101820" }), darkPage());
    const line = /rgb\((\d+), (\d+), (\d+)\)/.exec(style?.["--student-line"] ?? "");
    expect(line).not.toBeNull();
    expect(contrastRatio([Number(line![1]), Number(line![2]), Number(line![3])], hex("#fdf6e3")!)).toBeGreaterThanOrEqual(3);
  });

  it("measures a deck with only surface-color against the palette's slide background, not its page", () => {
    // The screen is painted from the surface colour down to the palette's own slide background,
    // here a light one, while the page behind it is dark.
    const env: PhoneColorEnv = { resolve: (css) => (css === "var(--mdq-slide-bg)" ? hex("#fdf6e3") : hex(css)), page: hex("#1a1b26") };
    const { style, attributes } = phoneScreenAppearance(styleOf({ "surface-color": "#ffffff", "text-color": "#101820" }), env);
    expect(attributes["data-deck-background"]).toBe("true");
    expect(style?.["--student-text"]).toBe("#101820");
  });

  it("changes only the sizes for a deck that sets only a body size", () => {
    const { style, attributes } = phoneScreenAppearance(styleOf({ "body-size": "1.4rem" }), darkPage());
    expect(attributes).toEqual({ "data-deck-size": "true" });
    expect(style).toEqual({ "--mdq-body-size": "1.4rem" });
  });

  it("passes the settings through as the slides read them when it has no colours to measure against", () => {
    const { attributes } = phoneScreenAppearance(styleOf({ "text-color": "#101820", "accent-color": "teal" }));
    expect(attributes).toEqual({ "data-deck-text": "true", "data-deck-accent": "true" });
  });
});

describe("phone question screen wiring", () => {
  const student = read("views/StudentView.tsx");
  const index = read("index.css");

  it("puts the settings on the root of both the question screen and the result screen", () => {
    const uses = student.match(/usePhoneScreenAppearance\(question\?\.deckStyle\)/g) ?? [];
    expect(uses).toHaveLength(2);
    const roots = student.match(/className="student-screen min-h-dvh flex flex-col p-4 pb-safe" style=\{appearance\.style\} \{\.\.\.appearance\.attributes\}/g) ?? [];
    expect(roots).toHaveLength(2);
  });

  it("measures colours through the browser only for a deck that has settings", () => {
    expect(student).toContain("deckStyle && typeof document !== \"undefined\" ? browserColorEnv(document) : undefined");
  });

  it("checks the colours again when the theme or palette changes", () => {
    expect(student).toContain("useSyncExternalStore(subscribeToLook, readLook");
    expect(student).toContain('const LOOK_ATTRIBUTES = ["data-theme", "data-palette"];');
    expect(student).toContain("observer.observe(document.documentElement, { attributes: true, attributeFilter: LOOK_ATTRIBUTES })");
    expect(student).toContain("[deckStyle, look],");
  });

  it("gates every rule on an attribute that only a deck with settings sets", () => {
    const block = index.slice(index.indexOf("/* ── Deck header appearance on the phone's question and result screens"));
    expect(block.length).toBeGreaterThan(0);
    const selectors = [...block.matchAll(/^(html:root\[data-theme\][^{]+)\{/gm)].map((match) => match[1]);
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) {
      expect(selector).toMatch(/\.student-screen\[data-deck-(background|size|text|muted|accent)="true"\]/);
    }
  });

  it("leaves the slide surface's own settings alone", () => {
    expect(index).toMatch(/\.slide-surface\[data-deck-text\] :is\(\.slide-header, \.slide-content-grid, \.slide-notes, \.slide-references\)/);
  });
});
