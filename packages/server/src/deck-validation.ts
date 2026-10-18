import type { DeckValidationReport } from "@mdq/shared";
import type { QuizParseError } from "./parser";

/** Presentation-only guidance. Keep parser details intact for adapter consumers. */
export function likelyValidationFix(detail: string): string {
  if (detail.startsWith("No answer options found")) {
    return "For a written response, add 'type: open_response' on its own line below the ## heading and remove any Correct Answer line. For multiple choice or a poll, add options such as 'A. First choice' and 'B. Second choice'.";
  }
  if (detail.startsWith("Missing correct answer line")) {
    return "Add '> Correct Answer: A' using an existing option label, or '> Correct Answers: A, B' for several correct options. For an unscored vote, use 'type: poll' instead.";
  }
  if (detail.includes("must not define correct answers")) {
    return "Remove the '> Correct Answer:' or '> Correct Answers:' line. Only multiple-choice questions declare correct options.";
  }
  if (detail.includes("must not define answer options")) {
    return "Remove the lettered options, or change to 'type: multiple_choice' if participants should choose an answer.";
  }
  if (detail.includes("must not use multi-select")) {
    return "Remove the 'multi_select:' line. Open responses and slides do not offer selectable options.";
  }
  if (detail.includes("must not use time-limit")) {
    return "Remove the 'time_limit:' line from this slide or cover.";
  }
  if (detail.startsWith("Unsupported type") || detail.startsWith("Unsupported question_type")) {
    return "Use 'type: multiple_choice', 'type: poll', 'type: open_response', 'type: slide', or 'type: cover'. 'type: question' also names the multiple-choice default.";
  }
  if (detail.startsWith("Correct answer")) {
    return "Change the Correct Answer label to one of the lettered options shown in the diagnostic, or add the missing option.";
  }
  if (detail.startsWith("Use '> Correct Answers:")) {
    return "Use the plural form '> Correct Answers: A, B' for more than one correct option.";
  }
  if (detail.startsWith("multi-select: false")) {
    return "Set 'multi_select: true' or remove that setting, or keep only one correct answer.";
  }
  if (detail.startsWith("Invalid time-limit")) {
    return "Set 'time_limit:' to a positive whole number of seconds, such as 'time_limit: 30'.";
  }
  if (detail.startsWith("Invalid theme:")) {
    return "Use 'theme: dark' or 'theme: light' in the deck header, or remove the override.";
  }
  if (detail.startsWith("Invalid palette:")) {
    return "Use one of the palette names listed in the diagnostic, or remove the 'palette:' override.";
  }
  if (/^Invalid (presenter-notes|presenter-notes-default-open|student-id):/.test(detail)) {
    return "Set the named header setting to 'true' or 'false', or remove it to use the runtime default.";
  }
  if (detail.startsWith("No questions found") || detail.startsWith("Missing H2")) {
    return "Add a '## Topic' heading for each item and separate items with a standalone '---' line. Set 'type: slide' for presentation-only content.";
  }
  if (detail.startsWith("Slide has images with conflicting positions")) {
    return "Give every image on this slide the same placement suffix, such as '-left' or '-right'.";
  }
  if (detail.startsWith("Invalid -background opacity")) {
    return "Use an image suffix such as '-background:0.3' with an opacity between 0 and 1.";
  }
  return "Check the named setting and Markdown syntax at this location. Fix it and reload to see any remaining issues in this item.";
}

export function buildDeckValidationResponse(errors: readonly QuizParseError[]): { error: string; validation: DeckValidationReport } {
  const files: DeckValidationReport["files"] = [];
  for (const error of errors) {
    let file = files.find((entry) => entry.sourceFile === error.sourceFile);
    if (!file) {
      file = { sourceFile: error.sourceFile, issues: [] };
      files.push(file);
    }
    file.issues.push({
      questionIndex: error.questionIndex,
      lineNumber: error.lineNumber,
      detail: error.detail,
      likelyFix: likelyValidationFix(error.detail),
    });
  }
  const details = files.map((file) => `${file.sourceFile}\n${file.issues.map((issue) =>
    `${file.sourceFile}${issue.lineNumber === undefined ? "" : `:${issue.lineNumber}`}, ${issue.questionIndex < 0 ? "header" : `item ${issue.questionIndex + 1}`}: ${issue.detail}\nLikely fix: ${issue.likelyFix}`,
  ).join("\n")}`).join("\n\n");
  return {
    error: `Deck validation found ${errors.length} ${errors.length === 1 ? "issue" : "issues"} in ${files.length} ${files.length === 1 ? "file" : "files"}.\n${details}\nFix the markdown file and reload decks before starting a session. No server restart is needed. More issues in the same item may appear after its first error is fixed.`,
    validation: { issueCount: errors.length, files },
  };
}
