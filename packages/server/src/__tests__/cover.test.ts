import fs from "fs";
import path from "path";
import { buildSync } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isSlideType, splitCoverHtml, type Session, type QuestionType, type FoldoutNote, SocketEvents } from "@mdq/shared";
import { parseQuizMarkdown } from "../parser";
import { apply, questionPosition } from "../engine";

const source = (body = "", title = "Opening: a new chapter") => `# Sample deck\n\n---\n\n## ${title}\n\ntype: cover\n\n${body}\n`;
const parsed = (body = "") => parseQuizMarkdown(source(body), "sample-cover.md");

describe("cover parser", () => {
  it("is a first-class content-only type and keeps the whole heading", () => {
    const result = parsed("A subtitle.\n\nCourse name\n\nPresenter · 2026");
    expect(result.errors).toEqual([]);
    const cover = result.quiz!.questions[0];
    expect(cover).toMatchObject({ questionType: "cover", topic: "Opening: a new chapter", timeLimitSec: 0, options: [], correctOptions: [], allowsMultiple: false });
    expect(cover.subtopic).toBeUndefined();
    expect(isSlideType(cover.questionType)).toBe(true);
    expect(splitCoverHtml(cover.textHtml)).toEqual({ subtitleHtml: "<p>A subtitle.</p>", metaHtml: "<p>Course name</p>\n<p>Presenter · 2026</p>" });
  });
  it("accepts a title with no subtitle or body", () => {
    expect(parsed().errors).toEqual([]);
    expect(splitCoverHtml(parsed().quiz!.questions[0].textHtml)).toEqual({ subtitleHtml: "", metaHtml: "" });
  });
  it("keeps list-only metadata out of the subtitle, including ordered lists", () => {
    for (const list of ["- Course\n- Presenter\n- Date", "1. Course\n2. Presenter\n3. Date"]) {
      const result = parsed(list);
      expect(result.errors).toEqual([]);
      const parts = splitCoverHtml(result.quiz!.questions[0].textHtml);
      expect(parts.subtitleHtml).toBe("");
      expect(parts.metaHtml).toContain("<li>Course</li>");
    }
    const cover = parsed("Subtitle\n\n- Course\n- Presenter").quiz!.questions[0];
    expect(splitCoverHtml(cover.textHtml).subtitleHtml).toBe("<p>Subtitle</p>");
  });
  it("extracts attendee and presenter notes and per-slide images", () => {
    const cover = parsed("Subtitle\n\n![Logo](../images/sample.png)\n\n> Attendee Note: Keep this.\n\n> Presenter Note: Welcome everyone.").quiz!.questions[0];
    expect(cover.attendeeNotes?.[0].bodyMd).toBe("Keep this.");
    expect(cover.presenterNotes?.[0].bodyMd).toBe("Welcome everyone.");
    expect(cover.textHtml).not.toMatch(/Note:|<img/);
    expect(cover.slideMedia?.[0].src).toBe("/data/images/sample.png");
    expect(parsed("slide-background: ../images/sample.png").quiz!.questions[0].slideBackground?.src).toBe("/data/images/sample.png");
  });
  it.each(["time-limit: 30", "multi-select: true", "A. Answer", "> Correct Answer: A"])("rejects question-only content: %s", body => {
    expect(parsed(body).errors).toHaveLength(1);
  });
});

