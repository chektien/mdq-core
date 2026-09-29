import { parseQuizMarkdown } from "../parser";

describe("student-id deck setting", () => {
  const deck = (header: string) => `# Deck\n${header}\n---\n\n## Q\n\ntime-limit: 20\n\nWhich?\n\nA. One\nB. Two\n\n> Correct Answer: A\n`;

  it("is on when the header does not mention it", () => {
    const { quiz, errors } = parseQuizMarkdown(deck(""), "d.md");
    expect(errors).toEqual([]);
    expect(quiz?.studentId).toBeUndefined();
  });

  it("reads true and false, quoted or in any case", () => {
    expect(parseQuizMarkdown(deck("student-id: false"), "d.md").quiz?.studentId).toBe(false);
    expect(parseQuizMarkdown(deck("student-id: true"), "d.md").quiz?.studentId).toBe(true);
    expect(parseQuizMarkdown(deck('student-id: "False"'), "d.md").quiz?.studentId).toBe(false);
  });

  it("accepts the underscored spelling", () => {
    const result = parseQuizMarkdown(deck("student_id: false"), "d.md");
    expect(result.errors).toEqual([]);
    expect(result.quiz?.studentId).toBe(false);
  });

  it("reports a value that is not true or false", () => {
    const result = parseQuizMarkdown(deck("student-id: maybe"), "d.md");
    expect(result.errors.map((error) => error.detail)).toEqual(["Invalid student-id: maybe (expected true or false)"]);
  });

  it("does not read the setting from inside a question", () => {
    const body = "# Deck\n\n---\n\n## Q\n\nstudent-id: false\n\nWhich?\n\nA. One\nB. Two\n\n> Correct Answer: A\n";
    expect(parseQuizMarkdown(body, "d.md").quiz?.studentId).toBeUndefined();
  });
});
