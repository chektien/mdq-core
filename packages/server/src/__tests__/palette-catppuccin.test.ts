import fs from "fs";
import path from "path";

// Catppuccin palette contract: both theme blocks exist, the upstream is
// credited, and every text, fill and boundary colour holds its contrast target
// on the surfaces it sits on.
const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const serverSrc = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(clientSrc, "index.css"), "utf-8");
const themeCss = fs.readFileSync(path.join(clientSrc, "theme.css"), "utf-8");
const printSource = fs.readFileSync(path.join(serverSrc, "print-mdq.ts"), "utf-8");

const NAME = "catppuccin";
const DARK = `html[data-palette="${NAME}"]:not([data-theme="light"])`;
const LIGHT = `html[data-palette="${NAME}"][data-theme="light"]`;

function ruleBody(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing rule: ${selector}`);
  const open = source.indexOf("{", start);
  return source.slice(open + 1, source.indexOf("}", open));
}

function declarations(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+|[a-z-]+)\s*:\s*([^;]+);/g)) {
    result[match[1]] = match[2].trim();
  }
  return result;
}

type Rgb = [number, number, number];

function parseColor(value: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgba = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgba) return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  throw new Error(`Unsupported colour: ${value}`);
}

/** Composite a colour (hex or rgba) over an opaque hex background. */
function over(value: string, background: string): Rgb {
  const { rgb, alpha } = parseColor(value);
  const bg = parseColor(background).rgb;
  return [0, 1, 2].map((i) => rgb[i] * alpha + bg[i] * (1 - alpha)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const solid = (hex: string): Rgb => parseColor(hex).rgb;

function expectRatio(label: string, fg: Rgb, bg: Rgb, min: number): void {
  const value = ratio(fg, bg);
  if (value < min) throw new Error(`${label} is ${value.toFixed(2)}:1, needs ${min}:1`);
}

const themes = [
  ["dark", DARK],
  ["light", LIGHT],
] as const;

describe(`${NAME} palette`, () => {
  it("defines both theme blocks and credits the upstream palette", () => {
    for (const selector of [DARK, `${DARK} body`, `${DARK} .slide-surface`, LIGHT, `${LIGHT} .slide-surface`]) {
      expect(css).toContain(`${selector} {`);
    }
    expect(css).toContain("https://github.com/catppuccin/palette");
    expect(css).toContain("(MIT,");
  });

  it("sets every token the gruvbox palette sets, in both themes", () => {
    for (const [, selector] of themes) {
      const gruvbox = selector.replace(NAME, "gruvbox");
      const own = declarations(ruleBody(css, selector));
      const model = declarations(ruleBody(css, gruvbox));
      for (const token of Object.keys(model)) {
        if (token === "--mdq-panel-radius") continue;
        expect(own[token]).toBeDefined();
      }
    }
  });

  it("uses no !important in its rules", () => {
    const start = css.indexOf(`/* ── Catppuccin palette (deck palette: ${NAME}) ── */`);
    const end = css.indexOf("/* ── ", start + 10);
    expect(start).toBeGreaterThan(0);
    expect(css.slice(start, end)).not.toContain("!important");
  });

  describe.each(themes)("%s theme", (mode, selector) => {
    const t = declarations(ruleBody(css, selector));
    const slideStops = [t["--mdq-slide-bg"], t["--mdq-slide-bg-soft"]];
    const codeBody = { color: t["--mdq-slide-ink"], background: t["--mdq-slide-glass"] };
    // Surfaces that hold text: page, panels, cards and (light) dialog and field.
    const surfaces = [t["--mdq-paper"], t["--mdq-paper-strong"], over(t["--mdq-card"], t["--mdq-paper"]), t["--mdq-card-strong"], t["--mdq-dialog"], t["--mdq-field"]]
      .filter(Boolean)
      .map((value) => (typeof value === "string" ? solid(value) : value)) as Rgb[];
    const slideSurfaces = [...slideStops, t["--mdq-slide-glass"]].map(solid);

    it("holds 4.5:1 for slide text and markers on both gradient stops and the glass panel", () => {
      const tokens = [
        "--mdq-slide-heading", "--mdq-slide-ink", "--mdq-slide-ink-soft", "--mdq-slide-eyebrow", "--mdq-slide-accent",
        "--mdq-slide-accent-strong", "--mdq-slide-accent-warm", "--mdq-slide-accent-cool", "--mdq-slide-blue",
        "--mdq-slide-scene", "--mdq-slide-maroon", "--mdq-note-attendee", "--mdq-note-presenter",
      ];
      for (const token of tokens) {
        for (const bg of slideSurfaces) expectRatio(`${mode} ${token} ${t[token]}`, solid(t[token]), bg, 4.5);
      }
      const gradient = declarations(ruleBody(css, `${selector} .slide-surface`)).background;
      expect(gradient).toContain(t["--mdq-slide-bg"]);
      expect(gradient).toContain(t["--mdq-slide-bg-soft"]);
    });

    it("holds 4.5:1 for slide notes on their tints and status pills on their fills", () => {
      for (const bg of slideStops.map(solid)) {
        const attendeeBg = over(t["--mdq-note-attendee-tint"], `#${bg.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`);
        const presenterBg = over(t["--mdq-note-presenter-tint"], `#${bg.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`);
        expectRatio(`${mode} attendee note`, solid(t["--mdq-note-attendee"]), attendeeBg, 4.5);
        expectRatio(`${mode} presenter note`, solid(t["--mdq-note-presenter"]), presenterBg, 4.5);
      }
      const pillText = (token: string): string => (mode === "light" ? t[token.replace("-text", "-ink")] : t[token]);
      for (const kind of ["success", "warning"]) {
        for (const bg of slideStops) {
          const pillBg = over(t[`--mdq-${kind}-soft`], bg);
          const hex = `#${pillBg.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
          expectRatio(`${mode} ${kind} pill`, solid(pillText(`--mdq-${kind}-text`)), solid(hex), 4.5);
        }
      }
    });

    it("keeps code blocks and bold text at 4.5:1", () => {
      expectRatio(`${mode} code`, solid(codeBody.color), solid(codeBody.background), 4.5);
      const questionCode = codeBody;
      expectRatio(`${mode} question code`, solid(questionCode.color), solid(questionCode.background), 4.5);
      const strong = declarations(ruleBody(css, `${selector} .slide-surface .quiz-html strong`)).color;
      for (const bg of slideStops) expectRatio(`${mode} strong`, solid(strong), solid(bg), 4.5);
      if (mode === "dark") expect(ruleBody(css, `${selector} body`)).toContain(t["--mdq-paper"]);
      expect(t.background).toBe(t["--mdq-paper"]);
    });

    it("holds 4.5:1 for control text on every surface", () => {
      const tokens = [
        "--mdq-ink", "--mdq-ink-strong", "--mdq-ink-soft", "--mdq-muted", "--mdq-soft", "--mdq-accent-text",
        "--mdq-secondary-text", "--mdq-success-text", "--mdq-warning-text", "--mdq-danger-text", "--mdq-info-text",
      ];
      for (const token of tokens) {
        for (const bg of surfaces) expectRatio(`${mode} ${token} ${t[token]}`, solid(t[token]), bg, 4.5);
      }
    });

    it("holds 4.5:1 for ink on the tinted status and accent backgrounds", () => {
      const pairs: Array<[string, string]> = [
        ["--mdq-accent-ink", "--mdq-accent-soft-strong"], ["--mdq-accent-ink", "--mdq-accent-soft"],
        ["--mdq-success-ink", "--mdq-success-soft"], ["--mdq-warning-ink", "--mdq-warning-soft"],
        ["--mdq-danger-ink", "--mdq-danger-soft"], ["--mdq-info-ink", "--mdq-info-soft"],
      ];
      for (const [ink, soft] of pairs) {
        for (const surface of [t["--mdq-paper"], t["--mdq-card-strong"], t["--mdq-slide-bg"], t["--mdq-slide-bg-soft"]]) {
          const tint = over(t[soft], surface);
          expectRatio(`${mode} ${ink} on ${soft}`, solid(t[ink]), tint, 4.5);
        }
      }
      for (const wash of ["--mdq-accent-wash", "--mdq-success-wash", "--mdq-danger-wash"]) {
        if (!t[wash]) continue;
        const stops = t[wash].match(/#[0-9a-f]{6}/gi) ?? [];
        expect(stops).toHaveLength(2);
        const ink = wash.includes("accent") ? t["--mdq-accent-ink"] : wash.includes("success") ? t["--mdq-success-ink"] : t["--mdq-danger-ink"];
        for (const stop of stops) expectRatio(`${mode} ${wash}`, solid(ink), solid(stop), 4.5);
      }
    });

    it("holds 4.5:1 for the on-colour labels on their fills", () => {
      const fills: Array<[string, string]> = [
        ["--mdq-on-accent", "--mdq-accent"], ["--mdq-on-secondary", "--mdq-secondary"], ["--mdq-on-success", "--mdq-success"],
        ["--mdq-on-warning", "--mdq-warning"], ["--mdq-on-danger", "--mdq-danger"], ["--mdq-on-info", "--mdq-info"],
        ["--mdq-on-bar", "--mdq-bar"], ["--mdq-on-bar-muted", "--mdq-bar-muted"],
      ];
      for (const [on, fill] of fills) expectRatio(`${mode} ${on} on ${fill}`, solid(t[on]), solid(t[fill]), 4.5);
    });

    it("holds 3:1 for outlines, focus rings, state lines and the timer", () => {
      const pages = [t["--mdq-paper"], t["--mdq-paper-strong"], t["--mdq-slide-bg"], t["--mdq-slide-bg-soft"]].map(solid);
      // The dark dialog is #201d28 with a #292630 button fill in theme.css.
      const dialogs = mode === "dark" ? ["#201d28", "#292630"].map(solid) : [t["--mdq-dialog"], t["--mdq-field"]].map(solid);
      for (const page of pages) {
        for (const token of ["--mdq-timer-track", "--mdq-accent", "--mdq-control-border", "--mdq-timer-ok", "--mdq-timer-warn", "--mdq-timer-urgent", "--mdq-bar"]) {
          expectRatio(`${mode} ${token} on page`, solid(t[token]), page, 3);
        }
      }
      for (const surface of [...surfaces, ...dialogs]) {
        for (const token of ["--mdq-control-border", "--mdq-accent", "--mdq-danger-line", "--mdq-success-line", "--mdq-info-line"]) {
          expectRatio(`${mode} ${token} ${t[token]}`, solid(t[token]), surface, 3);
        }
      }
      // Selected options fill with the soft accent over the card and keep the accent outline.
      const selected = over(t["--mdq-accent-soft-strong"], t["--mdq-card-strong"]);
      expectRatio(`${mode} selected outline`, solid(t["--mdq-accent"]), selected, 3);
    });

    it("keeps the join QR link at 4.5:1 on the white panel", () => {
      const panels = `html[data-palette="${NAME}"][data-theme="dark"] .instructor-qr-panel,\nhtml[data-palette="${NAME}"][data-theme="light"] .instructor-qr-panel`;
      const link = declarations(ruleBody(css, panels))["--mdq-qr-link"];
      expectRatio(`${mode} QR link`, solid(link), solid("#ffffff"), 4.5);
      expect(themeCss).toContain("var(--mdq-qr-link");
    });
  });

  it("keeps the selection-mode card and chips at 4.5:1 in dark", () => {
    const t = declarations(ruleBody(css, DARK));
    for (const kind of ["single", "multi"]) {
      const card = declarations(ruleBody(css, `${DARK} .selection-mode-card-${kind}`));
      const start = card.background.match(/#[0-9a-f]{6}/gi) ?? [];
      expect(start.length).toBeGreaterThan(0);
      const chip = declarations(ruleBody(css, `${DARK} .selection-mode-chip-${kind}`));
      expectRatio(`${kind} chip`, solid(chip.color), solid(chip.background), 4.5);
      for (const stop of start) {
        expectRatio(`${kind} label`, solid(declarations(ruleBody(css, `${DARK} .selection-mode-label`)).color), solid(stop), 4.5);
        expectRatio(`${kind} text`, solid(declarations(ruleBody(css, `${DARK} .selection-mode-text`)).color), solid(stop), 4.5);
      }
    }
    expect(t["--mdq-accent"]).toBeDefined();
  });

  it("keeps the leaderboard rank colours at 4.5:1 on their row tint", () => {
    const rowText = (color: string, glass: string, alpha: number): void => {
      expectRatio(`rank ${color} on ${glass}`, solid(color), over(`rgba(${solid(color).join(",")},${alpha})`, glass), 4.5);
    };
    const dark = declarations(ruleBody(css, DARK));
    for (const rank of ["first", "second", "third", "standard"]) {
      const color = declarations(ruleBody(css, `${DARK} .leaderboard-row.rank-${rank}`))["--leaderboard-rank-color"];
      rowText(color, dark["--mdq-slide-glass"], 0.16);
    }
    // The viewer's own row washes the accent over the glass at 24 percent.
    const third = declarations(ruleBody(css, `${DARK} .leaderboard-row.leaderboard-row-highlight.rank-third`))["--leaderboard-rank-color"];
    for (const rank of ["first", "second", "third", "standard"]) {
      const color = rank === "third" ? third : declarations(ruleBody(css, `${DARK} .leaderboard-row.rank-${rank}`))["--leaderboard-rank-color"];
      const wash = over(`rgba(${solid(dark["--mdq-slide-accent"]).join(",")},0.24)`, dark["--mdq-slide-glass-strong"]);
      expectRatio(`highlighted ${rank}`, solid(color), wash, 4.5);
    }
    const light = declarations(ruleBody(css, LIGHT));
    for (const token of ["--mdq-rank-first", "--mdq-rank-second", "--mdq-rank-third"]) {
      rowText(light[token], light["--mdq-slide-glass"], 0.16);
      const wash = over(`rgba(${solid(light["--mdq-slide-accent"]).join(",")},0.24)`, light["--mdq-slide-glass-strong"]);
      expectRatio(`highlighted ${token}`, solid(light[token]), wash, 4.5);
    }
    const standard = declarations(ruleBody(css, `${LIGHT} .leaderboard-row.rank-standard`))["--leaderboard-rank-color"];
    rowText(standard, light["--mdq-slide-glass"], 0.16);
  });

  describe("print tokens", () => {
    const fnName = "renderCatppuccinTokens";
    const body = printSource.slice(printSource.indexOf(`function ${fnName}(`), printSource.indexOf("\n}\n", printSource.indexOf(`function ${fnName}(`)));
    const [lightPart, darkPart] = body.split("\n  return `");
    const grab = (part: string): Record<string, string> =>
      Object.fromEntries([...part.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

    it("defines tokens for both themes and the page background", () => {
      expect(body).toContain('if (theme === "light")');
      expect(printSource).toContain(`case "${NAME}":`);
      const light = grab(lightPart);
      const dark = grab(darkPart);
      for (const set of [light, dark]) {
        for (const key of ["page-bg", "ink", "body", "muted", "paper", "wash", "option-bg", "media-bg", "accent", "teal", "amber", "green", "reference"]) {
          expect(set[key]).toBeDefined();
        }
      }
      expect(printSource).toContain("(MIT,");
      const page = /case "catppuccin":\s*return theme === "dark" \? "(#[0-9a-f]{6})" : "(#[0-9a-f]{6})";/.exec(printSource);
      expect(page).not.toBeNull();
      expect(page![1]).toBe(dark["page-bg"]);
      expect(page![2]).toBe(light["page-bg"]);
    });

    it.each([["light"], ["dark"]])("holds 4.5:1 for %s print text on its surfaces", (mode) => {
      const set = grab(mode === "light" ? lightPart : darkPart);
      for (const surface of [set["page-bg"], set["paper"], set["wash"], set["option-bg"]]) {
        for (const key of ["ink", "body", "muted", "accent", "teal", "amber", "green", "reference"]) {
          expectRatio(`print ${mode} ${key} on ${surface}`, solid(set[key]), solid(surface), 4.5);
        }
      }
      expectRatio(`print ${mode} green on tint`, solid(set["green"]), over(set["green-soft"], set["paper"]), 4.5);
      expectRatio(`print ${mode} teal on tint`, solid(set["teal"]), over(set["teal-soft"], set["paper"]), 4.5);
      expectRatio(`print ${mode} amber on tint`, solid(set["amber"]), over(set["amber-soft"], set["paper"]), 4.5);
      expectRatio(`print ${mode} accent on tint`, solid(set["accent"]), over(set["accent-soft"], set["paper"]), 4.5);
    });
  });
});
