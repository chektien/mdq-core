import { useCallback, useEffect, useState } from "react";
import { API, type ParticipantResultsPayload, type SessionState } from "@mdq/shared";

/** A retained seat credential is not a new join or identity/name-based impersonation. */
function retainedToken(sessionId: string | null): string | null {
  try {
    const stored = JSON.parse(localStorage.getItem("mdquiz_session") ?? "null");
    return stored?.sessionId === sessionId && typeof stored.sessionToken === "string" && stored.sessionToken ? stored.sessionToken : null;
  } catch { return null; }
}

export type ParticipantResultsStatus = "loading" | "pending" | "ready" | "ended" | "error";
/** HTTP recovery does not depend on receiving the final socket event or joining an ended session. */
export function useParticipantResults(
  sessionId: string | null,
  sessionToken: string | null,
  sessionState: SessionState | null = null,
  seatTaken = false,
  connected = false,
) {
  const token = seatTaken ? null : sessionToken ?? retainedToken(sessionId);
  const credentialKey = sessionId && !seatTaken ? JSON.stringify([sessionId, token]) : null;
  const [snapshot, setSnapshot] = useState<{ key: string; status: ParticipantResultsStatus; results: ParticipantResultsPayload | null; error: string | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!sessionId || !credentialKey) return;
    const controller = new AbortController();
    let cancelled = false;
    const fail = () => {
      if (!cancelled) setSnapshot({ key: credentialKey, status: "error", results: null, error: "Your results could not be loaded. Check your connection and try again." });
    };
    const timer = setTimeout(() => { fail(); controller.abort(); }, 10_000);
    fetch(API.SESSION_OWN_RESULTS.replace(":id", encodeURIComponent(sessionId)), {
      headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: controller.signal,
    }).then(async response => {
      if (cancelled) return;
      if (response.status === 409 || response.status === 401) {
        setSnapshot({ key: credentialKey, status: "pending", results: null, error: null }); return;
      }
      if (response.status === 410) {
        setSnapshot({ key: credentialKey, status: "ended", results: null, error: null }); return;
      }
      // An older active server may not expose this route yet. Do not replace its live view.
      if (response.status === 404 && sessionState !== "ENDED") {
        setSnapshot({ key: credentialKey, status: "pending", results: null, error: null }); return;
      }
      if (!response.ok) throw new Error("Results unavailable");
      const results = await response.json() as ParticipantResultsPayload;
      if (!cancelled && !controller.signal.aborted) setSnapshot({ key: credentialKey, status: "ready", results, error: null });
    }).catch(() => { if (!controller.signal.aborted) fail(); }).finally(() => clearTimeout(timer));
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [sessionId, credentialKey, token, sessionState, connected, revision]);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  const current = snapshot?.key === credentialKey ? snapshot : null;
  return { status: current?.status ?? "loading", results: current?.results ?? null, error: current?.error ?? null, refresh };
}
