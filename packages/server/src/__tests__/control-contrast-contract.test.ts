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
});
