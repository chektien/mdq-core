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
  it("retains nested lists, loose-list paragraphs and other Markdown blocks", () => {
    const cover = parsed("- Course\n\n  Details\n  - Nested\n\n> A quotation\n\n### Metadata heading\n\n```text\nSample code\n```").quiz!.questions[0];
    const parts = splitCoverHtml(cover.textHtml);
    expect(parts.subtitleHtml).toBe("");
    expect(parts.metaHtml).toBe(cover.textHtml.trim());
    expect(parts.metaHtml).toContain("<li>Nested</li>");
    expect(parts.metaHtml).toContain("<blockquote>");
  });
  it("accepts Cover casing and preserves unsupported-type diagnostics", () => {
    expect(parseQuizMarkdown(source().replace("type: cover", "type: Cover"), "sample.md").quiz!.questions[0].questionType).toBe("cover");
    expect(parseQuizMarkdown(source().replace("type: cover", "type: mystery"), "sample.md").errors[0].message).toContain("Unsupported type: mystery");
  });
  it("extracts attendee and presenter notes and per-slide images", () => {
    const cover = parsed("Subtitle\n\n![Logo](../images/sample.png)\n\n> Attendee Note: Keep this.\n\n> Presenter Note: Welcome everyone.").quiz!.questions[0];
    expect(cover.attendeeNotes?.[0].bodyMd).toBe("Keep this.");
    expect(cover.presenterNotes?.[0].bodyMd).toBe("Welcome everyone.");
    expect(cover.textHtml).not.toMatch(/Note:|<img/);
    expect(cover.slideMedia?.[0].src).toBe("/data/images/sample.png");
    expect(parsed("slide-background: ../images/sample.png").quiz!.questions[0].slideBackground?.src).toBe("/data/images/sample.png");
  });
  it.each(["live-url: https://example.com/demo", "video-card: https://www.youtube.com/watch?v=dQw4w9WgXcQ", "[Video: Sample](https://youtu.be/dQw4w9WgXcQ)"])("rejects media that a cover cannot render instead of silently losing it: %s", body => {
    const result = parsed(body);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("use type: slide");
  });
  it.each(["time-limit: 30", "multi-select: true", "A. Answer", "> Correct Answer: A", "> Correct Answer: a", "> Correct Answer: Yes"])("rejects question-only content: %s", body => {
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
  it("reconnects staff and participants without timer ticks or answer counts", () => {
    const current = apply(session(), quiz, { type: "start" }, 1000).session;
    for (const command of [{ type: "snapshot", view: "control" }, { type: "snapshot", view: "display" }, { type: "snapshot", participantId: "sample", isReconnect: true }] as const) {
      const result = apply(current, quiz, command, 5000);
      expect(result.messages.some(message => message.event === SocketEvents.QUESTION_OPEN)).toBe(true);
      expect(result.messages.some(message => message.event === SocketEvents.QUESTION_TICK || message.event === SocketEvents.ANSWER_COUNT)).toBe(false);
      expect(result.nextDeadline).toBeNull();
    }
    const joined = apply(current, quiz, { type: "join", socketId: "sample", newToken: "sample", payload: { studentId: "sample" } }, 5000);
    expect(joined.messages.some(message => message.event === SocketEvents.ANSWER_COUNT)).toBe(false);
    const disconnected = apply(joined.session, quiz, { type: "disconnect", studentId: "sample", socketId: "sample" }, 6000);
    expect(disconnected.messages.some(message => message.event === SocketEvents.ANSWER_COUNT)).toBe(false);
  });
  it("navigates back to a cover without creating a reveal or score", () => {
    const opened = apply(session(), quiz, { type: "start" }, 1000).session;
    const next = apply(opened, quiz, { type: "next" }, 2000).session;
    const previous = apply(next, quiz, { type: "previous" }, 3000);
    expect(previous.session.currentQuestionIndex).toBe(0);
    expect(previous.session.state).toBe("QUESTION_OPEN");
    expect(previous.messages.some(message => message.event === SocketEvents.RESULTS_REVEAL)).toBe(false);
    expect(previous.nextDeadline).toBeNull();
    expect(apply(previous.session, quiz, { type: "timeout", deadline: 3000 }, 4000).session.state).toBe("QUESTION_OPEN");
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
});

it("refits the cover after media loads and removes its listener on unmount", () => {
  let scale = 1;
  let mediaHeight = 0;
  const listeners = new Map<string, () => void>();
  const stage = { clientHeight: 200, clientWidth: 800 };
  const block = {
    style: { setProperty: (_name: string, value: string) => { scale = Number(value); } },
    get scrollHeight() { return Math.ceil(300 * scale) + mediaHeight; },
    scrollWidth: 600,
    addEventListener: (event: string, handler: () => void) => listeners.set(event, handler),
    removeEventListener: (event: string) => listeners.delete(event),
  };
  let refs = 0;
  const effects: (() => (() => void) | void)[] = [];
  const react = { ...require("react"),
    useRef: () => ({ current: refs++ === 0 ? stage : block }),
    useLayoutEffect: (effect: () => (() => void) | void) => effects.push(effect),
  };
  const module = { exports: {} };
  new Function("require", "module", "exports", bundled.outputFiles[0].text)(
    (name: string) => name === "react" ? react : require(name), module, module.exports);
  const component = (module.exports as typeof components).SlideContentBody;
  renderToStaticMarkup(createElement(component, { title: "Long title", html: "", slideType: "cover" }));
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {} });
  try {
    const cleanup = effects[0]();
    const before = scale;
    expect(block.scrollHeight).toBeLessThanOrEqual(stage.clientHeight);
    mediaHeight = 100;
    listeners.get("load")!();
    expect(scale).toBeLessThan(before);
    expect(block.scrollHeight).toBeLessThanOrEqual(stage.clientHeight);
    cleanup?.();
    expect(listeners.size).toBe(0);
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
