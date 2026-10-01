import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { safeDeckStyle, type DeckStyle } from "@mdq/shared";
import SessionCodeCard from "./SessionCodeCard";
import { pickNavAction } from "../presenterKeys";
import {
  SWIPE_BLOCKING_SELECTOR,
  canBeginSwipe,
  isSwipePointer,
  resolveSwipe,
  type HorizontalScroller,
  type SwipeStart,
} from "../presenterSwipe";

export interface LiveSurfaceAction {
  label: string;
  /** Pointer/keyboard clicks carry the opener; swipe/key navigation has no event. */
  onClick?: (event?: { currentTarget: HTMLElement }) => void | Promise<void>;
  /** Makes the action a plain link that downloads a file instead of a button. */
  href?: string;
  disabled?: boolean;
  tone?: "neutral" | "primary" | "warning" | "danger";
  detail?: string | null;
  /** Why a disabled button is disabled, such as "Reconnecting...". Shown as a tooltip and read out. */
  reason?: string | null;
  /** A toggle's state; sets aria-pressed. */
  pressed?: boolean;
}

interface LiveSurfaceProps {
  children: ReactNode;
  mode?: "projector" | "review" | "student";
  surfaceClassName?: string;
  backgroundLayer?: ReactNode;
  /** The deck header's appearance settings, applied as custom properties on the slide surface. */
  deckStyle?: DeckStyle;
  nextLabel?: string | null;
  statusLabel?: string | null;
  statusTone?: "neutral" | "success" | "warning";
  /** Fades the status label away after a few seconds, for a message that only needs a glance. */
  statusFades?: boolean;
  positionLabel?: string;
  qrDataUrl?: string;
  sessionCode?: string;
  participantCount?: number;
  /** True while the presenter has closed joining: the join card says so instead of showing the code and QR. */
  joinClosed?: boolean;
  /** True while this screen is disconnected, so the online count is greyed. */
  offline?: boolean;
  presentationUrl?: string;
  joinUrl?: string;
  shortUrl?: string;
  joinCardDefaultExpanded?: boolean;
  showFullscreenButton?: boolean;
  navActions?: LiveSurfaceAction[];
  actions?: LiveSurfaceAction[];
}

