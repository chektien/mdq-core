import { useLayoutEffect, useRef } from "react";
import { splitCoverHtml, type QuestionType } from "@mdq/shared";
import type {
  FoldoutNote as FoldoutNoteModel,
  MediaPosition,
  SlideMedia,
  SlideBackground,
  SlideLiveEmbed,
  SlideVideo,
  SlideReference,
  DeckStyle,
} from "@mdq/shared";
import FoldoutNote from "./FoldoutNote";
import SlideBackgroundLayer from "./SlideBackgroundLayer";
import VideoCard from "./VideoCard";
import { ExpandableImage } from "./ImageExpansion";
import LiveSurface, { type LiveSurfaceAction } from "./LiveSurface";
import QuizHtml from "./QuizHtml";
import { isAgendaSlide } from "../agendaSlide";

interface SlideContentBodyProps {
  title: string;
  slideType?: QuestionType;
  html: string;
  attendeeNotes?: FoldoutNoteModel[];
  slideMedia?: SlideMedia[];
  slideMediaPosition?: MediaPosition;
  slideMediaOpacity?: number;
  slideLiveEmbed?: SlideLiveEmbed;
  slideVideo?: SlideVideo;
  /** Identifies the slide, so a video's player starts over whenever the slide changes. */
  slideKey?: string | number;
  slideReferences?: SlideReference[];
  chromeLabel?: string | null;
}

interface SlideContentProps extends SlideContentBodyProps {
  slideBackground?: SlideBackground;
  /** The deck header's appearance settings, applied to the slide surface. */
  deckStyle?: DeckStyle;
  positionLabel?: string;
  mode?: "projector" | "review" | "student";
  nextLabel?: string | null;
  qrDataUrl?: string;
  sessionCode?: string;
  participantCount?: number;
  joinClosed?: boolean;
  offline?: boolean;
  presentationUrl?: string;
  joinUrl?: string;
  shortUrl?: string;
  joinCardDefaultExpanded?: boolean;
  showFullscreenButton?: boolean;
  statusLabel?: string | null;
  statusTone?: "neutral" | "success" | "warning";
  statusFades?: boolean;
  navActions?: LiveSurfaceAction[];
  actions?: LiveSurfaceAction[];
}

/** Group slide media by their `group` label, preserving first-seen order.
 * Ungrouped images collapse into a single leading label-less group. */
function groupSlideMedia(media: SlideMedia[]): { label?: string; items: SlideMedia[] }[] {
  const order: string[] = [];
  const byKey = new Map<string, SlideMedia[]>();
  for (const item of media) {
    const key = item.group ?? "";
    if (!byKey.has(key)) {
      byKey.set(key, []);
      order.push(key);
    }
    byKey.get(key)!.push(item);
  }
  return order.map((key) => ({ label: key || undefined, items: byKey.get(key)! }));
}

function mediaGridCountClass(count: number): string {
  return count > 3 ? "slide-media-grid-count-many" : `slide-media-grid-count-${count}`;
}

/** Render a single expandable media figure. Visible captions are opt-in via
 * the Markdown image title; alt text remains available to assistive tech
 * without being duplicated under every image. */
