import { DECK_SETTING_KEYS, normalizeDeckSettingKeys } from "@mdq/shared";
import { parseQuizMarkdown } from "../parser";

// Setting keys are written with dashes; the earlier underscored spelling keeps
// working, and so does any mix of the two.
const deck = (header: string, blocks: string[]) => `# Settings deck\n${header}\n${blocks.map((block) => `---\n\n${block}\n`).join("\n")}---\n`;
const QUIZ = "## Pick one\n\ntime-limit: 45\nmulti-select: true\n\nWhich apply?\n\nA. One\nB. Two\nC. Three\n\n> Correct Answers: A, B\n> Overall Feedback: A and B.";
const SLIDE = "## Media\n\ntype: slide\nmedia-group: Before\nslide-background: ../images/bg.png\nslide-background-position: top\nslide-background-size: contain\n\n- Point.";
const OPEN = "## Reflect\n\nquestion-type: open-response\n\nShare one takeaway.";
const LIVE = "## Live\n\ntype: slide\nlive-url: https://example.edu/demo\nlive-title-overlay: true\nlive-interactive: false\n\nText.";
const VIDEO = "## Video\n\ntype: slide\nvideo-card: https://example.edu/v.mp4\nvideo-thumbnail: ../images/thumb.png\nvideo-caption: A caption\nvideo-label: Watch\n\nText.";
const HEADER = "presenter-notes: false\npresenter-notes-default-open: true";

const underscored = (text: string) => text.replace(/^(\s*[A-Za-z]+(?:-[A-Za-z]+)+)(\s*:)/gm, (_all, key: string, colon: string) => key.replace(/-/g, "_") + colon)
  .replace(/open-response/g, "open_response");

describe("dashed setting keys", () => {
  it("parse exactly like the underscored spelling, for every key", () => {
    const dashed = deck(HEADER, [QUIZ, SLIDE, OPEN, LIVE, VIDEO]);
    const old = underscored(dashed);
    expect(old).not.toBe(dashed);
    const fromDashed = parseQuizMarkdown(dashed, "d.md");
    const fromOld = parseQuizMarkdown(old, "d.md");
    expect(fromDashed.errors).toEqual([]);
    expect(fromDashed.quiz).toEqual(fromOld.quiz);
    const [quiz, slide, open, live, video] = fromDashed.quiz!.questions;
    expect(fromDashed.quiz!.presenterNotes).toBe(false);
    expect(fromDashed.quiz!.presenterNotesDefaultOpen).toBe(true);
    expect([quiz.timeLimitSec, quiz.allowsMultiple, quiz.correctOptions]).toEqual([45, true, ["A", "B"]]);
    expect(slide.slideMedia ?? []).toEqual([]);
    expect(slide.slideBackground).toEqual({ src: "/data/images/bg.png", position: "top", size: "contain" });
    expect(open.questionType).toBe("open_response");
    expect(live.slideLiveEmbed).toMatchObject({ url: "https://example.edu/demo" });
    expect(video.slideVideo).toBeTruthy();
    for (const question of fromDashed.quiz!.questions) expect(question.textHtml).not.toMatch(/time-limit|media-group|slide-background|live-url|video-card/);
  });

  it("accept a mix of spellings in one deck", () => {
    const mixed = deck("presenter_notes: false\npresenter-notes-default-open: true", [QUIZ.replace("time-limit", "time_limit"), SLIDE]);
    const result = parseQuizMarkdown(mixed, "m.md");
    expect(result.errors).toEqual([]);
    expect([result.quiz!.presenterNotes, result.quiz!.presenterNotesDefaultOpen, result.quiz!.questions[0].timeLimitSec]).toEqual([false, true, 45]);
  });

  it("keep line numbers and report problems in the dashed spelling", () => {
    const bad = deck("presenter-notes: sometimes", ["## Pick\n\ntime-limit: 0\n\nWhich?\n\nA. One\nB. Two\n\n> Correct Answer: A"]);
    const result = parseQuizMarkdown(bad, "b.md");
    expect(result.errors.map((error) => error.detail)).toEqual([
      "Invalid presenter-notes: sometimes (expected true or false)",
      "Invalid time-limit: 0 (must be positive)",
    ]);
    // The same positions as the underscored spelling (block line numbers keep
    // Core's existing trim offset either way).
    const old = parseQuizMarkdown(underscored(bad), "b.md");
    expect(result.errors.map((error) => [error.lineNumber, error.questionIndex])).toEqual(old.errors.map((error) => [error.lineNumber, error.questionIndex]));
    expect(result.errors[0].lineNumber).toBe(2);
    expect(normalizeDeckSettingKeys(bad).length).toBe(bad.length);
  });

  it("read dashed keys in CRLF decks", () => {
    const dashed = deck(HEADER, [QUIZ, OPEN]).replace(/\n/g, "\r\n");
    const result = parseQuizMarkdown(dashed, "w.md");
    expect(result.errors).toEqual([]);
    expect(result.quiz).toEqual(parseQuizMarkdown(underscored(dashed), "w.md").quiz);
    expect([result.quiz!.presenterNotes, result.quiz!.questions[0].timeLimitSec, result.quiz!.questions[1].questionType]).toEqual([false, 45, "open_response"]);
    expect(normalizeDeckSettingKeys(dashed).length).toBe(dashed.length);
  });

  it("leave fenced code, blockquotes and unrelated lines as written", () => {
    const text = "```md\ntime-limit: 30\n```\n> media-group: quoted\nfollow-up: a prose label\ntime-limit: 30";
    expect(normalizeDeckSettingKeys(text)).toBe("```md\ntime-limit: 30\n```\n> media-group: quoted\nfollow-up: a prose label\ntime_limit: 30");
    const shown = parseQuizMarkdown(deck("", ["## Syntax\n\ntype: slide\n\n```md\ntime-limit: 30\n```"]), "c.md");
    expect(shown.quiz!.questions[0].textHtml).toContain("time-limit: 30");
  });

  it("list every key the parser reads", () => {
    expect(DECK_SETTING_KEYS.every((key) => /^[a-z]+(-[a-z]+)*$/.test(key))).toBe(true);
    expect(DECK_SETTING_KEYS).toContain("presenter-notes-default-open");
    expect(DECK_SETTING_KEYS).toContain("slide-background-size");
  });
});
