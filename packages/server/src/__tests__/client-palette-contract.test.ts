import fs from "fs";
import path from "path";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string =>
  fs.readFileSync(path.join(clientSrc, rel), "utf-8");

const GRUVBOX_DARK = 'html[data-palette="gruvbox"]:not([data-theme="light"])';
const GRUVBOX_LIGHT = 'html[data-palette="gruvbox"][data-theme="light"]';

/** Return the declarations of the first rule whose selector list is exactly `selector`. */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing rule: ${selector}`);
  const open = css.indexOf("{", start);
  return css.slice(open + 1, css.indexOf("}", open));
}

function declarations(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+|[a-z-]+)\s*:\s*([^;]+);/g)) {
    result[match[1]] = match[2].trim();
  }
  return result;
}

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("client slide palette contract", () => {
  describe("per-deck palette application", () => {
    const theme = read("theme.ts");
    const app = read("App.tsx");
    const main = read("main.tsx");
    const instructor = read("views/InstructorView.tsx");
    const student = read("views/StudentView.tsx");
    const presentation = read("views/PresentationView.tsx");
    const socket = read("hooks/useSocket.ts");

    it("normalizes and applies only supported palettes, defaulting to classic", () => {
      expect(theme).toContain('DEFAULT_CLIENT_PALETTE: DeckPalette = "classic"');
      expect(theme).toContain('palette === "classic" || palette === "gruvbox"');
      expect(theme).toContain("document.documentElement.dataset.palette = resolved");
    });

    it("applies the runtime palette before and after the app mounts", () => {
      expect(main).toContain("applyClientPalette(runtimeConfig.palette)");
      expect(app).toContain("resolveClientPalette(runtimeConfig.palette)");
      expect(app).toContain("applyClientPalette(defaultPalette)");
    });

    it("applies deck palettes to instructor, student, and projector views", () => {
      expect(instructor).toContain("applyClientPalette(sessionPalette ?? selectedDeck?.palette, defaultPalette)");
      expect(student).toContain("resolveClientPalette(data.palette, defaultPalette)");
      expect(student).toContain("applyClientPalette(sessionPalette, defaultPalette)");
      expect(presentation).toContain("applyClientPalette(meta?.palette, defaultPalette)");
    });

    it("retains the deck palette across student socket reconnection", () => {
      expect(socket).toContain("sessionPalette?: DeckPalette");
      expect(socket).toContain("sessionPalette: existing.sessionPalette");
      expect(student).toContain("sessionPalette: resolvedPalette");
      expect(student).toContain("resolveClientPalette(stored.sessionPalette, defaultPalette)");
    });
  });

  describe("gruvbox slide palette CSS", () => {
    const css = read("index.css");
    const themeCss = read("theme.css");
    const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const paletteRules = [...cssWithoutComments.matchAll(/([^{}]*data-palette[^{}]*)\{([^}]*)\}/g)];

    it("defines gruvbox rules for both themes", () => {
      for (const selector of [
        GRUVBOX_DARK,
        `${GRUVBOX_DARK} body`,
        `${GRUVBOX_DARK} .slide-surface`,
        GRUVBOX_LIGHT,
        `${GRUVBOX_LIGHT} .slide-surface`,
      ]) {
        expect(css).toContain(`${selector} {`);
      }
      expect(css).toContain(`${GRUVBOX_DARK} .slide-surface .quiz-html code,\n${GRUVBOX_DARK} .slide-surface .quiz-html pre {`);
      expect(css).toContain(`${GRUVBOX_LIGHT} .slide-surface .quiz-html code,\n${GRUVBOX_LIGHT} .slide-surface .quiz-html pre {`);
      expect(declarations(ruleBody(css, `${GRUVBOX_DARK} .slide-surface`)).background)
        .toBe("linear-gradient(180deg, #32302f 0%, #282828 100%)");
      expect(declarations(ruleBody(css, `${GRUVBOX_LIGHT} .slide-surface`)).background)
        .toBe("linear-gradient(180deg, #eff0ec 0%, #e3e5e0 100%)");
    });

    it("credits the upstream Gruvbox palette", () => {
      expect(css).toContain("morhetz/gruvbox");
    });

    it("never uses !important in palette rules", () => {
      expect(paletteRules.length).toBeGreaterThan(0);
      for (const [, , body] of paletteRules) {
        expect(body).not.toContain("!important");
      }
    });

    it("adds no rules for the classic palette", () => {
      expect(css).not.toMatch(/data-palette="classic"/);
      expect(themeCss).not.toMatch(/data-palette/);
      for (const [, selector] of paletteRules) {
        expect(selector).toContain('data-palette="gruvbox"');
      }
    });

    it("out-ranks the classic theme rules by specificity rather than !important", () => {
      // The classic rules these override: html[data-theme="light"] .slide-surface
      // (0,2,1) and theme.css html[data-theme] .quiz-html code (0,2,2). Every
      // gruvbox selector carries two attribute tests on html, so it wins.
      expect(css).toContain('html[data-theme="light"] .slide-surface {');
      expect(themeCss).toContain('html[data-theme="light"] .quiz-html code,');
      expect(themeCss).toContain('html[data-theme="dark"] .quiz-html code,');
      for (const [, selectorList] of paletteRules) {
        for (const selector of selectorList.split(",").map((part) => part.trim()).filter(Boolean)) {
          const attributeTests = selector.match(/\[data-(?:palette|theme)=/g) ?? [];
          expect(attributeTests.length).toBe(2);
        }
      }
    });

    const TEXT_TOKENS = [
      "--mdq-slide-heading",
      "--mdq-slide-ink",
      "--mdq-slide-ink-soft",
      "--mdq-slide-eyebrow",
      "--mdq-slide-accent",
      "--mdq-slide-accent-strong",
      "--mdq-slide-accent-warm",
      "--mdq-slide-accent-cool",
      "--mdq-slide-blue",
      "--mdq-slide-scene",
      "--mdq-slide-maroon",
      "--mdq-note-attendee",
      "--mdq-note-presenter",
    ];

    it.each([
      ["dark", GRUVBOX_DARK],
      ["light", GRUVBOX_LIGHT],
    ])("gruvbox %s text and marker colours meet 4.5:1 on both gradient stops", (_mode, selector) => {
      const tokens = declarations(ruleBody(css, selector));
      const backgrounds = [tokens["--mdq-slide-bg"], tokens["--mdq-slide-bg-soft"]];
      expect(backgrounds.every((value) => /^#[0-9a-f]{6}$/i.test(value))).toBe(true);
      for (const token of TEXT_TOKENS) {
        const color = tokens[token];
        expect(color).toMatch(/^#[0-9a-f]{6}$/i);
        for (const background of backgrounds) {
          const ratio = contrast(color, background);
          if (ratio < 4.5) {
            throw new Error(`${selector} ${token} ${color} on ${background} is ${ratio.toFixed(2)}:1`);
          }
        }
      }
    });

    it.each([
      ["dark", GRUVBOX_DARK],
      ["light", GRUVBOX_LIGHT],
    ])("gruvbox %s code blocks keep 4.5:1 ink on their panel", (_mode, selector) => {
      const body = ruleBody(css, `${selector} .slide-surface .quiz-html code,\n${selector} .slide-surface .quiz-html pre`);
      const { background, color } = declarations(body);
      expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
    });

    it.each([
      ["dark", GRUVBOX_DARK],
      ["light", GRUVBOX_LIGHT],
    ])("gruvbox %s bold text overrides the theme colour and keeps 4.5:1", (_mode, selector) => {
      const { color } = declarations(ruleBody(css, `${selector} .slide-surface .quiz-html strong`));
      const tokens = declarations(ruleBody(css, selector));
      for (const background of [tokens["--mdq-slide-bg"], tokens["--mdq-slide-bg-soft"]]) {
        expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
});
