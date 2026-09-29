import { Participant, Session, displayNameKey } from "@mdq/shared";

/**
 * Everything about naming participants that the engine and the older session
 * helpers share: public labels, their notes, and the clash messages.
 */

/** A name's label: the name, then `Name (2)`, `Name (3)` for later people with the same name. */
export function uniqueLabel(session: Session, base: string): string {
  const taken = new Set([...session.participants.values()].map((p) => displayNameKey(p.label)).filter(Boolean));
  let label = base;
  for (let n = 2; taken.has(displayNameKey(label)); n += 1) label = `${base} (${n})`;
  return label;
}

/**
 * The public label and the note shown to the participant for a new seat.
 * `typedName` is already normalised and may be empty. Call this before the
 * seat is added, so `Participant N` counts join order from one.
 */
export function assignLabel(session: Session, typedName: string): { label: string; labelNote?: string } {
  const label = uniqueLabel(session, typedName || `Participant ${session.participants.size + 1}`);
  if (!typedName) return { label, labelNote: `You appear as ${label}.` };
  if (label === typedName) return { label };
  return { label, labelNote: `Another participant is also called ${typedName}, so you appear as ${label}.` };
}

/** A new random key for public payloads. */
export const newPublicKey = (): string => crypto.randomUUID();

/**
 * Give any seat that predates public keys and labels one, in join order, so
 * a session saved by an earlier version still projects safely.
 */
export function ensureParticipantIdentity(session: Session): void {
  const missing = [...session.participants.values()].filter((p) => !p.publicKey || !p.label)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  for (const participant of missing) {
    if (!participant.publicKey) participant.publicKey = newPublicKey();
    if (!participant.label) {
      participant.label = "";
      participant.label = assignLabel(session, participant.displayName?.trim() ?? "").label;
    }
  }
}

export const nameTakenMessage = (name: string): string =>
  `Someone here is already using the name "${name}". Add an initial or your surname, for example "${name} B."`;

export const idTakenMessage = (id: string): string =>
  `The Student ID "${id}" is already in this session on another device. Use that device, or check that you typed your own ID.`;

/** The seat whose name is `name`, ignoring case, for a deck that uses names as IDs. */
export function findSeatByName(session: Session, name: string): Participant | undefined {
  const key = displayNameKey(name);
  for (const participant of session.participants.values()) {
    if (displayNameKey(participant.studentId) === key) return participant;
  }
  return undefined;
}
