import fs from "fs";
import path from "path";
import { parseQuizMarkdown } from "../parser";
import { isAgendaSlide } from "../../../client/src/agendaSlide";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const css = fs.readFileSync(path.join(clientSrc, "index.css"), "utf-8");
const content = fs.readFileSync(path.join(clientSrc, "components", "SlideContent.tsx"), "utf-8");
const bold = (...items: string[]) => items.map((item) => `<p><strong>${item}</strong></p>`).join("\n");

const deck = `# Agenda deck

---

## Contents

type: slide

**Why this course**

**What you will learn**

**R\\&D \\<b\\>x\\</b\\> \\_em\\_**

---

## Notes

type: slide

**One**

**Two**

---
`;

describe("agenda slides", () => {
  it("reads bold paragraphs under a Contents heading as an agenda, and nothing else", () => {
    const result = parseQuizMarkdown(deck, "agenda.md");
    expect(result.errors).toEqual([]);
    const [contents, notes] = result.quiz!.questions;
    expect(contents.textHtml).toBe(
      "<p><strong>Why this course</strong></p>\n<p><strong>What you will learn</strong></p>\n<p><strong>R&amp;D &lt;b&gt;x&lt;/b&gt; _em_</strong></p>",
    );
    expect(isAgendaSlide(contents.topic, contents.textHtml)).toBe(true);
    // The same lines under another heading are an ordinary slide.
    expect(isAgendaSlide(notes.topic, notes.textHtml)).toBe(false);
  });

  it("accepts the three headings in any case, with a continuation, and no others", () => {
    for (const heading of ["Contents", "contents", "Contents (continued)", "Agenda", "Table of contents", " Agenda "]) {
      expect(isAgendaSlide(heading, bold("A", "B"))).toBe(true);
    }
    for (const heading of ["Tools", "Contents of the garden", "Agenda items", ""]) {
      expect(isAgendaSlide(heading, bold("A", "B"))).toBe(false);
    }
  });

  it("keeps a bullet list, extra text, inline mixes and line breaks as ordinary slide content", () => {
    expect(isAgendaSlide("Contents", "<ul>\n<li>A</li>\n<li>B</li>\n</ul>")).toBe(false);
    expect(isAgendaSlide("Contents", `${bold("A")}\n<p>See the map.</p>`)).toBe(false);
    expect(isAgendaSlide("Contents", "<p><strong>A</strong> and more</p>")).toBe(false);
    expect(isAgendaSlide("Contents", "<p><strong>A</strong> <strong>B</strong></p>")).toBe(false);
    expect(isAgendaSlide("Contents", "<p><strong>A</strong><br><strong>B</strong></p>")).toBe(false);
    expect(isAgendaSlide("Contents", `${bold("A")}\n<ul><li>B</li></ul>`)).toBe(false);
    expect(isAgendaSlide("Contents", "")).toBe(false);
  });

  it("marks the header and body, and styles them in em of the body size with no new colour or font", () => {
    expect(content).toContain('import { isAgendaSlide } from "../agendaSlide";');
    expect(content).toContain("const isAgenda = hasBody && isAgendaSlide(title, html);");
    expect(content).toContain('isAgenda ? "slide-header slide-header-agenda" : "slide-header"');
    expect(content).toContain('isAgenda ? "quiz-html slide-body slide-content-text slide-body-agenda" : "quiz-html slide-body slide-content-text"');
    const start = css.indexOf("/* Agenda slides.");
    expect(start).toBeGreaterThan(0);
    const block = css.slice(start, css.indexOf("\n.quiz-html {", start));
    expect(block).not.toMatch(/!important|@import|url\(|color|font-family|background|border|gradient|shadow|list-style/);
    const rule = /\.slide-surface \.slide-body\.slide-body-agenda p \{([^}]*)\}/.exec(block)?.[1] ?? "";
    expect(rule).toContain("margin: 0 0 1.15em;");
    expect(rule).toContain("font-size: 1.3em;");
    expect(block).toContain("@media (orientation: portrait) and (min-width: 600px)");
    expect(block).toContain("font-size: 1.6em;");
    expect(block).toMatch(/\.slide-header-agenda,\s*\.slide-header-agenda \.slide-title \{\s*max-width: none;/);
    // A later, more specific rule than the slide paragraph margin it replaces.
    expect(start).toBeGreaterThan(css.indexOf(".slide-body.quiz-html p {"));
  });
});
