import fs from "fs";
import path from "path";
import { ArchivedAttempt, Submission } from "@mdq/shared";
import { activeSubmission, activeSubmissions, activeSubmissionsBySeat, activeSubmissionsFor, activeSubmissionsOf, archiveActiveAttempt, archivedAttempts, currentAttempt, hasAnyAnswers, normalizeAttemptState, removeSeatAnswers } from "../attempts";
import { apply, participantStudyPayload, timingFor } from "../engine";
import { nextAvailabilityAlarm } from "../availability";
import { deserializeSession, recordSubmission, serializeSession } from "../session";
import { saveSubmissions, saveSessionSummaryMarkdown } from "../persistence";
import { ensureRunClassification } from "../run-classification";
import { goldenQuiz, goldenSession, readerOutputs, seats } from "./attempts-test-support";

beforeEach(() => { jest.spyOn(Date, "now").mockReturnValue(100); });
afterEach(() => jest.restoreAllMocks());
const answer = (questionIndex: number, studentId = "one", attempt?: number, selectedOptions = ["A"]): Submission => ({
  studentId, questionIndex, selectedOptions, submittedAt: 1000, responseTimeMs: 100, ...(attempt === undefined ? {} : { attempt }),
});
function scenario(index: number) {
  const run = goldenSession("self-paced");
  for (let i = 0; i < index; i++) run.step({ type: "next" }, 300);
  const clean = run.current();
  clean.questionAttempts = { [index]: 2 };
  clean.submissions = [index === 3 ? { ...answer(index, "one", 2), selectedOptions: [], responseText: "Current smoke response" } : answer(index, "one", 2)];
  const dirty = deserializeSession(serializeSession(clean));
  dirty.attemptArchive = [{ questionIndex: index, attempt: 1, archivedAt: 500, submissions: seats.map(id => answer(index, id)) }];
  // A duplicate active answer loses to the later entry even with a newer timestamp.
  dirty.submissions = [{ ...answer(index, "one", 2, ["B"]), submittedAt: 9000 }, ...dirty.submissions,
    ...seats.map(id => index === 3 ? { ...answer(index, id), responseText: "Old smoke response" } : answer(index, id))];
  return { clean, dirty };
}

it.each([0, 1, 2, 3])("all readers ignore archive, stray old answers and earlier duplicates for item %i", index => {
  const { clean, dirty } = scenario(index);
  expect(readerOutputs(dirty)).toEqual(readerOutputs(clean));
  for (const type of ["broadcastOpen", "broadcastReveal", "broadcastLeaderboard"] as const) {
    expect(apply(dirty, goldenQuiz, { type }, 9000).messages).toEqual(apply(clean, goldenQuiz, { type }, 9000).messages);
  }
  const cleanEnd = apply(clean, goldenQuiz, { type: "end" }, 5000).session;
  const dirtyEnd = apply(dirty, goldenQuiz, { type: "end" }, 5000).session;
  expect(readerOutputs(dirtyEnd)).toEqual(readerOutputs(cleanEnd));
  const expected = index === 2 ? { questionIndex: 2, voters: 1, counts: null, floor: 3 } : undefined;
  if (expected) {
    expect(participantStudyPayload(dirty, goldenQuiz, "one", 9000).items[index].pollLive).toEqual(expected);
    expect(participantStudyPayload(dirty, goldenQuiz, "two", 9000).items[index].pollLive).toBeUndefined();
  }
});

it("uses the last matching attempt in array order and preserves surviving order without mutating", () => {
  const session = goldenSession("presenter-paced").current();
  const first = answer(0), last = { ...answer(0), submittedAt: 0 };
  const other = answer(1, "two", 2);
  session.questionAttempts = { 1: 2 };
  session.submissions = [first, other, last, answer(1, "one"), answer(0, "two", 2)];
  const before = serializeSession(session);
  expect(activeSubmissions(session)).toEqual([other, last]);
  expect(activeSubmissionsFor(session, 1)).toEqual([other]);
  expect(activeSubmission(session, "one", 0)).toBe(last);
  expect(activeSubmission(session, "missing", 0)).toBeUndefined();
  expect(serializeSession(session)).toBe(before);
});

