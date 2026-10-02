import { useCallback, useEffect, useMemo, useState } from "react";
import { API, type SessionAvailabilityPayload } from "@mdq/shared";

/** Shared native/hosted lifecycle observer. Local time never authorizes a server mutation. */
export function useSessionAvailability(sessionId: string | null, observed?: SessionAvailabilityPayload | null, sessionToken?: string | null) {
  const [snapshot, setSnapshot] = useState<{ id: string; value: SessionAvailabilityPayload; receivedAt: number } | null>(null);
  const observedRecord = useMemo(() => sessionId && observed ? { id: sessionId, value: observed, receivedAt: Date.now() } : null, [sessionId, observed]);
  const [revision, setRevision] = useState(0);
  const [clockRevision, setClockRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (observedRecord) setSnapshot(observedRecord);
  }, [observedRecord]);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    fetch(API.SESSION_AVAILABILITY.replace(":id", encodeURIComponent(sessionId)), { signal: controller.signal, cache: "no-store", credentials: "same-origin", ...(sessionToken ? { headers: { Authorization: `Bearer ${sessionToken}` } } : {}) })
      .then(async response => {
        if (response.status === 410) return { schemaVersion: 1, phase: "deleted", serverNow: Date.now() } as SessionAvailabilityPayload;
        if (!response.ok) return null; // Older native server compatibility.
        return response.json() as Promise<SessionAvailabilityPayload>;
      }).then(value => { if (value && !controller.signal.aborted) setSnapshot({ id: sessionId, value, receivedAt: Date.now() }); })
      .catch(() => {}).finally(() => clearTimeout(timeout));
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [sessionId, observed, sessionToken, revision]);
  useEffect(() => {
    if (!sessionId) return;
    const interval = setInterval(refresh, 30_000);
    window.addEventListener("online", refresh); window.addEventListener("pageshow", refresh);
    return () => { clearInterval(interval); window.removeEventListener("online", refresh); window.removeEventListener("pageshow", refresh); };
  }, [sessionId, refresh]);
  const fetchedRecord = snapshot?.id === sessionId ? snapshot : null;
  // An old HTTP response cannot replace a newer socket observation, even before effect cleanup.
  // Availability only increases. End/deletion are terminal and expiry cannot return active at the same deadline.
  const newer = (a: SessionAvailabilityPayload, b: SessionAvailabilityPayload) => {
    const finality = (value: SessionAvailabilityPayload) => value.phase === "deleted" ? 2 : value.phase === "ended" ? 1 : 0;
    if (finality(a) !== finality(b)) return finality(a) > finality(b);
    if ((a.availableUntil ?? -Infinity) !== (b.availableUntil ?? -Infinity)) return (a.availableUntil ?? -Infinity) > (b.availableUntil ?? -Infinity);
    if (a.phase !== b.phase && (a.phase === "expired" || b.phase === "expired")) return a.phase === "expired";
    return a.serverNow >= b.serverNow;
  };
  const current = observedRecord && (!fetchedRecord || newer(observedRecord.value, fetchedRecord.value)) ? observedRecord : fetchedRecord;
  const now = current ? current.value.serverNow + Date.now() - current.receivedAt : Date.now();
  const source = current?.value ?? null;
  const phase = source?.deleteAt !== undefined && now >= source.deleteAt ? "deleted"
    : source?.phase === "active" && source.availableUntil !== undefined && now >= source.availableUntil ? "expired" : source?.phase;
  // Referential stability matters to downstream /items effects, including locally derived expiry.
  const availability = useMemo(() => source && phase && phase !== source.phase ? { ...source, phase } : source, [source, phase]);
  const due = availability?.phase === "active" ? availability.availableUntil : availability?.deleteAt;
  useEffect(() => {
    if (due === undefined || due <= now) return;
    const timer = setTimeout(() => { setClockRevision(value => value + 1); refresh(); }, Math.max(1, due - now));
    return () => clearTimeout(timer);
  }, [due, current, clockRevision, refresh]);
  return { availability, refresh };
}
