import fs from "fs";
import path from "path";
import { labelFitsInBar } from "../../../client/src/components/distributionLabel";
import { timerFontSize, timerLabel } from "../../../client/src/components/timerLabel";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string =>
  fs.readFileSync(path.join(clientSrc, rel), "utf-8");

const ruleBody = (css: string, selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
};

function tokens(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing rule: ${selector}`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--mdq-[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("control contrast contract", () => {
  const index = read("index.css");
  const theme = read("theme.css");

  it("keeps disabled toolbar buttons at full opacity with the soft ink", () => {
    const disabled = ruleBody(index, ".slide-action-button:disabled");
    expect(disabled).not.toMatch(/opacity/);
    expect(disabled).toContain("color: var(--mdq-slide-ink-soft)");
    expect(disabled).toContain("border-style: dashed");
    expect(index).not.toMatch(/\.slide-nav-button:disabled\s*\{[^}]*opacity/);
  });

  it("outlines toolbar buttons in solid theme colours", () => {
    expect(index).toMatch(/\.slide-action-button,\s*\.slide-fullscreen-button\s*\{\s*border-color: var\(--mdq-control-border/);
    expect(ruleBody(index, ".slide-action-button-primary")).toContain("border-color: var(--mdq-slide-accent)");
    expect(ruleBody(index, ".slide-action-button-danger")).toContain("border-color: var(--mdq-danger-line");
    expect(index).toContain('html[data-theme="light"] .slide-action-button-warning');
    expect(index).toMatch(/html\[data-theme="dark"\] button\.open-response-entry \{\s*border-color: var\(--mdq-control-border\) !important/);
  });

  it("shows entered field values in the ink colour, not the placeholder colour", () => {
    expect(theme).toMatch(/:is\(input, textarea\)\[class\*="placeholder:text-zinc"\] \{\s*color: var\(--mdq-ink\) !important/);
  });

  it("keeps the open segment on loading spinners", () => {
    expect(theme).toMatch(/\.animate-spin\[class\*="border-t-transparent"\] \{[^}]*border-top-color: transparent !important/);
  });

  it("sizes the timer count to fit inside the ring", () => {
    expect(timerLabel(119)).toBe("1:59");
    expect(timerLabel(59)).toBe("59");
    // The student ring shrinks m:ss to fit, the projector sizes keep theirs.
    expect(timerFontSize(64, "1:59")).toBeCloseTo(14.67, 2);
    expect(timerFontSize(64, "59")).toBeCloseTo(20.48, 2);
    expect(timerFontSize(120, "1:59")).toBeCloseTo(31.2, 2);
    expect(timerFontSize(140, "5:00")).toBeCloseTo(36.4, 2);
    expect(timerFontSize(64, "10:00")).toBeLessThan(timerFontSize(64, "1:59"));
  });

  it("keeps a disabled warning button on the control outline in light themes", () => {
    expect(ruleBody(index, 'html[data-theme="light"] .slide-action-button-warning:disabled')).toContain("border-color: var(--mdq-control-border)");
  });

  it("lightens third place on the viewer's own row in dark themes", () => {
    expect(ruleBody(index, 'html:not([data-theme="light"]) .leaderboard-row.leaderboard-row-highlight.rank-third')).toContain("--leaderboard-rank-color: #ffa552");
  });

  it("draws a narrow distribution share at its true length with the count outside", () => {
    expect(ruleBody(theme, "html[data-theme] .dist-bar")).not.toMatch(/min-width/);
    // A 2 percent share of a 320 px track is 6.4 px; its "1 (2%)" count cannot fit inside.
    expect(labelFitsInBar(320, 2, 44)).toBe(false);
    expect(labelFitsInBar(320, 100, 70)).toBe(true);
    expect(labelFitsInBar(320, 21, 44)).toBe(false);
    expect(labelFitsInBar(320, 22, 44)).toBe(true);
    expect(ruleBody(theme, "html[data-theme] .dist-bar-track .dist-bar-label-outside")).toContain("color: var(--mdq-ink)");
  });

  describe("focus rings, the Keep Session outline and the timer track hold 3:1", () => {
    const darkBase = tokens(theme, 'html[data-theme="dark"]');
    const lightBase = tokens(theme, 'html[data-theme="light"]');
    const combos = [
      // Pages and panels measured in each combination; the dark dialog card is #201d28 with a #292630 button fill.
      { name: "dark classic", t: darkBase, pages: ["#262625", "#2d2d2b"], dialog: ["#201d28", "#292630"] },
      { name: "dark gruvbox", t: { ...darkBase, ...tokens(index, 'html[data-palette="gruvbox"]:not([data-theme="light"])') },
        pages: ["#282828", "#32302f"], dialog: ["#201d28", "#292630"] },
      { name: "light classic", t: lightBase, pages: ["#ffffff", "#fffaf1", "#fffaf3", "#f7f1e3", "#f3ecdc"], dialog: [] as string[] },
      { name: "light gruvbox", t: { ...lightBase, ...tokens(index, 'html[data-palette="gruvbox"][data-theme="light"]') },
        pages: ["#eff0ec", "#e3e5e0", "#fbfbf9", "#f7f8f5"], dialog: [] as string[] },
    ];

    for (const { name, t, pages, dialog } of combos) {
      it(name, () => {
        const dialogSurfaces = dialog.length ? dialog : [t["--mdq-dialog"], t["--mdq-field"]];
        for (const page of pages) {
          expect(contrast(t["--mdq-timer-track"], page)).toBeGreaterThanOrEqual(3);
          expect(contrast(t["--mdq-accent"], page)).toBeGreaterThanOrEqual(3);
        }
        for (const surface of dialogSurfaces) {
          expect(contrast(t["--mdq-control-border"], surface)).toBeGreaterThanOrEqual(3);
          expect(contrast(t["--mdq-accent"], surface)).toBeGreaterThanOrEqual(3);
        }
      });
    }

    it("uses those tokens for the Keep Session outline and the focus rings", () => {
      expect(ruleBody(theme, "html[data-theme] .end-session-keep")).toContain("border-color: var(--mdq-control-border)");
      expect(ruleBody(theme, 'html[data-theme="light"] .end-session-keep')).toContain("border-color: var(--mdq-control-border)");
      const focus = ruleBody(theme, "html[data-theme] :is(.end-session-keep, .end-session-end):focus-visible");
      expect(focus).toContain("outline: 2px solid var(--mdq-accent) !important");
      expect(focus).toContain("outline-offset: 3px");
      expect(theme).toContain('html[data-theme] :is(input, textarea)[class*="focus:ring-"]:focus-visible,\nhtml[data-theme] .option-btn:focus-visible,');
    });
  });
});
