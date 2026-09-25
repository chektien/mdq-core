import fs from "fs";
import path from "path";

const css = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "..", "client", "src", "index.css"),
  "utf-8",
);
const start = css.indexOf("/* Reading typography for long fold-out notes.");
const block = css.slice(start, css.indexOf(".slide-counter {", start));
const selectors = [...block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^}]*\}/g)]
  .flatMap((match) => match[1].split(","))
  .map((selector) => selector.trim())
  .filter(Boolean);

describe("fold-out note reading typography", () => {
  it("exists and is scoped to the note body only", () => {
    expect(start).toBeGreaterThan(0);
    expect(selectors.length).toBeGreaterThan(20);
    for (const selector of selectors) expect(selector).toMatch(/^\.foldout-note-body(\s|>|:|$)/);
    expect(block).not.toMatch(/!important|@import|url\(/);
  });

  it("restores headings, list markers and a bracketed reference list", () => {
    expect(block).toContain("list-style: disc");
    expect(block).toContain("list-style: decimal");
    expect(block).toMatch(/\.foldout-note-body h3 \{\s*font-size: 1\.12em;/);
    expect(block).toMatch(/\.foldout-note-body > ol:last-child > li::marker \{\s*content: "\[" counter\(list-item\) "\] {2}";/);
  });

  it("takes colours from slide tokens so every theme applies", () => {
    const colours = [...block.matchAll(/(?:^|[\s;])(?:color|background|border-left|border-top):\s*([^;]+);/g)].map((match) => match[1]);
    expect(colours.length).toBeGreaterThan(3);
    for (const value of colours) expect(value).toMatch(/var\(--mdq-slide-[a-z-]+\)/);
  });
});
