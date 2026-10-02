import { useEffect, useState } from "react";
import { MAX_SESSION_AVAILABILITY_MS, type SessionAvailabilityPayload } from "@mdq/shared";
import { configureSessionAvailability } from "../hooks/api";
import { useSessionAvailability } from "../hooks/useSessionAvailability";
import SessionAvailabilityInfo, { availabilityTimezone, formatAvailabilityTime, localAvailabilityInput } from "./SessionAvailabilityInfo";

/** Presenter-only mutation UI, shared with hosted presenter adapters. Server auth remains mandatory. */
export default function SessionAvailabilitySettings({ sessionId, observed }: { sessionId: string; observed?: SessionAvailabilityPayload | null }) {
  const { availability, refresh } = useSessionAvailability(sessionId, observed);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setValue(""); setError(null); }, [sessionId]);
  const until = value ? new Date(value).getTime() : NaN;
  const editable = availability?.availableUntil !== undefined && (availability.phase === "active" || availability.phase === "expired");
  const valid = editable && Number.isSafeInteger(until) && until > availability.availableUntil! && until > availability.serverNow && until <= availability.serverNow + MAX_SESSION_AVAILABILITY_MS;
  async function save() {
    if (!valid) return;
    setBusy(true); setError(null);
    try { await configureSessionAvailability(sessionId, until); setValue(""); refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "Availability could not be updated"); }
    finally { setBusy(false); }
  }
  return <section className="session-settings w-full" aria-label="Session availability">
    <SessionAvailabilityInfo availability={availability} />
    {editable && <>
      <label className="block text-sm py-2">New available-until date and time ({availabilityTimezone()})
        <input className="block w-full bg-zinc-800 text-white border border-zinc-700 rounded-xl p-3" type="datetime-local" value={value} min={localAvailabilityInput(Math.max(availability.serverNow, availability.availableUntil!))} max={localAvailabilityInput(availability.serverNow + MAX_SESSION_AVAILABILITY_MS)} onChange={event => setValue(event.target.value)} disabled={busy} />
      </label>
      <p className="text-sm text-zinc-400">Choose a later deadline, up to seven days from server now. Question clocks and saved answers stay unchanged.</p>
      {Number.isFinite(until) && <p className="text-sm">New deadline {formatAvailabilityTime(until)}</p>}
      <button className="bg-indigo-600 hover:bg-indigo-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-semibold py-3 px-4 rounded-xl" type="button" disabled={!valid || busy} onClick={save}>{busy ? "Saving..." : availability.phase === "expired" ? "Extend & reopen" : "Extend availability"}</button>
    </>}
    {error && <p className="text-sm text-red-200" role="alert">{error}</p>}
  </section>;
}
