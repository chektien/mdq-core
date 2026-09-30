import { useEffect, useState } from "react";
import type { SessionParticipantsPayload } from "@mdq/shared";
import { type FreedSeats, isSeatFreed, pruneFreedSeats } from "../participantSeats";

type OnlineEntry = SessionParticipantsPayload["participants"][number];
type OfflineEntry = NonNullable<SessionParticipantsPayload["offline"]>[number];

/**
 * Who has joined, for the instructor. Names always show; Student IDs show only
 * when `showStudentIds` is on. Each person has a "Let rejoin" action for a
 * phone that died: it asks in place, then frees their seat so the next join
 * with their ID (or name) from any device takes it over and keeps their answers.
 */
export default function ParticipantList({
  participants,
  showStudentIds,
  onRelease,
  disabled = false,
}: {
  participants: SessionParticipantsPayload | null;
  showStudentIds: boolean;
  onRelease?: (publicKey: string) => Promise<void>;
  /** True while the instructor's screen is offline or busy: the action waits. */
  disabled?: boolean;
}) {
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [freed, setFreed] = useState<FreedSeats>({});
  const [error, setError] = useState<string | null>(null);

  // The row follows the live list: once a phone takes a freed seat the person is online and the local mark goes.
  useEffect(() => {
    setFreed((prev) => pruneFreedSeats(prev, participants));
  }, [participants]);

  const online = participants?.participants ?? [];
  const offline = participants?.offline ?? [];
  if (online.length === 0 && offline.length === 0) return null;

  const release = async (publicKey: string) => {
    if (!onRelease) return;
    setBusyKey(publicKey);
    setError(null);
    try {
      await onRelease(publicKey);
      setFreed((prev) => ({ ...prev, [publicKey]: true }));
      setConfirmKey(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work. Please try again.");
    } finally {
      setBusyKey(null);
    }
  };

  const renderRow = (person: OnlineEntry | OfflineEntry, isOffline: boolean) => {
    const label = person.label || "Participant";
    const id = "studentId" in person ? person.studentId : undefined;
    const isFreed = isSeatFreed(isOffline, "released" in person ? person.released : undefined, freed, person.publicKey);
    const confirming = confirmKey === person.publicKey;
    const busy = busyKey === person.publicKey;
    return (
      <li key={person.publicKey} className={`participant-row${isOffline ? " participant-row-offline" : ""}`}>
        <span className="participant-name">
          {label}
          {showStudentIds && id && id !== label && <span className="participant-id">{id}</span>}
        </span>
        {isFreed ? (
          <span className="participant-freed">Free to join again</span>
        ) : confirming ? (
          <span className="participant-confirm" role="group" aria-label={`Let ${label} join again`}>
            <span className="participant-confirm-text">
              Let {label} join again from a new device? Their answers are kept.
            </span>
            <button
              type="button"
              className="participant-action participant-action-confirm"
              disabled={disabled || busy}
              onClick={() => void release(person.publicKey)}
            >
              {busy ? "Working..." : "Let rejoin"}
            </button>
            <button type="button" className="participant-action" onClick={() => setConfirmKey(null)}>
              Cancel
            </button>
          </span>
        ) : onRelease ? (
          <button
            type="button"
            className="participant-action"
            disabled={disabled}
            title={disabled ? "Reconnecting..." : undefined}
            aria-label={`Let ${label} join again`}
            onClick={() => { setError(null); setConfirmKey(person.publicKey); }}
          >
            Let rejoin
          </button>
        ) : null}
      </li>
    );
  };

  return (
    <div className="participant-list">
      {online.length > 0 && (
        <ul className="participant-rows" aria-label="Students online">
          {online.map((person) => renderRow(person, false))}
        </ul>
      )}
      {offline.length > 0 && (
        <>
          <p className="participant-group-title">Not connected right now</p>
          <ul className="participant-rows" aria-label="Students not connected">
            {offline.map((person) => renderRow(person, true))}
          </ul>
        </>
      )}
      {error && <p role="alert" className="participant-error">{error}</p>}
    </div>
  );
}
