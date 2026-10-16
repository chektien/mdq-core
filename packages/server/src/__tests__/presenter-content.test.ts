import path from "path";
import { buildSync } from "esbuild";
import { createElement, Fragment, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FoldoutNote, QuestionType, SlideMedia, SlideVideo, SlideReference } from "@mdq/shared";

const client = path.resolve(__dirname, "../../../client/src");
const bundled = buildSync({ stdin: { contents: `export { default as PresenterContent, PresenterContentProvider, projectPresenterContent } from './components/PresenterContent';
export { SlideContentBody, QuestionMedia } from './components/SlideContent';
export { default as QuizHtml } from './components/QuizHtml';`, resolveDir: client, loader: "tsx" }, bundle: true, platform: "node", format: "cjs", jsx: "automatic", write: false, packages: "external",
  alias: { "@mdq/shared": path.resolve(client, "../../shared/src/index.ts") } });
const compiled = { exports: {} };
new Function("require", "module", "exports", bundled.outputFiles[0].text)(require, compiled, compiled.exports);
interface Input {
  title: string; textHtml: string; questionType: QuestionType; slideKey: string;
  attendeeNotes?: FoldoutNote[]; slideMedia?: SlideMedia[]; slideVideo?: SlideVideo; slideReferences?: SlideReference[];
}
interface RendererProps {
  sessionId: string; kind: "slide" | "question-stem"; content: Record<string, unknown>; reveal: boolean; reviewing: boolean;
}
const components = compiled.exports as {
  PresenterContent: ComponentType<{ sessionId: string; kind: RendererProps["kind"]; content: Input; reveal?: boolean; reviewing?: boolean; children: ReactNode }>;
  PresenterContentProvider: ComponentType<{ renderer: ComponentType<RendererProps>; children: ReactNode }>;
  projectPresenterContent: (input: Input) => Record<string, unknown>;
  SlideContentBody: ComponentType<{ title: string; html: string; slideType: QuestionType; slideMedia: SlideMedia[] }>;
  QuestionMedia: ComponentType<{ media: SlideMedia[] }>;
  QuizHtml: ComponentType<{ html: string; className: string }>;
};
const media: SlideMedia[] = [{ src: "data:image/png;base64,c2FtcGxl", alt: "Public figure", title: "Public caption" }];
const makeInput = (questionType: QuestionType): Input => ({ title: "Public heading", textHtml: "<p>Public body</p>", questionType, slideKey: "sample", slideMedia: media });

