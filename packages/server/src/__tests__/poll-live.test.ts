import { PollLivePayload, QuestionType, Quiz, Session, SocketEvents } from "@mdq/shared";
import { apply, Command, EngineResult, participantResultsPayload, participantStudyItemPayload, participantStudyPayload, publicQuestionPayload } from "../engine";
import { parseQuizMarkdown } from "../parser";
import { createSession, deserializeSession, serializeSession } from "../session";

// Intentional public, synthetic fixtures. No teaching-instance content.
const poll = (setting = "", title = "Synthetic poll") => `## ${title}\ntype: poll\ntime-limit: none\nmulti-select: true\n${setting}\nChoose.\nA. One\nB. Two\nC. Three`;
const source = (...items: string[]) => `# Synthetic live polls\n${items.map(item => `---\n${item}\n`).join("")}`;
const parse = (...items: string[]) => {
  const result = parseQuizMarkdown(source(...items), "synthetic.md");
  expect(result.errors).toEqual([]);
  return result.quiz!;
};
const liveDeck = () => parse(poll("live-results: on"), poll("live_results: on", "Second poll"), poll("", "Private poll"));
const run = (session: Session, quiz: Quiz, command: Command, now = 10) => apply(session, quiz, command, now);
const start = (quiz: Quiz, selfPaced = false) => {
  let session = createSession("synthetic", "open");
  session.availability = { schemaVersion: 1, generation: 1, availableUntil: 10000 };
  if (selfPaced) session = run(session, quiz, { type: "configurePolicy", role: "control", pacing: "self-paced" }, 0).session;
  session = run(session, quiz, { type: "start" }, 0).session;
  for (const id of ["voter-one", "voter-two", "voter-three", "unvoted-seat"]) {
    session = run(session, quiz, { type: "join", payload: { studentId: id, displayName: `Name ${id}` }, socketId: id, newToken: `token-${id}` }, 1).session;
  }
  return session;
};
const vote = (session: Session, quiz: Quiz, id = "voter-one", index = 0, options = ["A"]) => run(session, quiz, {
  type: "answerSubmit", studentId: id, sessionToken: `token-${id}`, payload: { questionIndex: index, selectedOptions: options },
});
const live = (result: EngineResult) => result.messages.filter(m => m.event === SocketEvents.POLL_LIVE);
const payloadFor = (result: EngineResult, audience: string): PollLivePayload | undefined => live(result).find(m => m.audience === audience)?.payload as PollLivePayload | undefined;
const snapshot = (session: Session, quiz: Quiz, audience: "control" | "display" | string, now = 20) => run(session, quiz,
  audience === "control" || audience === "display" ? { type: "snapshot", view: audience, isReconnect: true }
    : { type: "snapshot", participantId: audience, isReconnect: true }, now);
const toggle = (session: Session, quiz: Quiz, visible: boolean, questionIndex = 0) => run(session, quiz, { type: "liveResults", role: "control", questionIndex, visible });
const allVotes = (session: Session, quiz: Quiz, index = 0) => {
  for (const id of ["voter-one", "voter-two", "voter-three"]) session = vote(session, quiz, id, index, ["A", "B", "B"]).session;
  return session;
};

describe("poll live-results parser", () => {
  it.each(["live-results", "live_results"])("reads %s on/off/default and strips the setting from content", key => {
    const quiz = parse(poll(`${key}: on`), poll(`${key}: off`), poll());
    expect(quiz.questions.map(q => q.liveResults)).toEqual([true, false, false]);
    expect(quiz.questions.every(q => !/live[-_]results/.test(q.textHtml))).toBe(true);
  });

  it.each(["multiple_choice", "open_response", "slide", "cover"] as QuestionType[])("rejects the key, even off, on %s with an item/line diagnostic", type => {
    for (const key of ["live-results", "live_results"]) for (const value of ["on", "off"]) {
      const text = source(`## Synthetic\ntype: ${type}\n${key}: ${value}\nContent.`);
      const result = parseQuizMarkdown(text, "synthetic.md");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ detail: "live-results only applies to polls", questionIndex: 0, lineNumber: 5 });
    }
  });

  it.each(["true", "false", "sometimes", ""])("rejects invalid poll value %j", value => {
    expect(parseQuizMarkdown(source(poll(`live-results: ${value}`)), "synthetic.md").errors[0].detail).toMatch(/must be on or off/);
  });
});

