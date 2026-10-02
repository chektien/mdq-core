import { useEffect, useMemo, useState } from "react";
import type { SessionAvailabilityPayload } from "@mdq/shared";
import { configureSessionAvailability } from "../hooks/api";
import { useSessionAvailability } from "../hooks/useSessionAvailability";
import SessionAvailabilityInfo from "./SessionAvailabilityInfo";
import AvailabilityChoiceControl, { AVAILABILITY_PRESETS, availabilityRequest, deadlineProblem, firstCustomTime, type AvailabilityChoice } from "./AvailabilityChoice";

/** Presenter-only management. Never mount directly on a shared join/results screen. */
export default function SessionAvailabilitySettings({ sessionId, observed }: { sessionId: string; observed?: SessionAvailabilityPayload | null }) {
  const { availability, refresh } = useSessionAvailability(sessionId, observed);
  const [choice, setChoice] = useState<AvailabilityChoice | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now);
  const anchor = useMemo(() => ({ value: availability?.serverNow ?? Date.now(), receivedAt: Date.now() }), [availability?.serverNow]);
  const now = anchor.value + clock - anchor.receivedAt;
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => { setEditing(false); setChoice(null); setError(null); }, [sessionId]);
  const editable = availability?.availableUntil !== undefined && (availability.phase === "active" || availability.phase === "expired");
  const previous = availability?.availableUntil;
  function open() {
    const instant = anchor.value + Date.now() - anchor.receivedAt;
    setClock(Date.now());
    const preset = AVAILABILITY_PRESETS.filter(p => p.key !== "4h").find(p => instant + p.duration > (previous ?? instant));
    setChoice(preset ? { kind: "preset", key: preset.key } : { kind: "exact", value: firstCustomTime(instant, previous) });
    setEditing(true);
  }
  async function save() {
    if (!editable || !choice || deadlineProblem(choice, anchor.value + Date.now() - anchor.receivedAt, previous)) return;
    setBusy(true); setError(null);
    const request = availabilityRequest(choice);
    try { await configureSessionAvailability(sessionId, "availableForMs" in request ? { extendForMs: request.availableForMs } : request); setEditing(false); refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Availability could not be updated"); }
    finally { setBusy(false); }
  }
  return <section className="session-settings w-full" aria-label="Session availability">
    <SessionAvailabilityInfo availability={availability} />
    {editable && (!editing ? <button className="session-options-button" type="button" onClick={open}>{availability.phase === "expired" ? "Extend & reopen" : "Extend availability"}</button> : <>
      <AvailabilityChoiceControl choice={choice!} onChange={setChoice} now={now} previous={previous} disabled={busy} extension />
      <p className="text-sm text-zinc-400">Same link, participants and answers. Question timers do not restart.</p>
      <div className="availability-actions"><button type="button" className="session-options-button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
      <button className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-semibold py-3 px-4 rounded-xl" type="button" disabled={!choice || !!deadlineProblem(choice, now, previous) || busy} onClick={save}>{busy ? "Saving…" : availability.phase === "expired" ? "Extend & reopen" : "Extend availability"}</button></div>
    </>)}
    {error && <p className="text-sm text-red-200" role="alert">{error}</p>}
  </section>;
}