function renderMediaFigure(media: SlideMedia, index: number) {
  const caption = media.title;
  return (
    <figure className="slide-media-figure" key={`${media.src}-${index}`}>
      <ExpandableImage
        className="slide-media-expand-button"
        src={media.src}
        alt={media.alt}
        title={media.title}
      />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** Cover typography fits the remaining safe area, including live chrome and notes. */
function CoverContent({ title, html, slideMedia = [], slideMediaPosition, slideMediaOpacity }: SlideContentBodyProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const { subtitleHtml, metaHtml } = splitCoverHtml(html);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const block = blockRef.current;
    if (!stage || !block) return;
    const fit = () => {
      block.style.setProperty("--cover-fit", "1");
      if (block.scrollHeight <= stage.clientHeight && block.scrollWidth <= stage.clientWidth) return;
      let low = 0.01;
      let high = 1;
      for (let i = 0; i < 12; i++) {
        const scale = (low + high) / 2;
        block.style.setProperty("--cover-fit", String(scale));
        if (block.scrollHeight <= stage.clientHeight && block.scrollWidth <= stage.clientWidth) low = scale;
        else high = scale;
      }
      block.style.setProperty("--cover-fit", String(low));
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
    observer?.observe(stage);
    let disposed = false;
    void document.fonts?.ready.then(() => { if (!disposed) fit(); });
    return () => { disposed = true; observer?.disconnect(); };
  }, [title, html, slideMedia]);
  const background = slideMediaPosition === "background";
  return (
    <div ref={stageRef} className="slide-cover-stage">
      {background && <div className="slide-cover-background" style={{ opacity: slideMediaOpacity ?? 0.3 }}>
        {slideMedia.map((media, index) => <img key={index} src={media.src} alt={media.alt} />)}
      </div>}
      <div ref={blockRef} className="slide-cover-block slide-header">
        <h1 className="slide-title slide-cover-title">{title}</h1>
        {subtitleHtml && <QuizHtml className="quiz-html slide-cover-subtitle" html={subtitleHtml} />}
        {metaHtml && <QuizHtml className="quiz-html slide-cover-meta" html={metaHtml} />}
        {!background && slideMedia.length > 0 && <div className="slide-cover-media" aria-label="Slide images">
          {slideMedia.map((media, index) => renderMediaFigure(media, index))}
        </div>}
      </div>
    </div>
  );
}

export function SlideContentBody({
  title,
  slideType,
  html,
  attendeeNotes = [],
  slideMedia = [],
  slideMediaPosition,
  slideMediaOpacity,
  slideLiveEmbed,
  slideVideo,
  slideKey,
  slideReferences = [],
  chromeLabel = null,
}: SlideContentBodyProps) {
  const hasAttendeeNotes = attendeeNotes.length > 0;
  const hasMedia = slideMedia.length > 0;
  const hasVideo = !!slideVideo;
  const hasVisual = hasMedia || hasVideo;
  const hasReferences = slideReferences.length > 0;
  const hasBody = html.trim().length > 0;
  const isAgenda = hasBody && isAgendaSlide(title, html);
  const mediaCountClass = slideMedia.length > 3
    ? "slide-media-grid-count-many"
    : `slide-media-grid-count-${slideMedia.length}`;
  const resolvedPosition: MediaPosition = slideMediaPosition ?? "right";
  const stackVisuals = hasVideo && hasMedia && resolvedPosition !== "background";
  const hasMediaGroups = slideMedia.some((media) => media.group);
  const mediaGroups = hasMediaGroups ? groupSlideMedia(slideMedia) : [];
  const positionClass = hasMedia ? `slide-content-grid-media-${resolvedPosition}` : null;
  const bgStyle =
    resolvedPosition === "background" && hasMedia
      ? ({ ["--bg-opacity" as string]: slideMediaOpacity ?? 0.3 } as React.CSSProperties)
      : undefined;

  if (slideType === "cover") {
    return <>
      <CoverContent title={title} html={html} slideMedia={slideMedia} slideMediaPosition={slideMediaPosition} slideMediaOpacity={slideMediaOpacity} />
      {hasAttendeeNotes && <div className="slide-notes"><div className="slide-note-group slide-note-group-attendee">
        {attendeeNotes.map(note => <FoldoutNote key={note.id} note={note} />)}
      </div></div>}
      {hasReferences && <footer className="slide-references" aria-label="Slide references"><ol>
        {slideReferences.map(reference => <li key={reference.id}><QuizHtml className="slide-reference-text" html={reference.html} as="span" /></li>)}
      </ol></footer>}
    </>;
  }

  if (slideLiveEmbed) {
    const showOverlay = slideLiveEmbed.titleOverlay !== false;
    return (
      <div className="slide-live-embed">
        <iframe
          className="slide-live-embed-frame"
          src={slideLiveEmbed.url}
          title={title}
          allow="fullscreen; xr-spatial-tracking"
          loading="eager"
        />
        {showOverlay && (
          <div className="slide-live-embed-overlay">
            <header className="slide-header slide-live-embed-header">
              {chromeLabel && <p className="slide-eyebrow">{chromeLabel}</p>}
              <h1 className="slide-title">{title}</h1>
            </header>
            {hasBody && <QuizHtml className="quiz-html slide-body slide-live-embed-copy" html={html} />}
            {hasMedia && (
              <div className="slide-live-embed-logos" aria-label="Slide logos">
                {slideMedia.map((media, index) => (
                  <img
                    key={`${media.src}-${index}`}
                    src={media.src}
                    alt={media.alt}
                    title={media.title}
                  />
                ))}
              </div>
            )}
            {hasAttendeeNotes && (
              <div className="slide-notes slide-live-embed-notes">
                <div className="slide-note-group slide-note-group-attendee">
                  {attendeeNotes.map((note) => (
                    <FoldoutNote key={note.id} note={note} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <header className={isAgenda ? "slide-header slide-header-agenda" : "slide-header"}>
        {chromeLabel && <p className="slide-eyebrow">{chromeLabel}</p>}
        <h1 className="slide-title">{title}</h1>
      </header>

      <div
        className={[
          "slide-content-grid",
          hasVisual ? "slide-content-grid-with-media" : "slide-content-grid-text-only",
          !hasBody && hasVisual ? "slide-content-grid-media-only" : null,
          positionClass,
        ].filter(Boolean).join(" ")}
        style={bgStyle}
      >
        {hasBody && <QuizHtml className={isAgenda ? "quiz-html slide-body slide-content-text slide-body-agenda" : "quiz-html slide-body slide-content-text"} html={html} />}

        {stackVisuals ? (
          <div className="slide-visual-stack">
            <div className="slide-video-slot">
              <VideoCard key={`${slideKey ?? ""}:${slideVideo!.embedUrl}`} video={slideVideo!} title={title} />
            </div>
            <div className={`slide-media-grid ${mediaCountClass}`} aria-label="Slide images">
              {slideMedia.map((media, index) => renderMediaFigure(media, index))}
            </div>
          </div>
        ) : (
          <>
            {hasVideo && slideVideo && (
              <div className="slide-video-slot">
                <VideoCard key={`${slideKey ?? ""}:${slideVideo.embedUrl}`} video={slideVideo} title={title} />
              </div>
            )}

            {hasMedia && hasMediaGroups && (
              <div
                className={`slide-media-groups slide-media-groups-count-${
                  mediaGroups.length > 2 ? "many" : mediaGroups.length
                }`}
              >
                {mediaGroups.map((group, groupIndex) => (
                  <section className="slide-media-group" key={group.label ?? `group-${groupIndex}`}>
                    {group.label && <h2 className="slide-media-group-title">{group.label}</h2>}
                    <div
                      className={`slide-media-grid ${mediaGridCountClass(group.items.length)}`}
                      aria-label={group.label ? `${group.label} images` : "Slide images"}
                    >
                      {group.items.map((media, index) => renderMediaFigure(media, index))}
                    </div>
                  </section>
                ))}
              </div>
            )}

            {hasMedia && !hasMediaGroups && (
              <div className={`slide-media-grid ${mediaCountClass}`} aria-label="Slide images">
                {slideMedia.map((media, index) => renderMediaFigure(media, index))}
              </div>
            )}
          </>
        )}
      </div>

      {hasAttendeeNotes && (
        <div className="slide-notes">
          <div className="slide-note-group slide-note-group-attendee">
            {attendeeNotes.map((note) => (
              <FoldoutNote key={note.id} note={note} />
            ))}
          </div>
        </div>
      )}

      {hasReferences && (
        <footer className="slide-references" aria-label="Slide references">
          <ol>
            {slideReferences.map((reference) => (
              <li key={reference.id}>
                <QuizHtml className="slide-reference-text" html={reference.html} as="span" />
              </li>
            ))}
          </ol>
        </footer>
      )}
    </>
  );
}

export default function SlideContent({
  title,
  slideType,
  html,
  attendeeNotes = [],
  slideMedia = [],
  slideMediaPosition,
  slideMediaOpacity,
  slideLiveEmbed,
  slideVideo,
  slideKey,
  slideReferences = [],
  slideBackground,
  deckStyle,
  positionLabel,
  mode = "projector",
  nextLabel,
  qrDataUrl,
  sessionCode,
  participantCount,
  joinClosed,
  offline,
  presentationUrl,
  joinUrl,
  shortUrl,
  joinCardDefaultExpanded,
  showFullscreenButton = true,
  statusLabel,
  statusTone,
  statusFades,
  chromeLabel = null,
  navActions = [],
  actions = [],
}: SlideContentProps) {
  const surfaceClassName = slideType === "cover" ? "slide-surface-cover" : slideLiveEmbed ? "slide-surface-live-embed" : undefined;

  return (
    <LiveSurface
      mode={mode}
      surfaceClassName={surfaceClassName}
      backgroundLayer={slideBackground ? <SlideBackgroundLayer background={slideBackground} /> : undefined}
      deckStyle={deckStyle}
      nextLabel={nextLabel}
      qrDataUrl={qrDataUrl}
      sessionCode={sessionCode}
      participantCount={participantCount}
      joinClosed={joinClosed}
      offline={offline}
      presentationUrl={presentationUrl}
      joinUrl={joinUrl}
      shortUrl={shortUrl}
      joinCardDefaultExpanded={joinCardDefaultExpanded}
      positionLabel={positionLabel}
      showFullscreenButton={showFullscreenButton}
      statusLabel={statusLabel}
      statusTone={statusTone}
      statusFades={statusFades}
      navActions={navActions}
      actions={actions}
    >
      <SlideContentBody
        slideType={slideType}
        title={title}
        html={html}
        attendeeNotes={attendeeNotes}
        slideMedia={slideMedia}
        slideMediaPosition={slideMediaPosition}
        slideMediaOpacity={slideMediaOpacity}
        slideLiveEmbed={slideLiveEmbed}
        slideVideo={slideVideo}
        slideKey={slideKey}
        slideReferences={slideReferences}
        chromeLabel={chromeLabel}
      />
    </LiveSurface>
  );
}
