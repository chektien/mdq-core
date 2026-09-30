import { MAX_DISPLAY_NAME_LENGTH, MAX_STUDENT_ID_LENGTH, normalizeDisplayName } from "@mdq/shared";

/** How one text input on the join form is set up. */
export interface JoinFieldSpec {
  id: string;
  name: string;
  label: string;
  /** Shown after the label: a red asterisk, or "(optional)". */
  required: boolean;
  placeholder: string;
  maxLength: number;
  autoComplete: string;
  autoCapitalize: "off" | "words" | "characters";
  inputMode: "text";
  enterKeyHint: "next" | "go";
}

export type JoinFieldName = "code" | "studentId" | "displayName";

export interface JoinFormSpec {
  /** Asks for a Student ID and a name: `id`; or for a name only, which is also the ID: `name`. */
  mode: "id" | "name";
  studentId?: JoinFieldSpec;
  displayName: JoinFieldSpec;
  /** A hidden ID made on this device stands in for the Student ID. */
  generatedId: boolean;
}

/**
 * The fields a join form shows.
 *
 * - A deck that uses Student IDs (the default) asks for the ID (required) and a name (optional).
 * - `autoGenerateStudentIds` hides the ID field, makes the name required and sends an ID
 *   generated on this device, exactly as before.
 * - A deck with `student-id: false` asks for a name only, and the name is the ID. That wins
 *   over `autoGenerateStudentIds`: no ID is generated, because the name already is one.
 */
export function joinFormSpec(studentIds: boolean, autoGenerateStudentIds: boolean): JoinFormSpec {
  const nameRequired = !studentIds || autoGenerateStudentIds;
  const displayName: JoinFieldSpec = {
    id: "join-display-name",
    name: "displayName",
    label: "Name",
    required: nameRequired,
    placeholder: "Your name",
    maxLength: MAX_DISPLAY_NAME_LENGTH,
    autoComplete: "name",
    autoCapitalize: "words",
    inputMode: "text",
    enterKeyHint: "go",
  };
  if (!studentIds || autoGenerateStudentIds) {
    return { mode: studentIds ? "id" : "name", displayName, generatedId: studentIds };
  }
  return {
    mode: "id",
    generatedId: false,
    displayName,
    studentId: {
      id: "join-student-id",
      name: "studentId",
      label: "Student ID",
      required: true,
      placeholder: "e.g. 2301234",
      maxLength: MAX_STUDENT_ID_LENGTH,
      autoComplete: "off",
      autoCapitalize: "off",
      inputMode: "text",
      enterKeyHint: "next",
    },
  };
}

export interface JoinValues {
  studentId: string;
  displayName: string;
}

export interface JoinProblem {
  field: JoinFieldName;
  message: string;
}

/** The first thing wrong with what was typed, or null. The server checks again. */
export function checkJoinValues(spec: JoinFormSpec, values: JoinValues): JoinProblem | null {
  const name = normalizeDisplayName(values.displayName);
  if (spec.studentId) {
    const id = values.studentId.trim();
    if (!id) return { field: "studentId", message: "Enter your Student ID to join." };
    if (id.length > MAX_STUDENT_ID_LENGTH) return { field: "studentId", message: `Student ID can be at most ${MAX_STUDENT_ID_LENGTH} characters.` };
  }
  if (spec.displayName.required && !name) return { field: "displayName", message: "Enter your name to join." };
  if (name.length > MAX_DISPLAY_NAME_LENGTH) return { field: "displayName", message: `Name can be at most ${MAX_DISPLAY_NAME_LENGTH} characters.` };
  return null;
}

/** What to send as the identity: the Student ID (never in name mode) and the cleaned-up name. */
export function joinIdentity(spec: JoinFormSpec, values: JoinValues, generatedId: () => string): { studentId?: string; displayName?: string; seatKey: string } {
  const displayName = normalizeDisplayName(values.displayName) || undefined;
  if (spec.mode === "name") return { displayName, seatKey: displayName ?? "" };
  const studentId = spec.generatedId ? generatedId() : values.studentId.trim();
  return { studentId, displayName, seatKey: studentId };
}

/** Which field a server message is about, so it can be marked and focused. */
export function errorField(spec: JoinFormSpec, reason: string): JoinFieldName | null {
  if (spec.studentId && /student id/i.test(reason)) return "studentId";
  if (/name/i.test(reason)) return "displayName";
  if (/session|code/i.test(reason)) return "code";
  return null;
}

/** The form's own element id for a field. */
export function fieldElementId(spec: JoinFormSpec, field: JoinFieldName): string {
  if (field === "code") return "join-session-code";
  return field === "studentId" ? spec.studentId?.id ?? spec.displayName.id : spec.displayName.id;
}

/** Said when a code matches no session, whether it never existed or has ended. */
export const SESSION_MISSING_MESSAGE = "We could not find a session with that code. It may have ended. Check the code with your instructor.";

const SEAT_TAKEN_HINT = "If that device is not working, ask your instructor to let you join again.";

/**
 * What to tell a participant about a refused join. The server's own words are
 * kept, with a next step added where a person would otherwise be stuck.
 */
export function joinRefusalMessage(reason: string): string {
  if (/session has ended|session not found/i.test(reason)) return SESSION_MISSING_MESSAGE;
  if (/already in this session on another device/i.test(reason) && !/join again/i.test(reason)) return `${reason} ${SEAT_TAKEN_HINT}`;
  return reason;
}

/**
 * The note to show under the waiting screen's "You are in as ..." line. The
 * server's note for a participant who gave no name only repeats the label, so
 * it is left out; a note that says why the label differs from what was typed stays.
 */
export function extraLabelNote(label: string | null, note: string | null): string | null {
  if (!note) return null;
  if (label && note.trim() === `You appear as ${label}.`) return null;
  return note;
}