it.each([false, true])("new choice answers at attempt 2 are accepted after attempt 1 (legacy=%s)", legacy => {
  const session = goldenSession("presenter-paced", legacy).current();
  session.questionAttempts = { 0: 2 };
  session.submissions = [answer(0)];
  const before = serializeSession(session);
  const result = apply(session, goldenQuiz, { type: "answerSubmit", studentId: "one", sessionToken: "token-one", payload: { questionIndex: 0, selectedOptions: ["A"] } }, 1200);
  expect(result.messages.some(m => m.event === "answer:accepted")).toBe(true);
  expect(activeSubmission(result.session, "one", 0)).toMatchObject({ attempt: 2, selectedOptions: ["A"] });
  expect(serializeSession(session)).toBe(before);
  if (legacy) expect(recordSubmission(session, "two", 0, ["B"]).attempt).toBe(2);
});

it("open-response replacement targets the last active answer and keeps previous engine input immutable", () => {
  const { dirty } = scenario(3);
  const before = serializeSession(dirty);
  const result = apply(dirty, goldenQuiz, { type: "answerSubmit", studentId: "one", sessionToken: "token-one", payload: { questionIndex: 3, responseText: "Edited smoke response" } }, 1500);
  expect(activeSubmission(result.session, "one", 3)).toMatchObject({ attempt: 2, responseText: "Edited smoke response" });
  expect(serializeSession(dirty)).toBe(before);
});

it("legacy recordSubmission edits only the active open response", () => {
  const session = goldenSession("presenter-paced", true).current();
  session.currentQuestionIndex = 3; session.questionAttempts = { 3: 2 };
  session.submissions = [{ ...answer(3), responseText: "Old" }, { ...answer(3, "one", 2), responseText: "Current" }];
  expect(recordSubmission(session, "one", 3, { responseText: "Edited" }).attempt).toBe(2);
  expect(session.submissions[0].responseText).toBe("Old");
  expect(session.submissions[1].responseText).toBe("Edited");
});

it("archive-only evidence keeps all hasAnswers payloads true without active answers", () => {
  const { dirty } = scenario(2);
  dirty.submissions = [];
  expect(hasAnyAnswers(dirty)).toBe(true);
  const snapshot = apply(dirty, goldenQuiz, { type: "snapshot", view: "control" }, 9000).messages;
  expect(snapshot.filter(m => m.event === "session:state" || m.event === "answer:count").map(m => m.payload)).toEqual(expect.arrayContaining([
    expect.objectContaining({ hasAnswers: true }), expect.objectContaining({ hasAnswers: true, submitted: 0 }),
  ]));
  const broadcast = apply(dirty, goldenQuiz, { type: "broadcastOpen" }, 9000).messages;
  expect(broadcast.filter(m => m.event === "session:state").every(m => (m.payload as { hasAnswers?: boolean }).hasAnswers)).toBe(true);
  dirty.attemptArchive![0].submissions = [];
  expect(hasAnyAnswers(dirty)).toBe(false);
});

it("seat deletion removes active, stray and archived answers while preserving other seats and history", () => {
  const { dirty } = scenario(2);
  const oldArchive = dirty.attemptArchive;
  removeSeatAnswers(dirty, "one");
  expect(dirty.submissions.every(sub => sub.studentId !== "one")).toBe(true);
  expect(archivedAttempts(dirty)[0].submissions.map(sub => sub.studentId)).toEqual(["two", "three"]);
  expect(oldArchive![0].submissions).toHaveLength(3);
  removeSeatAnswers(dirty, "two"); removeSeatAnswers(dirty, "three");
  expect(hasAnyAnswers(dirty)).toBe(false);
  expect(archivedAttempts(dirty)).toHaveLength(1);
});

it("history is sorted by item then attempt without reordering stored arrays", () => {
  const session = goldenSession("presenter-paced").current();
  const entry = (questionIndex: number, attempt: number): ArchivedAttempt => ({ questionIndex, attempt, archivedAt: 100, submissions: [] });
  session.attemptArchive = [entry(2, 2), entry(0, 2), entry(2, 1), entry(0, 1)];
  const original = [...session.attemptArchive];
  expect(archivedAttempts(session).map(e => [e.questionIndex, e.attempt])).toEqual([[0, 1], [0, 2], [2, 1], [2, 2]]);
  expect(archivedAttempts(session, 2).map(e => e.attempt)).toEqual([1, 2]);
  expect(session.attemptArchive).toEqual(original);
});

it("original JSON reads as attempt 1 and empty archive, and round-trips byte for byte", () => {
  const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "attempts-origin-main.json"), "utf8")) as { serialized: string }[];
  for (const { serialized } of fixtures) {
    const session = deserializeSession(serialized);
    expect(currentAttempt(session, 1)).toBe(1); expect(archivedAttempts(session)).toEqual([]);
    expect(session).not.toHaveProperty("questionAttempts"); expect(session).not.toHaveProperty("attemptArchive");
    expect(serializeSession(session)).toBe(serialized);
  }
});

