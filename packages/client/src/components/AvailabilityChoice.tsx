import { useId } from "react";
import { MAX_SESSION_AVAILABILITY_MS } from "@mdq/shared";
import { availabilityTimezone, formatAvailabilityTime, localAvailabilityInput } from "./SessionAvailabilityInfo";

export const AVAILABILITY_PRESETS = [
  { key: "2h", label: "2 hours", duration: 2 * 3_600_000 },
  { key: "4h", label: "4 hours", duration: 4 * 3_600_000 },
  { key: "24h", label: "24 hours", duration: 24 * 3_600_000 },
  { key: "3d", label: "3 days", duration: 72 * 3_600_000 },
] as const;
export type AvailabilityChoice = { kind: "preset"; key: string } | { kind: "exact"; value: string };
export function availabilityRequest(choice: AvailabilityChoice): { availableForMs: number } | { availableUntil: number } {
  return choice.kind === "preset" ? { availableForMs: AVAILABILITY_PRESETS.find(p => p.key === choice.key)?.duration ?? 4 * 3_600_000 } : { availableUntil: new Date(choice.value).getTime() };
}
export function choiceDeadline(choice: AvailabilityChoice, now: number): number {
  const request = availabilityRequest(choice);
  return "availableForMs" in request ? now + request.availableForMs : request.availableUntil;
}
export function deadlineProblem(choice: AvailabilityChoice, now: number, previous?: number): string | null {
  const until = choiceDeadline(choice, now);
  if (!Number.isSafeInteger(until) || until <= now) return "Choose a time later than now.";
  if (previous !== undefined && until <= previous) return "Choose a time after the current end.";
  if (until > now + MAX_SESSION_AVAILABILITY_MS) return "Choose a time within the next seven days.";
  if (choice.kind === "exact" && localAvailabilityInput(until) !== choice.value) return "This local time is unavailable. Choose another time.";
  return null;
}
export function firstCustomTime(now: number, previous?: number): string {
  const lower = Math.max(now, previous ?? now);
  return localAvailabilityInput(Math.ceil((lower + 1) / 900_000) * 900_000);
}
export function allowedDays(now: number, previous?: number): { value: string; label: string }[] {
  const first = new Date(Math.max(now, previous ?? now));
  first.setHours(12, 0, 0, 0);
  const last = localAvailabilityInput(now + MAX_SESSION_AVAILABILITY_MS).slice(0, 10);
  const days: { value: string; label: string }[] = [];
  for (let i = 0; i <= 7; i++) {
    const value = localAvailabilityInput(first.getTime()).slice(0, 10);
    if (value > last) break;
    days.push({ value, label: new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" }).format(first) });
    first.setDate(first.getDate() + 1);
  }
  return days;
}
/** Only allowed days exist in the select, including on browsers with unbounded system pickers. */
export default function AvailabilityChoiceControl({ choice, onChange, now, previous, disabled = false, extension = false }: {
  choice: AvailabilityChoice; onChange: (choice: AvailabilityChoice) => void; now: number; previous?: number; disabled?: boolean; extension?: boolean;
}) {
  const id = useId();
  const problem = deadlineProblem(choice, now, previous);
  const until = choiceDeadline(choice, now);
  const days = allowedDays(now, previous);
  const custom = choice.kind === "exact" ? choice.value : firstCustomTime(now, previous);
  const day = custom.slice(0, 10), time = custom.slice(11, 16);
  const max = localAvailabilityInput(Math.floor((now + MAX_SESSION_AVAILABILITY_MS) / 900_000) * 900_000);
  const min = localAvailabilityInput(Math.max(now, previous ?? now));
  const presets = extension ? AVAILABILITY_PRESETS.filter(p => p.key !== "4h") : AVAILABILITY_PRESETS;
  return <fieldset className="availability-choice" disabled={disabled}>
    <legend>{extension ? "New end time" : "Available until"}</legend>
    {presets.map(p => {
      const blocked = previous !== undefined && now + p.duration <= previous;
      return <label className="availability-option" key={p.key}>
        <input type="radio" name={`${id}-choice`} checked={choice.kind === "preset" && choice.key === p.key} disabled={blocked} onChange={() => onChange({ kind: "preset", key: p.key })} />
        <span>{p.label} {extension ? "from now" : "from when you present"}{blocked && " · already open longer"}</span>
      </label>;
    })}
    <label className="availability-option"><input type="radio" name={`${id}-choice`} checked={choice.kind === "exact"} onChange={() => onChange({ kind: "exact", value: firstCustomTime(now, previous) })} />Choose day and time</label>
    {choice.kind === "exact" && <div className="availability-day-time">
      <label htmlFor={`${id}-day`}>Day<select id={`${id}-day`} value={day} onChange={e => onChange({ kind: "exact", value: `${e.target.value}T${time || "12:00"}` })}>
        {!days.some(d => d.value === day) && <option value={day} disabled>Choose an allowed day</option>}
        {days.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
      </select></label>
      <label htmlFor={`${id}-time`}>Time ({availabilityTimezone()})<input id={`${id}-time`} type="time" step="60" value={time} min={day === min.slice(0, 10) ? min.slice(11, 16) : undefined} max={day === max.slice(0, 10) ? max.slice(11, 16) : undefined} onChange={e => onChange({ kind: "exact", value: `${day}T${e.target.value}` })} /></label>
    </div>}
    {problem ? <p role="alert">{problem}{choice.kind === "exact" && day === max.slice(0, 10) && ` Latest allowed is ${formatAvailabilityTime(new Date(max).getTime())}.`}</p>
      : <p className="availability-preview">{extension ? "Until" : choice.kind === "preset" ? "Expected until" : "Until"} {formatAvailabilityTime(until)}</p>}
    {!extension && <p className="availability-preview">Up to seven days. Availability ending closes answers without showing results.</p>}
  </fieldset>;
}
