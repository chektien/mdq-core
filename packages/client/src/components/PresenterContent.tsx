import { createContext, useContext, useMemo, type ComponentType, type ReactNode } from "react";
import type { FoldoutNote, MediaPosition, QuestionType, SlideLiveEmbed, SlideMedia, SlideReference, SlideVideo } from "@mdq/shared";

/** Public content only. Presenter controls, answers and private notes are not renderer inputs. */
export interface PresenterPublicContentInput {
  title: string;
  textHtml: string;
  questionType: QuestionType;
  slideKey: string | number;
  attendeeNotes?: readonly FoldoutNote[];
  slideMedia?: readonly SlideMedia[];
  slideMediaPosition?: MediaPosition;
  slideMediaOpacity?: number;
  slideLiveEmbed?: SlideLiveEmbed;
  slideVideo?: SlideVideo;
  slideReferences?: readonly SlideReference[];
}

export interface PresenterPublicContent {
  readonly title: string;
  readonly textHtml: string;
  readonly questionType: QuestionType;
  readonly slideKey: string | number;
  readonly attendeeNotes: readonly Readonly<Pick<FoldoutNote, "id" | "scope" | "audience" | "title" | "bodyHtml">>[];
  readonly slideMedia: readonly Readonly<SlideMedia>[];
  readonly slideMediaPosition?: MediaPosition;
  readonly slideMediaOpacity?: number;
  readonly slideLiveEmbed?: Readonly<SlideLiveEmbed>;
  readonly slideVideo?: Readonly<Omit<SlideVideo, "link"> & { readonly link?: Readonly<NonNullable<SlideVideo["link"]>> }>;
  readonly slideReferences: readonly Readonly<Pick<SlideReference, "id" | "html">>[];
}

/** Copy selected fields before an asynchronous renderer can retain them.
 * No object spread: additional state/credentials can never hitch a ride. */
export function projectPresenterContent(input: PresenterPublicContentInput): PresenterPublicContent {
  const video = input.slideVideo;
  const link = video?.link;
  return Object.freeze({
    title: input.title, textHtml: input.textHtml, questionType: input.questionType, slideKey: input.slideKey,
    attendeeNotes: Object.freeze((input.attendeeNotes ?? []).filter(note => note.audience === "attendee").map(note => Object.freeze({
      id: note.id, scope: note.scope, audience: note.audience, title: note.title, bodyHtml: note.bodyHtml,
    }))),
    slideMedia: Object.freeze((input.slideMedia ?? []).map(media => Object.freeze({
      src: media.src, alt: media.alt, title: media.title, position: media.position, opacity: media.opacity, group: media.group,
    }))),
    slideMediaPosition: input.slideMediaPosition, slideMediaOpacity: input.slideMediaOpacity,
    slideLiveEmbed: input.slideLiveEmbed ? Object.freeze({ url: input.slideLiveEmbed.url, titleOverlay: input.slideLiveEmbed.titleOverlay, interactive: input.slideLiveEmbed.interactive }) : undefined,
    slideVideo: video ? Object.freeze({ embedUrl: video.embedUrl, thumbnail: video.thumbnail, caption: video.caption, label: video.label,
      link: link ? Object.freeze({ url: link.url, provider: link.provider, mode: link.mode, startSeconds: link.startSeconds }) : undefined }) : undefined,
    slideReferences: Object.freeze((input.slideReferences ?? []).map(reference => Object.freeze({ id: reference.id, html: reference.html }))),
  });
}

export interface PresenterContentRendererProps {
  readonly sessionId: string;
  /** Slide renderers own the public heading as well as body; stems omit the topic heading. */
  readonly kind: "slide" | "question-stem";
  readonly content: PresenterPublicContent;
  readonly reveal: boolean;
  readonly reviewing: boolean;
}

const PresenterRenderer = createContext<ComponentType<PresenterContentRendererProps> | null>(null);

/** A trusted embedding application may replace public presenter content.
 * This does not accept external URLs, author script or a renderer from deck data. */
export function PresenterContentProvider({ renderer, children }: {
  renderer: ComponentType<PresenterContentRendererProps>;
  children: ReactNode;
}) {
  return <PresenterRenderer.Provider value={renderer}>{children}</PresenterRenderer.Provider>;
}

/** With no provider the existing native presentation is returned unchanged. */
export default function PresenterContent({ sessionId, kind, content, reveal = false, reviewing = false, children }: {
  sessionId: string;
  kind: PresenterContentRendererProps["kind"];
  content: PresenterPublicContentInput;
  reveal?: boolean;
  reviewing?: boolean;
  children: ReactNode;
}) {
  const Renderer = useContext(PresenterRenderer);
  const publicContent = useMemo(() => projectPresenterContent(content), [content]);
  return Renderer ? <Renderer sessionId={sessionId} kind={kind} content={publicContent} reveal={reveal} reviewing={reviewing} /> : children;
}