it("archives all listed state deterministically without mutating or sharing the input", () => {
  const { dirty } = scenario(1);
  dirty.questionTiming = { 1: { firstOpenedAt: 0, startedAt: 100, deadlineAt: 500, restarts: [{ restartedAt: 100, previousStartedAt: 0, previousDeadlineAt: 400 }], timingFairnessInvalidated: true } };
  dirty.questionStartedAt = 100; dirty.questionDeadlineAt = 500; dirty.closedByTimer = true;
  dirty.revealedQuestionIndexes = new Set([1]); dirty.hiddenResponses = { 1: ["key-two"] }; dirty.shownResponses = { 1: ["key-one"] }; dirty.liveResultsOverrides = { 1: false };
  const before = serializeSession(dirty);
  const next = archiveActiveAttempt(dirty, 1, 2000, goldenQuiz.questions[1]);
  expect(serializeSession(next)).toBe(serializeSession(archiveActiveAttempt(dirty, 1, 2000, goldenQuiz.questions[1])));
  expect(serializeSession(dirty)).toBe(before);
  expect(currentAttempt(next, 1)).toBe(3);
  expect(next.attemptArchive![1]).toEqual({ questionIndex: 1, attempt: 2, archivedAt: 2000, submissions: [dirty.submissions[1]], question: goldenQuiz.questions[1], timing: dirty.questionTiming[1], revealed: true, hiddenResponses: ["key-two"], shownResponses: ["key-one"], liveResultsOverride: false });
  expect(activeSubmissionsFor(next, 1)).toEqual([]); expect(next.submissions).toEqual([]);
  for (const field of ["questionTiming", "hiddenResponses", "shownResponses", "liveResultsOverrides", "questionStartedAt", "questionDeadlineAt", "closedByTimer"]) expect(next).not.toHaveProperty(field);
  expect(next.revealedQuestionIndexes!.has(1)).toBe(false);
  expect(next.releasedQuestionIndexes).toEqual(dirty.releasedQuestionIndexes);
  expect(deserializeSession(serializeSession(next))).toEqual(next);
  next.attemptArchive![1].timing!.restarts[0].restartedAt = 999;
  next.attemptArchive![0].submissions[0].selectedOptions.push("C");
  expect(serializeSession(dirty)).toBe(before);
});

it("archives an unanswered first attempt and preserves unrelated per-item state", () => {
  const session = goldenSession("presenter-paced").current();
  session.questionTiming = { 0: { startedAt: 10, deadlineAt: null, restarts: [] } };
  session.submissions = [answer(0)]; session.hiddenResponses = { 0: ["key-one"] };
  const next = archiveActiveAttempt(session, 1, 0);
  expect(next.attemptArchive).toEqual([{ questionIndex: 1, attempt: 1, archivedAt: 0, submissions: [] }]);
  expect(next.questionTiming).toEqual(session.questionTiming); expect(next.hiddenResponses).toEqual(session.hiddenResponses);
  expect(next.submissions).toEqual(session.submissions);
  expect(currentAttempt(next, 0)).toBe(1); expect(currentAttempt(next, 1)).toBe(2);
});

it.each([undefined, null, [], {}, { 0: 1, 1: 0, 2: -2, 3: 2.5, 4: "2", nope: 2, "-1": 2, "1.5": 2, "01": 2 }])("drops empty or malformed optional attempt state %j", invalid => {
  const session = goldenSession("presenter-paced").current();
  Object.assign(session, { questionAttempts: invalid, attemptArchive: invalid });
  const restored = deserializeSession(serializeSession(session));
  expect(restored).not.toHaveProperty("questionAttempts"); expect(restored).not.toHaveProperty("attemptArchive");
});

