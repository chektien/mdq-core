import type { SessionParticipantsPayload } from "@mdq/shared";

/** Seats the presenter has just freed, by public key, until the live list says the same. */
export type FreedSeats = Record<string, true>;

/**
 * Whether a row reads "Free to join again". Only someone who is not connected can be free: the moment a
 * phone takes the seat the live list has them online, and the row must go back to a normal one.
 */
export function isSeatFreed(isOffline: boolean, released: boolean | undefined, freed: FreedSeats, publicKey: string): boolean {
  return isOffline && (released === true || freed[publicKey] === true);
}

/**
 * Drops the local "just freed" marks the live list has moved past: someone who is online again took the
 * seat, and someone the list already shows as released no longer needs the local mark. Returns the same
 * object when nothing changes.
 */
export function pruneFreedSeats(freed: FreedSeats, participants: SessionParticipantsPayload | null): FreedSeats {
  const keys = Object.keys(freed);
  if (keys.length === 0) return freed;
  const online = new Set((participants?.participants ?? []).map((p) => p.publicKey));
  const released = new Set((participants?.offline ?? []).filter((p) => p.released === true).map((p) => p.publicKey));
  const next: FreedSeats = {};
  for (const key of keys) if (!online.has(key) && !released.has(key)) next[key] = true;
  return Object.keys(next).length === keys.length ? freed : next;
}