it.each([false, true])("off preserves existing events and own-vote-only results (self-paced=%s)", selfPaced => {
  const quiz = parse(poll());
  let session = start(quiz, selfPaced);
  expect(publicQuestionPayload(session, quiz, 0, 10)).not.toHaveProperty("liveResults");
  const accepted = vote(session, quiz);
  expect(live(accepted)).toEqual([]);
  expect(accepted.messages.some(m => m.event === SocketEvents.ANSWER_ACCEPTED)).toBe(true);
  session = accepted.session;
  expect(vote(session, quiz).messages).toContainEqual(expect.objectContaining({ event: SocketEvents.ANSWER_REJECTED, payload: { questionIndex: 0, reason: "Already submitted an answer for this question." } }));
  for (const audience of ["control", "display", "voter-one", "unvoted-seat"]) expect(live(snapshot(session, quiz, audience))).toEqual([]);
  expect(participantStudyItemPayload(session, quiz, 0, "voter-one", 20)).not.toHaveProperty("pollLive");
  if (!selfPaced) {
    const closed = run(session, quiz, { type: "close" });
    expect(live(closed)).toEqual([]);
    expect(closed.messages.some(m => m.event === SocketEvents.RESULTS_DISTRIBUTION)).toBe(true);
    const revealed = run(closed.session, quiz, { type: "reveal" });
    expect(live(revealed)).toEqual([]);
    expect(revealed.messages.some(m => m.event === SocketEvents.RESULTS_REVEAL)).toBe(true);
    session = revealed.session;
  }
  session = run(session, quiz, { type: "end" }).session;
  expect(participantResultsPayload(session, quiz, "voter-one", 20)?.questions[0]).not.toHaveProperty("pollLive");
});

it("routes aggregate counts only to control, display and accepted voters, with a three-voter floor", () => {
  const quiz = liveDeck();
  let session = start(quiz);
  expect(publicQuestionPayload(session, quiz, 0, 10)?.liveResults).toBe(true);
  const before = serializeSession(session);
  for (const [position, id] of ["voter-one", "voter-two", "voter-three"].entries()) {
    const result = vote(session, quiz, id, 0, ["A", "B", "B"]);
    const voters = position + 1;
    expect(payloadFor(result, "control")).toEqual({ questionIndex: 0, voters, counts: { A: voters, B: voters, C: 0 }, liveResults: true });
    const publicPayload = voters < 3 ? { questionIndex: 0, voters, counts: null, floor: 3 }
      : { questionIndex: 0, voters, counts: { A: 3, B: 3, C: 0 } };
    expect(payloadFor(result, "display")).toEqual(publicPayload);
    for (const voter of ["voter-one", "voter-two", "voter-three"].slice(0, voters)) expect(payloadFor(result, `participant:${voter}`)).toEqual(publicPayload);
    expect(live(result).map(m => m.audience)).toEqual(["control", "display", ...["voter-one", "voter-two", "voter-three"].slice(0, voters).map(voter => `participant:${voter}`)]);
    expect(result.messages.findIndex(m => m.event === SocketEvents.ANSWER_ACCEPTED)).toBeLessThan(result.messages.findIndex(m => m.event === SocketEvents.POLL_LIVE));
    for (const m of live(result)) {
      expect(JSON.stringify(m.payload)).not.toMatch(/studentId|participantId|displayName|selectedOptions|voter-|Name|token-/);
      if ("counts" in (m.payload as PollLivePayload) && (m.payload as { counts: unknown }).counts) expect(Object.keys((m.payload as { counts: object }).counts)).toEqual(["A", "B", "C"]);
    }
    if (position === 0) expect(serializeSession(session)).toBe(before); // apply remains pure
    session = result.session;
  }
  expect(live(snapshot(session, quiz, "unvoted-seat"))).toEqual([]);
  expect(payloadFor(snapshot(session, quiz, "voter-one"), "participant:voter-one")).toMatchObject({ voters: 3, counts: { A: 3, B: 3, C: 0 } });
  expect(live(vote(session, quiz))).toEqual([]); // locked votes do not update counts
  const closed = run(session, quiz, { type: "close" });
  expect(closed.messages.some(m => m.event === SocketEvents.RESULTS_DISTRIBUTION)).toBe(true);
  expect(payloadFor(snapshot(closed.session, quiz, "voter-one"), "participant:voter-one")).toMatchObject({ voters: 3 });
  const revealed = run(closed.session, quiz, { type: "reveal" });
  expect(revealed.messages.some(m => m.event === SocketEvents.RESULTS_REVEAL)).toBe(true);
  expect(live(snapshot(revealed.session, quiz, "unvoted-seat"))).toEqual([]);
});