it("normalization drops unreadable attempts and bad optional fields, never the answers of a readable attempt", () => {
  const session = goldenSession("presenter-paced").current();
  const valid: ArchivedAttempt = { questionIndex: 0, attempt: 1, archivedAt: 0, submissions: [answer(0)] };
  Object.assign(session, { questionAttempts: { 0: 2, 1: 4, bad: 3, 2: 1, 3: 2.2 }, attemptArchive: [valid,
    null, {}, { ...valid, questionIndex: -1 }, { ...valid, attempt: 0 }, { ...valid, attempt: 1.5 },
    { ...valid, archivedAt: "now" }, { ...valid, submissions: null }, { ...valid, submissions: [{}, answer(0, "two")] },
    { ...valid, timing: "late" }, { ...valid, question: [] }, { ...valid, revealed: "true" },
    { ...valid, hiddenResponses: [42] }, { ...valid, shownResponses: "key" }, { ...valid, liveResultsOverride: 1 },
    { ...valid, question: { index: 0 }, timing: { startedAt: 1 }, laterReleaseField: { kept: true } },
  ] });
  normalizeAttemptState(session);
  expect(session.questionAttempts).toEqual({ 0: 2, 1: 4 });
  expect(session.attemptArchive).toEqual([valid, { ...valid, submissions: [answer(0, "two")] }, valid, valid, valid, valid, valid, valid,
    { ...valid, question: { index: 0 }, timing: { startedAt: 1 }, laterReleaseField: { kept: true } }]);
  const bytes = serializeSession(session); normalizeAttemptState(session); expect(serializeSession(session)).toBe(bytes);
});

it.each(["answer", "snapshot", "close", "reveal", "next", "end"])("engine %s never mutates a shared archive", command => {
  // Close and Reveal exist only in presenter-paced sessions.
  const { dirty: selfPaced } = scenario(2);
  const dirty = ["close", "reveal"].includes(command) ? Object.assign(goldenSession("presenter-paced").current(), { attemptArchive: selfPaced.attemptArchive, questionAttempts: { 0: 2 } }) : selfPaced;
  dirty.attemptArchive![0] = { ...dirty.attemptArchive![0], question: structuredClone(goldenQuiz.questions[2]), timing: { startedAt: 0, deadlineAt: null, restarts: [] }, hiddenResponses: ["key-one"], shownResponses: ["key-two"] };
  const deepFreeze = (value: unknown): void => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); } };
  deepFreeze(dirty.attemptArchive);
  const before = serializeSession(dirty);
  const first = command === "reveal" ? apply(dirty, goldenQuiz, { type: "close" }, 900).session : dirty;
  const next = apply(first, goldenQuiz, command === "answer" ? { type: "answerSubmit", studentId: "two", sessionToken: "token-two", payload: { questionIndex: 2, selectedOptions: ["B"] } }
    : { type: command, ...(command === "snapshot" ? { view: "control" } : {}) } as never, 1000).session;
  expect(next.attemptArchive).toBe(dirty.attemptArchive);
  next.questionAttempts![2] = 3;
  expect(serializeSession(dirty)).toBe(before);
});

it("purge clears both attempt fields and preserves the input session", () => {
  const { dirty } = scenario(2);
  dirty.availability = { schemaVersion: 1, generation: 1, availableUntil: 1000 };
  const alarm = nextAvailabilityAlarm(dirty, 1001)!;
  const before = serializeSession(dirty);
  const next = apply(dirty, goldenQuiz, { type: "purgeAvailability", alarm }, alarm.dueAt).session;
  expect(next.participants.size).toBe(0); expect(next.submissions).toEqual([]);
  expect(next).not.toHaveProperty("questionAttempts"); expect(next).not.toHaveProperty("attemptArchive");
  expect(serializeSession(dirty)).toBe(before);
});

it("persistence JSON, summary and classification consume the same projection", () => {
  // Mock only filesystem writes: exercise the real builders without private/runtime artifacts.
  const writes = new Map<string, string>();
  jest.spyOn(fs, "existsSync").mockReturnValue(false);
  jest.spyOn(fs, "mkdirSync").mockImplementation(() => undefined);
  jest.spyOn(fs, "writeFileSync").mockImplementation((file, data) => { writes.set(String(file), String(data)); });
  jest.spyOn(fs, "renameSync").mockImplementation(() => undefined);
  const { clean, dirty } = scenario(1);
  saveSubmissions(dirty, "/smoke");
  const json = JSON.parse([...writes.values()][0]);
  expect(json.submissionCount).toBe(1); expect(json.submissions).toEqual(activeSubmissions(clean));
  saveSessionSummaryMarkdown(clean, goldenQuiz, "/smoke", 9000);
  const cleanSummary = [...writes.values()].find(text => text.startsWith("#"));
  expect(cleanSummary).toBeDefined();
  saveSessionSummaryMarkdown(dirty, goldenQuiz, "/smoke", 9000);
  expect([...writes.values()].find(text => text.startsWith("#"))).toBe(cleanSummary);
  expect(ensureRunClassification(dirty, goldenQuiz, "/smoke", 9000).evidence?.answeredQuestions).toBe(1);
});

