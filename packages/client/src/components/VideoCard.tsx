import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolveVideoUrl, videoPlaybackUrl, videoProviderName, type SlideVideo } from "@mdq/shared";

/**
 * A contained, clickable playable-video card that belongs to the same visual
 * family as image thumbnails: the poster sits in a media figure with a
 * caption beneath it, styled exactly like ExpandableImage captions. A centred
 * play affordance marks it as playable. Clicking opens a modal player that
 * loads the embed in an iframe. Modelled on the ImageExpansion overlay: portal
 * to document.body, Escape-to-close, backdrop click, scroll lock, and the same
 * close control.
 */
export default function VideoCard({ video, title }: { video: SlideVideo; title: string }) {
  return video.link ? <LinkedVideoCard video={video} /> : <ModalVideoCard video={video} title={title} />;
}

const IFRAME_ALLOW = "autoplay; encrypted-media; picture-in-picture; fullscreen";
const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-popups";

/**
 * A video written as a `[Video: label](url)` link. It shows the label, the
 * provider and a play button, and requests nothing from the provider until the
 * viewer presses play. The player then replaces the card in place, so the
 * presenter can still move on. Leaving the slide unmounts it, which stops the
 * video. A link to the original address is always offered, and on paper the
 * card is replaced by the label, provider and link.
 */
function LinkedVideoCard({ video }: { video: SlideVideo }) {
  const link = video.link!;
  const label = video.label || "Video";
  // The payload is checked again here. The player address is rebuilt from the
  // author's link with the shared rules, and the address in the payload is not
  // trusted. If the link does not pass, only the Open video link is offered.
  const resolved = resolveVideoUrl(link.url);
  const target = resolved.ok ? resolved.target : null;
  const provider = videoProviderName(target?.provider ?? link.provider, link.url);
  const openHref = safeOpenHref(link.url);
  // The parent keys this card by slide, so it starts idle on every slide.
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const focusAfter = useRef<"stop" | "play" | null>(null);

  useEffect(() => {
    if (focusAfter.current === "stop") stopRef.current?.focus();
    if (focusAfter.current === "play") playRef.current?.focus();
    focusAfter.current = null;
  }, [playing]);

  const start = () => {
    focusAfter.current = "stop";
    setPlaying(true);
  };
  const stop = () => {
    focusAfter.current = "play";
    setPlaying(false);
  };

  if (!target) {
    return (
      <figure className="slide-video-figure slide-video-figure-link" aria-label={label}>
        <p className="slide-video-unavailable">{label}</p>
        {openHref && (
          <figcaption className="slide-video-actions">
            <a className="slide-video-action" href={openHref} target="_blank" rel="noopener noreferrer">
              Open video<span className="slide-video-sr"> (opens in a new tab)</span>
            </a>
          </figcaption>
        )}
      </figure>
    );
  }

  return (
    <figure
      className="slide-video-figure slide-video-figure-link"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape" && playing) {
          event.stopPropagation();
          stop();
        }
      }}
    >
      {playing ? (
        <div className="slide-video-player">
          {target.fileUrl ? (
            <video
              className="slide-video-native"
              src={target.fileUrl}
              controls
              playsInline
              autoPlay
              preload="metadata"
              aria-label={label}
            />
          ) : (
            <iframe
              className="slide-video-iframe"
              src={videoPlaybackUrl(target.embedUrl ?? "")}
              title={label}
              allow={IFRAME_ALLOW}
              sandbox={IFRAME_SANDBOX}
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          )}
        </div>
      ) : (
        <button
          ref={playRef}
          type="button"
          className="slide-video-card slide-video-card-link"
          onClick={start}
          aria-label={`Play video: ${label}, ${provider}`}
        >
          <span className="slide-video-card-thumb slide-video-card-thumb-empty" aria-hidden="true" />
          <span className="slide-video-card-play" aria-hidden="true">
            <PlayGlyph />
          </span>
          <span className="slide-video-card-text" aria-hidden="true">
            <span className="slide-video-card-label">{label}</span>
            <span className="slide-video-card-provider">{provider}</span>
          </span>
        </button>
      )}
      <figcaption className="slide-video-actions">
        <a className="slide-video-action" href={openHref ?? link.url} target="_blank" rel="noopener noreferrer">
          Open video<span className="slide-video-sr"> (opens in a new tab)</span>
        </a>
        {playing && (
          <button ref={stopRef} type="button" className="slide-video-action" onClick={stop}>
            Stop video
          </button>
        )}
      </figcaption>
      <p className="slide-video-print">
        <span className="slide-video-print-label">{label}</span>
        <span className="slide-video-print-provider">{provider}</span>
        <a className="slide-video-print-link" href={link.url}>{link.url}</a>
      </p>
    </figure>
  );
}

