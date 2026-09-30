import fs from "fs";
import path from "path";
import { parseQuizMarkdown } from "../parser";

const css = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "..", "client", "src", "index.css"),
  "utf-8",
);
const printSource = fs.readFileSync(path.resolve(__dirname, "..", "print-mdq.ts"), "utf-8");

const start = css.indexOf("/* Slide lists.");
const block = css.slice(start, css.indexOf(".slide-surface .quiz-html strong {", start));

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(new RegExp(`(?:^|\\n\\n|\\*/\\n)${escaped} \\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing rule: ${selector}`);
  return match[1];
}

const deck = `# Lists

---

## Nested

type: slide

- **Plan** the week
  - Book the room
    - Attach the map
-
- Review

1. First
   - Detail
2. Second
   1. Sub one

---
`;

describe("slide list styling", () => {
  it("renders nested lists, numbered lists and an empty item as plain list markup", () => {
    const result = parseQuizMarkdown(deck, "lists.md");
    expect(result.errors).toEqual([]);
    const html = result.quiz!.questions[0].textHtml;
    expect(html).toContain("<li></li>");
    expect(html).toMatch(/<li><strong>Plan<\/strong> the week<ul>/);
    expect(html).toMatch(/<li>First<ul>\s*<li>Detail<\/li>/);
    expect(html).toMatch(/<li>Second<ol>\s*<li>Sub one<\/li>/);
  });

  it("gives the list block a marker and indent scheme of its own", () => {
    expect(start).toBeGreaterThan(0);
    expect(block).not.toMatch(/!important|@import|url\(/);
  });

  it("uses one accent marker at the top level with no nth-child colour cycling", () => {
    expect(block).not.toMatch(/nth-child/);
    expect(rule(".slide-body li::marker")).toContain("color: var(--mdq-slide-accent)");
  });

  it("quiets child markers with an existing token, smaller than the top level", () => {
    const child = rule(".slide-body li li::marker");
    expect(child).toContain("color: var(--mdq-slide-ink-soft)");
    const size = (text: string) => Number(/font-size: ([\d.]+)em/.exec(text)![1]);
    expect(size(child)).toBeLessThan(size(rule(".slide-body li::marker")));
    expect(size(rule(".slide-body li li > ul > li::marker"))).toBeLessThan(size(child));
  });

  it("marks levels with different shapes in unordered lists and keeps numbers in ordered lists", () => {
    expect(rule(".slide-body ul")).toContain("list-style: disc");
    expect(rule(".slide-body ol")).toContain("list-style: decimal");
    expect(rule(".slide-body li > ul")).toContain("list-style-type: circle");
    expect(rule(".slide-body li li > ul")).toContain("list-style-type: square");
    expect(block).not.toMatch(/\.slide-body (?:li > )?ol \{[^}]*list-style-type:\s*(?!decimal)/);
  });

  it("keeps child text at or above 0.9 of the body size", () => {
    const step = Number(/font-size: ([\d.]+)em/.exec(rule(".slide-body li > ul,\n.slide-body li > ol"))![1]);
    expect(step * step).toBeGreaterThanOrEqual(0.9);
    expect(rule(".slide-body li li li > ul,\n.slide-body li li li > ol")).toContain("font-size: 1em");
  });

  it("indents every level by the same amount and keeps wrapped lines under the item text", () => {
    const indent = /padding-left: ([\d.]+)em/.exec(rule(".slide-body ul,\n.slide-body ol"))![1];
    expect(Number(indent)).toBeLessThanOrEqual(1.4);
    expect(block).not.toMatch(/\.slide-body li > (?:ul|ol)[^{]*\{[^}]*padding-left/);
    expect(rule(".slide-body li")).toContain("padding: 0");
    expect(css).not.toMatch(/\.slide-body li \{\s*padding-left/);
    expect(block).not.toMatch(/list-style-position:\s*inside/);
  });

  it("separates top-level items more than an item and its children", () => {
    const em = (text: string, name: string) => Number(new RegExp(`${name}: ([\\d.]+)em`).exec(text)![1]);
    const top = em(rule(".slide-body ul,\n.slide-body ol"), "--mdq-list-gap");
    const child = em(rule(".slide-body li > ul,\n.slide-body li > ol"), "--mdq-list-gap");
    expect(top).toBeGreaterThanOrEqual(child * 2);
  });

  it("hides an item with no text instead of showing a bare marker", () => {
    expect(rule(".slide-body li:empty")).toContain("display: none");
  });

  it("hides empty items in the printed deck too", () => {
    expect(printSource).toMatch(/\.body-copy li:empty \{\s*display: none;/);
  });
});
