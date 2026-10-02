import request from "supertest";
import fs from "fs";
import os from "os";
import path from "path";
import { Quiz, Question, Session, SocketEvents } from "@mdq/shared";
import { apply, audienceReaches, Command, leaderboardRows, publicQuestionPayload } from "../engine";
import { createSession, deserializeSession, serializeSession, clearAllSessions, getSession, recordSubmission } from "../session";
import { effectiveRanking, getSessionScoredQuestionCount, publicResultsHidden, resultMetadata } from "../policy";
import { buildResultsCsv } from "../results-csv";
import { saveSessionSnapshot, saveWeeklyResult, loadWeeklyResult, computeCumulativeLeaderboard } from "../persistence";
import { createApp } from "../app";
import { clearInstructorSessionsForTests } from "../instructor-auth";
import { startQuestionTimer } from "../socket";

const item = (index: number, extra: Partial<Question> = {}): Question => ({ index, topic: `Synthetic ${index}`, textMd: "Choose", textHtml: "Choose",
  options: [{ label: "A", textMd: "one", textHtml: "one" }, { label: "B", textMd: "two", textHtml: "two" }], correctOptions: ["A"],
  explanation: "SECRET_EXPLANATION", allowsMultiple: false, timeLimitSec: 10, ...extra });
const deck: Quiz = { week: "synthetic", title: "Synthetic", sourceFile: "synthetic.md", questions: [item(0), item(1, {
  options: [{ label: "X", textMd: "x", textHtml: "x" }], correctOptions: ["X"] }), item(2), item(3, { questionType: "open_response", options: [], correctOptions: [] })] };
const run = (session: Session, command: Command, now = 0, quiz = deck) => apply(session, quiz, command, now);
const policy = (pacing: "presenter-paced" | "self-paced" = "self-paced", ranking?: "correctness" | "speed") => {
  const created = createSession("synthetic", "open");
  // Explicit v1 fixture retains the original opt-in result semantics.
  if (ranking !== undefined) created.policy = { schemaVersion: 1, pacing: "presenter-paced", ranking: "correctness", effectiveTiming: "authored" };
  return run(created, { type: "configurePolicy", role: "control", pacing, ranking }).session;
};
const start = (session = policy()) => run(session, { type: "start" }).session;
const join = (session: Session, id = "one") => run(session, { type: "join", payload: { studentId: id }, socketId: id, newToken: `token-${id}` }).session;
const answer = (session: Session, index: number, labels = ["A"], id = "one", now = 10) => run(session,
  { type: "answerSubmit", studentId: id, sessionToken: `token-${id}`, payload: { questionIndex: index, selectedOptions: labels } }, now);
const rejected = (result: ReturnType<typeof apply>) => result.messages.some((m) => m.event === SocketEvents.ANSWER_REJECTED);

it("new defaults are independent from legacy mode and freeze policy/deck at Start", () => {
  expect(createSession("synthetic", "strict").policy).toEqual({ schemaVersion: 2, pacing: "presenter-paced", ranking: "automatic", effectiveTiming: "authored" });
  const session = start();
  expect(() => recordSubmission(session, "one", 0, ["A"])).toThrow("authenticated answerSubmit");
  expect(() => run(session, { type: "configurePolicy", role: "control", pacing: "presenter-paced", ranking: "speed" })).toThrow("frozen");
  expect(() => run(policy(), { type: "configurePolicy", role: "participant", pacing: "self-paced", ranking: "correctness" })).toThrow("presenter");
  const changed: Quiz = { ...deck, questions: deck.questions.map((q) => ({ ...q, correctOptions: ["B"], textHtml: "CHANGED" })) };
  expect(publicQuestionPayload(session, changed, 0, 0)?.text).toBe("Choose");
  expect(session.deckSnapshot?.questions[0].timeLimitSec).toBe(10);
});

