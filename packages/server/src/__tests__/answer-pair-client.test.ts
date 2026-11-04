/// <reference lib="dom" />
import type { AnswerSubmitPayload, ParticipantStudyPayload, QuestionOpenPayload } from "@mdq/shared";
import { hookHarness } from "./rerun-hook-harness";
import { readStudyPosition, writeStudyPosition } from "../../../client/src/participantPosition";
import { draftStorageKey, readDraft, writeDraft } from "../../../client/src/participantDrafts";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

const opening = (questionIndex = 0, contentVersion?: number, attempt?: number, questionType: QuestionOpenPayload["questionType"] = "multiple_choice"): QuestionOpenPayload => ({
  questionIndex, topic: "Sample", text: "Sample prompt", questionType,
  options: [{ label: "A", text: "Sample option" }], allowsMultiple: false, isPoll: questionType === "poll",
  timeLimitSec: null, startedAt: 100,
  ...(contentVersion !== undefined ? { contentVersion } : {}), ...(attempt !== undefined ? { attempt } : {}),
});
const snapshot = (items: QuestionOpenPayload[], selfPaced = false): ParticipantStudyPayload => ({
  items, currentQuestionIndex: 0, state: "QUESTION_OPEN", answers: [], answeredQuestions: [],
  answerableQuestionIndexes: items.map(item => item.questionIndex),
  policy: { schemaVersion: 2, pacing: selfPaced ? "self-paced" : "presenter-paced", effectiveTiming: "authored", ranking: "automatic" },
});
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
type PhoneButton = ReactElement<{ onClick: () => void; disabled: boolean; className?: string; children?: ReactNode }>;
const buttons = (node: ReactNode): PhoneButton[] => {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  if (node.type === "button") return [node as PhoneButton];
  return Children.toArray(node.props.children).flatMap(buttons);
};
const submitButton = (node: ReactNode) => buttons(node).find(button => String(button.props.children).startsWith("Submit"))!;
const optionButton = (node: ReactNode) => buttons(node).find(button => button.props.className?.includes("option-btn"))!;