it.each([false, true])("hide/show preserves counts, deck, clocks, locks and serialized overrides (authored on=%s)", authoredOn => {
  const quiz = parse(poll(authoredOn ? "live-results: on" : ""));
  let session = allVotes(start(quiz), quiz);
  const frozenDeck = JSON.stringify(session.deckSnapshot);
  const timing = session.questionTiming;
  if (!authoredOn) session = toggle(session, quiz, true).session;
  const original = serializeSession(session);
  const hidden = toggle(session, quiz, false);
  expect(serializeSession(session)).toBe(original);
  expect(payloadFor(hidden, "control")).toMatchObject({ voters: 3, counts: { A: 3, B: 3, C: 0 } });
  for (const audience of ["display", "participant:voter-one", "participant:voter-two", "participant:voter-three"]) expect(payloadFor(hidden, audience)).toEqual({ questionIndex: 0, hidden: true });
  expect(payloadFor(hidden, "participant:unvoted-seat")).toBeUndefined();
  session = deserializeSession(serializeSession(hidden.session));
  expect(session.liveResultsOverrides).toEqual({ "0": false });
  expect(publicQuestionPayload(session, quiz, 0, 20)?.liveResults).toBe(false);
  for (const audience of ["display", "voter-one"]) expect(live(snapshot(session, quiz, audience))[0].payload).toEqual({ questionIndex: 0, hidden: true });
  expect(payloadFor(snapshot(session, quiz, "control"), "control")).toMatchObject({ voters: 3, counts: { A: 3, B: 3, C: 0 } });
  expect(participantStudyItemPayload(session, quiz, 0, "voter-one", 20)?.pollLive).toEqual({ questionIndex: 0, hidden: true });
  const shown = toggle(session, quiz, true);
  session = deserializeSession(serializeSession(shown.session));
  expect(session.liveResultsOverrides).toEqual({ "0": true });
  expect(payloadFor(shown, "participant:voter-one")).toMatchObject({ voters: 3, counts: { A: 3, B: 3, C: 0 } });
  expect(JSON.stringify(session.deckSnapshot)).toBe(frozenDeck);
  expect(session.questionTiming).toEqual(timing);
  expect(session.state).toBe("QUESTION_OPEN");
  expect(live(vote(session, quiz))).toEqual([]);
});

it("replays floor counts on reconnect, including a token-authenticated join", () => {
  const quiz = liveDeck();
  const session = vote(start(quiz), quiz).session;
  expect(payloadFor(snapshot(session, quiz, "control"), "control")).toMatchObject({ voters: 1, counts: { A: 1, B: 0, C: 0 } });
  for (const audience of ["display", "voter-one"]) expect(live(snapshot(session, quiz, audience))[0].payload).toEqual({ questionIndex: 0, voters: 1, counts: null, floor: 3 });
  const joined = run(session, quiz, { type: "join", payload: { studentId: "voter-one", sessionToken: "token-voter-one" }, socketId: "new-socket", newToken: "unused" });
  expect(payloadFor(joined, "participant:voter-one")).toEqual({ questionIndex: 0, voters: 1, counts: null, floor: 3 });
});

it("self-paced votes and browse/reconnect projections use each item's accepted voters", () => {
  const quiz = liveDeck();
  let session = vote(start(quiz, true), quiz).session;
  session = run(session, quiz, { type: "next" }).session;
  const second = vote(session, quiz, "voter-two", 1, ["B"]);
  expect(live(second).map(m => m.audience)).toEqual(["control", "display", "participant:voter-two"]);
  expect(payloadFor(second, "participant:voter-two")).toMatchObject({ questionIndex: 1 });
  const firstAgain = vote(second.session, quiz, "voter-three", 0, ["C"]);
  expect(live(firstAgain).map(m => m.audience)).toEqual(["control", "display", "participant:voter-one", "participant:voter-three"]);
  expect(payloadFor(firstAgain, "control")).toEqual({ questionIndex: 0, voters: 2, counts: { A: 1, B: 0, C: 1 }, liveResults: true });
  session = firstAgain.session;
  for (const item of [participantStudyItemPayload(session, quiz, 0, "voter-one", 20), participantStudyPayload(session, quiz, "voter-one", 20).items[0]]) {
    expect(item?.pollLive).toEqual({ questionIndex: 0, voters: 2, counts: null, floor: 3 });
  }
  expect(participantStudyItemPayload(session, quiz, 1, "voter-one", 20)).not.toHaveProperty("pollLive");
  expect(participantStudyItemPayload(session, quiz, 0, "unvoted-seat", 20)).not.toHaveProperty("pollLive");
  expect(live(snapshot(session, quiz, "voter-one")).map(m => m.payload)).toEqual([{ questionIndex: 0, voters: 2, counts: null, floor: 3 }]);
  expect(live(snapshot(session, quiz, "control")).map(m => (m.payload as PollLivePayload).questionIndex)).toEqual([0, 1]);
  expect(live(snapshot(session, quiz, "display")).map(m => (m.payload as PollLivePayload).questionIndex)).toEqual([1]);
  const thirdVoter = vote(session, quiz, "voter-two", 0, ["A", "C"]);
  session = thirdVoter.session;
  expect(participantStudyItemPayload(session, quiz, 0, "voter-one", 20)?.pollLive).toEqual({ questionIndex: 0, voters: 3, counts: { A: 2, B: 0, C: 2 } });
  for (const m of thirdVoter.messages.filter(m => m.audience !== "control")) expect([SocketEvents.RESULTS_DISTRIBUTION, SocketEvents.RESULTS_REVEAL, SocketEvents.LEADERBOARD_UPDATE, SocketEvents.ANSWER_COUNT]).not.toContain(m.event);
  expect(() => run(session, quiz, { type: "close" })).toThrow("until End");
  expect(() => run(session, quiz, { type: "reveal" })).toThrow("until End");
});

