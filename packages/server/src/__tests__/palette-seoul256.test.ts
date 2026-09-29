import fs from "fs";
import path from "path";

// Contrast contract for the seoul256 palette: both blocks exist, the upstream is
// credited, text holds 4.5:1 on every surface it sits on, filled controls hold
// their label at 4.5:1, and boundaries, focus and selected colours hold 3:1.

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const index = fs.readFileSync(path.join(clientSrc, "index.css"), "utf-8");
const theme = fs.readFileSync(path.join(clientSrc, "theme.css"), "utf-8");
const printSource = fs.readFileSync(path.resolve(__dirname, "..", "print-mdq.ts"), "utf-8");

const NAME = "seoul256";
const DARK = `html[data-palette="${NAME}"]:not([data-theme="light"])`;
const LIGHT = `html[data-palette="${NAME}"][data-theme="light"]`;

type Tokens = Record<string, string>;

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing rule: ${selector}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

function tokens(css: string, selector: string): Tokens {
  return Object.fromEntries(
    [...ruleBody(css, selector).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (values: number[]): string =>
  `#${values.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => v / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Paint a hex or rgba() colour over an opaque hex background. */
function over(fg: string, bg: string): string {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(fg);
  if (!m) return fg;
  const alpha = Number(m[4]);
  const back = channels(bg);
  return toHex([Number(m[1]), Number(m[2]), Number(m[3])].map((v, i) => v * alpha + back[i] * (1 - alpha)));
}

const hex = (value: string | undefined, label: string): string => {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`${label} is not a hex colour: ${value}`);
  return value;
};

const printBlock = (fn: string, next: string): string =>
  printSource.slice(printSource.indexOf(`function ${fn}`), printSource.indexOf(`function ${next}`));

describe("seoul256 palette", () => {
  const dark: Tokens = { ...tokens(theme, 'html[data-theme="dark"]'), ...tokens(index, DARK) };
  const light: Tokens = { ...tokens(theme, 'html[data-theme="light"]'), ...tokens(index, LIGHT) };
  // The dark end-session dialog keeps the classic dark card in every palette.
  const darkDialog = ["#201d28", "#292630"];

  it("defines a dark block, which also applies when data-theme is absent, and a light block", () => {
    expect(index).toContain(`${DARK} {`);
    expect(index).toContain(`${LIGHT} {`);
    expect(dark["--mdq-slide-bg"]).toBe("#4b4b4b");
    expect(light["--mdq-slide-bg"]).toBe("#e1e1e1");
  });

  it("credits the upstream palette and names its adjusted shades", () => {
    const start = index.indexOf(`deck palette: ${NAME})`);
    const header = index.slice(start, index.indexOf(DARK, start));
    expect(header).toContain("junegunn/seoul256.vim");
    expect(header).toContain("MIT");
    expect(header).toMatch(/#[0-9a-f]{6} to #[0-9a-f]{6}/);
  });

  it("sets every token the gruvbox blocks set", () => {
    const names = (selector: string): string[] => Object.keys(tokens(index, selector)).sort();
    expect(names(DARK)).toEqual(names('html[data-palette="gruvbox"]:not([data-theme="light"])'));
    expect(names(LIGHT)).toEqual(names('html[data-palette="gruvbox"][data-theme="light"]'));
  });

  it("adds no !important and only rules keyed on this palette", () => {
    const own = [...index.matchAll(new RegExp(`^html\\[data-palette="${NAME}"\\][^{]*\\{[^}]*\\}`, "gm"))].map((m) => m[0]);
    expect(own.length).toBeGreaterThan(20);
    for (const rule of own) expect(rule).not.toContain("!important");
  });

  for (const mode of ["dark", "light"] as const) {
    describe(mode, () => {
      const t = mode === "dark" ? dark : light;
      const selector = mode === "dark" ? DARK : LIGHT;
      const c = (name: string): string => hex(t[name], `${mode} ${name}`);
      const slide = [c("--mdq-slide-bg"), c("--mdq-slide-bg-soft")];
      const paper = c("--mdq-paper");
      const card = over(t["--mdq-card"], paper);
      const surfaces: Record<string, string> = {
        paper,
        "paper-strong": c("--mdq-paper-strong"),
        card,
        "card-strong": c("--mdq-card-strong"),
        ...(mode === "light" ? { field: c("--mdq-field"), dialog: c("--mdq-dialog") } : {}),
      };
      const surfaceEntries = Object.entries(surfaces);
      const controlSurfaces = mode === "dark" ? [...Object.values(surfaces), ...darkDialog] : Object.values(surfaces);

      it("keeps body, muted and soft text at 4.5:1 on every surface and slide stop", () => {
        for (const name of ["--mdq-ink", "--mdq-ink-soft", "--mdq-ink-strong", "--mdq-muted", "--mdq-soft"]) {
          for (const [label, surface] of [...surfaceEntries, ["slide", slide[0]], ["slide-soft", slide[1]]]) {
            expect([name, label, contrast(c(name), surface) >= 4.5]).toEqual([name, label, true]);
          }
        }
      });

      it("keeps slide text and markers at 4.5:1 on both gradient stops and the glass panel", () => {
        const slideTokens = [
          "--mdq-slide-heading", "--mdq-slide-ink", "--mdq-slide-ink-soft", "--mdq-slide-eyebrow", "--mdq-slide-accent",
          "--mdq-slide-accent-strong", "--mdq-slide-accent-warm", "--mdq-slide-accent-cool", "--mdq-slide-blue",
          "--mdq-slide-scene", "--mdq-slide-maroon", "--mdq-note-attendee", "--mdq-note-presenter",
        ];
        for (const name of slideTokens) {
          for (const stop of slide) expect([name, stop, contrast(c(name), stop) >= 4.5]).toEqual([name, stop, true]);
        }
        const glass = c("--mdq-slide-glass");
        for (const name of ["--mdq-slide-ink", "--mdq-slide-ink-soft", "--mdq-slide-eyebrow", "--mdq-slide-accent"]) {
          expect([name, contrast(c(name), glass) >= 4.5]).toEqual([name, true]);
        }
      });

      it("keeps status text at 4.5:1 on surfaces and on its own tint, and each label on its fill", () => {
        for (const role of ["accent", "secondary", "success", "warning", "danger", "info"]) {
          const text = c(`--mdq-${role}-text`);
          const soft = t[`--mdq-${role}-soft`];
          for (const [label, surface] of [...surfaceEntries, ["slide", slide[0]], ["slide-soft", slide[1]]]) {
            expect([role, label, contrast(text, surface) >= 4.5]).toEqual([role, label, true]);
            if (role !== "accent") {
              expect([role, "tint", label, contrast(text, over(soft, surface)) >= 4.5]).toEqual([role, "tint", label, true]);
            }
          }
          const ink = t[`--mdq-${role}-ink`];
          if (ink) {
            for (const [label, surface] of surfaceEntries) {
              expect([role, "ink", label, contrast(hex(ink, role), over(soft, surface)) >= 4.5]).toEqual([role, "ink", label, true]);
            }
          }
          expect([role, "label", contrast(c(`--mdq-on-${role}`), c(`--mdq-${role}`)) >= 4.5]).toEqual([role, "label", true]);
        }
        expect(contrast(c("--mdq-on-bar"), c("--mdq-bar"))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c("--mdq-on-bar-muted"), c("--mdq-bar-muted"))).toBeGreaterThanOrEqual(4.5);
      });

      it("keeps control boundaries, the focus ring, selected states, poll bars and the timer at 3:1", () => {
        const boundary = [
          "--mdq-control-border", "--mdq-accent", "--mdq-danger-line", "--mdq-info-line", "--mdq-success-line",
          "--mdq-timer-ok", "--mdq-timer-warn", "--mdq-timer-urgent", "--mdq-timer-track", "--mdq-bar",
        ];
        for (const name of boundary) {
          for (const surface of controlSurfaces) expect([name, surface, contrast(c(name), surface) >= 3]).toEqual([name, surface, true]);
        }
        for (const surface of [...controlSurfaces, ...slide]) {
          expect(contrast(c("--mdq-timer-track"), surface)).toBeGreaterThanOrEqual(3);
        }
        for (const surface of Object.values(surfaces)) {
          expect(contrast(c("--mdq-bar-muted"), surface)).toBeGreaterThanOrEqual(3);
        }
      });

      it("keeps code, strong text and the QR link readable", () => {
        const codeRule = declarations(ruleBody(index, `${selector} .quiz-html code,\n${selector} .quiz-html pre`));
        expect(contrast(hex(codeRule.color, "code"), hex(codeRule.background, "code bg"))).toBeGreaterThanOrEqual(4.5);
        const strong = declarations(ruleBody(index, `${selector} .slide-surface .quiz-html strong`));
        for (const stop of slide) expect(contrast(hex(strong.color, "strong"), stop)).toBeGreaterThanOrEqual(4.5);
        const qr = tokens(
          index,
          `html[data-palette="${NAME}"][data-theme="dark"] .instructor-qr-panel,\nhtml[data-palette="${NAME}"][data-theme="light"] .instructor-qr-panel`,
        );
        expect(contrast(hex(qr["--mdq-qr-link"], "qr"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
      });

      it("keeps leaderboard ranks at 4.5:1 on their row, including the viewer's own row", () => {
        const rank = (name: string): string => {
          if (mode === "light") return hex(t[`--mdq-rank-${name}`] ?? t["--mdq-muted"], `rank ${name}`);
          return hex(declarations(ruleBody(index, `${selector} .leaderboard-row.rank-${name}`))["--leaderboard-rank-color"], name);
        };
        const glass = c("--mdq-slide-glass");
        const highlight = mode === "dark" ? over(`rgba(${channels(c("--mdq-accent")).join(", ")}, 0.24)`, c("--mdq-slide-glass-strong")) : over(`rgba(${channels(c("--mdq-accent")).join(", ")}, 0.07)`, c("--mdq-card-strong"));
        for (const name of ["first", "second", "third", "standard"]) {
          const color = rank(name);
          if (mode === "light" && name === "standard") continue;
          expect([name, contrast(color, over(`rgba(${channels(color).join(", ")}, 0.16)`, glass)) >= 4.5]).toEqual([name, true]);
          expect([name, "own row", contrast(color, highlight) >= 4.5]).toEqual([name, "own row", true]);
        }
      });
    });
  }

  it("has print tokens for both themes that mirror the live palette", () => {
    const print = printBlock("renderSeoul256Tokens", "renderAyuTokens");
    expect(print).not.toContain("TODO");
    expect(print).toContain("--page-bg: #4b4b4b;");
    expect(print).toContain("--page-bg: #e1e1e1;");
    expect(print).toContain(`--accent: ${dark["--mdq-accent-text"]};`);
    expect(print).toContain(`--accent: ${light["--mdq-accent-text"]};`);
    expect(print).toContain(`--green: ${dark["--mdq-success-text"]};`);
    expect(print).toContain(`--green: ${light["--mdq-success-text"]};`);
    expect(printSource).toContain(`case "${NAME}":\n      return theme === "dark" ? "#4b4b4b" : "#e1e1e1";`);
    const halves = {
      light: print.slice(print.indexOf('if (theme === "light")'), print.indexOf("\n  return `")),
      dark: print.slice(print.indexOf("\n  return `")),
    };
    for (const [label, half] of Object.entries(halves)) {
      const p = declarations(half);
      for (const name of ["--page-bg", "--ink", "--body", "--muted", "--paper", "--wash", "--accent", "--green", "--teal", "--amber"]) {
        expect([label, name, name in p]).toEqual([label, name, true]);
      }
      for (const name of ["--ink", "--body", "--muted", "--accent", "--green", "--teal", "--amber"]) {
        for (const surface of ["--page-bg", "--paper", "--wash"]) {
          expect([label, name, surface, contrast(hex(p[name], name), hex(p[surface], surface)) >= 4.5]).toEqual([label, name, surface, true]);
        }
      }
    }
  });
});

function declarations(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+|[a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
