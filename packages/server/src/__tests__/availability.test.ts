import { DEFAULT_SESSION_AVAILABILITY_MS, MAX_SESSION_AVAILABILITY_MS, PARTICIPANT_RESULT_RETENTION_MS, SESSION_RECOVERY_MS, Session, SocketEvents } from "@mdq/shared";
import { apply, audienceReaches, leaderboardRows, participantResultsPayload, participantStudyPayload, publicQuestionPayload } from "../engine";
import { availabilityPayload, nextAvailabilityAlarm, sessionAvailabilityPhase } from "../availability";
import { createSession, deserializeSession, serializeSession } from "../session";
import { parseQuizMarkdown } from "../parser";
const quiz = parseQuizMarkdown(`# Synthetic availability\n---\n## Released\ntime-limit: none\nChoose.\nA. One\nB. Two\n> Correct Answer: A\n> Overall Feedback: SECRET_EXPLANATION\n---\n## FUTURE_PRIVATE\nA. Next\nB. Other\n> Correct Answer: B\n`, "synthetic").quiz!;
function open(pacing: "presenter-paced" | "self-paced" = "self-paced", until = 10_000): Session {
  let session = createSession("synthetic", "open");
  session.createdAt = 0;
  session.availability = { schemaVersion: 1, availableUntil: until, generation: 1 };
  session = apply(session, quiz, { type: "configurePolicy", role: "control", pacing }, 0).session;
  session = apply(session, quiz, { type: "start" }, 0).session;
  return apply(session, quiz, { type: "join", socketId: "sock", newToken: "token", payload: { studentId: "synthetic-seat", clientInstanceId: "device" } }, 0).session;
}
const answer = (session: Session, now: number) => apply(session, quiz, { type: "answerSubmit", studentId: "synthetic-seat", sessionToken: "token", payload: { questionIndex: 0, selectedOptions: ["A"] } }, now);
const rejected = (result: ReturnType<typeof apply>) => result.messages.find(item => item.event === SocketEvents.ANSWER_REJECTED);

