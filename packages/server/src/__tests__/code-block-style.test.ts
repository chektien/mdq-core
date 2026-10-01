import fs from "fs";
import path from "path";
import { parseQuizMarkdown } from "../parser";
import { buildHtml } from "../print-mdq";

const client = path.resolve(__dirname, "../../../client/src");
const css = fs.readFileSync(path.join(client, "index.css"), "utf8");
const theme = fs.readFileSync(path.join(client, "theme.css"), "utf8");
const rule = (source: string, selector: string): string => {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const found = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selectors]) => selectors.trim() === selector.trim());
  if (!found) throw new Error(`Missing ${selector}`);
  return found[2];
};
const reset = (body: string): void => {
  for (const declaration of ["background: none;", "border: 0;", "padding: 0;", "border-radius: 0;", "color: inherit;"]) {
    expect(body).toContain(declaration);
  }
};

it("keeps one fenced panel; every colour/border rule excludes its code child", () => {
  reset(rule(css, ".quiz-html pre code"));
  // The old palette selectors beat the reset and painted a second box.
  for (const sheet of [css, theme]) {
    const bare = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selectors, body] of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/\.quiz-html code(?:\s*[,{}]|\s*$)/.test(selectors)) {
        expect(body).not.toMatch(/(?:background|border|padding|border-radius)\s*:/);
      }
    }
  }
  expect(rule(css, ".quiz-html :not(pre) > code")).toContain("font-size: 0.9em;");
  expect(rule(css, ".quiz-html")).toContain("min-width: 0;");
  const pre = rule(css, ".quiz-html pre");
  for (const declaration of ["box-sizing: border-box;", "min-width: 0;", "max-width: 100%;", "overflow-x: auto;", "tab-size: 2;", "font-size: var(--mdq-code-size);", "padding: var(--mdq-code-padding);"]) {
    expect(pre).toContain(declaration);
  }
  expect(css).toContain("--mdq-code-padding: 0.7em 1em;");
  expect(css).toContain("--mdq-code-line-height: 1.45;");
});

const palettes = ["classic", "gruvbox", "rose-pine", "catppuccin", "seoul256", "ayu", "tokyo-night"] as const;
const quiz = parseQuizMarkdown("# Sample\n\n---\n\n## Code\n\ntype: slide\n\nInline `value`.\n\n```js\nconst value = 1;\n```\n", "sample.md").quiz!;
const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

it.each(palettes)("prints %s code light, readable and wrapping even on a dark deck", (palette) => {
  for (const theme of ["light", "dark"] as const) {
    const html = buildHtml(quiz, { inputFile: "/tmp/sample.md", outputFile: "/tmp/sample.pdf", imagesDir: "/tmp",
      includeFoldouts: true, includePresenterNotes: true, includeAnswers: true, pageSize: "A4", theme, palette });
    expect(html).toContain('<pre><code class="language-js">');
    reset(rule(html, "    pre code"));
    const pre = rule(html, "    pre");
    expect(pre).toContain("white-space: pre-wrap;");
    expect(pre).toContain("overflow-wrap: anywhere;");
    expect(pre).toContain("overflow: visible;");
    const bg = luminance(html.match(/--mdq-code-bg: (#[\da-f]{6});/)![1]);
    const ink = luminance(html.match(/--mdq-code-ink: (#[\da-f]{6});/)![1]);
    expect(bg).toBeGreaterThan(0.6);
    expect((bg + 0.05) / (ink + 0.05)).toBeGreaterThanOrEqual(4.5);
  }
});