it.each(["presenter-paced", "self-paced"] as const)("%s timing/policy/release survive actual serialization and observer commands", (pacing) => {
  let session = start(policy(pacing));
  const expected = pacing === "self-paced" ? null : 10000;
  for (const command of [{ type: "broadcastOpen" }, { type: "snapshot", view: "display" }, { type: "snapshot", participantId: "one", isReconnect: true }] as Command[]) {
    const result = run(deserializeSession(serializeSession(session)), command, 4000);
    session = result.session;
    expect(result.nextDeadline).toBe(expected);
    expect(publicQuestionPayload(session, deck, 0, 4000)).toMatchObject({ firstOpenedAt: 0, startedAt: 0, deadlineAt: expected, timeLimitSec: pacing === "self-paced" ? null : 10 });
    expect([...session.releasedQuestionIndexes!]).toEqual([0]);
  }
});

it("self-paced Next/Previous keep earlier answers eligible and use submitted options, not presenter position", () => {
  let session = join(start());
  expect(publicQuestionPayload(session, deck, 1, 0)).toBeNull();
  expect(rejected(answer(session, 1, ["X"]))).toBe(true);
  session = run(session, { type: "next" }, 20000).session;
  expect(rejected(answer(session, 0, ["X"], "one", 999999))).toBe(true);
  const saved = answer(session, 0, ["A"], "one", 999999);
  expect(rejected(saved)).toBe(false);
  session = run(saved.session, { type: "previous" }, 1000000).session;
  expect(session.state).toBe("QUESTION_OPEN");
  expect(session.revealedQuestionIndexes?.size).toBe(0);
  expect(rejected(answer(session, 1, ["X"], "one", 1000001))).toBe(false);
  expect(rejected(answer(session, 0))).toBe(true);
  expect(run(session, { type: "timeout", deadline: 10000 }, 2000000).session.state).toBe("QUESTION_OPEN");
  expect(() => run(session, { type: "close" })).toThrow("until End");
  expect(() => run(session, { type: "reveal" })).toThrow("until End");
  expect(() => run(session, { type: "restartCountdown", role: "control" })).toThrow("timed");
});

it("monotonic release set does not authorize skipped future items or observational previews", () => {
  const session = join(start());
  session.currentQuestionIndex = 2; // an adapter's arbitrary jump never invents releases
  const observed = run(session, { type: "broadcastOpen" }).session;
  expect(publicQuestionPayload(observed, deck, 2, 0)).toBeNull();
  expect(rejected(answer(observed, 2))).toBe(true);
  expect(run(observed, { type: "broadcastReveal" }).messages.some((m) => m.event === SocketEvents.RESULTS_REVEAL)).toBe(false);
  const jumped = run(session, { type: "next" }).session;
  expect([...jumped.releasedQuestionIndexes!]).toEqual([0, 3]);
  expect(publicQuestionPayload(jumped, deck, 1, 0)).toBeNull();
});

it("seat token, End ordering, no new seats, and immutable result scope fail closed", () => {
  let session = join(start());
  expect(rejected(run(session, { type: "answerSubmit", studentId: "one", payload: { questionIndex: 0, selectedOptions: ["A"] } }))).toBe(true);
  expect(rejected(run(session, { type: "answerSubmit", studentId: "one", sessionToken: "wrong", payload: { questionIndex: 0, selectedOptions: ["A"] } }))).toBe(true);
  session = answer(session, 0).session;
  const ended = run(session, { type: "end" }, 20).session;
  expect(ended.resultScope).toMatchObject({ endedAt: 20, releasedQuestionIndexes: [0], scoredQuestionIndexes: [0], disclosed: true });
  expect(rejected(answer(ended, 0))).toBe(true);
  expect(run(ended, { type: "end" }, 100).session.resultScope).toEqual(ended.resultScope);
  expect(run(ended, { type: "join", payload: { studentId: "new" }, socketId: "new", newToken: "new" }).session.participants.size).toBe(1);
  expect(run(policy(), { type: "end" }).session.resultScope?.releasedQuestionIndexes).toEqual([]);
});