it("only active poll voters receive updates and three active voters clear the floor", () => {
  const { dirty } = scenario(2);
  dirty.submissions.push(answer(2, "two", 2, ["B"]));
  const before = participantStudyPayload(dirty, goldenQuiz, "two", 9000).items[2].pollLive;
  expect(before).toEqual({ questionIndex: 2, voters: 2, counts: null, floor: 3 });
  const result = apply(dirty, goldenQuiz, { type: "answerSubmit", studentId: "three", sessionToken: "token-three", payload: { questionIndex: 2, selectedOptions: ["C"] } }, 1000);
  const live = result.messages.filter(m => m.event === "poll:live");
  expect(live.map(m => m.audience)).toEqual(["control", "display", "participant:one", "participant:two", "participant:three"]);
  expect(live.find(m => m.audience === "display")?.payload).toEqual({ questionIndex: 2, voters: 3, counts: { A: 1, B: 1, C: 1 } });
});

it("inactive stray entries alone are not answer evidence and seat removal does not invent history", () => {
  const { clean } = scenario(1);
  clean.submissions = [answer(1)];
  expect(hasAnyAnswers(clean)).toBe(false);
  removeSeatAnswers(clean, "one");
  expect(clean.submissions).toEqual([]);
  expect(clean).not.toHaveProperty("attemptArchive");
});

it("archiving a legacy session keeps the current item's clock from the legacy fields", () => {
  const session = goldenSession("presenter-paced", true).current();
  const index = session.currentQuestionIndex, question = { ...goldenQuiz.questions[index], timeLimitSec: 30 };
  delete session.questionTiming;
  Object.assign(session, { questionStartedAt: 500, questionDeadlineAt: 1500 });
  expect(archiveActiveAttempt(session, index, 2000, question).attemptArchive![0].timing).toEqual({ startedAt: 500, deadlineAt: 1500, restarts: [] });
  delete session.questionDeadlineAt;
  expect(archiveActiveAttempt(session, index, 2000, question).attemptArchive![0].timing).toEqual({ startedAt: 500, deadlineAt: 30_500, restarts: [] });
  expect(archiveActiveAttempt(session, index + 1, 2000).attemptArchive![0]).not.toHaveProperty("timing");
});

it("archiving an untimed legacy item records the deadline the engine uses, ignoring a stale stored one", () => {
  const session = goldenSession("presenter-paced", true).current();
  const index = session.currentQuestionIndex;
  delete session.questionTiming;
  Object.assign(session, { questionStartedAt: 500, questionDeadlineAt: 1500 });
  for (const question of [{ ...goldenQuiz.questions[index], timeLimitSec: null }, { ...goldenQuiz.questions[index], questionType: "slide" as const, timeLimitSec: 30 }]) {
    const quiz = { ...goldenQuiz, questions: goldenQuiz.questions.map((q, i) => i === index ? question : q) };
    expect(timingFor(session, quiz, index)!.deadlineAt).toBeNull();
    expect(archiveActiveAttempt(session, index, 2000, question).attemptArchive![0].timing).toEqual({ startedAt: 500, deadlineAt: null, restarts: [] });
  }
  expect(archiveActiveAttempt(session, index, 2000).attemptArchive![0].timing).toEqual({ startedAt: 500, deadlineAt: 1500, restarts: [] });
});

it("the narrower readers return exactly what filtering the full projection returns", () => {
  const session = goldenSession("presenter-paced").current();
  session.questionAttempts = { 1: 2 };
  const ids = ["one", "two", "three"];
  let n = 0;
  // Deterministic mix of duplicates, inactive attempts and several questions.
  session.submissions = Array.from({ length: 60 }, () => {
    n = (n * 37 + 11) % 97;
    return { ...answer(n % 3, ids[n % 3 === 1 ? (n >> 2) % 3 : (n >> 1) % 3], (n % 5 === 0 ? 2 : n % 7 === 0 ? 3 : undefined)), submittedAt: n };
  });
  const full = activeSubmissions(session);
  for (const index of [0, 1, 2, 3]) {
    const expected = full.filter(sub => sub.questionIndex === index);
    expect(activeSubmissionsFor(session, index)).toEqual(expected);
    expect([...activeSubmissionsBySeat(session, index).values()]).toEqual(expected);
    for (const id of ids) expect(activeSubmission(session, id, index)).toBe(expected.find(sub => sub.studentId === id));
  }
  for (const id of ids) expect(activeSubmissionsOf(session, id)).toEqual(full.filter(sub => sub.studentId === id));
});
