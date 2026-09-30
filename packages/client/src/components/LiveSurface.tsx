import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import SessionCodeCard from "./SessionCodeCard";

export interface LiveSurfaceAction {
  label: string;
  onClick?: () => void | Promise<void>;
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
  const [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const hasJoinInfo = qrDataUrl || sessionCode || participantCount !== undefined || presentationUrl || joinUrl || shortUrl;
  const hasNavActions = navActions.length > 0;
  const hasActions = actions.length > 0;
  const className = [
    "slide-surface",
    `slide-surface-${mode}`,
    backgroundLayer ? "slide-surface-has-bg" : null,
    surfaceClassName,
  ].filter(Boolean).join(" ");

  useEffect(() => {
    if (typeof document === "undefined") return;

    setFullscreenSupported(document.fullscreenEnabled);
    const syncFullscreenState = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    syncFullscreenState();
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

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
    <section ref={surfaceRef} className={className}>
      {backgroundLayer}
      <div className="slide-safe">
        <div className="slide-toolbar">
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
            <div className="slide-toolbar-actions" aria-label="Presentation controls">
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
