import type { DeckPalette, DeckTheme } from "@mdq/shared";

const ACTIVE_KEY = "mdquiz_session";
const SESSIONS_KEY = "mdquiz_sessions";

export interface StoredParticipantSession {
  sessionId: string;
  studentId: string;
  sessionToken?: string;
  sessionWeek?: string;
  sessionTheme?: DeckTheme;
  sessionPalette?: DeckPalette;
}

function isSession(value: unknown): value is StoredParticipantSession {
  if (!value || typeof value !== "object") return false;
  const session = value as StoredParticipantSession;
  return typeof session.sessionId === "string" && Boolean(session.sessionId)
    && typeof session.studentId === "string"
    && (session.sessionToken === undefined || typeof session.sessionToken === "string");
}

function readActive(): StoredParticipantSession | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? "null");
    return isSession(value) ? value : null;
  } catch { return null; }
}

function readSessions(): Record<string, StoredParticipantSession> {
  const sessions: Record<string, StoredParticipantSession> = Object.create(null);
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [id, session] of Object.entries(value)) {
        if (isSession(session) && session.sessionId === id) sessions[id] = session;
      }
    }
  } catch { /* Storage may be unavailable or contain an older malformed value. */ }
  return sessions;
}

/** Read exactly this session's seat, or the most recent session when no ID is given.
 * The legacy slot remains supported for clients that still write it directly.
 */
export function loadStoredSession(sessionId?: string | null): StoredParticipantSession | null {
  const active = readActive();
  if (sessionId === undefined) return active;
  if (!sessionId) return null;
  return active?.sessionId === sessionId ? active : readSessions()[sessionId] ?? null;
}

/** Archive the previous active seat before selecting another session. */
export function saveStoredSession(data: StoredParticipantSession): void {
  if (!isSession(data)) return;
  try {
    const sessions = readSessions();
    const active = readActive();
    if (active) sessions[active.sessionId] = active;
    const existing = sessions[data.sessionId];
    // Retain appearance, never an old identity's token when a fresh join replaces it.
    const next = {
      sessionWeek: existing?.sessionWeek,
      sessionTheme: existing?.sessionTheme,
      sessionPalette: existing?.sessionPalette,
      ...data,
    };
    sessions[data.sessionId] = next;
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(next));
  } catch { /* Joining still works when browser storage is unavailable. */ }
}

/** Forget only the revoked session. A token guard protects a replacement seat in shared storage. */
export function clearStoredSession(sessionId: string | null, expectedToken?: string | null): void {
  if (!sessionId) return;
  try {
    const matches = (session: StoredParticipantSession | null | undefined) => session?.sessionId === sessionId
      && (expectedToken === undefined || session.sessionToken === expectedToken);
    const sessions = readSessions();
    if (matches(sessions[sessionId])) {
      delete sessions[sessionId];
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    }
    if (matches(readActive())) localStorage.removeItem(ACTIVE_KEY);
  } catch { /* Nothing to clear if browser storage is unavailable. */ }
}