/** The author's address as an https link, or null when it is anything else. */
function safeOpenHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="40" height="40" focusable="false">
      <circle cx="12" cy="12" r="12" fill="rgba(10,12,20,0.72)" />
      <path d="M9.5 7.5v9l7-4.5-7-4.5z" fill="#fff" />
    </svg>
  );
}

function ModalVideoCard({ video, title }: { video: SlideVideo; title: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const label = video.label || "Play video";
  const caption = video.caption;

  const closeOverlay = () => {
    setOpen(false);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  };

  return (
    <figure className="slide-video-figure">
      <button
        ref={triggerRef}
        type="button"
        className="slide-video-card"
        onClick={() => setOpen(true)}
        aria-label={`${label}: ${title}`}
      >
        {video.thumbnail ? (
          <img className="slide-video-card-thumb" src={video.thumbnail} alt="" />
        ) : (
          <span className="slide-video-card-thumb slide-video-card-thumb-empty" aria-hidden="true" />
        )}
        <span className="slide-video-card-play" aria-hidden="true">
          <PlayGlyph />
        </span>
      </button>
      {caption && <figcaption>{caption}</figcaption>}
      {open && <VideoOverlay video={video} title={title} onClose={closeOverlay} />}
    </figure>
  );
}

function isNativeVideoUrl(url: string): boolean {
  const pathname = (() => {
    try {
      return new URL(url, window.location.href).pathname;
    } catch {
      return url.split(/[?#]/, 1)[0];
    }
  })();
  return /\.(mp4|m4v|webm|mov)$/i.test(pathname);
}

function VideoOverlay({
  video,
  title,
  onClose,
}: {
  video: SlideVideo;
  title: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "Tab" && frameRef.current) {
        const focusables = Array.from(
          frameRef.current.querySelectorAll<HTMLElement>(
            'button, a[href], iframe, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("image-expansion-lock");
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.classList.remove("image-expansion-lock");
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;
  const nativeVideo = isNativeVideoUrl(video.embedUrl);
  return createPortal(
    <div className="video-expansion-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" className="video-expansion-backdrop" aria-label="Close expanded video" onClick={onClose} />
      <div className="video-expansion-frame" ref={frameRef}>
        <button
          type="button"
          ref={closeRef}
          className="image-expansion-close"
          onClick={onClose}
          aria-label="Close expanded video"
        >
          <span className="image-expansion-close-icon" aria-hidden="true" />
        </button>
        <div className="video-expansion-player">
          {nativeVideo ? (
            <video
              className="video-expansion-native"
              src={video.embedUrl}
              poster={video.thumbnail}
              controls
              playsInline
              preload="metadata"
              autoPlay
              aria-label={title}
            />
          ) : (
            <iframe
              className="video-expansion-iframe"
              src={video.embedUrl}
              title={title}
              allow="autoplay; fullscreen"
              allowFullScreen
            />
          )}
        </div>
        <a
          className="video-expansion-fallback"
          href={video.embedUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          If the player does not load, open the video in a new tab
        </a>
      </div>
    </div>,
    document.body,
  );
}
