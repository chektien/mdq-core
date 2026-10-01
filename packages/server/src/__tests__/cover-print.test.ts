import { parseQuizMarkdown } from "../parser";
import { buildHtml } from "../print-mdq";

it("prints covers with title, intact metadata, media and notes but no answer block", () => {
  const result = parseQuizMarkdown(`# Sample deck

---

## Opening: a shared title

type: cover

Subtitle

- Course
  - Nested metadata

![Sample image](https://example.invalid/sample.png)

> Attendee Note: Extra details

---

## Content

type: slide

Normal slide content
`, "sample.md");
  expect(result.errors).toEqual([]);
  const html = buildHtml(result.quiz!, { inputFile: "/tmp/sample.md", outputFile: "/tmp/sample.pdf", imagesDir: "/tmp",
    includeFoldouts: true, includePresenterNotes: false, includeAnswers: true, pageSize: "A4", theme: "light" });
  const article = html.match(/<article class="item item-cover">([\s\S]*?)<\/article>/)![1];
  expect(article).toContain("<h2>Opening: a shared title</h2>");
  expect(article.indexOf("<h2>")).toBeLessThan(article.indexOf("Subtitle"));
  expect(article.indexOf("Subtitle")).toBeLessThan(article.indexOf("Course"));
  expect(article).toContain("<li>Nested metadata</li>");
  expect(article).toContain('alt="Sample image"');
  expect(article).toContain("Extra details");
  expect(article).not.toContain("answer-block");
  expect(article).not.toContain("No body text");
  expect(html).toContain("Normal slide content");
  expect(html).toContain("02 / 02");
});
