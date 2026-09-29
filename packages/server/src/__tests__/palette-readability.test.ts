import fs from "fs";
import path from "path";

// Table-driven readability contract for every palette in both themes (14
// combinations): the classic look, gruvbox, Rosé Pine, Catppuccin, seoul256,
// Ayu and Tokyo Night. Each block reads the shipped CSS, resolves the tokens
// a screen really uses in a combination and asserts WCAG contrast: text 4.5:1
// and boundaries 3:1, measured against the worst stop of a gradient.

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const index = fs.readFileSync(path.join(clientSrc, "index.css"), "utf-8");
const theme = fs.readFileSync(path.join(clientSrc, "theme.css"), "utf-8");

type Tokens = Record<string, string>;

const PALETTES = ["classic", "gruvbox", "rose-pine", "catppuccin", "seoul256", "ayu", "tokyo-night"] as const;
const MODES = ["dark", "light"] as const;
type Palette = (typeof PALETTES)[number];
type Mode = (typeof MODES)[number];

const COMBOS: Array<{ name: string; palette: Palette; mode: Mode }> = PALETTES.flatMap((palette) =>
  MODES.map((mode) => ({ name: `${palette} ${mode}`, palette, mode })),
);

/** Palette selector of a combination: dark also applies when data-theme is absent. */
function paletteSelector(palette: Palette, mode: Mode): string {
  return mode === "dark"
    ? `html[data-palette="${palette}"]:not([data-theme="light"])`
    : `html[data-palette="${palette}"][data-theme="light"]`;
}

/** Declarations of every rule whose selector list is exactly `selector`, later rules winning. */
function declarationsOf(css: string, selector: string): Tokens {
  const result: Tokens = {};
  let from = 0;
  for (;;) {
    const at = css.indexOf(`\n${selector} {`, Math.max(from - 1, 0));
    if (at < 0) break;
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+|[a-z-]+)\s*:\s*([^;]+);/g)) result[m[1]] = m[2].trim();
    from = close;
  }
  return result;
}

const hasRule = (css: string, selector: string): boolean => css.includes(`\n${selector} {`);

/** Every token a combination sets: the shared base, the theme, then the palette. */
function tokensOf(palette: Palette, mode: Mode): Tokens {
  const base =
    mode === "dark"
      ? { ...declarationsOf(index, ":root"), ...declarationsOf(theme, 'html[data-theme="dark"]') }
      : {
          ...declarationsOf(index, ":root"),
          ...declarationsOf(index, 'html[data-theme="light"]'),
          ...declarationsOf(theme, 'html[data-theme="light"]'),
        };
  return palette === "classic" ? base : { ...base, ...declarationsOf(index, paletteSelector(palette, mode)) };
}

const TOKENS = Object.fromEntries(COMBOS.map((c) => [c.name, tokensOf(c.palette, c.mode)])) as Record<string, Tokens>;

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgba = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(v);
  if (rgba) return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
  throw new Error(`Not a hex or rgba colour: ${value}`);
}

const paint = (fg: Rgba, bg: Rgba): Rgba => [
  fg[0] * fg[3] + bg[0] * (1 - fg[3]),
  fg[1] * fg[3] + bg[1] * (1 - fg[3]),
  fg[2] * fg[3] + bg[2] * (1 - fg[3]),
  1,
];

/** Paint `fg` (a colour, optionally with an alpha override) over `bg`. */
const over = (fg: string | Rgba, bg: string | Rgba, alpha?: number): Rgba => {
  const front = typeof fg === "string" ? parseColor(fg) : fg;
  return paint(alpha === undefined ? front : [front[0], front[1], front[2], alpha], typeof bg === "string" ? parseColor(bg) : bg);
};

/** color-mix(in srgb, a pct%, b): `pct` of `a` and the rest of `b`. */
const mixColors = (a: string, b: string | Rgba, pct: number): Rgba => {
  const x = parseColor(a);
  const y = typeof b === "string" ? parseColor(b) : b;
  return [0, 1, 2].map((i) => x[i] * pct + y[i] * (1 - pct)).concat(1) as Rgba;
};