it("self-paced public projections omit results, keys, explanations, distributions and scored counts until deliberate End", () => {
  const session = answer(join(start()), 0).session;
  for (const command of [{ type: "broadcastOpen" }, { type: "broadcastReveal" }, { type: "broadcastLeaderboard" },
    { type: "leaderboardShow" }, { type: "snapshot", view: "display" }, { type: "snapshot", participantId: "one", isReconnect: true }] as Command[]) {
    const result = run(session, command);
    const exposed = result.messages.filter((m) => audienceReaches(m.audience, "display") || audienceReaches(m.audience, "participant"));
    for (const message of exposed) {
      expect([SocketEvents.RESULTS_REVEAL, SocketEvents.RESULTS_DISTRIBUTION, SocketEvents.LEADERBOARD_UPDATE, SocketEvents.ANSWER_COUNT]).not.toContain(message.event);
      expect(JSON.stringify(message.payload)).not.toMatch(/correctOptions|explanation|distribution|correctCount|rank|SECRET/);
    }
  }
  expect(leaderboardRows(session, deck, "public")).toEqual([]);
  expect(leaderboardRows(session, deck, "control")[0].correctCount).toBe(1);
  const expired = run(session, { type: "end", discloseResults: false }).session;
  expect(publicResultsHidden(deserializeSession(serializeSession(expired)))).toBe(true);
  expect(leaderboardRows(expired, deck, "public")).toEqual([]);
  const ended = run(session, { type: "end" }).session;
  expect(leaderboardRows(ended, deck, "public", 0)[0]).toEqual({ rank: 1, label: expect.any(String), publicKey: expect.any(String), correctCount: 1 });
});

it("correctness competition ties are 1,1,3 despite response times and only released scored items count", () => {
  let session = start();
  for (const id of ["one", "two", "three"]) session = join(session, id);
  session = answer(session, 0, ["A"], "one", 10).session;
  session = answer(session, 0, ["A"], "two", 90000).session;
  expect(leaderboardRows(session, deck, "control").map((r) => r.rank)).toEqual([1, 1, 3]);
  expect(getSessionScoredQuestionCount(session, deck)).toBe(1);
  expect(leaderboardRows(session, deck, "control").map((r) => r.correctCount)).toEqual([1, 1, 0]);
});

it("speed opt-in is presenter-only and falls back permanently for released untimed scored items or restart", () => {
  expect(() => policy("self-paced", "speed")).toThrow("Invalid");
  const session = start(policy("presenter-paced", "speed"));
  expect(effectiveRanking(session, deck)).toBe("speed");
  const restarted = run(session, { type: "restartCountdown", role: "control" }, 1000).session;
  expect(effectiveRanking(restarted, deck)).toBe("correctness");
  const quiz = { ...deck, questions: [item(0), item(1, { timeLimitSec: null })] };
  let untimed = run(policy("presenter-paced", "speed"), { type: "start" }, 0, quiz).session;
  expect(effectiveRanking(untimed, quiz)).toBe("speed"); // future untimed item does not count yet
  untimed = run(untimed, { type: "close" }, 10, quiz).session;
  untimed = run(untimed, { type: "reveal" }, 11, quiz).session;
  untimed = run(untimed, { type: "next" }, 12, quiz).session;
  expect(effectiveRanking(deserializeSession(serializeSession(untimed)), quiz)).toBe("correctness");
});

it("mixed unscored release keeps single submissions/editable open responses with no leaderboard when nothing scored", () => {
  const quiz = { ...deck, questions: [item(0, { questionType: "poll", correctOptions: [] }), item(1, { questionType: "open_response", options: [], correctOptions: [] }), item(2)] };
  let session = run(policy(), { type: "start" }, 0, quiz).session;
  session = run(session, { type: "join", payload: { studentId: "one" }, socketId: "one", newToken: "token-one" }, 0, quiz).session;
  session = answer(session, 0, ["A"], "one", 10).session;
  session = run(session, { type: "next" }, 10, quiz).session;
  for (const text of ["first", "edited"]) session = run(session, { type: "answerSubmit", studentId: "one", sessionToken: "token-one", payload: { questionIndex: 1, responseText: text } }, 10, quiz).session;
  expect(session.submissions.length).toBe(2);
  expect(session.submissions[1].responseText).toBe("edited");
  expect(getSessionScoredQuestionCount(session, quiz)).toBe(0);
  const ended = run(session, { type: "end" }, 20, quiz).session;
  expect(leaderboardRows(ended, quiz, "public")).toEqual([]);
  expect(run(ended, { type: "broadcastLeaderboard" }, 21, quiz).messages.some((message) => message.event === SocketEvents.LEADERBOARD_UPDATE)).toBe(false);
});

