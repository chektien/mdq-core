import { isSlideType } from "@mdq/shared";
import type { QuestionType } from "@mdq/shared";

/** Compact console wording; participant/projector instructions stay separate. */
export function getPresenterQuestionModeText(questionType: QuestionType, allowsMultiple: boolean): string {
  if (questionType === "open_response") return "Open response · not scored";
  if (questionType === "poll") {
    return `Poll · ${allowsMultiple ? "several choices" : "one choice"} · not scored`;
  }
  if (isSlideType(questionType)) return "Slide · no response needed";
  return `Question · ${allowsMultiple ? "several answers" : "one answer"}`;
}

export function getQuestionModeText(questionType: QuestionType, allowsMultiple: boolean): string {
  if (questionType === "poll") {
    return allowsMultiple
      ? "Poll question. You can select multiple options. This does not affect your score."
      : "Poll question. Select one option. This does not affect your score.";
  }

  if (questionType === "open_response") {
    return "Open response. Write a reply. You can update it while answers are open. This does not affect your score.";
  }

  if (isSlideType(questionType)) {
    return "Slide. No student response is needed.";
  }

  return allowsMultiple
    ? "You can select multiple answers"
    : "Select only one answer";
}

export function getRevealActionLabel(questionType: QuestionType): string {
  if (questionType === "poll") {
    return "Show Poll Results";
  }
  if (questionType === "open_response") {
    return "Reveal Responses";
  }
  if (isSlideType(questionType)) {
    return "Continue";
  }
  return "Reveal Answer";
}
