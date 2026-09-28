import fs from "fs";
import path from "path";

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
    const timer = read("components/Timer.tsx");
    expect(timer).toContain("const fitFontSize = (0.8 * (size - 20)) / (label.length * 0.6);");
    expect(timer).toContain("Math.min(");
  });
});