describe("native participant answer provenance and position", () => {
  let harness: ReturnType<typeof hookHarness>;
  let requests: { resolve: (response: unknown) => void }[];
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let sessionId: string;
  let prepareAnswer: ((payload: AnswerSubmitPayload) => void) | null;
  const render = () => harness.render(() => {
    const sock = harness.useSocket(sessionId, "student");
    const study = harness.useParticipantStudy(sessionId, sock);
    const view = harness.QuestionView({
      question: study.question, state: "QUESTION_OPEN", remainingSec: null, submitted: study.submitted,
      submittedOptions: study.submittedOptions, submittedResponseText: study.submittedResponseText,
      timedOut: false, connected: sock.connected, draft: study.draft, onDraftChange: study.setDraft, onSubmit: prepareAnswer ?? study.submitAnswer,
    });
    return { sock, study, view };
  });
  const receive = (event: string, payload: unknown) => { harness.receive(event, payload); return render(); };
  const fetched = async (data: ParticipantStudyPayload) => {
    requests.at(-1)!.resolve({ ok: true, json: async () => data }); await settle(); return render();
  };
  const start = async (data: ParticipantStudyPayload, shown = data.items[0], token = "seat") => {
    render();
    receive("student:joined", { participantId: "sample", sessionToken: token, sessionState: "QUESTION_OPEN", answers: [], answeredQuestions: [] });
    receive("question:open", shown);
    return fetched(data);
  };
  const reload = () => { harness.unmount(); harness = hookHarness(); requests = []; };
  beforeEach(() => {
    jest.useFakeTimers(); sessionId = "sample-session"; requests = []; prepareAnswer = null;
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => storage.set(name, value),
      removeItem: (name: string) => storage.delete(name),
    } });
    jest.spyOn(globalThis, "fetch").mockImplementation(url => String(url).endsWith("/items")
      ? new Promise(resolve => requests.push({ resolve: resolve as (response: unknown) => void }))
      : Promise.resolve({ ok: false } as Response));
    harness = hookHarness();
  });
  afterEach(() => {
    harness.unmount(); jest.restoreAllMocks(); jest.useRealTimers();
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  it.each([false, true].flatMap(selfPaced => (["multiple_choice", "poll", "open_response"] as const).flatMap(questionType => [0, 4].flatMap(contentVersion => [1, 2].map(attempt => ({ selfPaced, questionType, contentVersion, attempt }))))))(
    "$questionType sends displayed version $contentVersion and attempt $attempt in self-paced=$selfPaced", async ({ selfPaced, questionType, contentVersion, attempt }) => {
      const shown = opening(selfPaced ? 1 : 0, contentVersion, attempt > 1 ? attempt : undefined, questionType);
      const { study } = await start(snapshot(selfPaced ? [opening(), shown] : [shown], selfPaced), selfPaced ? opening() : shown);
      if (selfPaced) study.browse(1);
      const current = render().study;
      expect(current.question).toMatchObject({ contentVersion });
      expect(current.question?.attempt ?? 1).toBe(attempt);
      const payload = questionType === "open_response" ? { questionIndex: shown.questionIndex, responseText: "Sample response" }
        : { questionIndex: shown.questionIndex, selectedOptions: ["A"] };
      current.submitAnswer(payload);
      expect(harness.sent.at(-1)).toEqual({ event: "answer:submit", payload: { ...payload, contentVersion, attempt } });
    });

  it("a repeated opening with changed version replaces content, and newer HTTP content wins at the same attempt", async () => {
    const original = opening(0, 0);
    await start(snapshot([original]), original);
    const updated = { ...opening(0, 1), text: "Changed prompt" };
    expect(receive("question:open", updated).sock.currentQuestion).toMatchObject(updated);
    const newest = { ...opening(0, 2), text: "Newest prompt" };
    const { study } = await fetched(snapshot([newest]));
    expect(study.question).toMatchObject(newest);
    study.submitAnswer({ questionIndex: 0, selectedOptions: ["A"] });
      expect(harness.sent.at(-1)?.payload).toEqual({ questionIndex: 0, selectedOptions: ["A"], contentVersion: 2, attempt: 1 });
  });

  it.each([undefined, 0, 4])("delayed callbacks and prepared payloads keep original version %s and attempt", async version => {
    const original = opening(0, version);
    const before = await start(snapshot([original]), original);
    const prepared: AnswerSubmitPayload = { questionIndex: 0, selectedOptions: ["A"], attempt: 1, ...(version !== undefined ? { contentVersion: version } : {}) };
    const bytes = JSON.stringify(prepared);
    const after = receive("question:open", opening(0, 9, 2));
    before.study.submitAnswer({ questionIndex: 0, selectedOptions: ["A"] });
    before.sock.submitAnswer({ questionIndex: 0, selectedOptions: ["A"] });
    after.study.submitAnswer(prepared);
    after.sock.submitAnswer(prepared);
    const expected = { questionIndex: 0, selectedOptions: ["A"], ...(version !== undefined ? { contentVersion: version, attempt: 1 } : {}) };
    expect(harness.sent.filter(entry => entry.event === "answer:submit").map(entry => entry.payload)).toEqual([expected, expected, expected, expected]);
    expect(JSON.stringify(prepared)).toBe(bytes);
    expect(render().sock.submittedOptions).toEqual([]);
  });

  it.each((["multiple_choice", "poll"] as const).flatMap(questionType => ["opening", "http", "reload"].map(source => ({ questionType, source }))))(
    "same-attempt $questionType draft requires reselection after changed option meaning via $source", async ({ questionType, source }) => {
      const original = opening(0, 1, 1, questionType);
      const initial = await start(snapshot([original]));
      optionButton(initial.view).props.onClick();
      const selected = render();
      const key = draftStorageKey(sessionId, "seat", 0);
      expect(selected.study.draft).toMatchObject({ selectedOptions: ["A"], contentVersion: 1 });
      const updated = { ...opening(0, 2, 1, questionType), options: [{ label: "A", text: "Changed option meaning" }] };
      let changed;
      if (source === "reload") { reload(); changed = await start(snapshot([updated])); }
      else if (source === "http") { selected.study.refresh(); render(); changed = await fetched(snapshot([updated])); }
      else changed = receive("question:open", updated);
      expect(changed.study.question).toMatchObject(updated);
      const submit = submitButton(changed.view);
      submit.props.onClick(); // Even a direct handler invocation cannot submit the old selection.
      expect(harness.sent.filter(entry => entry.event === "answer:submit")).toEqual([]);
      expect(submit.props.disabled).toBe(true);
      expect(changed.study.draft).toMatchObject({ selectedOptions: [], contentVersion: 1 });
      expect(readDraft(key)).toMatchObject({ selectedOptions: [], contentVersion: 1 });
      optionButton(changed.view).props.onClick();
      const reselected = render();
      expect(reselected.study.draft).toMatchObject({ selectedOptions: ["A"], contentVersion: 2 });
      expect(submitButton(reselected.view).props.disabled).toBe(false);
      submitButton(reselected.view).props.onClick();
      expect(harness.sent.at(-1)).toEqual({ event: "answer:submit", payload: { questionIndex: 0, selectedOptions: ["A"], contentVersion: 2, attempt: 1 } });
    });

  it.each(["edit", "submit", "reload-submit"])("same-attempt open text keeps provenance until deliberate %s", async action => {
    const original = opening(0, 1, 1, "open_response");
    (await start(snapshot([original]))).study.setDraft({ responseText: "Earlier text" });
    render();
    const updated = { ...opening(0, 2, 1, "open_response"), text: "Changed prompt" };
    let changed;
    if (action === "reload-submit") { reload(); changed = await start(snapshot([updated])); }
    else changed = receive("question:open", updated);
    expect(changed.study.draft).toMatchObject({ responseText: "Earlier text", contentVersion: 1 });
    expect(harness.sent.filter(entry => entry.event === "answer:submit")).toEqual([]);
    if (action === "edit") changed.study.setDraft({ responseText: "Reviewed text" });
    else submitButton(changed.view).props.onClick();
    expect(render().study.draft).toMatchObject({ responseText: action === "edit" ? "Reviewed text" : "Earlier text", contentVersion: 2 });
    expect(readDraft(draftStorageKey(sessionId, "seat", 0))?.contentVersion).toBe(2);
    if (action !== "edit") expect(harness.sent.at(-1)?.payload).toEqual({ questionIndex: 0, responseText: "Earlier text", contentVersion: 2, attempt: 1 });
  });

  it("same-attempt delayed send preserves the prepared version after replacement", async () => {
    const original = opening(0, 1, 1);
    const initial = await start(snapshot([original]));
    optionButton(initial.view).props.onClick();
    const preparedAnswers: AnswerSubmitPayload[] = [];
    prepareAnswer = payload => preparedAnswers.push(payload);
    const selected = render();
    submitButton(selected.view).props.onClick();
    const prepared = preparedAnswers[0];
    expect(prepared).toEqual({ questionIndex: 0, selectedOptions: ["A"], contentVersion: 1, attempt: 1 });
    const bytes = JSON.stringify(prepared);
    prepareAnswer = null;
    const changed = receive("question:open", { ...opening(0, 2, 1), options: [{ label: "A", text: "Changed meaning" }] });
    selected.study.submitAnswer(prepared); // Retained callback and both current hooks preserve it.
    changed.study.submitAnswer(prepared);
    changed.sock.submitAnswer(prepared);
    expect(harness.sent.filter(entry => entry.event === "answer:submit").map(entry => entry.payload)).toEqual([prepared, prepared, prepared]);
    expect(JSON.stringify(prepared)).toBe(bytes);
  });

  it.each([undefined, 1])("identical openings and reload preserve draft bytes for version %s", async contentVersion => {
    const original = opening(0, contentVersion);
    (await start(snapshot([original]))).study.setDraft({ selectedOptions: ["A"], responseText: "Unsent text" });
    const key = draftStorageKey(sessionId, "seat", 0);
    const bytes = localStorage.getItem(key);
    expect(receive("question:open", { ...original }).study.draft?.selectedOptions).toEqual(["A"]);
    expect(localStorage.getItem(key)).toBe(bytes);
    reload();
    expect((await start(snapshot([original]))).study.draft?.selectedOptions).toEqual(["A"]);
    expect(localStorage.getItem(key)).toBe(bytes);
  });

  it("a legacy persisted choice with unknown provenance requires a fresh versioned selection", async () => {
    writeDraft(draftStorageKey(sessionId, "seat", 0), { selectedOptions: ["A"], responseText: "", revision: 1 });
    const current = await start(snapshot([opening(0, 2)]));
    expect(current.study.draft?.selectedOptions).toEqual([]);
    expect(submitButton(current.view).props.disabled).toBe(true);
  });

  it("a retained draft callback cannot overwrite a fresh choice after a same-attempt replacement", async () => {
    const initial = await start(snapshot([opening(0, 1)]));
    const changed = receive("question:open", opening(0, 2));
    changed.study.setDraft({ selectedOptions: ["A"] });
    initial.study.setDraft({ selectedOptions: ["B"] });
    expect(render().study.draft).toMatchObject({ selectedOptions: ["A"], contentVersion: 2 });
  });

  it("an unversioned first attempt keeps legacy wire bytes, including after refresh", async () => {
    await start(snapshot([opening()])); reload();
    const { study } = await start(snapshot([opening()]));
    study.submitAnswer({ questionIndex: 0, selectedOptions: ["A"] });
    expect(JSON.stringify(harness.sent.at(-1))).toBe('{"event":"answer:submit","payload":{"questionIndex":0,"selectedOptions":["A"]}}');
  });

  it("self-paced refresh restores a released browsing position and Back to presenter clears it", async () => {
    const data = snapshot([opening(), opening(1), opening(2)], true);
    (await start(data)).study.browse(2); reload();
    const restored = await start(data);
    expect(restored.study.viewedIndex).toBe(2);
    expect(restored.study.following).toBe(false);
    expect(restored.study.question?.questionIndex).toBe(2);
    restored.study.backToPresenter(); reload();
    expect((await start(data, opening(1))).study.viewedIndex).toBe(1);
  });

  it.each(["session", "seat", "unreleased", "presenter-paced"])("saved browsing position cannot override %s context", async change => {
    const data = snapshot([opening(), opening(1), opening(2)], true);
    (await start(data)).study.browse(2); reload();
    if (change === "session") sessionId = "other-session";
    const next = change === "unreleased" ? snapshot([opening(), opening(1)], true)
      : change === "presenter-paced" ? snapshot(data.items) : data;
    const { study, sock } = await start(next, opening(1), change === "seat" ? "other-seat" : "seat");
    expect(study.viewedIndex).toBe(1);
    expect(study.following).toBe(true);
    expect(sock.currentQuestion?.questionIndex).toBe(1);
  });

  it("position storage tolerates corrupt values and unavailable storage", () => {
    const key = "mdq_position_v1:sample-session%3Aseat";
    for (const value of ["invalid", "-1", "1.5", '"2"', "null", "9007199254740992"]) {
      localStorage.setItem(key, value);
      expect(readStudyPosition("sample-session:seat")).toBeNull();
    }
    jest.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("Unavailable"); });
    jest.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Unavailable"); });
    jest.spyOn(localStorage, "removeItem").mockImplementation(() => { throw new Error("Unavailable"); });
    expect(readStudyPosition("sample-session:seat")).toBeNull();
    expect(() => writeStudyPosition("sample-session:seat", 2)).not.toThrow();
    expect(() => writeStudyPosition("sample-session:seat", null)).not.toThrow();
  });
});