it("policy-less legacy reload retains whole-deck scoring/time ranks and invents no release history", () => {
  const legacy = createSession("synthetic", "open");
  delete legacy.policy; delete legacy.policyFrozen; delete legacy.releasedQuestionIndexes;
  let session = run(legacy, { type: "start" }).session;
  session = join(join(session, "one"), "two");
  session = answer(session, 0, ["A"], "one", 10).session;
  session = answer(session, 0, ["A"], "two", 20).session;
  session = deserializeSession(serializeSession(session));
  expect(session.releasedQuestionIndexes).toBeUndefined();
  expect(getSessionScoredQuestionCount(session, deck)).toBe(3);
  expect(leaderboardRows(session, deck, "public").map((row) => row.rank)).toEqual([1, 2]);
  expect(resultMetadata(session, deck)).toBeUndefined();
  expect(publicQuestionPayload(session, deck, 1, 0)).toBeNull();
});

it("snapshot, CSV and result history persist versioned effective policy and released/scored scope", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-policy-"));
  try {
    const active = answer(join(start()), 0).session;
    saveWeeklyResult(run(active, { type: "end", discloseResults: false }, 20).session, deck, directory);
    expect(computeCumulativeLeaderboard(directory)).toEqual([]);
    const session = run(active, { type: "end" }, 20).session;
    saveSessionSnapshot(session, directory); saveWeeklyResult(session, deck, directory);
    const snapshot = JSON.parse(fs.readFileSync(path.join(directory, "sessions", `${session.sessionId}.json`), "utf8"));
    expect(snapshot).toMatchObject({ policyFrozen: true, releasedQuestionIndexes: [0], resultScope: { endedAt: 20, disclosed: true } });
    expect(loadWeeklyResult("synthetic", directory)?.metadata).toMatchObject({ schemaVersion: 1, effectiveRanking: "correctness", releasedQuestionIndexes: [0], finality: "ended" });
    const csv = buildResultsCsv(session, deck, { now: 20 });
    expect(csv).toContain("results_schema_version,pacing,effective_timing,ranking,effective_ranking,released_item_indexes,scored_item_indexes,finality");
    expect(csv).toContain("1,self-paced,untimed,automatic,correctness,0,0,ended");
    expect(csv.split("\n")[0]).not.toContain("q2_");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it("numeric source never schedules Core socket countdown for self-paced", () => {
  jest.useFakeTimers();
  try { startQuestionTimer({} as never, start(), "synthetic", 10); expect(jest.getTimerCount()).toBe(0); }
  finally { jest.useRealTimers(); }
});

it("actual REST authenticates policy selection/seat content and hides self-paced public results/restores", async () => {
  clearAllSessions(); clearInstructorSessionsForTests();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-policy-rest-"));
  const originalPassword = process.env.INSTRUCTOR_PASSWORD;
  process.env.INSTRUCTOR_PASSWORD = "synthetic-password";
  fs.writeFileSync(path.join(directory, "synthetic.md"), "# Synthetic\n---\n## One\ntime-limit: 10\nChoose.\nA. One\nB. Two\n> Correct Answer: A\n> Overall Feedback: SECRET_EXPLANATION\n---\n## FUTURE_SECRET_TITLE\ntime-limit: 10\nChoose.\nA. One\nB. Two\n> Correct Answer: A\n> Overall Feedback: SECRET_FUTURE_EXPLANATION\n");
  try {
    const app = createApp({ quizDir: directory, dataDir: directory });
    const agent = request.agent(app);
    await agent.post("/api/instructor/login").send({ password: "synthetic-password" }).expect(204);
    const created = await agent.post("/api/session").send({ week: "synthetic" }).expect(201);
    const id = created.body.sessionId;
    await request(app).post(`/api/session/${id}/policy`).send({ pacing: "self-paced" }).expect(401);
    await agent.post(`/api/session/${id}/policy`).send({ pacing: "self-paced" }).expect(200);
    await agent.post(`/api/session/${id}/start`).expect(200);
    const session = getSession(id)!;
    const quiz = session.deckSnapshot!;
    Object.assign(session, run(session, { type: "join", payload: { studentId: "one" }, socketId: "one", newToken: "token-one" }, 0, quiz).session);
    await request(app).get(`/api/session/${id}/items/0`).expect(401);
    await request(app).get(`/api/session/${id}/items/1`).query({ participantId: "one", sessionToken: "token-one" }).expect(404);
    const read = await request(app).get(`/api/session/${id}/items/0`).query({ participantId: "one", sessionToken: "token-one" }).expect(200);
    expect(read.body.timeLimitSec).toBeNull(); expect(JSON.stringify(read.body)).not.toContain("SECRET");
    const board = await request(app).get(`/api/session/${id}/leaderboard`).expect(200);
    expect(board.body).toEqual({ entries: [] });
    const restore = await agent.get(`/api/session/${id}/state`).expect(200);
    expect(restore.body.policy.pacing).toBe("self-paced"); expect(restore.body.reviewReveals).toEqual([]);
    await agent.post(`/api/session/${id}/policy`).send({ pacing: "presenter-paced", ranking: "correctness" }).expect(400);
  } finally {
    if (originalPassword === undefined) delete process.env.INSTRUCTOR_PASSWORD; else process.env.INSTRUCTOR_PASSWORD = originalPassword;
    clearAllSessions(); clearInstructorSessionsForTests(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("automatic v2 ranking respects released scored timers, not unscored items or unreleased content", () => {
  const quiz = { ...deck, questions: [item(0), item(1, { questionType: "poll", correctOptions: [], timeLimitSec: null }), item(2, { timeLimitSec: null })] };
  let session = run(policy("presenter-paced"), { type: "start" }, 0, quiz).session;
  expect(session.policy).toMatchObject({ schemaVersion: 2, ranking: "automatic" });
  expect(effectiveRanking(session, quiz)).toBe("speed");
  session = run(session, { type: "close" }, 1, quiz).session;
  session = run(session, { type: "reveal" }, 2, quiz).session;
  session = run(session, { type: "next" }, 3, quiz).session;
  expect(effectiveRanking(session, quiz)).toBe("speed");
  session = run(session, { type: "close" }, 4, quiz).session;
  session = run(session, { type: "reveal" }, 5, quiz).session;
  session = run(session, { type: "next" }, 6, quiz).session;
  expect(effectiveRanking(deserializeSession(serializeSession(session)), quiz)).toBe("correctness");
});
it("v2 rejects ranking overrides and persists restart fairness while v1 correctness stays unchanged", () => {
  expect(() => run(createSession("synthetic", "open"), { type: "configurePolicy", role: "control", pacing: "presenter-paced", ranking: "speed" })).toThrow("automatically");
  expect(effectiveRanking(start(policy("presenter-paced", "correctness")), deck)).toBe("correctness");
  const session = start(policy("presenter-paced"));
  expect(effectiveRanking(session, deck)).toBe("speed");
  const result = run(session, { type: "restartCountdown", role: "control" }, 1000);
  expect(result.messages.find(m => m.event === SocketEvents.SESSION_STATE && m.audience === "control")?.payload).toMatchObject({ effectiveRanking: "correctness" });
  expect(effectiveRanking(deserializeSession(serializeSession(result.session)), deck)).toBe("correctness");
  expect(effectiveRanking(start(policy("self-paced")), deck)).toBe("correctness");
});