function luminance(c: Rgba): number {
  const [r, g, b] = c.slice(0, 3).map((v) => v / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string | Rgba, b: string | Rgba): number {
  const [hi, lo] = [luminance(typeof a === "string" ? parseColor(a) : a), luminance(typeof b === "string" ? parseColor(b) : b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const token = (t: Tokens, name: string): string => {
  const value = t[name];
  if (!value) throw new Error(`Missing token ${name}`);
  return value;
};

/** Colours named in a CSS value, with `var(--token)` resolved from the combination's tokens. */
function colorsIn(value: string, t: Tokens): string[] {
  return [...value.matchAll(/#[0-9a-f]{6}\b|rgba?\([^)]*\)|var\((--[\w-]+)\)/gi)].map((m) => (m[1] ? token(t, m[1]) : m[0]));
}

/** The slide surface's gradient stops (or flat colour), opaque: the ground text on a slide is measured against. */
function slideStops(palette: Palette, mode: Mode, t: Tokens): Rgba[] {
  const rule =
    palette !== "classic"
      ? declarationsOf(index, `${paletteSelector(palette, mode)} .slide-surface`).background
      : mode === "light"
        ? declarationsOf(index, 'html[data-theme="light"] .slide-surface').background
        : "var(--mdq-slide-bg)";
  if (!rule) throw new Error(`No slide background for ${palette} ${mode}`);
  return colorsIn(rule, t).map((color) => over(color, "#ffffff"));
}

/** Assert every foreground passes `need` against every background, listing every failing pair. */
function expectPairs(label: string, foregrounds: Record<string, string | Rgba>, backgrounds: Record<string, string | Rgba>, need = 4.5): void {
  const failures: string[] = [];
  for (const [fgName, fg] of Object.entries(foregrounds)) {
    for (const [bgName, bg] of Object.entries(backgrounds)) {
      const ratio = contrast(fg, bg);
      if (ratio < need) failures.push(`${label}: ${fgName} ${typeof fg === "string" ? fg : fg.slice(0, 3).map(Math.round).join(",")} on ${bgName} is ${ratio.toFixed(2)}, needs ${need}`);
    }
  }
  expect(failures).toEqual([]);
}

describe("palette readability, 7 palettes x 2 themes", () => {
  it("covers every palette and both themes", () => {
    expect(COMBOS).toHaveLength(14);
    for (const { name } of COMBOS) expect(Object.keys(TOKENS[name]).length).toBeGreaterThan(40);
  });

  describe.each(COMBOS)("$name", ({ name, palette, mode }) => {
    const t = TOKENS[name];
    const selector = paletteSelector(palette, mode);
    const stops = slideStops(palette, mode, t);
    const paperColor = over(token(t, "--mdq-paper"), "#ffffff");

    it("keeps the attendee fold-out note kicker and text at 4.5:1 on their wash", () => {
      if (palette === "classic") return;
      const wash = parseColor(token(t, "--mdq-note-attendee-tint"));
      const grounds = Object.fromEntries(stops.map((stop, i) => [`note on slide stop ${i + 1}`, over(wash, stop)]));
      expectPairs(`${name} attendee note`, { kicker: token(t, "--mdq-slide-eyebrow"), body: token(t, "--mdq-slide-ink-soft") }, grounds);
    });

    it("keeps success text at 4.5:1 on the tinted reveal explanation", () => {
      const grounds: Record<string, Rgba> =
        mode === "dark"
          ? Object.fromEntries(
              ["--mdq-paper", "--mdq-paper-strong"].map((surface, i) => [`panel ${i + 1}`, over(token(t, "--mdq-success"), token(t, surface), 0.16)]),
            )
          : Object.fromEntries(colorsIn(token(t, "--mdq-success-wash"), t).map((color, i) => [`wash stop ${i + 1}`, over(color, paperColor)]));
      expectPairs(`${name} reveal explanation`, { "explanation heading": token(t, "--mdq-success-text") }, grounds);
    });

    it("keeps the leaderboard rank and the id and time text at 4.5:1 on every row, including the viewer's own", () => {
      const glass = (strong: boolean): Rgba[] => {
        const g = parseColor(token(t, strong ? "--mdq-slide-glass-strong" : "--mdq-slide-glass"));
        return stops.map((stop) => over(g, stop));
      };
      const washOf = (rowSelector: string): number => {
        let value = mode === "light" ? Number.parseFloat(declarationsOf(theme, 'html[data-theme="light"] .leaderboard-row')["--leaderboard-wash"]) : 16;
        for (const rule of [`${selector} .leaderboard-row`, `${selector} ${rowSelector}`]) {
          const own = declarationsOf(index, rule)["--leaderboard-wash"];
          if (own) value = Number.parseFloat(own);
        }
        return value / 100;
      };
      /** Rank text colour, and the colour of the wash behind it (the accent when no rank colour is set). */
      const rankColors = (rank: string): { text: string; wash: string } => {
        const rule = declarationsOf(index, `${selector} .leaderboard-row.rank-${rank}`)["--leaderboard-rank-color"];
        const set =
          rule ??
          (mode === "light"
            ? declarationsOf(theme, `html[data-theme="light"] .leaderboard-row.rank-${rank}`)["--leaderboard-rank-color"]
            : declarationsOf(index, `.leaderboard-row.rank-${rank}`)["--leaderboard-rank-color"]);
        if (set) {
          const color = set.startsWith("var(") ? token(t, set.slice(4, -1)) : set;
          return { text: color, wash: color };
        }
        return { text: token(t, "--mdq-slide-eyebrow"), wash: token(t, "--mdq-slide-accent") };
      };
      const secondary = mode === "light" ? token(t, "--mdq-muted") : token(t, "--mdq-slide-ink-soft");
      for (const rank of ["first", "second", "third", "standard"]) {
        const { text, wash } = rankColors(rank);
        const grounds: Record<string, Rgba> = {};
        for (const [i, base] of glass(false).entries()) grounds[`row ${rank} stop ${i + 1}`] = over(wash, base, washOf(`.leaderboard-row.rank-${rank}`));
        expectPairs(`${name} leaderboard ${rank}`, { rank: text, "id and time": secondary }, grounds);
      }
      // The viewer's own row: the dark theme adds an accent wash on the strong glass.
      if (mode === "dark" && palette !== "classic") {
        const highlightWash = Number.parseFloat(declarationsOf(index, `${selector} .leaderboard-row`)["--leaderboard-highlight-wash"] ?? "24") / 100;
        const own: Record<string, Rgba> = {};
        for (const [i, base] of glass(true).entries()) own[`own row stop ${i + 1}`] = over(token(t, "--mdq-slide-accent"), base, highlightWash);
        // Below the podium the viewer's own row takes the palette's rule, or the generic dark rule for classic.
        const ownStandard = hasRule(index, `${selector} .leaderboard-row.rank-standard`)
          ? rankColors("standard").text
          : token(t, (declarationsOf(index, 'html:not([data-theme="light"]) .leaderboard-row-highlight.rank-standard')["--leaderboard-rank-color"] ?? "").replace(/^var\((.*)\)$/, "$1"));
        const third =
          declarationsOf(index, `${selector} .leaderboard-row.leaderboard-row-highlight.rank-third`)["--leaderboard-rank-color"] ??
          declarationsOf(index, 'html:not([data-theme="light"]) .leaderboard-row.leaderboard-row-highlight.rank-third')["--leaderboard-rank-color"];
        expectPairs(`${name} own row`, {
          first: rankColors("first").text,
          second: rankColors("second").text,
          third,
          standard: ownStandard,
          "id and time": secondary,
        }, own);
      }
    });

    it("keeps the presenter notes panel text at 4.5:1 and its border and marker at 3:1", () => {
      const panel = over(token(t, "--mdq-warning"), token(t, "--mdq-paper-strong"), 0.09);
      expectPairs(`${name} presenter notes`, {
        kicker: token(t, "--mdq-warning-ink"),
        summary: token(t, "--mdq-warning-ink"),
        position: token(t, "--mdq-muted"),
        "hint": token(t, "--mdq-muted"),
        body: token(t, "--mdq-ink"),
      }, { panel });
      const page = token(t, "--mdq-paper");
      expectPairs(`${name} presenter notes boundary`, {
        border: mixColors(token(t, "--mdq-warning-text"), page, 0.85),
        marker: token(t, "--mdq-warning-text"),
      }, { page }, 3);
    });

  });

  it("draws the presenter notes panel from palette tokens, with no fixed amber", () => {
    const start = index.indexOf("/* ── Presenter notes panel");
    const panelCss = index.slice(start, index.indexOf("/* ── Slide video card", start));
    expect(panelCss).toContain("border: 1px solid color-mix(in srgb, var(--mdq-warning-text) 85%, var(--mdq-paper));");
    expect(panelCss).toContain("background: color-mix(in srgb, var(--mdq-warning) 9%, var(--mdq-paper-strong));");
    expect(panelCss).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(index).not.toMatch(/html\[data-theme="light"\] \.presenter-notes/);
  });

});
