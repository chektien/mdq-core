import fs from "fs";
import path from "path";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const index = fs.readFileSync(path.join(clientSrc, "index.css"), "utf-8");

const palettes = ["gruvbox", "rose-pine", "catppuccin", "seoul256", "ayu", "tokyo-night"] as const;
type Theme = "dark" | "light";

// Where each slide surface gradient ends: on the slide background or on the soft one.
const endsOnSoft = new Set([
  "gruvbox light", "rose-pine light", "catppuccin dark", "catppuccin light", "seoul256 dark", "ayu light", "tokyo-night dark",
]);

const body = (selector: string): string => {
  const start = index.indexOf(`${selector} {\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  return index.slice(start, index.indexOf("\n}\n", start));
};
const headerFor = (palette: string, theme: Theme): string =>
  theme === "dark"
    ? `html[data-palette="${palette}"]:not([data-theme="light"])`
    : `html[data-palette="${palette}"][data-theme="light"]`;
const token = (block: string, name: string): string => {
  const match = block.match(new RegExp(`${name}: (#[0-9a-f]{6});`));
  expect(match).not.toBeNull();
  return match![1];
};

describe("live page canvas", () => {
  const LIVE = ".slide-surface:not(.slide-surface-student)";

  it("paints the page canvas on the presenter and projector, not on phones", () => {
    expect(body(`html:root[data-theme]:has(${LIVE})`)).toContain("background: var(--mdq-slide-bg);");
    // The phone's own surface keeps the page's colours.
    expect(LIVE).toContain(":not(.slide-surface-student)");
  });

  it("uses each palette surface's own end colour, for all fourteen palette and theme pairs", () => {
    for (const palette of palettes) {
      for (const theme of ["dark", "light"] as const) {
        const tokens = body(headerFor(palette, theme));
        const gradient = body(`${headerFor(palette, theme)} .slide-surface`);
        const end = gradient.match(/linear-gradient\(180deg, #[0-9a-f]{6} 0%, (#[0-9a-f]{6}) 100%\)/)?.[1];
        const soft = endsOnSoft.has(`${palette} ${theme}`);
        expect(end).toBe(token(tokens, soft ? "--mdq-slide-bg-soft" : "--mdq-slide-bg"));
      }
    }
  });

  it("switches the canvas to the soft background for exactly the palettes that end on it", () => {
    const start = index.indexOf('html:root[data-palette="gruvbox"][data-theme="light"]:has(');
    expect(start).toBeGreaterThanOrEqual(0);
    const rule = index.slice(start, index.indexOf("\n}\n", start));
    expect(rule).toContain("background: var(--mdq-slide-bg-soft);");
    const expected = [
      'html:root[data-palette="gruvbox"][data-theme="light"]',
      'html:root[data-palette="rose-pine"][data-theme="light"]',
      'html:root[data-palette="ayu"][data-theme="light"]',
      'html:root[data-palette="catppuccin"][data-theme="light"]',
      'html:root[data-palette="catppuccin"]:not([data-theme="light"])',
      'html:root[data-palette="seoul256"]:not([data-theme="light"])',
      'html:root[data-palette="tokyo-night"]:not([data-theme="light"])',
    ];
    const selectors = rule.slice(0, rule.indexOf(" {\n")).split(",\n");
    expect(selectors.map((selector) => selector.replace(`:has(${LIVE})`, ""))).toEqual(expected);
  });

  it("says the home indicator is system UI a page cannot hide", () => {
    const sentence = "The home indicator itself is system UI that a page cannot hide.";
    expect(index).toContain(sentence);
    expect(fs.readFileSync(path.resolve(clientSrc, "..", "..", "..", "README.md"), "utf-8")).toContain(sentence);
  });
});
