import { useEffect, useState } from "react";

/**
 * The presenter's switch for stopping new people joining, for example once the class is in. It shows the
 * state in words ("Lock joining" / "Joining locked") and follows the live list, so it is right after a
 * reload and when it is changed from another screen. Someone who is already in can always rejoin.
 */
export default function JoinLockToggle({
  locked,
  onChange,
  disabled = false,
  className = "",
}: {
  /** The state the live participants list reports. */
  locked: boolean;
  onChange: (locked: boolean) => Promise<void>;
  /** True while the instructor's screen is offline: the switch waits. */
  disabled?: boolean;
  className?: string;
}) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once the live list says something, it is the truth again.
  useEffect(() => setPending(null), [locked]);
  const shown = pending ?? locked;

  const toggle = async () => {
    const next = !shown;
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
      setPending(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`join-lock ${className}`.trim()}>
      <button
        type="button"
        className="join-lock-toggle"
        aria-pressed={shown}
        disabled={disabled || busy}
        title={disabled ? "Reconnecting..." : undefined}
        onClick={() => void toggle()}
      >
        {shown ? "Joining locked" : "Lock joining"}
      </button>
      <p className="join-lock-help">
        {shown
          ? "New people cannot join. Anyone already in can still rejoin. Choose again to open joining."
          : "Stop new people joining once everyone is in."}
      </p>
      {error && <p role="alert" className="participant-error">{error}</p>}
    </div>
  );
}
