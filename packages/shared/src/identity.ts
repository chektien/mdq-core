/**
 * Participant identity: how a joining participant is named, how two people
 * with the same name are told apart, and which sockets may see which parts.
 */

/** Longest Student ID a participant can join with. */
export const MAX_STUDENT_ID_LENGTH = 64;
/** Longest name a participant can join with. */
export const MAX_DISPLAY_NAME_LENGTH = 60;

/**
 * A name as it is stored and compared: Unicode NFC, trimmed, with every run
 * of whitespace collapsed to one space. Empty or missing input gives "".
 */
export function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** The form of a name used to compare two names: normalised, then lower-cased. */
export function displayNameKey(value: unknown): string {
  return normalizeDisplayName(value).toLowerCase();
}

/**
 * Whether a deck's join form asks for a Student ID. The `student-id` header
 * setting defaults to on; only an explicit `false` turns it off.
 */
export function usesStudentIds(quiz: { studentId?: boolean } | undefined): boolean {
  return quiz?.studentId !== false;
}

/**
 * The kinds of socket a session talks to. A control socket is the
 * instructor's, a display socket is the projector, and a participant socket
 * belongs to one joined participant.
 */
export const SOCKET_ROLES = ["control", "display", "participant"] as const;
export type SocketRole = (typeof SOCKET_ROLES)[number];
