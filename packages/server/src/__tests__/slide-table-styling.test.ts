import fs from "fs";
import path from "path";
import { parseQuizMarkdown } from "../parser";

const css = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "..", "client", "src", "index.css"),
  "utf-8",
);
const start = css.indexOf("/* Markdown tables:");
const block = css.slice(start, css.indexOf(".quiz-html strong {", start));
const selectors = [...block.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^}]*\}/g)]
  .flatMap((match) => match[1].split(","))
  .map((selector) => selector.trim())
  .filter(Boolean);

const deck = `# Tables

---

## Tides

type: slide

| Tide | Time | Height (m) |
| --- | :---: | ---: |
| High | 06:12 | 2.84 |
| Low | 12:25 | 0.41 |

> Attendee Note: Synthetic example.
>
> | Day | Kind |
> | --- | --- |
> | 1 | Spring |

---
`;

describe("slide table styling", () => {
  it("renders Markdown tables with column alignment on slides and in notes", () => {
    const result = parseQuizMarkdown(deck, "tables.md");
    expect(result.errors).toEqual([]);
    const slide = result.quiz!.questions[0];
    expect(slide.textHtml).toContain("<table>");
    expect(slide.textHtml).toContain('<td align="center">06:12</td>');
    expect(slide.textHtml).toContain('<td align="right">2.84</td>');
    expect(slide.attendeeNotes?.[0].bodyHtml).toContain("<table>");
  });

  it("styles tables inside rendered Markdown only", () => {
    expect(start).toBeGreaterThan(0);
    for (const selector of selectors) expect(selector).toMatch(/^\.quiz-html (table|th|td|tbody)/);
    expect(block).not.toMatch(/!important|@import|url\(/);
    expect(block).toMatch(/\.quiz-html td\[align="right"\] \{\s*text-align: right;/);
    expect(block).toMatch(/\.quiz-html td\[align="center"\] \{\s*text-align: center;/);
    expect(block).toContain("overflow-x: auto");
    expect(block).toContain("font-variant-numeric: tabular-nums");
  });

  it("takes colours from slide tokens so every theme applies", () => {
    const colours = [...block.matchAll(/(?:color|border-(?:top|bottom)):\s*([^;]+);/g)].map((match) => match[1]);
    expect(colours.length).toBeGreaterThan(3);
    for (const value of colours) expect(value).toMatch(/var\(--mdq-slide-[a-z-]+\)/);
  });
});
