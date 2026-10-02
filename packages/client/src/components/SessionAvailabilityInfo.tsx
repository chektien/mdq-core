import type { SessionAvailabilityPayload } from "@mdq/shared";

export function formatAvailabilityTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(timestamp);
}
export function localAvailabilityInput(timestamp: number): string {
  const date = new Date(timestamp);
  const local = new Date(timestamp - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}
export function availabilityTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
/** Dates stay separate: availability is not recovery, finality, or retention. */
export default function SessionAvailabilityInfo({ availability }: { availability?: SessionAvailabilityPayload | null }) {
  if (!availability) return null;
  return <div className="text-sm text-zinc-400" aria-live="polite">
    {availability.phase === "expired" && <p className="font-semibold text-zinc-200">Availability ended. Released content is available for review. Answers are closed.</p>}
    {availability.phase === "deleted" && <p>Session data has been deleted.</p>}
    {availability.availableUntil !== undefined && <p>Available until <time dateTime={new Date(availability.availableUntil).toISOString()}>{formatAvailabilityTime(availability.availableUntil)}</time></p>}
    {availability.recoverBefore !== undefined && <p>Recover before {formatAvailabilityTime(availability.recoverBefore)}</p>}
    {availability.resultRetainedUntil !== undefined && <p>Results kept until {formatAvailabilityTime(availability.resultRetainedUntil)}</p>}
    {availability.deleteAt !== undefined && <p>Data deleted on {formatAvailabilityTime(availability.deleteAt)}</p>}
  </div>;
}
