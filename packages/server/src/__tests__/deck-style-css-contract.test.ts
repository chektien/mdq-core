import fs from "fs";
import path from "path";
import { DECK_STYLE_KEYS, deckStylePresets, resolveDeckStyleSetting } from "@mdq/shared";

const css = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "client", "src", "index.css"), "utf-8");
const surface = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "client", "src", "components", "LiveSurface.tsx"), "utf-8");

// Every custom property a deck setting can set, found by resolving each key's presets, a length and a colour.
const PROBES = ["1rem", "red"];
const emitted = new Set<string>();
for (const key of DECK_STYLE_KEYS) {
  for (const value of [...deckStylePresets(key), ...PROBES]) {
    const result = resolveDeckStyleSetting(key, value);
    if (result.ok) for (const name of Object.keys(result.style)) emitted.add(name);
  }
}

// The palette's own properties are defined for every theme and palette, so the surface
// only has to override them. The others are new and must be read with a fallback.
const PALETTE_OWNED = new Set(["--mdq-slide-accent", "--mdq-slide-ink", "--mdq-slide-heading", "--mdq-slide-ink-soft", "--mdq-slide-bg", "--mdq-slide-bg-soft"]);
const escape = (name: string) => name.replace(/[-]/g, "\\-");

describe("deck style custom properties in the stylesheet", () => {
  it("finds every property the settings can set", () => {
    expect(emitted.size).toBeGreaterThanOrEqual(30);
    expect(emitted).toContain("--mdq-title-scale");
    expect(emitted).toContain("--mdq-image-inset");
  });

  it.each([...emitted].filter((name) => !PALETTE_OWNED.has(name)).sort())("%s is read, always with a fallback", (name) => {
    const reads = css.match(new RegExp(`var\\(${escape(name)}\\s*[,)]`, "g")) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    expect(css).not.toMatch(new RegExp(`var\\(${escape(name)}\\s*\\)`));
    expect(reads.every((read) => read.endsWith(","))).toBe(true);
  });

  it("gives every fallback a non-empty value", () => {
    for (const name of emitted) {
      expect(css).not.toMatch(new RegExp(`var\\(${escape(name)}\\s*,\\s*\\)`));
    }
  });

  it.each([...PALETTE_OWNED].sort())("%s is a palette property defined for both themes and every palette", (name) => {
    const definitions = css.match(new RegExp(`^\\s*${escape(name)}:`, "gm")) ?? [];
    // Dark and light theme, plus a dark and a light block for each of the six other palettes.
    expect(definitions.length).toBeGreaterThanOrEqual(14);
  });

  it("keeps the scale used with each size, spacing and bullet setting at one when unset", () => {
    for (const name of ["title", "heading", "body", "small", "caption", "bullet"]) {
      expect(css).toContain(`var(--mdq-${name}-scale, 1)`);
      expect(css).toContain(`var(--mdq-${name}-size, calc(`);
    }
    for (const name of ["slide-padding", "block-spacing", "inline-spacing", "image-spacing"]) {
      expect(css).toContain(`var(--mdq-${name}-scale, 1)`);
    }
  });

  it("repaints the surface only when the deck sets a background", () => {
    expect(css).toMatch(/html:root\[data-theme\] \.slide-surface\[data-deck-background="true"\] \{\s*background: linear-gradient\(180deg, var\(--mdq-slide-bg-soft, var\(--mdq-slide-bg\)\), var\(--mdq-slide-bg\)\);/);
    expect(surface).toContain("data-deck-background");
    expect(surface).toContain("safeDeckStyle(deckStyle)");
  });

  it("keeps Core's own values as the fallbacks it had before", () => {
    for (const fallback of [
      "var(--mdq-title-size, calc(clamp(2.8rem, 6.3cqi, 7.3rem) * var(--mdq-title-scale, 1)))",
      "var(--mdq-body-size, calc(clamp(1.22rem, 2.25cqi, 2.55rem) * var(--mdq-body-scale, 1)))",
      "var(--mdq-content-width, min(62cqi, 70rem))",
      "var(--mdq-slide-width, min(82cqi, 92rem))",
      "var(--mdq-list-indent, 1.3em)",
      "var(--mdq-image-corners, 0.48rem)",
      "var(--mdq-bullet-color, var(--mdq-slide-accent))",
      "var(--mdq-bullet-color, var(--mdq-slide-ink-soft))",
      "var(--mdq-list-gap, 0.5em)",
      "var(--mdq-list-gap-nested, 0.16em)",
    ]) {
      expect(css).toContain(fallback);
    }
  });
});