it("new sessions default to exactly four hours and unknown legacy availability stays optional", () => {
  const session = createSession("synthetic", "open");
  expect(session.availability).toEqual({ schemaVersion: 1, availableUntil: session.createdAt + DEFAULT_SESSION_AVAILABILITY_MS, generation: 1 });
  session.availability = undefined;
  const restored = deserializeSession(serializeSession(session));
  expect(restored.availability).toBeUndefined();
  expect(nextAvailabilityAlarm(restored, Number.MAX_SAFE_INTEGER)).toBeNull();
  expect(() => apply(restored, quiz, { type: "configureAvailability", role: "control", availableUntil: 100 }, 0)).toThrow("explicitly adopted");
});
it.each(["presenter-paced", "self-paced"] as const)("%s expiry is not End and serialized answers use server time even without a fired alarm", pacing => {
  const session = open(pacing);
  expect(answer(session, 9_999).session.submissions).toHaveLength(1);
  expect(rejected(answer(session, 10_000))).toBeDefined();
  const alarm = nextAvailabilityAlarm(session, 9_999)!;
  const expired = apply(session, quiz, { type: "expireAvailability", alarm }, 10_000);
  expect(expired.session.state).toBe(session.state);
  expect(expired.session.resultScope).toBeUndefined();
  expect(expired.nextDeadline).toBeNull();
  expect(expired.nextAvailabilityAlarm?.dueAt).toBe(10_000 + SESSION_RECOVERY_MS);
  expect(rejected(answer(expired.session, 10_000))).toBeDefined();
  expect(participantResultsPayload(expired.session, quiz, "synthetic-seat", 10_000)).toBeNull();
  expect(participantStudyPayload(expired.session, quiz, "synthetic-seat", 10_000).answerableQuestionIndexes).toEqual([]);
});
it.each(["presenter-paced", "self-paced"] as const)("%s expired public snapshot/broadcast/study never serialize any prior reveal or scored rank", pacing => {
  let session = answer(open(pacing), 1).session;
  if (pacing === "presenter-paced") {
    session = apply(session, quiz, { type: "close" }, 2).session;
    session = apply(session, quiz, { type: "reveal" }, 3).session;
    expect(session.revealedQuestionIndexes?.has(0)).toBe(true);
  }
  for (const command of [
    { type: "snapshot", view: "display" } as const,
    { type: "snapshot", participantId: "synthetic-seat", isReconnect: true } as const,
    { type: "broadcastReveal" } as const, { type: "broadcastLeaderboard" } as const,
  ]) {
    const result = apply(session, quiz, command, 10_000);
    const publicMessages = result.messages.filter(message => audienceReaches(message.audience, "display") || audienceReaches(message.audience, "participant"));
    expect(JSON.stringify(publicMessages)).not.toMatch(/correctOptions|explanation|distribution|correctCount|rank|SECRET_EXPLANATION|FUTURE_PRIVATE/);
  }
  expect(leaderboardRows(session, quiz, "public", 10_000)).toEqual([]);
  expect(publicQuestionPayload(session, quiz, 1, 10_000)).toBeNull();
});
it("expired joins require a still-valid seat token, never same-browser/name takeover or a new seat", () => {
  const session = open();session.participants.get("synthetic-seat")!.connected = false;
  const join = (payload: { studentId: string; sessionToken?: string; clientInstanceId?: string }) => apply(session, quiz, { type: "join", payload, socketId: "rejoin", newToken: "new" }, 10_000);
  expect(join({ studentId: "synthetic-seat", sessionToken: "token" }).messages.some(item => item.event === SocketEvents.STUDENT_JOINED)).toBe(true);
  for (const payload of [{ studentId: "new-seat" }, { studentId: "synthetic-seat", clientInstanceId: "device" }, { studentId: "synthetic-seat", sessionToken: "bad" }]) {
    expect(join(payload).messages.some(item => item.event === SocketEvents.STUDENT_REJECTED)).toBe(true);
  }
  session.participants.get("synthetic-seat")!.released = true;
  expect(join({ studentId: "synthetic-seat", sessionToken: "token" }).messages.some(item => item.event === SocketEvents.STUDENT_REJECTED)).toBe(true);
});
it("authenticated recovery preserves serialized immutable quiz/policy/seats/submissions/release and timing, stale alarms lose", () => {
  const session = answer(open(), 5).session;
  const expiry = nextAvailabilityAlarm(session, 9_000)!;
  const purge = nextAvailabilityAlarm(session, 10_000)!;
  const until = 30_000;
  const recovered = apply(deserializeSession(serializeSession(session)), quiz, { type: "configureAvailability", role: "control", availableUntil: until }, 20_000).session;
  expect(recovered.availability).toEqual({ schemaVersion: 1, availableUntil: until, generation: 2 });
  expect(serializeSession({ ...recovered, availability: session.availability })).toBe(serializeSession(session));
  for (const [type, alarm, now] of [["expireAvailability", expiry, 30_001], ["purgeAvailability", purge, purge.dueAt]] as const) {
    const stale = apply(recovered, quiz, { type, alarm }, now);
    expect(stale.session.deletedAt).toBeUndefined();
    expect(stale.session.participants.size).toBe(1);expect(stale.messages).toEqual([]);
  }
  expect(() => apply(session, quiz, { type: "configureAvailability", role: "participant", availableUntil: until }, 20_000)).toThrow("presenter");
  expect(() => apply(session, quiz, { type: "configureAvailability", role: "control", availableUntil: 10_000 }, 5_000)).toThrow("later");
  expect(() => apply(session, quiz, { type: "configureAvailability", role: "control", availableUntil: 20_000 + MAX_SESSION_AVAILABILITY_MS + 1 }, 20_000)).toThrow("seven days");
  expect(() => apply(session, quiz, { type: "configureAvailability", role: "control", availableUntil: 2 * SESSION_RECOVERY_MS }, 10_000 + SESSION_RECOVERY_MS)).toThrow("deleted");
});
it("legacy numeric question clocks and revealed attempts cannot receive a new reward after availability recovery", () => {
  const session = open("presenter-paced");session.policy = undefined;
  session.deckSnapshot = undefined;
  const numericQuiz = { ...quiz, questions: quiz.questions.map(q => ({ ...q, timeLimitSec: 10 })) };
  session.questionStartedAt = 0;session.questionDeadlineAt = 10;session.questionTiming = undefined;
  const extended = apply(session, numericQuiz, { type: "configureAvailability", role: "control", availableUntil: 20_000 }, 10_001).session;
  expect(extended.questionStartedAt).toBe(0);expect(extended.questionDeadlineAt).toBe(10);
  const legacyAnswer = () => apply(extended, numericQuiz, { type: "answerSubmit", studentId: "synthetic-seat", sessionToken: "token", payload: { questionIndex: 0, selectedOptions: ["A"] } }, 10_002);
  expect(rejected(legacyAnswer())?.payload).toMatchObject({ reason: "The question deadline has passed." });
  extended.revealedQuestionIndexes?.add(0);
  expect(rejected(legacyAnswer())?.payload).toMatchObject({ reason: "Revealed questions do not accept answers." });
});
it("End during recovery starts its own seven days, is idempotent/final, and defeats the old purge", () => {
  const session = answer(open(), 5).session;
  const oldPurge = nextAvailabilityAlarm(session, 10_000)!;
  const ended = apply(session, quiz, { type: "end" }, 20_000).session;
  expect(availabilityPayload(ended, 20_000)).toMatchObject({ phase: "ended", resultRetainedUntil: 20_000 + PARTICIPANT_RESULT_RETENTION_MS });
  expect(availabilityPayload(ended, 20_000).recoverBefore).toBeUndefined();
  expect(participantResultsPayload(ended, quiz, "synthetic-seat", 20_000)?.questions[0].correct).toBe(true);
  expect(apply(ended, quiz, { type: "end" }, 30_000).session.resultScope).toEqual(ended.resultScope);
  expect(() => apply(ended, quiz, { type: "configureAvailability", role: "control", availableUntil: 40_000 }, 30_000)).toThrow("cannot be reopened");
  expect(apply(ended, quiz, { type: "purgeAvailability", alarm: oldPurge }, oldPurge.dueAt).session.deletedAt).toBeUndefined();
  const purge = nextAvailabilityAlarm(ended, 20_000)!;
  const deleted = apply(ended, quiz, { type: "purgeAvailability", alarm: purge }, purge.dueAt).session;
  expect(sessionAvailabilityPhase(deleted, purge.dueAt)).toBe("deleted");expect(deleted.submissions).toEqual([]);
  expect(participantResultsPayload(deleted, quiz, "synthetic-seat", purge.dueAt)).toBeNull();
});
it("unrecovered expiry purges without End, result scope or disclosure", () => {
  const session = answer(open(), 5).session;
  const alarm = nextAvailabilityAlarm(session, 10_000)!;
  const deleted = apply(session, quiz, { type: "purgeAvailability", alarm }, alarm.dueAt);
  expect(deleted.session.resultScope).toBeUndefined();expect(deleted.session.state).toBe("QUESTION_OPEN");
  expect(deleted.session.participants.size).toBe(0);expect(deleted.session.submissions).toEqual([]);
  expect(deleted.messages.map(item => item.event)).toEqual([SocketEvents.SESSION_AVAILABILITY]);
  expect(participantStudyPayload(deleted.session, quiz, "synthetic-seat", alarm.dueAt).items).toEqual([]);
  expect(() => apply(deleted.session, quiz, { type: "end" }, alarm.dueAt)).toThrow("deleted");
});

