import type { SessionAvailabilityPayload } from "@mdq/shared";

export function formatAvailabilityTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short", ...(new Date(timestamp).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }).format(timestamp);
}
export function localAvailabilityInput(timestamp: number): string {
  const date = new Date(timestamp);
  const local = new Date(timestamp - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
export function availabilityTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
/** Public status only by default. Lifecycle dates require a private management opt-in. */
export default function SessionAvailabilityInfo({ availability, management = false }: { availability?: SessionAvailabilityPayload | null; management?: boolean }) {
  if (!availability) return null;
  if (!management) return availability.phase === "expired" ? <p className="text-sm text-zinc-400">Availability ended. Released content is available for review. Answers are closed.</p>
    : availability.phase === "deleted" ? <p className="text-sm text-zinc-400">Session data has been deleted.</p> : null;
  const date = (timestamp: number) => <time dateTime={new Date(timestamp).toISOString()}>{formatAvailabilityTime(timestamp)}</time>;
  return <div className="text-sm text-zinc-400" aria-live="polite">
    {availability.phase === "expired" ? <>
      <p>Availability ended{availability.availableUntil !== undefined && <> {date(availability.availableUntil)}</>}. Answers are closed and results are hidden.</p>
      {availability.recoverBefore !== undefined && <p>Reopen or show results by {date(availability.recoverBefore)}. After that this session is deleted without showing results.</p>}
    </> : availability.phase === "deleted" ? <p>Session data has been deleted.</p>
      : availability.phase === "ended" ? availability.resultRetainedUntil !== undefined && <p>Results kept until {date(availability.resultRetainedUntil)}.</p>
      : availability.availableUntil !== undefined && <p>Open until {date(availability.availableUntil)}.</p>}
  </div>;
}
