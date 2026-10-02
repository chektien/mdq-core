import { MAX_SESSION_AVAILABILITY_MS, PARTICIPANT_RESULT_RETENTION_MS, SESSION_RECOVERY_MS, type Session, type SessionAvailabilityAlarm, type SessionAvailabilityPayload, type SessionAvailabilityPhase } from "@mdq/shared";

export function availabilityEndTimestamp(session: Session): number | undefined {
  return session.resultScope?.endedAt ?? session.endedAt;
}
/** Reads observe server time. They never extend, finalize or invent legacy availability. */
export function sessionAvailabilityPhase(session: Session, now: number): SessionAvailabilityPhase {
  if (session.deletedAt !== undefined) return "deleted";
  if (session.state === "ENDED" || session.resultScope) {
    const endedAt = availabilityEndTimestamp(session);
    return session.availability && endedAt !== undefined && now >= endedAt + PARTICIPANT_RESULT_RETENTION_MS ? "deleted" : "ended";
  }
  if (!session.availability) return "active";
  if (now >= session.availability.availableUntil + SESSION_RECOVERY_MS) return "deleted";
  return now >= session.availability.availableUntil ? "expired" : "active";
}
export function availabilityPayload(session: Session, now: number): SessionAvailabilityPayload {
  const phase = sessionAvailabilityPhase(session, now);
  const endedAt = availabilityEndTimestamp(session);
  return { schemaVersion: 1, phase, serverNow: now,
    ...(session.availability ? { availableUntil: session.availability.availableUntil } : {}),
    ...(phase === "active" || phase === "expired" ? session.availability ? {
      recoverBefore: session.availability.availableUntil + SESSION_RECOVERY_MS,
      deleteAt: session.availability.availableUntil + SESSION_RECOVERY_MS,
    } : {} : phase === "ended" && endedAt !== undefined ? {
      resultRetainedUntil: endedAt + PARTICIPANT_RESULT_RETENTION_MS,
      deleteAt: endedAt + PARTICIPANT_RESULT_RETENTION_MS,
    } : {}) };
}
export function validateAvailabilityDeadline(availableUntil: unknown, now: number): asserts availableUntil is number {
  if (typeof availableUntil !== "number" || !Number.isSafeInteger(availableUntil) || availableUntil <= now || availableUntil > now + MAX_SESSION_AVAILABILITY_MS) {
    throw new Error("Choose an exact future deadline no more than seven days from server now.");
  }
}
export function nextAvailabilityAlarm(session: Session, now: number): SessionAvailabilityAlarm | null {
  if (!session.availability || session.deletedAt !== undefined) return null;
  const endedAt = availabilityEndTimestamp(session);
  const ended = session.state === "ENDED" || !!session.resultScope;
  if (ended && endedAt === undefined) return null; // Unknown legacy final timestamp must stay unknown.
  const phase = !ended && now < session.availability.availableUntil ? "expire" : "purge";
  return { sessionId: session.sessionId, generation: session.availability.generation,
    availableUntil: session.availability.availableUntil, phase,
    dueAt: ended ? endedAt! + PARTICIPANT_RESULT_RETENTION_MS : phase === "expire"
      ? session.availability.availableUntil : session.availability.availableUntil + SESSION_RECOVERY_MS,
    ...(ended ? { endedAt } : {}) };
}
export function availabilityAlarmMatches(session: Session, alarm: SessionAvailabilityAlarm): boolean {
  return !!session.availability && session.sessionId === alarm.sessionId
    && session.availability.generation === alarm.generation && session.availability.availableUntil === alarm.availableUntil
    && availabilityEndTimestamp(session) === alarm.endedAt && session.deletedAt === undefined;
}
