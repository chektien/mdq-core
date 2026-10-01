import { parseQuizMarkdown } from "../parser";
import { buildHtml } from "../print-mdq";

const cases = [
  ["cover", "type: cover", ""],
  ["slide", "type: slide", ""],
  ["multiple_choice", "time-limit: 45", "A. First\nB. Second\n\n> Correct Answer: A\n> Overall Feedback: Reason"],
  ["multi-select", "multi-select: true\ntime-limit: 45", "A. First\nB. Second\n\n> Correct Answers: A, B\n> Overall Feedback: Reason"],
  ["poll", "type: poll\ntime-limit: 45", "A. First\nB. Second"],
  ["open_response", "type: open-response\ntime-limit: 45", ""],
];

it.each(cases)("extracts and prints images before and after options on %s", (_name, settings, options) => {
  const source = `# Synthetic deck\n\n---\n\n## Picture question\n${settings}\n\nPrompt\n\n![Before](assets/images/before.png "First caption")\n\n${options}\n\n![After](assets/images/after.png "Second caption")\n\n> Attendee Note: More context\n> Presenter Note: Private cue\n> ![Private](assets/images/private.png)\n`;
  const parsed = parseQuizMarkdown(source, "sample.md");
  expect(parsed.errors).toEqual([]);
  const question = parsed.quiz!.questions[0];
  expect(question.slideMedia!.map(item => [item.src, item.alt, item.title])).toEqual([
    ["assets/images/before.png", "Before", "First caption"],
    ["assets/images/after.png", "After", "Second caption"],
  ]);
  expect(question.textHtml).not.toContain("<img");
  expect(question.presenterNotes![0].bodyMd).toContain("![Private]");
  if (options) expect(question.options.map(option => option.label)).toEqual(["A", "B"]);
  if (settings.includes("time-limit")) expect(question.timeLimitSec).toBe(45);
  if (options.includes("Correct Answer")) expect(question.correctOptions).toEqual(_name === "multi-select" ? ["A", "B"] : ["A"]);
  const html = buildHtml(parsed.quiz!, { inputFile: "/tmp/sample.md", outputFile: "/tmp/sample.pdf", imagesDir: "/tmp", includeFoldouts: true, includePresenterNotes: false, includeAnswers: true, pageSize: "A4", theme: "light" });
  expect(html).toContain('alt="Before"');
  expect(html).toContain('alt="After"');
  expect(html).toContain("First caption");
  expect(html).not.toContain("Private cue");
  expect(html).not.toContain('alt="Private"');
});

it("does not lift fenced, inline code, quoted feedback or notes into question media", () => {
  const parsed = parseQuizMarkdown(`## Sample\n\nPrompt with \`![Literal](literal.png)\`\n\n\`\`\`md\n![Code](code.png)\n\`\`\`\n\nA. First\nB. Second\n\n> Correct Answer: A\n> Overall Feedback: ![Feedback](feedback.png)\n> Presenter Note: ![Private](private.png)\n\n![Public](public.png)\n`, "sample.md");
  expect(parsed.errors).toEqual([]);
  expect(parsed.quiz!.questions[0].slideMedia).toEqual([{ src: "public.png", alt: "Public" }]);
});