describe("optional presenter content renderer", () => {
  const variants: [string, QuestionType][] = [["cover", "cover"], ["slide", "slide"], ["single choice", "multiple_choice"], ["multiple choice", "multiple_choice"], ["poll", "poll"], ["open response", "open_response"]];
  it.each(variants)("preserves native heading/body/media markup without a provider (%s)", (_variant, questionType) => {
    const input = makeInput(questionType);
    const kind = ["cover", "slide"].includes(questionType) ? "slide" : "question-stem";
    const children = kind === "slide" ? createElement(components.SlideContentBody, { title: input.title, html: input.textHtml, slideType: questionType, slideMedia: media })
      : createElement(Fragment, null, createElement(components.QuizHtml, { html: input.textHtml, className: "native-question" }), createElement(components.QuestionMedia, { media }));
    const native = renderToStaticMarkup(children);
    const throughSlot = renderToStaticMarkup(createElement(components.PresenterContent, { sessionId: "sample-session", kind, content: input, children }));
    expect(throughSlot).toBe(native);
    expect(throughSlot).toContain("Public body");
    expect(throughSlot).toContain("Public figure");
    if (kind === "slide") expect(throughSlot.match(/Public heading/g)).toHaveLength(1);
  });

  it("gives a trusted provider ownership of the public heading/body only, never fallback children", () => {
    const captured: RendererProps[] = [];
    const renderer: ComponentType<RendererProps> = props => {
      captured.push(props);
      return createElement("section", null, createElement("h1", null, props.content.title as string));
    };
    const slot = createElement(components.PresenterContent, { sessionId: "sample-session", kind: "slide", content: makeInput("cover"), reveal: false, reviewing: true,
      children: createElement("p", null, "NATIVE FALLBACK NOT A RENDERER INPUT") });
    const html = renderToStaticMarkup(createElement(components.PresenterContentProvider, { renderer, children: slot }));
    expect(html).toBe("<section><h1>Public heading</h1></section>");
    expect(Object.keys(captured[0]).sort()).toEqual(["content", "kind", "reveal", "reviewing", "sessionId"]);
    expect(captured[0]).toMatchObject({ sessionId: "sample-session", kind: "slide", reviewing: true, reveal: false });
    expect(JSON.stringify(captured)).not.toContain("NATIVE FALLBACK");
  });

  it("strips private/answer/credential extras at every copied level, including wrongly mixed private notes", () => {
    const privateText = "PRIVATE SENTINEL";
    const note: FoldoutNote = { id: "public", scope: "section", audience: "attendee", bodyMd: "public raw", bodyHtml: "<p>Public attendee note</p>" };
    const input = Object.assign(makeInput("slide"), {
      attendeeNotes: [Object.assign(note, { token: privateText }), { ...note, id: "private", audience: "presenter" as const, bodyMd: privateText, bodyHtml: privateText }],
      slideMedia: [Object.assign({ ...media[0] }, { token: privateText })],
      slideVideo: Object.assign({ embedUrl: "https://example.com/public.mp4", link: Object.assign({ url: "https://example.com/public.mp4", provider: "file" as const, mode: "file" as const }, { token: privateText }) }, { token: privateText }),
      slideReferences: [Object.assign({ id: "r", html: "<p>Public reference</p>", textMd: privateText }, { token: privateText })],
      presenterNotes: privateText, options: privateText, correctOptions: privateText, sessionToken: privateText, sock: privateText,
    });
    const projected = components.projectPresenterContent(input);
    expect(JSON.stringify(projected)).not.toContain(privateText);
    expect(JSON.stringify(projected)).not.toContain("public raw");
    expect(projected.attendeeNotes).toHaveLength(1);
    expect(Object.keys(projected).sort()).toEqual(["attendeeNotes", "questionType", "slideKey", "slideLiveEmbed", "slideMedia", "slideMediaOpacity", "slideMediaPosition", "slideReferences", "slideVideo", "textHtml", "title"]);
    let received: RendererProps | undefined;
    const renderer: ComponentType<RendererProps> = props => { received = props; return null; };
    const slot = createElement(components.PresenterContent, { sessionId: "sample-session", kind: "slide", content: input, children: null });
    renderToStaticMarkup(createElement(components.PresenterContentProvider, { renderer, children: slot }));
    expect(received).toBeDefined();
    expect(JSON.stringify(received)).not.toContain(privateText);
  });

  it("owns immutable array/object snapshots while retained source data changes asynchronously", () => {
    const input = makeInput("slide");
    input.slideMedia = [{ ...media[0] }];
    input.attendeeNotes = [{ id: "n", scope: "section", audience: "attendee", bodyMd: "Public raw", bodyHtml: "<p>Public note</p>" }];
    input.slideReferences = [{ id: "r", textMd: "Public ref", html: "<p>Public reference</p>" }];
    input.slideVideo = { embedUrl: "https://example.com/public.mp4", link: { url: "https://example.com/public.mp4", provider: "file", mode: "file" } };
    const projected = components.projectPresenterContent(input);
    const before = JSON.stringify(projected);
    input.title = "Later title"; input.slideMedia[0].alt = "Later image"; input.attendeeNotes[0].bodyHtml = "Later note";
    input.slideReferences[0].html = "Later reference"; input.slideVideo.link!.url = "https://example.com/later.mp4";
    expect(JSON.stringify(projected)).toBe(before);
    const frozen = (value: unknown): void => {
      if (value && typeof value === "object") { expect(Object.isFrozen(value)).toBe(true); Object.values(value).forEach(frozen); }
    };
    frozen(projected);
  });
});