it.each([false, true])("expired/deleted sessions send no live event or study counts (self-paced=%s)", selfPaced => {
  const quiz = liveDeck();
  const active = vote(start(quiz, selfPaced), quiz).session;
  for (const session of [active, { ...active, deletedAt: 25 }]) for (const now of [10000, 10001]) {
    for (const audience of ["control", "display", "voter-one", "unvoted-seat"]) expect(live(snapshot(session, quiz, audience, now))).toEqual([]);
    expect(live(run(session, quiz, { type: "answerSubmit", studentId: "voter-two", sessionToken: "token-voter-two", payload: { questionIndex: 0, selectedOptions: ["A"] } }, now))).toEqual([]);
    expect(participantStudyItemPayload(session, quiz, 0, "voter-one", now)?.pollLive).toBeUndefined();
    expect(() => run(session, quiz, { type: "liveResults", role: "control", questionIndex: 0, visible: true }, now)).toThrow();
  }
  const ended = run(active, quiz, { type: "end" }, 30).session;
  const deleted = { ...ended, deletedAt: 40 };
  for (const audience of ["control", "display", "voter-one"]) expect(live(snapshot(deleted, quiz, audience, 50))).toEqual([]);
  expect(participantResultsPayload(deleted, quiz, "voter-one", 50)).toBeNull();
});

it.each([false, true])("deliberate End discloses final live aggregates only to their own voters (self-paced=%s)", selfPaced => {
  const quiz = liveDeck();
  let session = allVotes(start(quiz, selfPaced), quiz);
  const advance = () => {
    if (!selfPaced) {
      session = run(session, quiz, { type: "close" }).session;
      session = run(session, quiz, { type: "reveal" }).session;
    }
    session = run(session, quiz, { type: "next" }).session;
  };
  advance();
  session = vote(session, quiz, "voter-one", 1, ["C"]).session;
  advance();
  session = vote(session, quiz, "voter-one", 2, ["B"]).session;
  const ended = run(session, quiz, { type: "end" }, 30).session;
  const results = participantResultsPayload(ended, quiz, "voter-one", 40)!;
  expect(results.questions[0].pollLive).toEqual({ voters: 3, counts: { A: 3, B: 3, C: 0 } });
  expect(results.questions[1].pollLive).toEqual({ voters: 1, counts: null });
  expect(results.questions[2]).not.toHaveProperty("pollLive");
  expect(results.questions[2].answer?.selectedOptions).toEqual([1]);
  expect(participantResultsPayload(ended, quiz, "voter-two", 40)?.questions[1]).not.toHaveProperty("pollLive");
  expect(participantResultsPayload(ended, quiz, "unvoted-seat", 40)?.questions.every(q => q.pollLive === undefined)).toBe(true);
  const undisclosed = run(session, quiz, { type: "end", discloseResults: false }, 30).session;
  expect(participantResultsPayload(undisclosed, quiz, "voter-one", 40)).toBeNull();
  for (const audience of ["control", "display", "voter-one"]) expect(live(snapshot(undisclosed, quiz, audience, 40))).toEqual([]);
  expect(participantStudyPayload(undisclosed, quiz, "voter-one", 40).items.every(item => !item.pollLive)).toBe(true);
});

