/// <reference lib="dom" />
import type { ParticipantStudyPayload, QuestionOpenPayload, StudentAnswer } from "@mdq/shared";
import { compareAcceptedAnswers, mergeOwnAnswers, isEarlierAttemptDraft, isLaterAttempt } from "../../../client/src/ownAnswers";
import { draftStorageKey, readDraft, writeDraft } from "../../../client/src/participantDrafts";
import { hookHarness } from "./rerun-hook-harness";
import { apply, Command, participantStudyPayload } from "../engine";
import { createSession } from "../session";
import { goldenQuiz } from "./attempts-test-support";

const opening = (questionIndex = 0, attempt?: number, questionType: "multiple_choice" | "open_response" | "poll" = "multiple_choice"): QuestionOpenPayload => ({
  questionIndex, topic: "Sample", text: `Sample attempt ${attempt ?? 1}`, questionType,
  options: [{ label: "A", text: attempt ? "New option" : "Old option" }, { label: "B", text: "Other option" }],
  allowsMultiple: false, isPoll: questionType === "poll", liveResults: questionType === "poll" && !attempt,
  timeLimitSec: null, startedAt: attempt ? 200 : 100, ...(attempt ? { attempt } : {}),
});
const answer = (questionIndex = 0, attempt?: number, responseText?: string): StudentAnswer => ({ questionIndex, selectedOptions: responseText ? [] : [0], ...(attempt ? { attempt } : {}), ...(responseText ? { responseText } : {}) });
const studyData = (items = [opening()], answers: StudentAnswer[] = [], selfPaced = false): ParticipantStudyPayload => ({
  items, answers, answeredQuestions: answers.map(value => value.questionIndex), currentQuestionIndex: 0, state: "QUESTION_OPEN",
  answerableQuestionIndexes: items.filter(item => item.questionType === "open_response" || !answers.some(answer => answer.questionIndex === item.questionIndex)).map(item => item.questionIndex),
  policy: { schemaVersion: 2, pacing: selfPaced ? "self-paced" : "presenter-paced", effectiveTiming: "authored", ranking: "automatic" },
});
const joined = (answers: StudentAnswer[] = []) => ({ participantId: "sample", sessionToken: "seat", sessionState: "QUESTION_OPEN", answeredQuestions: answers.map(value => value.questionIndex), answers });
const key = draftStorageKey("sample-session", "seat", 0);
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("a page across a re-run", () => {
  let harness: ReturnType<typeof hookHarness>;
  let requests: { resolve: (response: unknown) => void; reject: (reason: Error) => void }[];
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  beforeEach(() => {
    jest.useFakeTimers();
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => storage.set(name, value),
      removeItem: (name: string) => storage.delete(name),
    } });
    requests = [];
    jest.spyOn(globalThis, "fetch").mockImplementation((url) => String(url).endsWith("/items")
      ? new Promise((resolve, reject) => requests.push({ resolve: resolve as (response: unknown) => void, reject }))
      : Promise.resolve({ ok: false } as Response));
    harness = hookHarness();
  });
  afterEach(() => {
    harness.unmount(); jest.restoreAllMocks(); jest.useRealTimers();
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const render = () => harness.render(() => {
    const sock = harness.useSocket("sample-session", "student");
    return { sock, study: harness.useParticipantStudy("sample-session", sock) };
  });
  const receive = (event: string, payload: unknown) => { harness.receive(event, payload); return render(); };
  const fetched = async (data: ParticipantStudyPayload) => {
    requests.at(-1)!.resolve({ ok: true, json: async () => data }); await settle(); return render();
  };
  const start = async (data = studyData(), shown = opening(), answers: StudentAnswer[] = data.answers) => {
    render(); receive("student:joined", joined(answers)); receive("question:open", shown);
    return fetched(data);
  };

  it.each(["session", "seat"] as const)("changing the %s before an opening preserves the destination draft bytes", async change => {
    await start(studyData([opening(0, 2)], [], true), opening(0, 2));
    let sessionId = "sample-session";
    const destinationSession = change === "session" ? "other-session" : sessionId;
    const destinationToken = change === "seat" ? "other-seat" : "seat";
    const destinationKey = draftStorageKey(destinationSession, destinationToken, 0);
    const destinationDraft = { selectedOptions: ["B"], responseText: "Destination text", revision: 4 };
    writeDraft(destinationKey, destinationDraft);
    const bytes = localStorage.getItem(destinationKey);
    const routeRender = () => harness.render(() => {
      const sock = harness.useSocket(sessionId, "student");
      return { sock, study: harness.useParticipantStudy(sessionId, sock) };
    });
    if (change === "session") sessionId = destinationSession;
    if (change !== "seat") routeRender();
    harness.receive("student:joined", { ...joined(), sessionToken: destinationToken });
    const waiting = routeRender();
    expect(localStorage.getItem(destinationKey)).toBe(bytes);
    expect(waiting.sock.currentQuestion).toBeNull();
    expect(waiting.study.question).toBeNull();
    harness.receive("question:open", opening());
    const current = routeRender();
    expect(current.study.draft).toEqual(destinationDraft);
    expect(localStorage.getItem(destinationKey)).toBe(bytes);
    current.study.setDraft({ responseText: "Destination edit" });
    expect(routeRender().study.draft).toEqual({ ...destinationDraft, responseText: "Destination edit", revision: 5 });
  });

  it.each([1, 2].flatMap(attempt => [false, true].map(versioned => ({ attempt, versioned }))))("a previous seat's HTTP answer cannot reconcile before render at attempt $attempt with revisions $versioned", async ({ attempt, versioned }) => {
    await start();
    render().study.refresh(); render();
    const outstanding = requests.at(-1)!;
    const earlier = { ...answer(0, attempt), ...(versioned ? { acceptedRevision: 5 } : {}) };
    harness.receive("student:joined", { ...joined(), participantId: "other", sessionToken: "other-seat" });
    outstanding.resolve({ ok: true, json: async () => studyData([opening(0, attempt)], [earlier]) });
    await settle();
    const switched = render();
    expect(switched.sock.sessionToken).toBe("other-seat");
    expect(switched.sock.ownAnswers.size).toBe(0);
    expect(switched.sock.answeredQuestions).toEqual([]);
    expect(switched.sock.questionAttempts.size).toBe(0);
    expect(switched.study.submitted).toBe(false);
    const current = { ...answer(), selectedOptions: [1], ...(versioned ? { acceptedRevision: 1 } : {}) };
    receive("question:open", opening());
    const restored = await fetched(studyData([opening()], [current]));
    expect(restored.sock.ownAnswers.get(0)).toEqual(current);
    expect(restored.study.submittedOptions).toEqual(["B"]);
  });

  it.each([undefined, 2].flatMap(attempt => (["multiple_choice", "open_response"] as const).flatMap(questionType => [false, true].map(accepted => ({ attempt, questionType, accepted })))))("a fresh join reconciles a persisted later draft for $questionType at attempt $attempt with an accepted answer $accepted", async ({ attempt, questionType, accepted }) => {
    const persistedAttempt = (attempt ?? 1) + 1;
    writeDraft(key, { selectedOptions: ["A"], responseText: "Persisted later text", revision: 4, attempt: persistedAttempt });
    const shown = opening(0, attempt, questionType);
    const answers = accepted ? [{ ...answer(0, attempt, questionType === "open_response" ? "Server text" : undefined), selectedOptions: questionType === "open_response" ? [] : [1] }] : [];
    const { study } = await start(studyData([shown], answers), shown);
    const expected = { selectedOptions: accepted && questionType === "multiple_choice" ? ["B"] : [], responseText: accepted && questionType === "open_response" ? "Server text" : "", revision: 0, ...(attempt ? { attempt } : {}) };
    const displayed = study.draft;
    expect(readDraft(key)?.attempt).toBe(persistedAttempt);
    study.setDraft({ selectedOptions: ["B"], responseText: "Editable text" });
    expect(render().study.draft).toEqual({ ...expected, selectedOptions: ["B"], responseText: "Editable text", revision: 1 });
    expect(readDraft(key)).toEqual(render().study.draft);
    expect(displayed).toEqual(expected);
    if (!accepted || questionType === "open_response") {
      render().study.submitAnswer({ questionIndex: 0, responseText: "Editable text" });
      expect(harness.sent.at(-1)).toEqual({ event: "answer:submit", payload: { questionIndex: 0, responseText: "Editable text", ...(attempt ? { attempt } : {}) } });
    }
  });

  it.each(["join", "snapshot"])("a newer %s attempt invalidates the cached leaderboard until a fresh delivery", async source => {
    await start();
    receive("leaderboard:update", { entries: [{ rank: 1, publicKey: "sample", label: "Sample", correctCount: 1 }], totalQuestions: 1 });
    expect(render().sock.leaderboardReady).toBe(true);
    if (source === "join") receive("student:joined", { ...joined(), sessionState: "LEADERBOARD", questionAttempts: { "0": 2 } });
    else receive("session:state", { state: "LEADERBOARD", questionAttempts: { "0": 2 } });
    expect(render().sock.leaderboard).toEqual([]);
    expect(render().sock.leaderboardReady).toBe(false);
    receive("leaderboard:update", { entries: [], totalQuestions: 1 });
    expect(render().sock.leaderboard).toEqual([]);
    expect(render().sock.leaderboardReady).toBe(true);
    receive("student:joined", { ...joined(), sessionState: "LEADERBOARD", questionAttempts: { "0": 2 } });
    expect(render().sock.leaderboardReady).toBe(true);
  });

  it("HTTP recovery invalidates an archived reveal until the current opening arrives", async () => {
    await start(studyData([opening()], [answer()]));
    const revealed = { questionIndex: 0, correctOptions: ["A"], explanation: "Archived explanation", distribution: { A: 1 } };
    receive("results:reveal", revealed);
    receive("results:distribution", { questionIndex: 0, distribution: { A: 1 } });
    expect(render().sock.reveal?.explanation).toBe("Archived explanation");
    expect(render().sock.distribution).not.toBeNull();
    receive("disconnect", undefined);
    render().study.refresh(); render();
    const recovered = await fetched(studyData([opening(0, 2)]));
    expect(recovered.sock.questionAttempts.get(0)).toBe(2);
    expect(recovered.sock.reveal).toBeNull();
    expect(recovered.sock.distribution).toBeNull();
    expect(recovered.sock.submitted).toBe(false);
    expect(recovered.sock.submittedOptions).toEqual([]);
    expect(recovered.study.question?.attempt).toBe(2);
    receive("results:reveal", revealed);
    expect(render().sock.reveal).toBeNull();
    render().study.refresh(); render();
    requests.at(-1)!.reject(new Error("Synthetic items failure")); await settle();
    expect(render().study.error).toBe("Available items could not be refreshed. Try again.");
    render().sock.reconnect();
    receive("student:joined", { ...joined(), questionAttempts: { "0": 2 } });
    const current = receive("question:open", opening(0, 2));
    expect(current.sock.currentQuestion?.attempt).toBe(2);
    expect(current.sock.sessionState).toBe("QUESTION_OPEN");
    const ready = await fetched(studyData([opening(0, 2)]));
    expect(ready.study.error).toBeNull();
    expect(ready.study.canAnswer).toBe(true);
  });

  it.each(["ACK", "HTTP", "join", "snapshot"])("two revisionless acceptances let the server win through %s", async source => {
    const shown = opening(0, undefined, "open_response");
    const first = answer(0, undefined, "First text");
    const second = answer(0, undefined, "Second text");
    await start(studyData([shown]), shown);
    render().sock.submitAnswer({ questionIndex: 0, responseText: "First text" });
    receive("answer:accepted", { questionIndex: 0 });
    expect(render().sock.ownAnswers.get(0)).toEqual(first);
    render().study.refresh(); render(); await fetched(studyData([shown], [first]));
    if (source === "ACK") {
      render().sock.submitAnswer({ questionIndex: 0, responseText: "Second text" });
      receive("answer:accepted", { questionIndex: 0 });
    } else if (source === "HTTP") {
      render().study.refresh(); render(); await fetched(studyData([shown], [second]));
    } else {
      // The second acceptance happened on another tab while this transport was offline.
      render().sock.submitAnswer({ questionIndex: 0, responseText: "Unconfirmed text" });
      receive("disconnect", undefined); receive("connect", undefined);
      if (source === "join") receive("student:joined", joined([second]));
      else receive("session:state", { state: "QUESTION_OPEN", answers: [second] });
    }
    const check = () => {
      const { sock, study } = render();
      expect(sock.ownAnswers.get(0)).toEqual(second);
      expect(sock.answeredQuestions).toEqual([0]);
      expect(sock.submitted).toBe(true);
      expect(sock.submittedOptions).toEqual([]);
      expect(sock.submittedResponseText).toBe("Second text");
      expect(study.submitted).toBe(true);
      expect(study.submittedOptions).toEqual([]);
      expect(study.submittedResponseText).toBe("Second text");
    };
    check();
    receive("question:open", shown);
    receive("results:reveal", { questionIndex: 0, questionType: "open_response", correctOptions: [], explanation: "Sample", distribution: {} });
    check();
  });

  it.each(["HTTP", "join", "snapshot"])("revisionless server %s replaces an ACK while a pending edit stays separate", async source => {
    const shown = opening(0, undefined, "open_response");
    await start(studyData([shown]), shown);
    render().sock.submitAnswer({ questionIndex: 0, responseText: "Local text" });
    receive("answer:accepted", { questionIndex: 0 });
    render().sock.submitAnswer({ questionIndex: 0, responseText: "Pending text" });
    const accepted = answer(0, undefined, "Other tab text");
    if (source === "HTTP") { render().study.refresh(); render(); await fetched(studyData([shown], [accepted])); }
    else if (source === "join") receive("student:joined", joined([accepted]));
    else receive("session:state", { state: "QUESTION_OPEN", answers: [accepted] });
    expect(render().sock.ownAnswers.get(0)).toEqual(accepted);
    expect(render().sock.submittedResponseText).toBe("Pending text");
    expect(render().study.submittedResponseText).toBe("Pending text");
    receive("answer:accepted", { questionIndex: 0 });
    expect(render().sock.ownAnswers.get(0)).toEqual(answer(0, undefined, "Pending text"));
    expect(render().sock.submittedResponseText).toBe("Pending text");
    expect(render().study.submittedResponseText).toBe("Pending text");
  });

  it("a first pending open response has no saved-answer content before ACK", async () => {
    const shown = opening(0, undefined, "open_response");
    await start(studyData([shown]), shown);
    render().study.setDraft({ responseText: "First text" });
    render().study.submitAnswer({ questionIndex: 0, responseText: "First text" });
    expect(render().sock.ownAnswers.size).toBe(0);
    expect(render().study.submitted).toBe(false);
    expect(render().study.submittedResponseText).toBeNull();
    expect(render().study.draft?.responseText).toBe("First text");
    receive("answer:accepted", { questionIndex: 0 });
    expect(render().study.submitted).toBe(true);
    expect(render().study.submittedResponseText).toBe("First text");
  });

  it.each([false, true].flatMap(versioned => [1, 2].map(count => ({ versioned, count }))))("rejected edits leave the saved answer intact with revisions $versioned and $count pending entries", async ({ versioned, count }) => {
    const shown = opening(0, undefined, "open_response");
    const accepted = { ...answer(0, undefined, "Accepted text"), ...(versioned ? { acceptedRevision: 1 } : {}) };
    await start(studyData([shown]), shown);
    render().sock.submitAnswer({ questionIndex: 0, responseText: "Accepted text" });
    receive("answer:accepted", { questionIndex: 0, ...(versioned ? { acceptedRevision: 1 } : {}) });
    await fetched(studyData([shown], [accepted]));
    for (let index = 0; index < count; index++) {
      render().study.setDraft({ responseText: `Rejected edit ${index}` });
      render().study.submitAnswer({ questionIndex: 0, responseText: `Rejected edit ${index}` });
    }
    expect(render().study.submittedResponseText).toBe(`Rejected edit ${count - 1}`);
    for (let index = 0; index < count; index++) {
      receive("answer:rejected", { questionIndex: 0, reason: "Synthetic refusal" });
      expect(render().sock.ownAnswers.get(0)).toEqual(accepted);
      expect(render().study.submittedResponseText).toBe(index < count - 1 ? `Rejected edit ${count - 1}` : "Accepted text");
    }
    expect(render().sock.answerRejectionFor(0)).toEqual({ questionIndex: 0, reason: "Synthetic refusal" });
    expect(render().study.submitted).toBe(true);
    expect(render().study.draft?.responseText).toBe(`Rejected edit ${count - 1}`);
  });

  it("a revisionless same-attempt snapshot replaces versioned knowledge without reviving an archived attempt", async () => {
    const shown = opening(0, 2, "open_response");
    await start(studyData([shown], [{ ...answer(0, 2, "Versioned text"), acceptedRevision: 5 }]), shown);
    const legacy = answer(0, 2, "Rollback text");
    receive("session:state", { state: "QUESTION_OPEN", answers: [legacy] });
    expect(render().sock.ownAnswers.get(0)).toEqual(legacy);
    receive("session:state", { state: "QUESTION_OPEN", answers: [answer(0, undefined, "Archived text")] });
    expect(render().sock.ownAnswers.get(0)).toEqual(legacy);
    expect(render().sock.submittedResponseText).toBe("Rollback text");
    expect(render().study.submittedResponseText).toBe("Rollback text");
  });

  it("main rollback replay cannot recover an attempt-2 edit until the page reloads", async () => {
    // Main da0d9fb6 engine.ts ownAnswers 307-316, join 759-766, snapshot 925-966 and study 326-342.
    // app.ts 823-831 returns the study payload unchanged over HTTP.
    const mainAvailability = { schemaVersion: 1 as const, phase: "active" as const, serverNow: 300, availableUntil: 10000, recoverBefore: 604810000, deleteAt: 604810000 };
    const mainAnswer: StudentAnswer = { questionIndex: 0, selectedOptions: [], responseText: "Rollback text" };
    const mainOpening: QuestionOpenPayload = {
      questionIndex: 0, topic: "Sample", text: "Sample attempt 2", questionType: "open_response", options: [],
      allowsMultiple: false, isPoll: false, timeLimitSec: null, startedAt: 200, serverNow: 300,
      deadlineAt: null, firstOpenedAt: 200, questionNumber: 1, questionTotal: 1,
    };
    const mainJoin = {
      participantId: "sample", sessionToken: "seat", sessionState: "QUESTION_OPEN", availability: mainAvailability,
      currentQuestion: 0, answeredQuestions: [0], answers: [mainAnswer], publicKey: "key-sample", label: "Sample", deckTitle: "Rollback smoke",
    };
    const mainSnapshot = [
      { audience: "participant:sample", event: "session:availability", payload: mainAvailability },
      { audience: "participant:sample", event: "question:open", payload: mainOpening },
    ];
    const mainStudy: ParticipantStudyPayload = {
      availability: mainAvailability, policy: { schemaVersion: 2, pacing: "presenter-paced", ranking: "automatic", effectiveTiming: "authored" },
      items: [mainOpening], currentQuestionIndex: 0, state: "QUESTION_OPEN", answers: [mainAnswer], answeredQuestions: [0], answerableQuestionIndexes: [0],
    };
    const shown = { ...mainOpening, attempt: 2 };
    const known = { ...answer(0, 2, "Versioned text"), acceptedRevision: 5 };
    await start(studyData([shown], [known]), shown);
    const checkRetained = () => {
      expect(render().sock.ownAnswers.get(0)).toEqual(known);
      expect(render().sock.answeredQuestions).toEqual([0]);
      expect(render().sock.currentQuestion?.attempt).toBe(2);
      expect(render().sock.submitted).toBe(true);
      expect(render().sock.submittedOptions).toEqual([]);
      expect(render().sock.submittedResponseText).toBe("Versioned text");
      expect(render().study.question?.attempt).toBe(2);
      expect(render().study.submitted).toBe(true);
      expect(render().study.submittedOptions).toEqual([]);
      expect(render().study.submittedResponseText).toBe("Versioned text");
    };
    render().sock.submitAnswer({ questionIndex: 0, attempt: 2, responseText: "Rollback text" });
    expect(render().sock.submittedResponseText).toBe("Rollback text");
    expect(render().study.submittedResponseText).toBe("Rollback text");
    receive("disconnect", undefined); receive("connect", undefined);
    receive("student:joined", mainJoin);
    checkRetained();
    for (const message of mainSnapshot) receive(message.event, message.payload);
    checkRetained();
    render().study.refresh(); render(); await fetched(mainStudy);
    checkRetained();

    // Reload keeps the seat credential and starts a new page with no attempt watermark.
    harness.unmount(); harness = hookHarness(); requests = [];
    render(); receive("student:joined", mainJoin);
    for (const message of mainSnapshot) receive(message.event, message.payload);
    await fetched(mainStudy);
    expect(render().sock.ownAnswers.get(0)).toEqual(mainAnswer);
    expect(render().sock.answeredQuestions).toEqual([0]);
    expect(render().sock.currentQuestion?.attempt).toBeUndefined();
    expect(render().sock.submitted).toBe(true);
    expect(render().sock.submittedOptions).toEqual([]);
    expect(render().sock.submittedResponseText).toBe("Rollback text");
    expect(render().study.question?.attempt).toBeUndefined();
    expect(render().study.submitted).toBe(true);
    expect(render().study.submittedOptions).toEqual([]);
    expect(render().study.submittedResponseText).toBe("Rollback text");
  });

  it("orders accepted answers by attempt then revision when both revisions are present", () => {
    const old = { ...answer(), acceptedRevision: 100 };
    const next = answer(0, 2);
    expect(compareAcceptedAnswers(next, old)).toBeGreaterThan(0);
    expect(compareAcceptedAnswers(answer(), { ...answer(), acceptedRevision: 0 })).toBe(0);
    const current = { ...answer(0, 2), acceptedRevision: 3 };
    const older = { ...answer(0, 2), acceptedRevision: 2, selectedOptions: [1] };
    expect(mergeOwnAnswers(new Map([[0, current]]), [older, { ...next, acceptedRevision: 0 }, old]).get(0)).toEqual(current);
    expect(mergeOwnAnswers(new Map([[0, next]]), [current]).get(0)).toEqual(current);
    expect(mergeOwnAnswers(new Map([[0, current]]), [{ ...current, selectedOptions: [1] }]).get(0)).toEqual(current);
    expect(mergeOwnAnswers(new Map([[0, current]]), [next]).get(0)).toEqual(next);
    expect(mergeOwnAnswers(new Map([[0, next]]), [current]).get(0)).toEqual(current);
  });

  it.each([1, 2].flatMap(attempt => (["multiple_choice", "open_response"] as const).flatMap(questionType =>
    ["ACK", "HTTP-only"].flatMap(initial => ["HTTP", "snapshot", "join"].map(source => ({ attempt, questionType, initial, source }))))))(
    "a newer server $questionType after $initial wins through $source at attempt $attempt", async ({ attempt, questionType, initial, source }) => {
      const response = questionType === "open_response";
      const shown = opening(0, attempt, questionType);
      const earlier = { ...answer(0, attempt > 1 ? attempt : undefined, response ? "Tab A text" : undefined), acceptedRevision: 1 };
      await start(studyData([shown], initial === "HTTP-only" ? [earlier] : []), shown, []);
      if (initial === "ACK") {
        render().sock.submitAnswer({ questionIndex: 0, attempt, ...(response ? { responseText: "Tab A text" } : { selectedOptions: ["A"] }) });
        receive("answer:accepted", { questionIndex: 0, attempt, acceptedRevision: 1 });
      }
      expect(render().sock.ownAnswers.get(0)).toEqual(earlier);
      const newer = { ...answer(0, attempt > 1 ? attempt : undefined, response ? "Tab B text" : undefined), selectedOptions: response ? [] : [1], acceptedRevision: 2 };
      if (source === "HTTP") { render().study.refresh(); render(); await fetched(studyData([shown], [newer])); }
      else if (source === "join") receive("student:joined", joined([newer]));
      else receive("session:state", { state: "QUESTION_OPEN", answers: [newer] });
      const current = render();
      expect(current.sock.ownAnswers.get(0)).toEqual(newer);
      expect(current.sock.answeredQuestions).toEqual([0]);
      expect(current.sock.submitted).toBe(true);
      expect(current.sock.submittedOptions).toEqual(response ? [] : ["B"]);
      expect(current.sock.submittedResponseText).toBe(response ? "Tab B text" : null);
      expect(current.study.submittedOptions).toEqual(response ? [] : ["B"]);
      expect(current.study.submittedResponseText).toBe(response ? "Tab B text" : null);
      // Delayed and duplicate deliveries cannot reverse the accepted order.
      receive("student:joined", joined([earlier]));
      receive("session:state", { state: "QUESTION_OPEN", answers: [earlier] });
      render().study.refresh(); render(); await fetched(studyData([shown], [earlier]));
      receive("question:open", shown);
      expect(render().sock.ownAnswers.get(0)).toEqual(newer);
      expect(render().study.submittedResponseText).toBe(response ? "Tab B text" : null);
      expect(render().study.submittedOptions).toEqual(response ? [] : ["B"]);
    });

  it.each([false, true])("a newer server answer reaches a browsed item with revisions %s", async versioned => {
    const shown = opening();
    const browsed = opening(1, undefined, "open_response");
    const earlier = { ...answer(1, undefined, "Earlier text"), ...(versioned ? { acceptedRevision: 1 } : {}) };
    const newer = { ...answer(1, undefined, "Newer text"), ...(versioned ? { acceptedRevision: 2 } : {}) };
    await start(studyData([shown, browsed], [earlier], true), shown);
    render().study.browse(1);
    receive("session:state", { state: "QUESTION_OPEN", answers: [newer] });
    expect(render().sock.currentQuestion?.questionIndex).toBe(0);
    expect(render().sock.ownAnswers.get(1)).toEqual(newer);
    expect(render().study.question?.questionIndex).toBe(1);
    expect(render().study.submittedResponseText).toBe("Newer text");
  });

  it.each([1, 2].flatMap(attempt => (["multiple_choice", "open_response"] as const).map(questionType => ({ attempt, questionType }))))(
    "a server revision keeps a pending $questionType display and an older ACK cannot roll it back at attempt $attempt", async ({ attempt, questionType }) => {
      const response = questionType === "open_response";
      const shown = opening(0, attempt, questionType);
      await start(studyData([shown]), shown);
      render().sock.submitAnswer({ questionIndex: 0, attempt, ...(response ? { responseText: "Pending text" } : { selectedOptions: ["A"] }) });
      const newer = { ...answer(0, attempt > 1 ? attempt : undefined, response ? "Server text" : undefined), selectedOptions: response ? [] : [1], acceptedRevision: 3 };
      receive("session:state", { state: "QUESTION_OPEN", answers: [newer] });
      expect(render().sock.ownAnswers.get(0)).toEqual(newer);
      expect(render().sock.submittedOptions).toEqual(response ? [] : ["A"]);
      expect(render().sock.submittedResponseText).toBe(response ? "Pending text" : null);
      receive("answer:accepted", { questionIndex: 0, attempt, acceptedRevision: 2 });
      expect(render().sock.ownAnswers.get(0)).toEqual(newer);
      expect(render().sock.submittedOptions).toEqual(response ? [] : ["B"]);
      expect(render().sock.submittedResponseText).toBe(response ? "Server text" : null);
    });

  it.each([1, 2].flatMap(attempt => (["multiple_choice", "open_response"] as const).map(questionType => ({ attempt, questionType }))))(
    "disconnect retains accepted ordering for $questionType at attempt $attempt", async ({ attempt, questionType }) => {
      const response = questionType === "open_response";
      const shown = opening(0, attempt, questionType);
      const current = { ...answer(0, attempt, response ? "Current text" : undefined), acceptedRevision: 2 };
      await start(studyData([shown], [current]), shown);
      receive("disconnect", undefined); receive("connect", undefined);
      const older = { ...answer(0, attempt, response ? "Earlier text" : undefined), selectedOptions: response ? [] : [1], acceptedRevision: 1 };
      receive("student:joined", joined([older]));
      receive("session:state", { state: "QUESTION_OPEN", answers: [older] });
      receive("question:open", shown);
      expect(render().sock.ownAnswers.get(0)).toEqual(current);
      expect(render().sock.submittedResponseText).toBe(response ? "Current text" : null);
      expect(render().sock.submittedOptions).toEqual(response ? [] : ["A"]);
    });

  it.each([1, 2].flatMap(attempt => (["multiple_choice", "open_response"] as const).flatMap(questionType =>
    [1, 2].flatMap(revision => ["snapshot", "opening"].map(source => ({ attempt, questionType, revision, source }))))))(
    "snapshot-only reconnect restores accepted $questionType display through $source revision $revision at attempt $attempt", async ({ attempt, questionType, revision, source }) => {
      const response = questionType === "open_response";
      const shown = opening(0, attempt, questionType);
      const accepted = { ...answer(0, attempt, response ? "Accepted text" : undefined), acceptedRevision: 2 };
      await start(studyData([shown], [accepted]), shown);
      render().sock.submitAnswer({ questionIndex: 0, attempt, ...(response ? { responseText: "Unconfirmed text" } : { selectedOptions: ["B"] }) });
      expect(render().sock.submittedResponseText).toBe(response ? "Unconfirmed text" : null);
      expect(render().sock.submittedOptions).toEqual(response ? [] : ["B"]);
      receive("disconnect", undefined); receive("connect", undefined);
      const check = () => {
        expect(render().sock.ownAnswers.get(0)).toEqual(accepted);
        expect(render().sock.answeredQuestions).toEqual([0]);
        expect(render().sock.submitted).toBe(true);
        expect(render().sock.submittedResponseText).toBe(response ? "Accepted text" : null);
        expect(render().sock.submittedOptions).toEqual(response ? [] : ["A"]);
      };
      if (source === "snapshot") {
        const replayed = { ...answer(0, attempt, response ? "Stale text" : undefined), selectedOptions: response ? [] : [1], acceptedRevision: revision };
        receive("session:state", { state: "QUESTION_OPEN", answers: [revision === 2 ? accepted : replayed] });
        check();
      }
      receive("question:open", shown);
      check();
      receive("results:reveal", { questionIndex: 0, questionType, correctOptions: ["A"], explanation: "Sample", distribution: {} });
      check();
    });

  it("forgets only for a later attempt than it saw, and a first sighting only records", () => {
    const seen = new Map<number, number>();
    expect(isLaterAttempt(seen, 0, 1)).toBe(false);
    expect(isLaterAttempt(seen, 0, 1)).toBe(false);
    expect(isLaterAttempt(seen, 0, 2)).toBe(true);
    expect(isLaterAttempt(seen, 0, 2)).toBe(false);
    expect(isLaterAttempt(seen, 0, 1)).toBe(false);
    expect(seen.get(0)).toBe(2);
    expect(isLaterAttempt(seen, 4, 3)).toBe(false);
    expect(isLaterAttempt(seen, 4, 4)).toBe(true);
  });

  it("an opening forgets the earlier answer, answered mark and shown selection before reseeding", async () => {
    await start(studyData([opening(), opening(1)], [answer(), answer(1)]));
    const { sock } = receive("question:open", opening(0, 2));
    expect(sock.currentQuestion?.attempt).toBe(2);
    expect(sock.ownAnswers.has(0)).toBe(false);
    expect(sock.ownAnswers.has(1)).toBe(true);
    expect(sock.answeredQuestions).toEqual([1]);
    expect(sock.submitted).toBe(false);
    expect(sock.submittedOptions).toEqual([]);
    expect(sock.submittedResponseText).toBeNull();
  });

  it("an attempt advance is a new opening even when its timestamp is unchanged", async () => {
    await start(studyData([opening()], [answer()]));
    const { sock, study } = receive("question:open", { ...opening(0, 2), startedAt: 100 });
    expect(sock.currentQuestion?.attempt).toBe(2);
    expect(study.question?.attempt).toBe(2);
    expect(study.submitted).toBe(false);
    expect(study.canAnswer).toBe(true);
  });

  it("repeated openings and join snapshots keep a current accepted answer and current draft", async () => {
    writeDraft(key, { selectedOptions: ["B"], responseText: "", revision: 3, attempt: 2 });
    await start(studyData([opening()], [answer()]));
    receive("student:joined", joined([answer(0, 2)]));
    expect(receive("question:open", opening(0, 2)).sock.ownAnswers.get(0)).toEqual(answer(0, 2));
    await fetched(studyData([opening(0, 2)], [answer(0, 2)]));
    receive("question:open", opening(0, 2));
    receive("student:joined", joined([answer(0, 2)]));
    const { sock, study } = receive("question:open", opening(0, 2));
    expect(sock.ownAnswers.get(0)).toEqual(answer(0, 2));
    expect(sock.answeredQuestions).toEqual([0]);
    expect(sock.submittedOptions).toEqual(["A"]);
    expect(study.submitted).toBe(true);
    expect(study.draft?.selectedOptions).toEqual(["B"]);
    expect(study.draft?.revision).toBe(3);
  });

  it.each([0, 2, 3].flatMap(questionIndex => [false, true].map(accepted => ({ questionIndex, accepted }))))("a rejoin reveals only the current answer for item $questionIndex with a new accepted answer $accepted", async ({ questionIndex, accepted }) => {
    let session = createSession(goldenQuiz.week, "open");
    const step = (command: Command, now = 200) => { const result = apply(session, goldenQuiz, command, now); session = result.session; return result; };
    const join: Command = { type: "join", payload: { studentId: "sample", displayName: "Sample", sessionToken: "seat" }, socketId: "sample", newToken: "seat" };
    const response = questionIndex === 3;
    step({ type: "configurePolicy", role: "control", pacing: "presenter-paced" });
    step(join); step({ type: "start" });
    for (let index = 0; index < questionIndex; index++) {
      step({ type: "close" }); step({ type: "reveal" }); step({ type: "next" });
    }
    step({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex, ...(response ? { responseText: "Earlier accepted text" } : { selectedOptions: ["A"] }) } });
    const cached = participantStudyPayload(session, goldenQuiz, "sample", 300);
    const initial = await start(cached, cached.items.find(item => item.questionIndex === questionIndex)!);
    expect(initial.sock.submitted).toBe(true);
    expect(initial.sock.submittedOptions).toEqual(response ? [] : ["A"]);
    expect(initial.sock.submittedResponseText).toBe(response ? "Earlier accepted text" : null);
    receive("disconnect", undefined);
    step({ type: "disconnect", studentId: "sample", socketId: "sample" });
    step({ type: "rerun", role: "control", questionIndex }, 400);
    if (accepted) step({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex, attempt: 2, ...(response ? { responseText: "Current accepted text" } : { selectedOptions: ["B"] }) } }, 450);
    step({ type: "close" }, 500); step({ type: "reveal" }, 550);
    receive("connect", undefined);
    const replay = step(join, 600).messages.filter(message => message.audience === "participant:sample");
    expect(replay.map(message => message.event)).toEqual(["student:joined", "session:availability", "session:state", "question:open", "results:reveal", ...(questionIndex === 2 && accepted ? ["poll:live"] : [])]);
    for (const message of replay) {
      const { sock } = receive(message.event, message.payload);
      const beforeOpening = ["student:joined", "session:availability", "session:state"].includes(message.event);
      expect(sock.answeredQuestions.includes(questionIndex)).toBe(accepted);
      expect(sock.ownAnswers.has(questionIndex)).toBe(accepted);
      expect(sock.submitted).toBe(accepted && !beforeOpening);
      expect(sock.submittedOptions).toEqual(accepted && !response && !beforeOpening ? ["B"] : []);
      expect(sock.submittedResponseText).toBe(accepted && response && !beforeOpening ? "Current accepted text" : null);
    }
    requests.at(-1)!.reject(new Error("Synthetic items failure")); await settle();
    const { sock, study } = render();
    expect(sock.sessionState).toBe("REVEAL");
    expect(sock.currentQuestion?.attempt).toBe(2);
    expect(sock.reveal?.questionIndex).toBe(questionIndex);
    expect(sock.submittedOptions).toEqual(accepted && !response ? ["B"] : []);
    expect(sock.submittedResponseText).toBe(accepted && response ? "Current accepted text" : null);
    expect(study.submitted).toBe(accepted);
    expect(study.submittedOptions).toEqual(sock.submittedOptions);
    expect(study.submittedResponseText).toBe(sock.submittedResponseText);
  });

  it("a snapshot without a join forgets an archived answer before replaying the new reveal", async () => {
    await start(studyData([opening()], [answer()]));
    receive("disconnect", undefined); receive("connect", undefined);
    const announced = receive("session:state", { state: "REVEAL", questionIndex: 0, questionAttempts: { "0": 2 } });
    expect(announced.sock.submitted).toBe(false);
    expect(announced.sock.answeredQuestions).toEqual([]);
    expect(announced.sock.ownAnswers.has(0)).toBe(false);
    expect(announced.sock.submittedOptions).toEqual([]);
    receive("question:open", opening(0, 2));
    const { sock } = receive("results:reveal", { questionIndex: 0, correctOptions: ["B"], explanation: "Sample", distribution: { B: 1 } });
    expect(sock.sessionState).toBe("REVEAL");
    expect(sock.submitted).toBe(false);
    expect(sock.submittedOptions).toEqual([]);
    expect(sock.submittedResponseText).toBeNull();
  });

  it.each((["presenter-paced", "self-paced"] as const).flatMap(pacing => [0, 2, 3].flatMap(questionIndex => [false, true].map(failed => ({ pacing, questionIndex, failed })))))("a real $pacing snapshot restores the accepted second-attempt answer for item $questionIndex with HTTP failure $failed", async ({ pacing, questionIndex, failed }) => {
    let session = createSession(goldenQuiz.week, "open");
    const step = (command: Command, now = 200) => { const result = apply(session, goldenQuiz, command, now); session = result.session; return result; };
    const response = questionIndex === 3;
    step({ type: "configurePolicy", role: "control", pacing });
    step({ type: "join", payload: { studentId: "sample", displayName: "Sample", sessionToken: "seat" }, socketId: "sample", newToken: "seat" });
    step({ type: "start" });
    for (let index = 0; index < questionIndex; index++) {
      if (pacing === "presenter-paced") { step({ type: "close" }); step({ type: "reveal" }); }
      step({ type: "next" });
    }
    const submit = (attempt = 1): Command => ({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: {
      questionIndex, ...(attempt > 1 ? { attempt } : {}),
      ...(response ? { responseText: attempt === 1 ? "Earlier accepted text" : "Current accepted text" } : { selectedOptions: [attempt === 1 ? "A" : "B"] }),
    } });
    expect(step(submit()).messages[0].event).toBe("answer:accepted");
    const cached = participantStudyPayload(session, goldenQuiz, "sample", 300);
    await start(cached, cached.items.find(item => item.questionIndex === questionIndex)!);
    receive("disconnect", undefined);
    step({ type: "disconnect", studentId: "sample", socketId: "sample" });
    step({ type: "rerun", role: "control", questionIndex }, 400);
    expect(step(submit(2), 450).messages[0].event).toBe("answer:accepted");
    if (pacing === "presenter-paced") { step({ type: "close" }, 500); step({ type: "reveal" }, 550); }
    receive("connect", undefined);
    const replay = step({ type: "snapshot", participantId: "sample", isReconnect: true }, 600).messages;
    expect(replay.every(message => message.audience === "participant:sample")).toBe(true);
    expect(replay.map(message => message.event)).toEqual(["session:availability", "session:state", "question:open",
      ...(pacing === "presenter-paced" ? ["results:reveal"] : []), ...(questionIndex === 2 ? ["poll:live"] : [])]);
    const accepted = { questionIndex, acceptedRevision: 1, selectedOptions: response ? [] : [1], attempt: 2, ...(response ? { responseText: "Current accepted text" } : {}) };
    expect(replay.find(message => message.event === "session:state")?.payload).toMatchObject({ answers: [accepted] });
    const check = () => {
      const { sock, study } = render();
      expect(sock.ownAnswers.get(questionIndex)).toEqual(accepted);
      expect(sock.answeredQuestions).toContain(questionIndex);
      expect(sock.submitted).toBe(true);
      expect(sock.submittedOptions).toEqual(response ? [] : ["B"]);
      expect(sock.submittedResponseText).toBe(response ? "Current accepted text" : null);
      expect(study.submitted).toBe(true);
      expect(study.submittedOptions).toEqual(sock.submittedOptions);
      expect(study.submittedResponseText).toBe(sock.submittedResponseText);
      expect(sock.currentQuestion?.attempt).toBe(2);
      if (pacing === "presenter-paced") {
        expect(sock.sessionState).toBe("REVEAL");
        expect(sock.reveal?.questionIndex).toBe(questionIndex);
      }
    };
    for (const message of replay) {
      receive(message.event, message.payload);
      if (message.event === "session:state") {
        expect(render().sock.ownAnswers.get(questionIndex)).toEqual(accepted);
        expect(render().sock.submitted).toBe(false);
      }
      if (message.event === "results:reveal") check();
    }
    check();
    if (failed) { requests.at(-1)!.reject(new Error("Synthetic items failure")); await settle(); }
    else await fetched(participantStudyPayload(session, goldenQuiz, "sample", 650));
    check();
    expect(render().study.error).toBe(failed ? "Available items could not be refreshed. Try again." : null);
    render().study.refresh(); render();
    await fetched(cached);
    check();
  });

  it.each((["presenter-paced", "self-paced"] as const).flatMap(pacing => [0, 2, 3].map(questionIndex => ({ pacing, questionIndex }))))("HTTP restores socket fields for an older $pacing snapshot without own answers for item $questionIndex", async ({ pacing, questionIndex }) => {
    let session = createSession(goldenQuiz.week, "open");
    const step = (command: Command, now = 200) => { const result = apply(session, goldenQuiz, command, now); session = result.session; return result; };
    const response = questionIndex === 3;
    step({ type: "configurePolicy", role: "control", pacing });
    step({ type: "join", payload: { studentId: "sample", sessionToken: "seat" }, socketId: "sample", newToken: "seat" });
    step({ type: "start" });
    for (let index = 0; index < questionIndex; index++) {
      if (pacing === "presenter-paced") { step({ type: "close" }); step({ type: "reveal" }); }
      step({ type: "next" });
    }
    step({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex, ...(response ? { responseText: "Earlier accepted text" } : { selectedOptions: ["A"] }) } });
    const cached = participantStudyPayload(session, goldenQuiz, "sample", 300);
    await start(cached, cached.items.find(item => item.questionIndex === questionIndex)!);
    receive("disconnect", undefined);
    step({ type: "rerun", role: "control", questionIndex }, 400);
    step({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex, attempt: 2, ...(response ? { responseText: "Current accepted text" } : { selectedOptions: ["B"] }) } }, 450);
    if (pacing === "presenter-paced") { step({ type: "close" }, 500); step({ type: "reveal" }, 550); }
    receive("connect", undefined);
    for (const message of step({ type: "snapshot", participantId: "sample", isReconnect: true }, 600).messages) {
      const payload = { ...message.payload as Record<string, unknown> };
      // Simulate an older host that sends attempts but omits the optional own answers.
      if (message.event === "session:state") delete payload.answers;
      receive(message.event, payload);
    }
    expect(render().sock.submitted).toBe(false);
    expect(render().sock.submittedOptions).toEqual([]);
    const { sock, study } = await fetched(participantStudyPayload(session, goldenQuiz, "sample", 650));
    expect(sock.ownAnswers.get(questionIndex)).toMatchObject({ attempt: 2, selectedOptions: response ? [] : [1] });
    expect(sock.answeredQuestions).toContain(questionIndex);
    expect(sock.submitted).toBe(true);
    expect(sock.submittedOptions).toEqual(response ? [] : ["B"]);
    expect(sock.submittedResponseText).toBe(response ? "Current accepted text" : null);
    expect(study.submittedOptions).toEqual(sock.submittedOptions);
    expect(study.submittedResponseText).toBe(sock.submittedResponseText);
  });

  it.each((["presenter-paced", "self-paced"] as const).flatMap(pacing => [false, true].map(known => ({ pacing, known }))))("a never-rerun $pacing HTTP answer cannot overwrite an ACK before render with known answer $known", async ({ pacing, known }) => {
    const quiz = { ...goldenQuiz, questions: [{ ...goldenQuiz.questions[3], index: 0 }] };
    let session = createSession(quiz.week, "open");
    const step = (command: Command, now = 200) => { const result = apply(session, quiz, command, now); session = result.session; return result; };
    const submit = (responseText: string): Command => ({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex: 0, responseText } });
    step({ type: "configurePolicy", role: "control", pacing });
    step({ type: "join", payload: { studentId: "sample", sessionToken: "seat" }, socketId: "sample", newToken: "seat" });
    step({ type: "start" });
    if (known) step(submit("Earlier accepted text"), 300);
    const initial = participantStudyPayload(session, quiz, "sample", 350);
    await start(initial, initial.items[0]);
    if (!known) step(submit("Earlier accepted text"), 400);
    render().study.refresh(); render();
    const delayed = requests.at(-1)!;
    const captured = participantStudyPayload(session, quiz, "sample", 450);
    expect(captured.answers[0]).toEqual({ questionIndex: 0, selectedOptions: [], responseText: "Earlier accepted text" });
    render().sock.submitAnswer({ questionIndex: 0, responseText: "Current accepted text" });
    const accepted = step(submit("Current accepted text"), 500).messages[0];
    expect(accepted).toEqual({ audience: "participant:sample", event: "answer:accepted", payload: { questionIndex: 0 } });
    harness.receive(accepted.event, accepted.payload);
    delayed.resolve({ ok: true, json: async () => captured }); await settle();
    const check = () => {
      const { sock, study } = render();
      expect(sock.ownAnswers.get(0)).toEqual({ questionIndex: 0, selectedOptions: [], responseText: "Current accepted text" });
      expect(sock.submitted).toBe(true);
      expect(sock.submittedResponseText).toBe("Current accepted text");
      expect(study.submitted).toBe(true);
      expect(study.submittedResponseText).toBe("Current accepted text");
    };
    check();
    requests.at(-1)!.reject(new Error("Synthetic follow-up items failure")); await settle();
    check();
    expect(render().study.error).toBe("Available items could not be refreshed. Try again.");
    step(submit("Later server text"), 550);
    render().study.refresh(); render();
    await fetched(participantStudyPayload(session, quiz, "sample", 600));
    expect(render().sock.ownAnswers.get(0)?.responseText).toBe("Later server text");
    expect(render().study.submittedResponseText).toBe("Later server text");
  });

  it.each((["presenter-paced", "self-paced"] as const).flatMap(pacing => [1, 2].flatMap(attempt => [false, true].flatMap(known => [false, true].map(ackFirst => ({ pacing, attempt, known, ackFirst }))))))("a delayed $pacing HTTP answer preserves newer text at attempt $attempt with known answer $known and ACK first $ackFirst", async ({ pacing, attempt, known, ackFirst }) => {
    const quiz = { ...goldenQuiz, questions: [0, 1].map(index => ({ ...goldenQuiz.questions[3], index })) };
    let session = createSession(quiz.week, "open");
    const step = (command: Command, now = 200) => { const result = apply(session, quiz, command, now); session = result.session; return result; };
    const questionIndex = attempt === 1 ? 1 : 0;
    const submit = (responseText: string): Command => ({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex, responseText, ...(attempt > 1 ? { attempt } : {}) } });
    step({ type: "configurePolicy", role: "control", pacing });
    step({ type: "join", payload: { studentId: "sample", sessionToken: "seat" }, socketId: "sample", newToken: "seat" });
    step({ type: "start" });
    step({ type: "rerun", role: "control", questionIndex: 0 }, 300);
    if (attempt === 1) {
      if (pacing === "presenter-paced") { step({ type: "close" }); step({ type: "reveal" }); }
      step({ type: "next" });
    }
    if (known) step(submit("Earlier accepted text"), 350);
    const initial = participantStudyPayload(session, quiz, "sample", 400);
    await start(initial, initial.items.find(item => item.questionIndex === questionIndex)!);
    if (!known) step(submit("Earlier accepted text"), 450);
    render().study.refresh(); render();
    const delayed = requests.at(-1)!;
    const captured = participantStudyPayload(session, quiz, "sample", 500);
    render().sock.submitAnswer({ questionIndex, responseText: "Current accepted text", attempt });
    const accepted = step(submit("Current accepted text"), 550).messages[0];
    expect(accepted.event).toBe("answer:accepted");
    // Deliver the ACK without a render to cover HTTP resolving before effect cleanup.
    if (ackFirst) harness.receive(accepted.event, accepted.payload);
    delayed.resolve({ ok: true, json: async () => captured }); await settle(); render();
    expect(render().sock.submittedResponseText).toBe("Current accepted text");
    expect(render().sock.ownAnswers.get(questionIndex)?.responseText).toBe(ackFirst ? "Current accepted text" : "Earlier accepted text");
    expect(render().sock.submitted).toBe(true);
    if (!ackFirst) receive(accepted.event, accepted.payload);
    requests.at(-1)!.reject(new Error("Synthetic follow-up items failure")); await settle();
    if (pacing === "presenter-paced") {
      for (const type of ["close", "reveal"] as const) for (const message of step({ type }, 600).messages) {
        if (message.audience === "all" || message.audience === "participants") receive(message.event, message.payload);
      }
      expect(render().sock.sessionState).toBe("REVEAL");
      expect(render().sock.reveal?.questionIndex).toBe(questionIndex);
      requests.at(-1)!.reject(new Error("Synthetic reveal items failure")); await settle();
    }
    const { sock, study } = render();
    expect(sock.ownAnswers.get(questionIndex)).toMatchObject({ responseText: "Current accepted text" });
    expect(sock.submitted).toBe(true);
    expect(sock.submittedResponseText).toBe("Current accepted text");
    expect(study.submittedResponseText).toBe("Current accepted text");
    expect(study.error).toBe("Available items could not be refreshed. Try again.");
  });

  it.each([1, 2].flatMap(attempt => [false, true].map(laterPending => ({ attempt, laterPending }))))("an ACK repairs a delayed snapshot at attempt $attempt without replacing a later pending edit $laterPending", async ({ attempt, laterPending }) => {
    const quiz = { ...goldenQuiz, questions: [0, 1].map(index => ({ ...goldenQuiz.questions[3], index })) };
    const questionIndex = attempt === 1 ? 1 : 0;
    let session = createSession(quiz.week, "open");
    const step = (command: Command, now = 200) => { const result = apply(session, quiz, command, now); session = result.session; return result; };
    const submit = (responseText: string): Command => ({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex, responseText, ...(attempt > 1 ? { attempt } : {}) } });
    step({ type: "configurePolicy", role: "control", pacing: "presenter-paced" });
    step({ type: "join", payload: { studentId: "sample", sessionToken: "seat" }, socketId: "sample", newToken: "seat" });
    step({ type: "start" });
    step({ type: "rerun", role: "control", questionIndex: 0 }, 300);
    if (attempt === 1) { step({ type: "close" }); step({ type: "reveal" }); step({ type: "next" }); }
    step(submit("Earlier accepted text"), 350);
    const cached = participantStudyPayload(session, quiz, "sample", 400);
    await start(cached, cached.items.find(item => item.questionIndex === questionIndex)!);
    const delayed = step({ type: "snapshot", participantId: "sample", isReconnect: true }, 450).messages;
    render().sock.submitAnswer({ questionIndex, responseText: "Current accepted text", attempt });
    const accepted = step(submit("Current accepted text"), 500).messages[0];
    for (const message of delayed) receive(message.event, message.payload);
    expect(render().sock.submittedResponseText).toBe("Current accepted text");
    let laterAck = accepted;
    if (laterPending) {
      render().sock.submitAnswer({ questionIndex, responseText: "Later accepted text", attempt });
      laterAck = step(submit("Later accepted text"), 550).messages[0];
    }
    receive(accepted.event, accepted.payload);
    expect(render().sock.submittedResponseText).toBe(laterPending ? "Later accepted text" : "Current accepted text");
    if (laterPending) receive(laterAck.event, laterAck.payload);
    requests.at(-1)!.reject(new Error("Synthetic ACK items failure")); await settle();
    for (const type of ["close", "reveal"] as const) for (const message of step({ type }, 600).messages) {
      if (message.audience === "all" || message.audience === "participants") receive(message.event, message.payload);
    }
    requests.at(-1)!.reject(new Error("Synthetic reveal items failure")); await settle();
    const { sock, study } = render();
    expect(sock.sessionState).toBe("REVEAL");
    expect(sock.reveal?.questionIndex).toBe(questionIndex);
    expect(sock.ownAnswers.get(questionIndex)?.responseText).toBe(laterPending ? "Later accepted text" : "Current accepted text");
    expect(sock.submittedResponseText).toBe(sock.ownAnswers.get(questionIndex)?.responseText);
    expect(study.submittedResponseText).toBe(sock.submittedResponseText);
    expect(study.error).toBe("Available items could not be refreshed. Try again.");
  });

  it.each((["multiple_choice", "open_response"] as const).flatMap(questionType => [false, true].map(currentAccepted => ({ questionType, currentAccepted }))))("HTTP advance consumes an archived $questionType ACK without restoring it with current answer $currentAccepted", async ({ questionType, currentAccepted }) => {
    const response = questionType === "open_response";
    const shown = opening(0, undefined, questionType);
    await start(studyData([shown]), shown);
    render().sock.submitAnswer({ questionIndex: 0, ...(response ? { responseText: "Archived text" } : { selectedOptions: ["A"] }) });
    render().study.refresh(); render();
    const current = answer(0, 2, response ? "Current text" : undefined);
    await fetched(studyData([opening(0, 2, questionType)], currentAccepted ? [current] : []));
    expect(render().sock.currentQuestion?.attempt).toBeUndefined();
    const revision = render().sock.answerRevision;
    const after = receive("answer:accepted", { questionIndex: 0 }).sock;
    expect(after.ownAnswers.get(0)).toEqual(currentAccepted ? current : undefined);
    expect(after.answeredQuestions).toEqual(currentAccepted ? [0] : []);
    expect(after.submitted).toBe(false);
    expect(after.submittedOptions).toEqual([]);
    expect(after.submittedResponseText).toBeNull();
    expect(after.answerRevision).toBe(revision);
    receive("question:open", opening(0, 2, questionType));
    if (!currentAccepted) {
      render().sock.submitAnswer({ questionIndex: 0, ...(response ? { responseText: "Current text" } : { selectedOptions: ["A"] }) });
      receive("answer:accepted", { questionIndex: 0 });
    }
    const { sock } = receive("results:reveal", { questionIndex: 0, questionType, correctOptions: ["A"], explanation: "Sample", distribution: {} });
    expect(sock.ownAnswers.get(0)).toEqual(current);
    expect(sock.answeredQuestions).toEqual([0]);
    expect(sock.submitted).toBe(true);
    expect(sock.submittedOptions).toEqual(response ? [] : ["A"]);
    expect(sock.submittedResponseText).toBe(response ? "Current text" : null);
  });

  it.each([1, 2].flatMap(attempt => (["multiple_choice", "open_response"] as const).map(questionType => ({ attempt, questionType }))))("an older HTTP $questionType answer keeps a newer socket snapshot answer at attempt $attempt", async ({ attempt, questionType }) => {
    const response = questionType === "open_response";
    const shown = opening(0, attempt, questionType);
    const earlier = { ...answer(0, attempt, response ? "Earlier text" : undefined), acceptedRevision: 1 };
    const current = { ...answer(0, attempt, response ? "Current text" : undefined), acceptedRevision: 2, selectedOptions: response ? [] : [1] };
    const cached = studyData([shown], [earlier]);
    await start(cached, shown);
    render().study.refresh(); render();
    const delayed = requests.at(-1)!;
    receive("session:state", { state: "QUESTION_OPEN", questionIndex: 0, answers: [current] });
    delayed.resolve({ ok: true, json: async () => cached }); await settle();
    const { sock } = render();
    expect(sock.ownAnswers.get(0)).toEqual(current);
    expect(sock.answeredQuestions).toEqual([0]);
    expect(sock.submitted).toBe(true);
    expect(sock.submittedOptions).toEqual(response ? [] : ["B"]);
    expect(sock.submittedResponseText).toBe(response ? "Current text" : null);
  });

  it.each([1, 2].flatMap(attempt => (["multiple_choice", "open_response"] as const).map(questionType => ({ attempt, questionType }))))("a snapshot keeps both pending $questionType edits before their ACKs at attempt $attempt", async ({ attempt, questionType }) => {
    const response = questionType === "open_response";
    const shown = { ...opening(0, attempt, questionType), options: [...opening().options, { label: "C", text: "Third option" }] };
    const accepted = answer(0, attempt, response ? "Accepted A" : undefined);
    await start(studyData([shown], [accepted]), shown);
    const submit = (label: string) => render().sock.submitAnswer({ questionIndex: 0, ...(response ? { responseText: label } : { selectedOptions: [label] }) });
    submit("B"); submit("C");
    const expectPending = () => {
      expect(render().sock.submitted).toBe(true);
      expect(render().sock.submittedOptions).toEqual(response ? [] : ["C"]);
      expect(render().sock.submittedResponseText).toBe(response ? "C" : null);
    };
    const refreshed = { ...accepted, acceptedRevision: 1 };
    receive("session:state", { state: "QUESTION_OPEN", questionIndex: 0, questionAttempts: { "0": attempt }, answers: [refreshed] });
    expect(render().sock.ownAnswers.get(0)).toEqual(refreshed);
    expectPending();
    receive("question:open", shown);
    expectPending();
    receive("answer:accepted", { questionIndex: 0, acceptedRevision: 2 });
    expect(render().sock.ownAnswers.get(0)).toMatchObject(response ? { responseText: "B" } : { selectedOptions: [1] });
    expectPending();
    receive("answer:accepted", { questionIndex: 0, acceptedRevision: 3 });
    expect(render().sock.ownAnswers.get(0)).toMatchObject(response ? { responseText: "C" } : { selectedOptions: [2] });
    expectPending();
  });

  it.each((["multiple_choice", "open_response"] as const).flatMap(questionType => ["repeat", "revisit"].map(order => ({ questionType, order }))))("an unaccepted pending $questionType answer survives an opening $order", async ({ questionType, order }) => {
    const response = questionType === "open_response";
    const shown = opening(0, 2, questionType);
    await start(studyData([shown]), shown);
    render().sock.submitAnswer({ questionIndex: 0, ...(response ? { responseText: "Pending text" } : { selectedOptions: ["B"] }) });
    if (order === "revisit") receive("question:open", opening(1));
    const { sock } = receive("question:open", shown);
    expect(sock.ownAnswers.has(0)).toBe(false);
    expect(sock.answeredQuestions).toEqual([]);
    expect(sock.submitted).toBe(false);
    expect(sock.submittedOptions).toEqual(response ? [] : ["B"]);
    expect(sock.submittedResponseText).toBe(response ? "Pending text" : null);
  });

  it.each((["multiple_choice", "open_response"] as const).flatMap(questionType => ["snapshot", "rejoin"].map(order => ({ questionType, order }))))("HTTP advance rejects an earlier $questionType $order and opening replay", async ({ questionType, order }) => {
    const response = questionType === "open_response";
    const shown = opening(0, undefined, questionType);
    const archived = answer(0, undefined, response ? "Archived text" : undefined);
    await start(studyData([shown], [archived]), shown);
    render().study.refresh(); render();
    const current = answer(0, 2, response ? "Current text" : undefined);
    await fetched(studyData([opening(0, 2, questionType)], [current]));
    if (order === "rejoin") receive("student:joined", joined([archived]));
    else receive("session:state", { state: "QUESTION_OPEN", questionIndex: 0, answers: [archived] });
    const stale = receive("question:open", shown).sock;
    expect(stale.questionAttempts.get(0)).toBe(2);
    expect(stale.ownAnswers.get(0)).toEqual(current);
    expect(stale.answeredQuestions).toEqual([0]);
    expect(stale.submitted).toBe(false);
    expect(stale.submittedOptions).toEqual([]);
    expect(stale.submittedResponseText).toBeNull();
    const fresh = receive("question:open", opening(0, 2, questionType)).sock;
    expect(fresh.submitted).toBe(true);
    expect(fresh.submittedOptions).toEqual(response ? [] : ["A"]);
    expect(fresh.submittedResponseText).toBe(response ? "Current text" : null);
  });

  it("a newer item's ACK stays off the earlier opening and an unmatched ACK cannot resurrect an answer", async () => {
    await start();
    render().study.refresh(); render();
    await fetched(studyData([opening(0, 2)], [], true));
    render().study.submitAnswer({ questionIndex: 0, selectedOptions: ["B"] });
    const accepted = receive("answer:accepted", { questionIndex: 0 }).sock;
    expect(accepted.ownAnswers.get(0)).toEqual({ questionIndex: 0, selectedOptions: [1], attempt: 2 });
    expect(accepted.answeredQuestions).toEqual([0]);
    expect(accepted.submitted).toBe(false);
    expect(accepted.submittedOptions).toEqual([]);
    receive("question:open", opening(0, 2));
    receive("disconnect", undefined);
    receive("session:state", { state: "QUESTION_OPEN", questionAttempts: { "0": 3 }, answers: [] });
    const unmatched = receive("answer:accepted", { questionIndex: 0 }).sock;
    expect(unmatched.ownAnswers.has(0)).toBe(false);
    expect(unmatched.answeredQuestions).toEqual([]);
    expect(unmatched.submitted).toBe(false);
  });

  it.each((["multiple_choice", "open_response"] as const).flatMap(questionType => ["snapshot", "rejoin"].map(order => ({ questionType, order }))))("a delayed $questionType $order cannot replace a locally acknowledged answer in the same attempt", async ({ questionType, order }) => {
    const response = questionType === "open_response";
    const shown = opening(0, 2, questionType);
    const earlier = { ...answer(0, 2, response ? "Earlier text" : undefined), acceptedRevision: 0 };
    await start(studyData([shown], [earlier]), shown);
    render().sock.submitAnswer({ questionIndex: 0, ...(response ? { responseText: "Current text" } : { selectedOptions: ["B"] }) });
    receive("answer:accepted", { questionIndex: 0, acceptedRevision: 1 });
    if (order === "rejoin") receive("student:joined", joined([earlier]));
    else receive("session:state", { state: "QUESTION_OPEN", questionAttempts: { "0": 2 }, answers: [earlier] });
    const { sock } = receive("question:open", shown);
    expect(sock.ownAnswers.get(0)).toEqual({ questionIndex: 0, acceptedRevision: 1, attempt: 2, selectedOptions: response ? [] : [1], ...(response ? { responseText: "Current text" } : {}) });
    expect(sock.answeredQuestions).toEqual([0]);
    expect(sock.submitted).toBe(true);
    expect(sock.submittedOptions).toEqual(response ? [] : ["B"]);
    expect(sock.submittedResponseText).toBe(response ? "Current text" : null);
  });

  it.each(["multiple_choice", "open_response"] as const)("a delayed same-seat join keeps a pending %s submission matched to its ACK", async questionType => {
    const response = questionType === "open_response";
    const shown = opening(0, 2, questionType);
    await start(studyData([shown]), shown);
    render().sock.submitAnswer({ questionIndex: 0, ...(response ? { responseText: "Pending text" } : { selectedOptions: ["B"] }) });
    const pending = receive("student:joined", joined()).sock;
    expect(pending.submitted).toBe(false);
    expect(pending.submittedOptions).toEqual(response ? [] : ["B"]);
    expect(pending.submittedResponseText).toBe(response ? "Pending text" : null);
    const accepted = receive("answer:accepted", { questionIndex: 0 }).sock;
    expect(accepted.ownAnswers.get(0)).toMatchObject(response ? { attempt: 2, responseText: "Pending text" } : { attempt: 2, selectedOptions: [1] });
    expect(accepted.answeredQuestions).toEqual([0]);
    expect(accepted.submitted).toBe(true);
  });

  it("a stale submission cannot restore displayed content after an HTTP attempt advance", async () => {
    await start();
    render().study.refresh(); render();
    await fetched(studyData([opening(0, 2)]));
    render().sock.submitAnswer({ questionIndex: 0, selectedOptions: ["A"] });
    const pending = render().sock;
    expect(pending.submitted).toBe(false);
    expect(pending.submittedOptions).toEqual([]);
    expect(pending.submittedResponseText).toBeNull();
    receive("answer:rejected", { questionIndex: 0, reason: "Sample archived attempt" });
    const fresh = receive("question:open", opening(0, 2)).sock;
    expect(fresh.ownAnswers.has(0)).toBe(false);
    expect(fresh.answeredQuestions).toEqual([]);
    expect(fresh.submitted).toBe(false);
    expect(fresh.submittedOptions).toEqual([]);
  });

  it.each(["multiple_choice", "open_response"] as const)("disconnect drops a lost pending %s submission before matching the next ACK", async questionType => {
    const response = questionType === "open_response";
    const shown = opening(0, 2, questionType);
    await start(studyData([shown]), shown);
    render().sock.submitAnswer({ questionIndex: 0, ...(response ? { responseText: "Lost text" } : { selectedOptions: ["A"] }) });
    receive("disconnect", undefined); receive("connect", undefined);
    receive("student:joined", joined());
    render().sock.submitAnswer({ questionIndex: 0, ...(response ? { responseText: "Current text" } : { selectedOptions: ["B"] }) });
    const { sock } = receive("answer:accepted", { questionIndex: 0 });
    expect(sock.ownAnswers.get(0)).toEqual({ questionIndex: 0, attempt: 2, selectedOptions: response ? [] : [1], ...(response ? { responseText: "Current text" } : {}) });
    expect(sock.submitted).toBe(true);
    expect(sock.submittedOptions).toEqual(response ? [] : ["B"]);
    expect(sock.submittedResponseText).toBe(response ? "Current text" : null);
  });

  it.each([false, true])("disconnect lets the reconnect snapshot replace a same-attempt local open-response ACK with revisions %s", async versioned => {
    const shown = opening(0, 2, "open_response");
    await start(studyData([shown]), shown);
    render().sock.submitAnswer({ questionIndex: 0, responseText: "Local text" });
    receive("answer:accepted", { questionIndex: 0 });
    receive("disconnect", undefined); receive("connect", undefined);
    const accepted = { ...answer(0, 2, "Server text"), ...(versioned ? { acceptedRevision: 1 } : {}) };
    receive("session:state", { state: "QUESTION_OPEN", questionAttempts: { "0": 2 }, answers: [accepted] });
    const { sock } = receive("question:open", shown);
    expect(sock.ownAnswers.get(0)).toEqual(accepted);
    expect(sock.submitted).toBe(true);
    expect(sock.submittedOptions).toEqual([]);
    expect(sock.submittedResponseText).toBe("Server text");
  });

  it("an earlier open-response count stays archived and a current count keeps a pending edit", async () => {
    const shown = opening(0, undefined, "open_response");
    render(); receive("student:joined", { ...joined(), publicKey: "sample-key" });
    receive("question:open", shown); await fetched(studyData([shown]));
    render().study.refresh(); render();
    await fetched(studyData([opening(0, 2, "open_response")]));
    const count = { questionIndex: 0, openResponses: [{ publicKey: "sample-key", responseText: "Archived text" }] };
    const stale = receive("answer:count", count).sock;
    expect(stale.answeredQuestions).toEqual([]);
    expect(stale.submitted).toBe(false);
    expect(stale.submittedResponseText).toBeNull();
    receive("question:open", opening(0, 2, "open_response"));
    render().sock.submitAnswer({ questionIndex: 0, responseText: "Pending text" });
    const pending = receive("answer:count", { ...count, openResponses: [{ publicKey: "sample-key", responseText: "Accepted text" }] }).sock;
    expect(pending.submittedResponseText).toBe("Pending text");
    receive("answer:accepted", { questionIndex: 0 });
    const accepted = receive("answer:count", count).sock;
    expect(accepted.submittedResponseText).toBe("Pending text");
  });

  it("a first-seen newer opening forgets an earlier joined answer and answered mark in the socket", () => {
    render(); receive("student:joined", joined([answer()]));
    const { sock } = receive("question:open", opening(0, 2));
    expect(sock.currentQuestion?.attempt).toBe(2);
    expect(sock.ownAnswers.has(0)).toBe(false);
    expect(sock.answeredQuestions).toEqual([]);
    expect(sock.submitted).toBe(false);
    expect(sock.submittedOptions).toEqual([]);
    expect(sock.submittedResponseText).toBeNull();
  });

  it("an opening replaces an earlier attempt's rejected selection with the current joined answer", async () => {
    const initial = await start(studyData([opening()], [answer()]));
    receive("disconnect", undefined); receive("connect", undefined);
    const current = { ...answer(0, 2), selectedOptions: [1] };
    receive("student:joined", joined([current]));
    receive("session:state", { state: "REVEAL", questionIndex: 0, questionAttempts: { "0": 2 } });
    initial.sock.submitAnswer({ questionIndex: 0, selectedOptions: ["A"] });
    expect(harness.sent.at(-1)?.payload).toEqual({ questionIndex: 0, selectedOptions: ["A"] });
    receive("answer:rejected", { questionIndex: 0, reason: "Sample earlier attempt" });
    expect(render().sock.submittedOptions).toEqual([]);
    const { sock } = receive("question:open", opening(0, 2));
    expect(sock.ownAnswers.get(0)).toEqual(current);
    expect(sock.answeredQuestions).toEqual([0]);
    expect(sock.submitted).toBe(true);
    expect(sock.submittedOptions).toEqual(["B"]);
    expect(sock.submittedResponseText).toBeNull();
  });

  it.each([undefined, 2].flatMap(attempt => (["multiple_choice", "open_response"] as const).flatMap(questionType => [false, true].map(versioned => ({ attempt, questionType, versioned })))))("a same-attempt $questionType rejoin restores its accepted answer at attempt $attempt and keeps its draft with revisions $versioned", async ({ attempt, questionType, versioned }) => {
    const response = questionType === "open_response";
    const shown = opening(0, attempt, questionType);
    const earlier = answer(0, attempt, response ? "Earlier accepted text" : undefined);
    const current = { ...answer(0, attempt, response ? "Current accepted text" : undefined), ...(versioned ? { acceptedRevision: 1 } : {}) };
    writeDraft(key, { selectedOptions: ["B"], responseText: "Current draft text", revision: 3, ...(attempt ? { attempt } : {}) });
    const initial = await start(studyData([shown], [earlier]), shown);
    initial.sock.submitAnswer({ questionIndex: 0, ...(response ? { responseText: "Rejected edit" } : { selectedOptions: ["B"] }) });
    receive("answer:rejected", { questionIndex: 0, reason: "Sample rejected edit" });
    receive("disconnect", undefined); receive("connect", undefined);
    const rejoined = receive("student:joined", joined([current]));
    expect(rejoined.sock.submitted).toBe(true);
    expect(rejoined.sock.submittedOptions).toEqual(response ? [] : ["A"]);
    expect(rejoined.sock.submittedResponseText).toBe(response ? "Current accepted text" : null);
    receive("question:open", shown);
    const { sock, study } = receive("results:reveal", { questionIndex: 0, questionType, correctOptions: ["A"], explanation: "Sample", distribution: {} });
    expect(sock.submittedOptions).toEqual(response ? [] : ["A"]);
    expect(sock.submittedResponseText).toBe(response ? "Current accepted text" : null);
    expect(study.submittedOptions).toEqual(sock.submittedOptions);
    expect(study.submittedResponseText).toBe(sock.submittedResponseText);
    expect(study.draft).toMatchObject({ selectedOptions: ["B"], responseText: "Current draft text", revision: 3 });
  });

  it("a legacy join without answer content keeps this page's accepted first-attempt selection", async () => {
    await start(studyData([opening()], [answer()]));
    receive("student:joined", { participantId: "sample", sessionToken: "seat", sessionState: "REVEAL", answeredQuestions: [0] });
    const { sock } = receive("question:open", opening());
    expect(sock.answeredQuestions).toEqual([0]);
    expect(sock.submitted).toBe(true);
    expect(sock.submittedOptions).toEqual(["A"]);
    expect(sock.submittedResponseText).toBeNull();
  });

  it("a failed post-rerun fetch cannot restore a cached answer or answered mark", async () => {
    writeDraft(key, { selectedOptions: ["A"], responseText: "", revision: 1 });
    await start(studyData([opening(), opening(1)], [answer(), answer(1)]));
    receive("question:open", opening(0, 2));
    requests.at(-1)!.reject(new Error("Synthetic items failure")); await settle();
    const { study } = render();
    expect(study.error).toBe("Available items could not be refreshed. Try again.");
    expect(study.question?.attempt).toBe(2);
    expect(study.submitted).toBe(false);
    expect(study.submittedOptions).toEqual([]);
    expect(study.canAnswer).toBe(true);
    expect(study.progressLabel).toBe("1 of 2 available questions answered");
    expect(study.draft?.selectedOptions).toEqual([]);
    expect(study.draft?.attempt).toBe(2);
    study.refresh(); render();
    const recovered = await fetched(studyData([opening(), opening(1)], [answer(), answer(1)]));
    expect(recovered.study.question?.attempt).toBe(2);
    expect(recovered.study.error).toBeNull();
    expect(recovered.study.submitted).toBe(false);
    expect(recovered.sock.ownAnswers.has(0)).toBe(false);
    expect(recovered.sock.answeredQuestions).not.toContain(0);
  });

  it("self-paced refresh without availability prefers a newer fetched item and submits its attempt", async () => {
    writeDraft(key, { selectedOptions: ["A"], responseText: "", revision: 1 });
    await start(studyData([opening()], [answer()], true));
    const count = requests.length;
    const advanced = receive("session:state", { state: "QUESTION_OPEN", questionIndex: 0, questionAttempts: { "0": 2 } });
    expect(advanced.sock.submitted).toBe(false);
    expect(advanced.sock.submittedOptions).toEqual([]);
    expect(requests.length).toBeGreaterThan(count);
    const { sock, study } = await fetched(studyData([opening(0, 2)], [], true));
    expect(sock.currentQuestion?.attempt).toBeUndefined();
    expect(study.question?.text).toBe("Sample attempt 2");
    expect(study.question?.options[0].text).toBe("New option");
    expect(study.submitted).toBe(false);
    expect(study.draft?.selectedOptions).toEqual([]);
    expect(study.canAnswer).toBe(true);
    study.setDraft({ selectedOptions: ["B"] });
    expect(render().study.draft).toMatchObject({ selectedOptions: ["B"], attempt: 2 });
    const send = jest.spyOn(sock, "submitAnswer");
    study.submitAnswer({ questionIndex: 0, selectedOptions: ["B"] });
    expect(send).toHaveBeenCalledWith({ questionIndex: 0, selectedOptions: ["B"], attempt: 2 }, study.question?.options);
    expect(harness.sent.at(-1)).toEqual({ event: "answer:submit", payload: { questionIndex: 0, selectedOptions: ["B"], attempt: 2 } });
    receive("answer:accepted", { questionIndex: 0 });
    expect(render().study.submittedOptions).toEqual(["B"]);
  });

  it.each(["multiple_choice", "poll"] as const)("a stale successful self-paced %s refresh keeps Retry even with a fresh socket opening", async questionType => {
    const shown = opening(0, undefined, questionType);
    const cached = studyData([shown, opening(1)], [answer()], true);
    expect(cached.answerableQuestionIndexes).toEqual([1]);
    writeDraft(key, { selectedOptions: ["A"], responseText: "", revision: 1 });
    await start(cached, shown);
    receive("question:open", opening(0, 2, questionType));
    requests.at(-1)!.reject(new Error("Synthetic items failure")); await settle();
    expect(render().study.error).toBe("Available items could not be refreshed. Try again.");
    render().study.refresh(); render();
    const stale = await fetched(cached);
    expect(stale.study.question?.attempt).toBe(2);
    expect(stale.study.submitted).toBe(false);
    expect(stale.study.canAnswer).toBe(false);
    expect(stale.study.draft).toMatchObject({ selectedOptions: [], attempt: 2 });
    expect(stale.study.error).toBe("Available items could not be refreshed. Try again.");
    stale.study.refresh(); render();
    const { study } = await fetched(studyData([opening(0, 2, questionType), opening(1)], [], true));
    expect(study.error).toBeNull();
    expect(study.canAnswer).toBe(true);
    study.submitAnswer({ questionIndex: 0, selectedOptions: ["B"] });
    expect(harness.sent.at(-1)).toEqual({ event: "answer:submit", payload: { questionIndex: 0, selectedOptions: ["B"], attempt: 2 } });
  });

  it.each(["snapshot", "rejoin"] as const)("a participant %s catches a missed re-run of an unviewed item even when refresh fails", async recovery => {
    let session = createSession(goldenQuiz.week, "open");
    const step = (command: Command, now = 200) => { const result = apply(session, goldenQuiz, command, now); session = result.session; return result; };
    const join: Command = { type: "join", payload: { studentId: "sample", displayName: "Sample", sessionToken: "seat" }, socketId: "sample", newToken: "seat" };
    step({ type: "configurePolicy", role: "control", pacing: "self-paced" });
    step(join); step({ type: "start" }); step({ type: "next" });
    step({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex: 1, selectedOptions: ["A"] } });
    step({ type: "previous" });
    const cached = participantStudyPayload(session, goldenQuiz, "sample", 300);
    const otherKey = draftStorageKey("sample-session", "seat", 1);
    writeDraft(otherKey, { selectedOptions: ["A"], responseText: "", revision: 1 });
    await start(cached, cached.items[0]);
    receive("disconnect", undefined);
    step({ type: "disconnect", studentId: "sample", socketId: "sample" });
    step({ type: "rerun", role: "control", questionIndex: 1 }, 400);
    receive("connect", undefined);
    const result = step(recovery === "rejoin" ? join : { type: "snapshot", participantId: "sample", isReconnect: true }, 500);
    for (const message of result.messages) if (message.audience === "participant:sample") receive(message.event, message.payload);
    requests.at(-1)!.reject(new Error("Synthetic items failure")); await settle();
    const { sock, study } = render();
    expect(sock.questionAttempts.get(1)).toBe(2);
    expect(study.question?.questionIndex).toBe(0);
    expect(study.progressLabel).toBe("0 of 2 available questions answered");
    expect(readDraft(otherKey)).toMatchObject({ selectedOptions: [], responseText: "", attempt: 2 });
    expect(study.error).toBe("Available items could not be refreshed. Try again.");
    study.browse(1);
    const waiting = render().study;
    expect(waiting.viewedIndex).toBe(1);
    expect(waiting.question).toBeNull();
    expect(waiting.submitted).toBe(false);
    expect(waiting.submittedOptions).toEqual([]);
    expect(waiting.canAnswer).toBe(false);
    expect(waiting.draft).toMatchObject({ selectedOptions: [], responseText: "", attempt: 2 });
    waiting.refresh(); render();
    const recovered = await fetched(participantStudyPayload(session, goldenQuiz, "sample", 600));
    expect(recovered.study.error).toBeNull();
    expect(recovered.study.question?.questionIndex).toBe(1);
    expect(recovered.study.question?.attempt).toBe(2);
    expect(recovered.study.canAnswer).toBe(true);
    expect(recovered.study.submitted).toBe(false);
  });

  it.each(["multiple_choice", "open_response"] as const)("a %s answer and draft clear while a self-paced refresh is pending or fails", async questionType => {
    const shown = opening(0, undefined, questionType);
    const saved = answer(0, undefined, questionType === "open_response" ? "Earlier accepted text" : undefined);
    writeDraft(key, { selectedOptions: ["A"], responseText: "Earlier draft text", revision: 4 });
    const initial = await start(studyData([shown, opening(1)], [saved, answer(1)], true), shown);
    expect(initial.study.submitted).toBe(true);
    expect(initial.study.draft).toMatchObject({ selectedOptions: ["A"], responseText: "Earlier draft text" });
    receive("session:state", { state: "QUESTION_OPEN", questionIndex: 0, questionAttempts: { "0": 2 } });
    const payload = questionType === "open_response" ? { questionIndex: 0, responseText: "Text for the old prompt" } : { questionIndex: 0, selectedOptions: ["A"] };
    for (const failed of [false, true]) {
      if (failed) { requests.at(-1)!.reject(new Error("Synthetic items failure")); await settle(); }
      const { sock, study } = render();
      expect(sock.questionAttempts.get(0)).toBe(2);
      expect(study.items[0].text).toBe("Sample attempt 1");
      expect(study.items[0].attempt).toBeUndefined();
      expect(study.viewedIndex).toBe(0);
      expect(study.question).toBeNull();
      expect(study.canAnswer).toBe(false);
      expect(study.submitted).toBe(false);
      expect(study.submittedOptions).toEqual([]);
      expect(study.submittedResponseText).toBeNull();
      expect(study.progressLabel).toBe("1 of 2 available questions answered");
      expect(study.draft).toMatchObject({ selectedOptions: [], responseText: "", attempt: 2 });
      expect(readDraft(key)).toMatchObject({ selectedOptions: [], responseText: "", attempt: 2 });
      const count = harness.sent.length;
      study.submitAnswer(payload);
      expect(harness.sent).toHaveLength(count);
      study.setDraft({ selectedOptions: ["A"], responseText: "Cannot edit stale content" });
      expect(readDraft(key)).toMatchObject({ selectedOptions: [], responseText: "", attempt: 2 });
      sock.submitAnswer(payload);
      expect(harness.sent.at(-1)).toEqual({ event: "answer:submit", payload });
      if (failed) expect(study.error).toBe("Available items could not be refreshed. Try again.");
    }
    render().study.refresh(); render();
    const stale = await fetched(studyData([shown, opening(1)], [saved, answer(1)], true));
    expect(stale.study.question).toBeNull();
    expect(stale.study.submitted).toBe(false);
    expect(stale.study.canAnswer).toBe(false);
    expect(stale.study.draft).toMatchObject({ selectedOptions: [], responseText: "", attempt: 2 });
    expect(stale.study.error).toBe("Available items could not be refreshed. Try again.");
    render().study.refresh(); render();
    const { study } = await fetched(studyData([opening(0, 2, questionType), opening(1)], [answer(1)], true));
    expect(study.question?.attempt).toBe(2);
    expect(study.canAnswer).toBe(true);
    expect(study.submitted).toBe(false);
    expect(study.draft).toMatchObject({ selectedOptions: [], responseText: "", attempt: 2 });
    study.submitAnswer(payload);
    expect(harness.sent.at(-1)).toEqual({ event: "answer:submit", payload: { ...payload, attempt: 2 } });
  });

  it("an announcement clears an unviewed draft and keeps the browsing position while its content refreshes", async () => {
    const otherKey = draftStorageKey("sample-session", "seat", 1);
    writeDraft(otherKey, { selectedOptions: ["A"], responseText: "", revision: 1 });
    await start(studyData([opening(), opening(1)], [answer(), answer(1)], true));
    const advanced = receive("session:state", { state: "QUESTION_OPEN", questionIndex: 0, questionAttempts: { "1": 2 } });
    expect(advanced.study.question?.questionIndex).toBe(0);
    expect(advanced.study.submitted).toBe(true);
    expect(advanced.study.progressLabel).toBe("1 of 2 available questions answered");
    expect(readDraft(otherKey)).toMatchObject({ selectedOptions: [], responseText: "", attempt: 2 });
    advanced.study.browse(1);
    expect(render().study.viewedIndex).toBe(1);
    expect(render().study.question).toBeNull();
    expect(render().study.following).toBe(false);
    receive("student:joined", joined([answer()]));
    expect(render().sock.questionAttempts.get(1)).toBe(2);
    const { study } = await fetched(studyData([opening(), opening(1, 2)], [answer()], true));
    expect(study.question?.questionIndex).toBe(1);
    expect(study.question?.attempt).toBe(2);
    expect(study.following).toBe(false);
    expect(study.canAnswer).toBe(true);
  });

  it("a callback retained from an earlier render cannot upgrade its submission after a new opening", async () => {
    const { study } = await start();
    receive("question:open", opening(0, 2));
    study.submitAnswer({ questionIndex: 0, selectedOptions: ["A"] });
    expect(harness.sent.at(-1)).toEqual({ event: "answer:submit", payload: { questionIndex: 0, selectedOptions: ["A"] } });
  });

  it.each(["multiple_choice", "open_response"] as const)("a retained %s draft callback cannot copy old content into a newer draft", async questionType => {
    const shown = opening(0, undefined, questionType);
    writeDraft(key, { selectedOptions: ["A"], responseText: "Earlier text", revision: 1 });
    const earlier = await start(studyData([shown], [], true), shown);
    receive("session:state", { state: "QUESTION_OPEN", questionIndex: 0, questionAttempts: { "0": 2 } });
    earlier.study.setDraft({ selectedOptions: ["A"], responseText: "Earlier retained edit" });
    expect(readDraft(key)).toMatchObject({ selectedOptions: [], responseText: "", attempt: 2 });
    const { study } = await fetched(studyData([opening(0, 2, questionType)], [], true));
    expect(study.canAnswer).toBe(true);
    study.setDraft({ selectedOptions: ["B"], responseText: "Current text" });
    earlier.study.setDraft({ selectedOptions: ["A"], responseText: "Earlier retained edit" });
    expect(render().study.draft).toMatchObject({ selectedOptions: ["B"], responseText: "Current text", attempt: 2 });
    expect(readDraft(key)).toMatchObject({ selectedOptions: ["B"], responseText: "Current text", attempt: 2 });
  });

  it.each(["multiple_choice", "open_response"] as const)("a refreshed accepted %s answer seeds an untouched cleared draft", async questionType => {
    const shown = opening(0, undefined, questionType);
    writeDraft(key, { selectedOptions: ["A"], responseText: "Earlier text", revision: 1 });
    await start(studyData([shown], [answer()], true), shown);
    receive("session:state", { state: "QUESTION_OPEN", questionIndex: 0, questionAttempts: { "0": 2 } });
    const accepted = { ...answer(0, 2, questionType === "open_response" ? "Current accepted text" : undefined), selectedOptions: questionType === "open_response" ? [] : [1] };
    receive("student:joined", joined([accepted]));
    const { study } = await fetched(studyData([opening(0, 2, questionType)], [accepted], true));
    expect(study.submitted).toBe(true);
    expect(study.draft).toMatchObject({ selectedOptions: questionType === "open_response" ? [] : ["B"], responseText: accepted.responseText ?? "", attempt: 2 });
    study.setDraft({ selectedOptions: [], responseText: "" });
    render().study.refresh(); render();
    const edited = await fetched(studyData([opening(0, 2, questionType)], [accepted], true));
    expect(edited.study.draft).toMatchObject({ selectedOptions: [], responseText: "", revision: 1, attempt: 2 });
  });

  it("the fetched list forgets an earlier answer and draft on an explored self-paced item", async () => {
    await start(studyData([opening(), opening(1)], [answer(1)], true));
    render().study.browse(1); render().study.setDraft({ selectedOptions: ["A"] }); render();
    render().study.refresh(); render();
    const { sock, study } = await fetched(studyData([opening(), opening(1, 2)], [], true));
    expect(sock.ownAnswers.has(1)).toBe(false);
    expect(sock.answeredQuestions).not.toContain(1);
    expect(study.question?.questionIndex).toBe(1);
    expect(study.question?.attempt).toBe(2);
    expect(study.submitted).toBe(false);
    expect(study.draft?.selectedOptions).toEqual([]);
    expect(study.following).toBe(false);
  });

  it("a newer item list forgets an earlier socket answer and answered mark before merging", async () => {
    render(); receive("student:joined", joined([answer()]));
    const { sock, study } = await fetched(studyData([opening(0, 2)], [], true));
    expect(sock.ownAnswers.has(0)).toBe(false);
    expect(sock.answeredQuestions).not.toContain(0);
    expect(study.question?.attempt).toBe(2);
    expect(study.submitted).toBe(false);
    expect(study.submittedOptions).toEqual([]);
    expect(study.draft?.selectedOptions).toEqual([]);
    expect(study.canAnswer).toBe(true);
  });

  it("an old joined answer cannot mark a first-seen newer opening submitted", async () => {
    render(); receive("student:joined", joined([answer()]));
    const { study } = receive("question:open", opening(0, 2));
    expect(study.question?.attempt).toBe(2);
    expect(study.submitted).toBe(false);
    expect(study.submittedOptions).toEqual([]);
    expect(study.canAnswer).toBe(true);
  });

  it("rejoining with a current accepted response replaces an earlier editable draft with that answer", async () => {
    writeDraft(key, { selectedOptions: [], responseText: "Earlier unsent text", revision: 4 });
    const shown = opening(0, 2, "open_response"), current = answer(0, 2, "Current accepted text");
    const { study } = await start(studyData([shown], [current]), shown);
    expect(study.submitted).toBe(true);
    expect(study.draft).toMatchObject({ responseText: "Current accepted text", selectedOptions: [], attempt: 2 });
    expect(readDraft(key)?.responseText).toBe("Current accepted text");
    expect(study.canAnswer).toBe(true);
  });

  it("clears only the advancing question's poll aggregate when live results are disabled", async () => {
    await start(studyData([opening(0, undefined, "poll")], [answer()]), opening(0, undefined, "poll"));
    receive("poll:live", { questionIndex: 0, voters: 3, counts: { A: 3 } });
    receive("poll:live", { questionIndex: 1, voters: 2, counts: { A: 2 } });
    const { sock } = receive("question:open", opening(0, 2, "poll"));
    expect(sock.currentQuestion?.liveResults).toBe(false);
    expect(sock.pollLive[0]).toBeUndefined();
    expect(sock.pollLive[1]).toMatchObject({ voters: 2 });
    sock.submitAnswer({ questionIndex: 0, selectedOptions: ["B"] });
    expect(harness.sent.at(-1)?.payload).toEqual({ questionIndex: 0, selectedOptions: ["B"], attempt: 2 });
    receive("answer:accepted", { questionIndex: 0 });
    expect(render().sock.pollLive[0]).toBeUndefined();
  });

  it("a first sighting after a re-run stamps new drafts without dropping the current answer", async () => {
    await start(studyData([opening(0, 2)], [answer(0, 2)]), opening(0, 2));
    expect(render().study.submittedOptions).toEqual(["A"]);
    render().study.setDraft({ selectedOptions: ["B"] });
    expect(render().study.draft).toMatchObject({ selectedOptions: ["B"], attempt: 2 });
  });

  it("first-attempt submissions keep their payload and an ACK keeps the new attempt answer", async () => {
    await start();
    render().study.submitAnswer({ questionIndex: 0, selectedOptions: ["A"] });
    expect(harness.sent.at(-1)?.payload).toEqual({ questionIndex: 0, selectedOptions: ["A"] });
    receive("answer:accepted", { questionIndex: 0 });
    expect(render().study.submitted).toBe(true);
    receive("question:open", opening(0, 2));
    render().study.submitAnswer({ questionIndex: 0, selectedOptions: ["B"] });
    receive("answer:accepted", { questionIndex: 0 });
    expect(render().sock.ownAnswers.get(0)).toEqual({ questionIndex: 0, selectedOptions: [1], attempt: 2 });
    expect(render().study.submitted).toBe(true);
    expect(render().study.submittedOptions).toEqual(["B"]);
  });
});

describe("a draft across a re-run", () => {
  it("a draft made for an earlier attempt is never shown, and one for this attempt is", () => {
    expect(isEarlierAttemptDraft({}, 2)).toBe(true);
    expect(isEarlierAttemptDraft({ attempt: 1 }, 2)).toBe(true);
    expect(isEarlierAttemptDraft({ attempt: 2 }, 3)).toBe(true);
    expect(isEarlierAttemptDraft({}, undefined)).toBe(false);
    expect(isEarlierAttemptDraft({}, 1)).toBe(false);
    expect(isEarlierAttemptDraft({ attempt: 2 }, 2)).toBe(false);
    expect(isEarlierAttemptDraft({ attempt: 3 }, 2)).toBe(false);
  });
});