describe("cover runtime", () => {
  const quiz = parseQuizMarkdown(source() + "\n---\n\n## Content\n\ntype: slide\n\nText\n\n---\n\n## Question\n\nChoose.\n\nA. One\nB. Two\n\n> Correct Answer: A", "sample-cover.md").quiz!;
  const session = (): Session => ({ sessionId: "sample", sessionCode: "COVER", week: quiz.week, mode: "open", state: "LOBBY", currentQuestionIndex: -1, participants: new Map(), submissions: [], createdAt: 0 });
  it("opens with no deadline or question count and advances without revealing", () => {
    const opened = apply(session(), quiz, { type: "start" }, 1000);
    expect(opened.nextDeadline).toBeNull();
    expect(questionPosition(quiz, 0)).toEqual({});
    expect(questionPosition(quiz, 2)).toEqual({ questionNumber: 1, questionTotal: 1 });
    expect(opened.messages.find(message => message.event === SocketEvents.QUESTION_OPEN)?.payload).toMatchObject({ questionType: "cover", timeLimitSec: 0, options: [] });
    const next = apply(opened.session, quiz, { type: "next" }, 2000);
    expect(next.session.state).toBe("QUESTION_OPEN");
    expect(next.session.currentQuestionIndex).toBe(1);
  });
  it("refuses submissions even when a client invents an answer option", () => {
    const current = apply(session(), quiz, { type: "start" }, 1000).session;
    current.participants.set("sample", { studentId: "sample", publicKey: "sample", label: "Sample", sessionToken: "sample", socketId: "sample", joinedAt: 0, connected: true });
    const result = apply(current, quiz, { type: "answerSubmit", studentId: "sample", payload: { questionIndex: 0, selectedOptions: ["A"] } }, 1100);
    expect(result.session.submissions).toEqual([]);
    expect(result.messages[0].payload).toMatchObject({ reason: "Slides do not accept answers." });
  });
});

// Render the actual client component, rather than asserting only source strings.
const root = path.resolve(__dirname, "../../..");
const bundled = buildSync({ entryPoints: [path.join(root, "client/src/components/SlideContent.tsx")], bundle: true, platform: "node", format: "cjs", jsx: "automatic", write: false, packages: "external", alias: { "@mdq/shared": path.join(root, "shared/src/index.ts") } });
const compiled = { exports: {} };
new Function("require", "module", "exports", bundled.outputFiles[0].text)(require, compiled, compiled.exports);
const components = compiled.exports as { SlideContentBody: ComponentType<{ title: string; html: string; slideType?: QuestionType; attendeeNotes?: FoldoutNote[] }> };

describe("cover rendering", () => {
  it("renders title, subtitle, marker-free metadata structure and attendee notes", () => {
    const cover = parsed("Subtitle\n\n- Course\n- Presenter\n\n> Attendee Note: Extra details").quiz!.questions[0];
    const html = renderToStaticMarkup(createElement(components.SlideContentBody, { title: cover.topic, html: cover.textHtml, slideType: cover.questionType, attendeeNotes: cover.attendeeNotes }));
    expect(html).toContain('class="slide-cover-stage"');
    expect(html).toContain('class="slide-title slide-cover-title"');
    expect(html).toContain('class="quiz-html slide-cover-subtitle"');
    expect(html).toContain('class="quiz-html slide-cover-meta"');
    expect(html).toContain('<li>Course</li>');
    expect(html).toContain('slide-note-group-attendee');
    expect(html).not.toContain('slide-content-grid');
  });
  it("renders only the featured title when the body is absent", () => {
    const html = renderToStaticMarkup(createElement(components.SlideContentBody, { title: "Title", html: "", slideType: "cover" }));
    expect(html).toContain('>Title</h1>');
    expect(html).not.toMatch(/slide-cover-(subtitle|meta)/);
  });
  it("uses deck tokens, balanced wrapping and no list markers or decoration", () => {
    const css = fs.readFileSync(path.join(root, "client/src/index.css"), "utf8").split("/* Covers:")[1];
    expect(css).toContain('text-wrap: balance');
    expect(css).toContain('var(--mdq-title-size');
    expect(css).toContain('* 1.25 * var(--cover-fit)');
    expect(css).toContain('var(--mdq-slide-ink-soft)');
    expect(css).toContain('list-style: none');
    expect(css).not.toMatch(/gradient|shadow|#[0-9a-f]{3}|font-family/);
  });
});
