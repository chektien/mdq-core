import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface SessionCodeCardProps {
  qrDataUrl?: string;
  sessionCode: string;
  participantCount?: number;
  /** True while the presenter has closed joining: the card says so instead of showing the code and QR. */
  joinClosed?: boolean;
  /** True while the screen has lost its connection, so the count may be out of date. */
  offline?: boolean;
  presentationUrl?: string;
  joinUrl?: string;
  shortUrl?: string;
  defaultExpanded?: boolean;
  className?: string;
}

export default function SessionCodeCard({
  qrDataUrl,
  sessionCode,
  participantCount,
  joinClosed = false,
  offline = false,
  presentationUrl,
  joinUrl,
  shortUrl,
  defaultExpanded = true,
  className = "",
}: SessionCodeCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [enlarged, setEnlarged] = useState(false);
  const displayJoinUrl = shortUrl || joinUrl;
  const hasBody = !joinClosed && (qrDataUrl || presentationUrl || displayJoinUrl);
  const expandedLabel = shortUrl || "";
  const rootClassName = [
    "session-code-card",
    expanded ? "session-code-card-expanded" : "session-code-card-compact",
    joinClosed ? "session-code-card-closed" : "",
    className,
  ].filter(Boolean).join(" ");

  // Locking joins closes an enlarged QR, so it does not come back on unlock.
  useEffect(() => {
    if (joinClosed) setEnlarged(false);
  }, [joinClosed]);

  useEffect(() => {
    if (!enlarged) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEnlarged(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enlarged]);

  return (
    <aside className={rootClassName} aria-label="Session join details">
      <button
        type="button"
        className="session-code-card-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded && expandedLabel && !joinClosed && <span className="session-code-card-kicker">{expandedLabel}</span>}
        <strong>{joinClosed ? "Joining is closed" : sessionCode}</strong>
        {participantCount !== undefined && (
          <span
            className={`session-code-card-meta${offline ? " session-code-card-meta-offline" : ""}`}
            title={offline ? "Reconnecting. This count may be out of date." : undefined}
          >
            {participantCount} online
          </span>
        )}
        {hasBody && <span className="session-code-card-icon" aria-hidden="true">{expanded ? "−" : "+"}</span>}
      </button>

      {expanded && hasBody && (
        <div className="session-code-card-body">
          {qrDataUrl && (
            <button
              type="button"
              className="session-code-card-qr-button"
              aria-label="Show the join QR code large"
              onClick={() => setEnlarged(true)}
            >
              <img className="session-code-card-qr" src={qrDataUrl} alt="Join QR" />
              <span className="session-code-card-qr-hint">Tap to enlarge</span>
            </button>
          )}
          {displayJoinUrl && <p className="session-code-card-link-text">{displayJoinUrl}</p>}
          {presentationUrl && (
            <a className="session-code-card-link" href={presentationUrl} target="_blank" rel="noopener noreferrer">
              Presentation view
            </a>
          )}
        </div>
      )}

      {enlarged && qrDataUrl && !joinClosed && createPortal(
        <div
          className="qr-enlarged"
          role="dialog"
          aria-modal="true"
          aria-label="Join QR code"
          onClick={() => setEnlarged(false)}
        >
          <div className="qr-enlarged-card">
            <img className="qr-enlarged-image" src={qrDataUrl} alt="Join QR code" />
            <p className="qr-enlarged-code">{sessionCode}</p>
            {displayJoinUrl && <p className="qr-enlarged-url">{displayJoinUrl}</p>}
            <button
              type="button"
              className="qr-enlarged-close"
              autoFocus
              onClick={(event) => { event.stopPropagation(); setEnlarged(false); }}
            >
              Close
            </button>
          </div>
        </div>,
        document.body,
      )}
    </aside>
  );
}