it("session overrides determine final bars and cannot change the final scope after End", () => {
  const quiz = parse(poll(), poll("live-results: on"));
  let session = vote(start(quiz, true), quiz).session;
  session = toggle(session, quiz, true).session;
  session = run(session, quiz, { type: "next" }).session;
  session = vote(session, quiz, "voter-one", 1).session;
  session = toggle(session, quiz, false, 1).session;
  session = run(session, quiz, { type: "end" }, 30).session;
  expect(participantResultsPayload(session, quiz, "voter-one", 40)?.questions.map(q => q.pollLive)).toEqual([{ voters: 1, counts: null }, undefined]);
  expect(() => toggle(session, quiz, true, 1)).toThrow("ended");
});

it.each(["multiple_choice", "open_response", "slide", "cover"] as const)("never emits live results for forged %s models or overrides", questionType => {
  const quiz = liveDeck();
  quiz.questions[0] = { ...quiz.questions[0], questionType, liveResults: true, isPoll: true };
  let session = start(quiz, true);
  session.liveResultsOverrides = { "0": true };
  expect(() => toggle(session, quiz, true)).toThrow("only applies to polls");
  const result = questionType === "open_response" ? run(session, quiz, { type: "answerSubmit", studentId: "voter-one", sessionToken: "token-voter-one", payload: { questionIndex: 0, responseText: "Synthetic response" } }) : vote(session, quiz);
  expect(live(result)).toEqual([]);
  session = result.session;
  for (const audience of ["control", "display", "voter-one"]) expect(live(snapshot(session, quiz, audience))).toEqual([]);
  expect(participantStudyItemPayload(session, quiz, 0, "voter-one", 20)).not.toHaveProperty("pollLive");
});

it("requires control authority, a poll index, and a boolean visibility", () => {
  const quiz = liveDeck();
  const session = start(quiz);
  for (const role of ["display", "participant"] as const) expect(() => run(session, quiz, { type: "liveResults", role, questionIndex: 0, visible: true })).toThrow("Only the presenter");
  for (const questionIndex of [-1, 999, 0.5]) expect(() => toggle(session, quiz, true, questionIndex)).toThrow("only applies to polls");
  expect(() => toggle(session, quiz, "on" as unknown as boolean)).toThrow("true or false");
});

it("a released seat stops receiving live counts until it joins again, and its retained vote still counts", () => {
  const quiz = liveDeck();
  let session = allVotes(start(quiz), quiz);
  const key = session.participants.get("voter-one")!.publicKey!;
  session = run(session, quiz, { type: "releaseSeat", role: "control", publicKey: key, newToken: "token-released" }).session;
  const result = vote(session, quiz, "unvoted-seat", 0, ["C"]);
  expect(payloadFor(result, "participant:voter-two")).toEqual({ questionIndex: 0, voters: 4, counts: { A: 3, B: 3, C: 1 } });
  expect(payloadFor(result, "participant:voter-one")).toBeUndefined();
  expect(live(snapshot(result.session, quiz, "voter-one"))).toEqual([]);
});

it("reveals multi-select poll percentages against accepted voters, not selections", () => {
  const quiz = parse(poll());
  let session = start(quiz);
  session = vote(session, quiz, "voter-one", 0, ["A", "B"]).session;
  session = vote(session, quiz, "voter-two", 0, ["A", "C"]).session;
  session = run(session, quiz, { type: "close" }).session;
  const revealed = run(session, quiz, { type: "reveal" });
  const payloads = revealed.messages.filter(m => m.event === SocketEvents.RESULTS_REVEAL).map(m => m.payload);
  expect(payloads.length).toBeGreaterThan(0);
  for (const payload of payloads) expect(payload).toMatchObject({ voters: 2, distribution: { A: 2, B: 1, C: 1 } });
  for (const audience of ["control", "display", "voter-one"]) {
    const replay = snapshot(revealed.session, quiz, audience).messages.find(m => m.event === SocketEvents.RESULTS_REVEAL);
    expect(replay?.payload).toMatchObject({ voters: 2 });
  }
});

it.each(["multiple_choice", "open_response"])("does not add voters to a %s reveal", type => {
  const quiz = parse(`## Synthetic question\ntype: ${type}\ntime-limit: none\nChoose.${type === "multiple_choice" ? "\nA. One\nB. Two\n> Correct Answer: A" : ""}`);
  const closed = run(start(quiz), quiz, { type: "close" });
  const reveals = run(closed.session, quiz, { type: "reveal" }).messages.filter(m => m.event === SocketEvents.RESULTS_REVEAL);
  expect(reveals.length).toBeGreaterThan(0);
  for (const reveal of reveals) expect(reveal.payload).not.toHaveProperty("voters");
});