export default function LiveSurface({
  children,
  mode = "projector",
  surfaceClassName,
  backgroundLayer,
  deckStyle,
  nextLabel,
  statusLabel,
  statusTone = "neutral",
  statusFades = false,
  positionLabel,
  qrDataUrl,
  sessionCode,
  participantCount,
  joinClosed = false,
  offline = false,
  presentationUrl,
  joinUrl,
  shortUrl,
  joinCardDefaultExpanded = true,
  showFullscreenButton = true,
  navActions = [],
  actions = [],
}: LiveSurfaceProps) {
  const surfaceRef = useRef<HTMLElement | null>(null);
  const safeRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const hasJoinInfo = qrDataUrl || sessionCode || participantCount !== undefined || presentationUrl || joinUrl || shortUrl;
  const hasNavActions = navActions.length > 0;
  const hasActions = actions.length > 0;
  const className = [
    "slide-surface",
    `slide-surface-${mode}`,
    backgroundLayer ? "slide-surface-has-bg" : null,
    hasNavActions ? "slide-surface-swipe" : null,
    surfaceClassName,
  ].filter(Boolean).join(" ");
  const appearance = safeDeckStyle(deckStyle);
  const surfaceStyle = appearance as CSSProperties | undefined;
  // The stylesheet repaints the slide from its background colour only when the deck sets one.
  const hasDeckBackground = !!appearance && ("--mdq-slide-bg" in appearance || "--mdq-slide-bg-soft" in appearance);
  // Text, muted and accent colours reach the slide's own content only. The controls keep the palette's colours.
  const deckColors = {
    "data-deck-text": appearance && "--mdq-deck-text" in appearance ? "true" : undefined,
    "data-deck-muted": appearance && "--mdq-deck-muted" in appearance ? "true" : undefined,
    "data-deck-accent": appearance && "--mdq-deck-accent" in appearance ? "true" : undefined,
  };
  // The page canvas behind the slide matches the colour the slide ends on, so no band of the palette's colour shows past it.
  // That is the deck's background colour, or the palette's own background when the deck sets only a surface colour.
  // The phone's own page is not a full-screen slide, so its canvas is left alone.
  const deckCanvas = appearance?.["--mdq-slide-bg"];
  useEffect(() => {
    if (!hasDeckBackground || mode === "student") return undefined;
    const root = document.documentElement;
    if (deckCanvas) root.style.setProperty("--mdq-deck-canvas", deckCanvas);
    root.setAttribute("data-deck-canvas", "true");
    return () => {
      root.style.removeProperty("--mdq-deck-canvas");
      root.removeAttribute("data-deck-canvas");
    };
  }, [hasDeckBackground, deckCanvas, mode]);

  useEffect(() => {
    if (typeof document === "undefined") return;

    setFullscreenSupported(document.fullscreenEnabled);
    // The page also marks <html>, so the stylesheet can keep the toolbar clear
    // of the close button some browsers draw over the top-left corner in full screen.
    const syncFullscreenState = () => {
      const active = !!document.fullscreenElement;
      setIsFullscreen(active);
      if (active) document.documentElement.setAttribute("data-fullscreen", "true");
      else document.documentElement.removeAttribute("data-fullscreen");
    };

    syncFullscreenState();
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      document.documentElement.removeAttribute("data-fullscreen");
    };
  }, []);

  // The toolbar floats over the top of the slide, so the slide's top padding
  // follows the toolbar's real height instead of a fixed guess: it grows when
  // the buttons wrap or carry longer titles. The stylesheet adds a clear gap
  // (see --slide-toolbar-clear) and applies it from 761px up, where the toolbar
  // floats. Measured before the first paint so the title does not jump.
  useLayoutEffect(() => {
    const safe = safeRef.current;
    const toolbar = toolbarRef.current;
    if (!safe || !toolbar) return undefined;
    const measure = () => {
      const height = toolbar.offsetHeight;
      if (height <= 0) {
        safe.removeAttribute("data-toolbar");
        safe.style.removeProperty("--slide-toolbar-clear");
        return;
      }
      safe.setAttribute("data-toolbar", "true");
      safe.style.setProperty("--slide-toolbar-clear", `${Math.ceil(toolbar.offsetTop + height)}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    if (surfaceRef.current) observer.observe(surfaceRef.current);
    return () => observer.disconnect();
  }, []);

  // The join card floats over the bottom corner from 761px up. Its height and
  // its distance from the bottom edge go to the safe area as --slide-join-clear,
  // so a question on a tablet can keep its options clear of the card (the
  // stylesheet uses it from 761px to 1180px). A card in the flow needs none.
  useLayoutEffect(() => {
    const safe = safeRef.current;
    const card = hasJoinInfo ? safe?.querySelector<HTMLElement>(":scope > .slide-join-panel") : null;
    if (!safe || !card) return undefined;
    const measure = () => {
      const style = window.getComputedStyle(card);
      if (style.position !== "absolute" && style.position !== "fixed") {
        safe.style.removeProperty("--slide-join-clear");
        return;
      }
      safe.style.setProperty("--slide-join-clear", `${Math.ceil((parseFloat(style.bottom) || 0) + card.offsetHeight)}px`);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return () => safe.style.removeProperty("--slide-join-clear");
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    if (surfaceRef.current) observer.observe(surfaceRef.current);
    return () => {
      observer.disconnect();
      safe.style.removeProperty("--slide-join-clear");
    };
  }, [hasJoinInfo]);

  // Swipe navigation belongs to the presenter, the only surface handed Prev and
  // Next actions. The phone and the projector never swipe. A swipe calls the
  // same handlers as the buttons, so a disabled button also stops the swipe.
  const navActionsRef = useRef(navActions);
  useEffect(() => {
    navActionsRef.current = navActions;
  });
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !hasNavActions) return undefined;

    const touches = new Set<number>();
    let gesture: { pointerId: number; start: SwipeStart } | null = null;

    const scrollersAround = (target: Element | null): HorizontalScroller[] => {
      const found: HorizontalScroller[] = [];
      for (let el: Element | null = target; el; el = el.parentElement) {
        const overflowX = getComputedStyle(el).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") {
          found.push({ scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
        }
        if (el === surface) break;
      }
      return found;
    };

    const onPointerDown = (event: PointerEvent) => {
      // Only a finger or a pen counts. A new primary pointer starts afresh, so
      // an id left behind by a lost pointerup cannot keep swipes off.
      if (!isSwipePointer(event.pointerType)) return;
      if (event.isPrimary) touches.clear();
      touches.add(event.pointerId);
      // A second finger is a pinch, not a swipe.
      if (touches.size > 1) {
        gesture = null;
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      const start: SwipeStart = {
        x: event.clientX,
        y: event.clientY,
        pointerType: event.pointerType,
        viewportWidth: window.innerWidth,
        onBlockedTarget: !!target?.closest(SWIPE_BLOCKING_SELECTOR),
        scrollers: scrollersAround(target),
      };
      gesture = canBeginSwipe(start) ? { pointerId: event.pointerId, start } : null;
    };

    const onPointerUp = (event: PointerEvent) => {
      touches.delete(event.pointerId);
      const current = gesture;
      if (!current || current.pointerId !== event.pointerId) return;
      gesture = null;
      const direction = resolveSwipe(current.start, event.clientX, event.clientY);
      if (direction) void pickNavAction(navActionsRef.current, direction)?.onClick?.();
    };

    const onPointerCancel = (event: PointerEvent) => {
      touches.delete(event.pointerId);
      if (gesture?.pointerId === event.pointerId) gesture = null;
    };

    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointerup", onPointerUp);
    surface.addEventListener("pointercancel", onPointerCancel);
    surface.addEventListener("lostpointercapture", onPointerCancel);
    return () => {
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointerup", onPointerUp);
      surface.removeEventListener("pointercancel", onPointerCancel);
      surface.removeEventListener("lostpointercapture", onPointerCancel);
    };
  }, [hasNavActions]);

  const requestFullscreen = useCallback(async () => {
    if (typeof document === "undefined") return;

    const target = document.documentElement || surfaceRef.current;
    if (!target || !document.fullscreenEnabled) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await target.requestFullscreen();
      }
    } catch {
      // Fullscreen can be denied by the browser; leave the surface usable.
    }
  }, []);

  const renderActionButton = (
    action: LiveSurfaceAction,
    index: number,
    variant: "nav" | "action",
  ) => {
    const tone = action.tone || "neutral";
    const hasDetail = !!action.detail;
    const className = [
      "slide-action-button",
      `slide-action-button-${tone}`,
      variant === "nav" ? "slide-nav-button" : null,
      hasDetail ? "slide-action-button-with-detail" : null,
    ].filter(Boolean).join(" ");

    if (action.href) {
      return (
        <a
          key={`${variant}-${action.label}-${index}`}
          className={className}
          href={action.href}
          download
        >
          <span className="slide-button-label">{action.label}</span>
        </a>
      );
    }

    return (
      <button
        key={`${variant}-${action.label}-${index}`}
        type="button"
        className={className}
        onClick={action.onClick}
        disabled={action.disabled}
        title={action.disabled && action.reason ? action.reason : undefined}
        aria-pressed={action.pressed}
        aria-label={hasDetail ? `${action.label}: ${action.detail}` : undefined}
        aria-description={action.disabled && action.reason ? action.reason : undefined}
      >
        <span className="slide-button-label">{action.label}</span>
        {hasDetail && <span className="slide-button-detail">{action.detail}</span>}
      </button>
    );
  };

  return (
    <section ref={surfaceRef} className={className} style={surfaceStyle} data-deck-background={hasDeckBackground ? "true" : undefined} {...deckColors}>
      {backgroundLayer}
      <div ref={safeRef} className="slide-safe">
        <div ref={toolbarRef} className="slide-toolbar">
          {hasNavActions && (
            <div className="slide-toolbar-nav" aria-label="Slide navigation controls">
              {navActions.map((action, index) => renderActionButton(action, index, "nav"))}
            </div>
          )}
          <div className="slide-toolbar-stack">
            {statusLabel && <span className={`slide-status-pill slide-status-pill-${statusTone}${statusFades ? " slide-status-pill-fades" : ""}`}>{statusLabel}</span>}
            {nextLabel && (
              <div className="slide-next-up" aria-label={`Next up: ${nextLabel}`}>
                <span>Next up</span>
                <strong>{nextLabel}</strong>
              </div>
            )}
          </div>
          {(hasActions || (showFullscreenButton && fullscreenSupported)) && (
            <div className="slide-toolbar-actions" aria-label={hasActions || hasNavActions ? "Presenter controls" : "Display controls"}>
              {actions.map((action, index) => renderActionButton(action, index, "action"))}
              {showFullscreenButton && fullscreenSupported && (
                <button
                  type="button"
                  className="slide-fullscreen-button"
                  onClick={requestFullscreen}
                  aria-label={isFullscreen ? "Exit full screen" : "Open full screen"}
                  aria-pressed={isFullscreen}
                >
                  {isFullscreen ? "Exit full screen" : "Full screen"}
                </button>
              )}
            </div>
          )}
        </div>

        {hasJoinInfo && (
          <SessionCodeCard
            className="slide-join-panel"
            qrDataUrl={qrDataUrl}
            sessionCode={sessionCode || ""}
            participantCount={participantCount}
            joinClosed={joinClosed}
            offline={offline}
            presentationUrl={presentationUrl}
            joinUrl={joinUrl}
            shortUrl={shortUrl}
            defaultExpanded={joinCardDefaultExpanded}
          />
        )}

        {children}

        {positionLabel && <p className="slide-counter">{positionLabel}</p>}
      </div>
    </section>
  );
}
