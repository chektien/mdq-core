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
-
  - Only child

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

  it("marks an item that holds only a nested list, and leaves other items alone", () => {
    const html = parseQuizMarkdown(deck, "lists.md").quiz!.questions[0].textHtml;
    expect(html).toMatch(/<li class="list-parent-only"><ul>\s*<li>Only child<\/li>/);
    expect(html).toContain("<li><strong>Plan</strong> the week<ul>");
    expect(html.match(/list-parent-only/g)).toHaveLength(1);
  });

  it("gives the list block a marker and indent scheme of its own", () => {
    expect(start).toBeGreaterThan(0);
    expect(block).not.toMatch(/!important|@import|url\(/);
  });

  it("keeps --mdq-slide-bullet as the marker colour hook, accent at the top and muted below", () => {
    expect(block).not.toMatch(/nth-child/);
    expect(rule(".slide-body li::marker")).toContain("color: var(--mdq-slide-bullet)");
    expect(rule(":where(.slide-body li)")).toContain("--mdq-slide-bullet: var(--mdq-bullet-color, var(--mdq-slide-accent))");
    expect(rule(":where(.slide-body li li)")).toContain("--mdq-slide-bullet: var(--mdq-bullet-color, var(--mdq-slide-ink-soft))");
    // The defaults carry no specificity, so an override on li wins at every level.
    expect(block).not.toMatch(/\n\.slide-body li(?: li)? \{[^}]*--mdq-slide-bullet/);
  });

  it("makes overlay copy markers follow the overlay text colour", () => {
    const overlay = /\n\.slide-live-embed-copy li \{([^}]*)\}/.exec(css)![1];
    const text = /\.slide-live-embed-copy li,[^{]*\{\s*color: (rgba\([^)]*\));/.exec(css)![1];
    expect(overlay).toContain(`--mdq-slide-bullet: ${text}`);
  });

  it("shrinks bullets at each level and keeps numerals from shrinking below level 3's", () => {
    // A marker reads the deck's bullet-size setting and falls back to Core's own size scaled by bullet-size presets.
    const size = (selector: string) => Number(/font-size: var\(--mdq-bullet-size, calc\(([\d.]+)em \* var\(--mdq-bullet-scale, 1\)\)\)/.exec(rule(selector))![1]);
    const step = Number(/font-size: ([\d.]+)em/.exec(rule(".slide-body li > ul,\n.slide-body li > ol"))![1]);
    // Effective size against the body: marker em times the item's own em.
    const bullet1 = size(".slide-body li::marker");
    const bullet2 = size(".slide-body li > ul > li::marker") * step;
    const bullet3 = size(".slide-body li li > ul > li::marker") * step * step;
    expect(bullet1).toBeGreaterThan(bullet2);
    expect(bullet2).toBeGreaterThan(bullet3);
    const numeral1 = size(".slide-body ol > li::marker");
    const numeral2 = size(".slide-body li > ol > li::marker") * step;
    const numeral3 = size(".slide-body li > ol > li::marker") * step * step;
    expect(numeral1).toBeGreaterThanOrEqual(numeral2);
    expect(numeral2).toBeGreaterThanOrEqual(numeral3);
    expect(numeral3).toBeGreaterThanOrEqual(0.75);
    expect(bullet2).toBeGreaterThanOrEqual(0.65);
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
    const indent = /padding-left: var\(--mdq-list-indent, ([\d.]+)em\)/.exec(rule(".slide-body ul,\n.slide-body ol"))![1];
    expect(Number(indent)).toBeLessThanOrEqual(1.4);
    expect(block).not.toMatch(/\.slide-body li > (?:ul|ol)[^{]*\{[^}]*padding-left/);
    expect(rule(".slide-body li")).toContain("padding: 0");
    expect(css).not.toMatch(/\.slide-body li \{\s*padding-left/);
    expect(block).not.toMatch(/list-style-position:\s*inside/);
  });

  it("separates top-level items more than an item and its children, with overridable gaps", () => {
    const gap = (text: string, name: string) => Number(new RegExp(`gap: var\\(${name}, ([\\d.]+)em\\)`).exec(text)![1]);
    const top = gap(rule(".slide-body ul,\n.slide-body ol"), "--mdq-list-gap");
    const child = gap(rule(".slide-body li > ul,\n.slide-body li > ol"), "--mdq-list-gap-nested");
    expect(top).toBeGreaterThanOrEqual(child * 2);
    // The variables are read, never redeclared on the lists, so an ancestor can set them.
    expect(block).not.toMatch(/\n\s+--mdq-list-gap(?:-nested)?:/);
  });

  it("hides an item with no text instead of showing a bare marker", () => {
    expect(rule(".slide-body li:empty")).toContain("display: none");
  });

  it("drops the box and marker of an item that holds only a nested list", () => {
    expect(rule(".slide-body li.list-parent-only")).toContain("display: contents");
  });

  it("hides empty items in the printed deck too, with the same child markers", () => {
    expect(printSource).toMatch(/\.body-copy li:empty \{\s*display: none;/);
    expect(printSource).toMatch(/\.body-copy li\.list-parent-only \{\s*display: contents;/);
    expect(printSource).toMatch(/\.body-copy li > ul \{\s*list-style-type: circle;/);
    expect(printSource).toMatch(/\.body-copy li li > ul \{\s*list-style-type: square;/);
    expect(printSource).toMatch(/\.body-copy li li::marker \{\s*color: var\(--muted\);/);
    for (const [selector, size] of [
      ["li > ul > li", "0.72em"],
      ["li li > ul > li", "0.6em"],
      ["li > ol > li", "0.85em"],
    ]) {
      expect(printSource).toContain(`.body-copy ${selector}::marker {\n      font-size: ${size};`);
      expect(css).toContain(`.slide-body ${selector}::marker {\n  font-size: var(--mdq-bullet-size, calc(${size} * var(--mdq-bullet-scale, 1)));`);
    }
  });
});