it("duration extension resolves at command time and rejects ambiguous, shorter or out-of-bounds requests", () => {
  const session = createSession("synthetic", "open");
  session.availability = { schemaVersion: 1, availableUntil: 10_000, generation: 1 };
  const changed = apply(session, quiz, { type: "configureAvailability", role: "control", extendForMs: 7_200_000 }, 5000).session;
  expect(changed.availability?.availableUntil).toBe(7_205_000);
  for (const request of [{ extendForMs: 7_200_000, availableUntil: 7_205_000 }, { extendForMs: 60_000 }, { extendForMs: 604_800_001 }, { extendForMs: NaN }]) {
    expect(() => apply(changed, quiz, { type: "configureAvailability", role: "control", ...request }, 5000)).toThrow();
  }
});


it("adapter retention survives restore, keeps expiry private, and leaves the seven-day access ceiling unchanged", () => {
  const day = 86_400_000, retention = 90 * day;
  let session = answer(open(), 5).session;
  session.retention = { recoveryMs: retention, resultsMs: retention };
  session = deserializeSession(serializeSession(session));
  const until = session.availability!.availableUntil;
  expect(sessionAvailabilityPhase(session, until + 7 * day)).toBe("expired");
  expect(availabilityPayload(session, until)).toMatchObject({ recoverBefore: until + retention, deleteAt: until + retention });
  expect(participantResultsPayload(session, quiz, "synthetic-seat", until + 30 * day)).toBeNull();
  expect(() => apply(session, quiz, { type: "configureAvailability", role: "control", availableUntil: until + 30 * day + MAX_SESSION_AVAILABILITY_MS + 1 }, until + 30 * day)).toThrow("seven days");
  const recovered = apply(session, quiz, { type: "configureAvailability", role: "control", extendForMs: day }, until + 30 * day).session;
  expect(recovered.retention).toEqual(session.retention);
  expect(recovered.submissions).toEqual(session.submissions);
  const endedAt = until + 40 * day;
  const ended = apply(session, quiz, { type: "end" }, endedAt).session;
  expect(nextAvailabilityAlarm(ended, endedAt)?.dueAt).toBe(endedAt + retention);
  expect(sessionAvailabilityPhase(ended, endedAt + 7 * day)).toBe("ended");
  expect(sessionAvailabilityPhase(ended, endedAt + retention - 1)).toBe("ended");
  expect(sessionAvailabilityPhase(ended, endedAt + retention)).toBe("deleted");
  expect(sessionAvailabilityPhase(session, until + retention - 1)).toBe("expired");
  expect(sessionAvailabilityPhase(session, until + retention)).toBe("deleted");
});
it("invalid adapter retention cannot invent an infinite or negative window", () => {
  for (const value of [NaN, Infinity, -1, 0, 1.5]) {
    const session = open(); session.retention = { recoveryMs: value, resultsMs: value };
    expect(nextAvailabilityAlarm(session, 10_000)?.dueAt).toBe(10_000 + SESSION_RECOVERY_MS);
  }
});
