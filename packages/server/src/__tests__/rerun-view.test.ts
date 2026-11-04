import path from "path";
import { buildSync } from "esbuild";
import { Children, createElement, isValidElement, type ComponentType, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { UseSocketReturn } from "../../../client/src/hooks/useSocket";
import type { useParticipantStudy } from "../../../client/src/hooks/useParticipantStudy";
import { hookHarness } from "./rerun-hook-harness";
import { apply, type Command, participantStudyPayload } from "../engine";
import { createSession } from "../session";
import { goldenQuiz } from "./attempts-test-support";

let sock: UseSocketReturn;
let study: ReturnType<typeof useParticipantStudy>;
const root = path.resolve(__dirname, "../../../..");
const bundle = buildSync({
  entryPoints: [path.join(root, "packages/client/src/views/StudentView.tsx")],
  bundle: true, platform: "node", format: "cjs", jsx: "automatic", write: false, packages: "external",
  external: ["../hooks/useSocket", "../hooks/useParticipantStudy", "../hooks/useParticipantResults"],
  alias: { "@mdq/shared": path.join(root, "packages/shared/src/index.ts") },
});
function loadStudentView(react = require("react")) {
  const compiled = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)((name: string) => {
    if (name === "react") return react;
    if (name === "../hooks/useSocket") return { useSocket: () => sock };
    if (name === "../hooks/useParticipantStudy") return { useParticipantStudy: () => study };
    if (name === "../hooks/useParticipantResults") return { useParticipantResults: () => ({ status: "idle" }) };
    return require(name);
  }, compiled, compiled.exports);
  return (compiled.exports as { default: ComponentType }).default;
}
const StudentView = loadStudentView();
const interactiveView = loadStudentView({
  ...require("react"),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => undefined],
  useEffect: () => undefined, useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(), useRef: (current: unknown) => ({ current }),
}) as (props: object) => ReactElement;
const retryButton = (node: ReactNode): ReactElement<{ onClick: () => void }> | undefined => {
  if (!isValidElement<{ children?: ReactNode; onClick: () => void }>(node)) return;
  if (node.type === "button" && node.props.children === "Retry") return node;
  return Children.toArray(node.props.children).map(retryButton).find(Boolean);
};
const render = () => renderToStaticMarkup(createElement(StudentView));

beforeEach(() => {
  sock = {
    sessionToken: "seat", connected: false, sessionState: "REVEAL", questionAttempts: new Map([[0, 2]]),
    currentQuestion: { questionIndex: 0, topic: "Sample", text: "Archived prompt", questionType: "multiple_choice", options: [{ label: "A", text: "Archived option" }], allowsMultiple: false, isPoll: false, startedAt: 100, timeLimitSec: null },
    reveal: { questionIndex: 0, questionType: "multiple_choice", correctOptions: ["A"], explanation: "Archived explanation", distribution: { A: 1 }, isPoll: false, openResponses: [] },
    submittedOptions: ["A"], submittedResponseText: null, leaderboard: [{ rank: 1, publicKey: "sample", label: "Archived leader", correctCount: 1 }], totalQuestions: 1,
    leaderboardInvalidated: true,
    answerRejectionFor: () => null, reconnect: () => undefined,
  } satisfies Partial<UseSocketReturn> as unknown as UseSocketReturn;
  study = {
    question: { ...sock.currentQuestion!, text: "Current prompt", attempt: 2 }, submittedOptions: [], submittedResponseText: null, error: null, refresh: () => undefined,
    selfPaced: false, canBrowse: false, following: true, items: [], viewedIndex: 0, canAnswer: true, submitted: false, draft: null, draftPersisted: false, setDraft: () => undefined, submitAnswer: () => undefined, browse: () => undefined, backToPresenter: () => undefined, progressLabel: null, upToDate: false,
  } as ReturnType<typeof useParticipantStudy>;
});

it.each(["REVEAL", "LEADERBOARD"] as const)("a newer HTTP attempt hides archived %s content and offers recovery until its opening", state => {
  sock = { ...sock, sessionState: state };
  const waiting = render();
  expect(waiting).toContain("Loading question...");
  expect(waiting).toMatch(/<button\b[^>]*>Retry<\/button>/);
  for (const archived of ["Archived prompt", "Archived option", "Archived explanation", "Archived leader", "Correct!"]) expect(waiting).not.toContain(archived);
  study = { ...study, error: "Available items could not be refreshed. Try again." };
  const failed = render();
  expect(failed).toContain(study.error);
  expect(failed).toMatch(/<button\b[^>]*>Retry<\/button>/);
  expect(failed).not.toContain("Archived");
  sock = { ...sock, currentQuestion: study.question, sessionState: "QUESTION_OPEN", reveal: null };
  study = { ...study, error: null };
  expect(render()).toContain("Current prompt");
  expect(render()).not.toContain("Loading question...");
  sock = { ...sock, sessionState: "REVEAL", reveal: { questionIndex: 0, questionType: "multiple_choice", correctOptions: ["A"], explanation: "Current explanation", distribution: {}, isPoll: false, openResponses: [] } };
  expect(render()).toContain("Current explanation");
  expect(render()).toContain("Current prompt");
});

it("a fresh empty leaderboard ends the wait while the retained opening is older", () => {
  sock = { ...sock, sessionState: "LEADERBOARD", leaderboard: [], leaderboardReady: true, leaderboardInvalidated: false };
  expect(render()).toContain("Leaderboard");
  expect(render()).not.toContain("Loading question...");
  expect(render()).not.toContain("Archived");
});

describe("leaderboard recovery through Retry", () => {
  let harness: ReturnType<typeof hookHarness>;
  let requests: { resolve: (response: unknown) => void }[];
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  const renderHooks = () => harness.render(() => {
    sock = harness.useSocket("sample-session", "student");
    study = harness.useParticipantStudy("sample-session", sock);
  });
  const receive = (event: string, payload: unknown) => { harness.receive(event, payload); renderHooks(); };
  beforeEach(() => {
    jest.useFakeTimers();
    const storage = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (name: string) => storage.get(name) ?? null,
      setItem: (name: string, value: string) => storage.set(name, value),
      removeItem: (name: string) => storage.delete(name),
    } });
    requests = [];
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

  it.each([false, true])("a never-rerun leaderboard join keeps its initial rendering with another opening %s", async otherOpening => {
    renderHooks();
    if (otherOpening) receive("question:open", { questionIndex: 1, text: "Other prompt", topic: "Sample", options: [], allowsMultiple: false, isPoll: false, timeLimitSec: null, startedAt: 100 });
    receive("student:joined", { participantId: "sample", sessionToken: "seat", sessionState: "LEADERBOARD", answeredQuestions: [], answers: [] });
    const initial = render();
    expect(sock.leaderboardReady).toBe(false);
    expect(sock.leaderboardInvalidated).toBe(false);
    expect(initial).toContain("Leaderboard");
    expect(initial).toContain("No ranked participants yet.");
    expect(initial).not.toContain("Loading question...");
    expect(initial).not.toMatch(/<button\b[^>]*>Retry<\/button>/);
    requests.at(-1)!.resolve({ ok: true, json: async () => ({ items: [], answers: [], answeredQuestions: [], state: "LEADERBOARD" }) });
    await settle(); renderHooks();
    expect(render()).toBe(initial);
  });

  it.each([false, true].flatMap(accepted => ["rerun", "none", "other"].map(retainedOpening => ({ accepted, retainedOpening }))))("a real reconnect leaderboard ends the wait with $retainedOpening opening and current answers $accepted", async ({ accepted, retainedOpening }) => {
    let session = createSession(goldenQuiz.week, "open");
    const step = (command: Command, now = 200) => { const result = apply(session, goldenQuiz, command, now); session = result.session; return result; };
    const join: Command = { type: "join", payload: { studentId: "sample", displayName: "Sample", sessionToken: "seat" }, socketId: "sample", newToken: "seat", newPublicKey: "sample-key" };
    const replay = (messages: ReturnType<typeof step>["messages"]) => {
      for (const message of messages) if (["all", "participants", "public", "participant:sample"].includes(message.audience)) receive(message.event, message.payload);
    };
    step({ type: "configurePolicy", role: "control", pacing: "presenter-paced" });
    renderHooks(); replay(step(join).messages); replay(step({ type: "start" }).messages);
    replay(step({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex: 0, selectedOptions: ["A"] } }).messages);
    replay(step({ type: "close" }).messages); replay(step({ type: "reveal" }).messages);
    if (retainedOpening === "other") {
      replay(step({ type: "next" }).messages);
      replay(step({ type: "close" }).messages); replay(step({ type: "reveal" }).messages);
    }
    replay(step({ type: "leaderboardShow" }).messages);
    if (retainedOpening === "none") {
      harness.unmount(); harness = hookHarness(); requests = [];
      renderHooks(); replay(step(join).messages);
      expect(sock.currentQuestion).toBeNull();
    } else expect(sock.currentQuestion?.questionIndex).toBe(retainedOpening === "other" ? 1 : 0);
    expect(sock.leaderboardReady).toBe(true);
    expect(sock.leaderboard[0].correctCount).toBe(1);
    expect(render()).toContain("Leaderboard");
    receive("disconnect", undefined);
    step({ type: "disconnect", studentId: "sample", socketId: "sample" });
    if (retainedOpening === "other") step({ type: "previous" }, 350);
    step({ type: "rerun", role: "control", questionIndex: 0 }, 400);
    if (accepted) step({ type: "answerSubmit", studentId: "sample", sessionToken: "seat", payload: { questionIndex: 0, attempt: 2, selectedOptions: ["B"] } }, 450);
    step({ type: "close" }, 500); step({ type: "reveal" }, 550); step({ type: "leaderboardShow" }, 600);
    study.refresh(); renderHooks();
    const currentItems = participantStudyPayload(session, goldenQuiz, "sample", 650);
    requests.at(-1)!.resolve({ ok: true, json: async () => currentItems }); await settle(); renderHooks();
    expect(sock.currentQuestion?.attempt).toBeUndefined();
    expect(sock.questionAttempts.get(0)).toBe(2);
    expect(sock.leaderboard).toEqual([]);
    expect(sock.leaderboardReady).toBe(false);
    expect(sock.leaderboardInvalidated).toBe(true);
    expect(render()).toContain("Loading question...");
    expect(render()).not.toContain("Leaderboard");
    const retry = retryButton(interactiveView({}));
    expect(retry).toBeDefined();
    const reconnect = jest.spyOn(sock, "reconnect");
    const refresh = jest.spyOn(study, "refresh");
    retry!.props.onClick();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    renderHooks();
    expect(harness.sent.at(-1)?.event).toBe("student:join");
    const repeatedRetry = retryButton(interactiveView({}));
    expect(repeatedRetry).toBeDefined();
    const repeatedReconnect = jest.spyOn(sock, "reconnect");
    const repeatedRefresh = jest.spyOn(study, "refresh");
    repeatedRetry!.props.onClick(); renderHooks();
    expect(repeatedReconnect).toHaveBeenCalledTimes(1);
    expect(repeatedRefresh).toHaveBeenCalledTimes(1);
    expect(render()).toContain("Loading question...");
    const snapshot = step(join, 700).messages.filter(message => message.audience === "participant:sample");
    expect(snapshot.map(message => message.event)).toEqual(["student:joined", "session:availability", "session:state", "leaderboard:update"]);
    for (const message of snapshot) {
      receive(message.event, message.payload);
      if (message.event !== "leaderboard:update") {
        expect(render()).toContain("Loading question...");
        expect(render()).not.toContain("Leaderboard");
      }
    }
    expect(sock.currentQuestion?.attempt).toBeUndefined();
    expect(sock.leaderboardReady).toBe(true);
    expect(sock.leaderboardInvalidated).toBe(false);
    expect(sock.leaderboard[0].correctCount).toBe(0);
    expect(sock.leaderboard).toEqual((snapshot.at(-1)!.payload as { entries: unknown }).entries);
    expect(render()).toContain("Leaderboard");
    expect(render()).not.toContain("Loading question...");
    expect(render()).not.toMatch(/<button\b[^>]*>Retry<\/button>/);
    requests.at(-1)!.resolve({ ok: true, json: async () => currentItems }); await settle(); renderHooks();
    expect(sock.leaderboardReady).toBe(true);
    expect(render()).toContain("Leaderboard");
    expect(render()).not.toContain("Loading question...");
  });

  it("a real REVEAL reconnect restores the current opening and reveal after Retry", async () => {
    let session = createSession(goldenQuiz.week, "open");
    const step = (command: Command, now = 200) => { const result = apply(session, goldenQuiz, command, now); session = result.session; return result; };
    const join: Command = { type: "join", payload: { studentId: "sample", sessionToken: "seat" }, socketId: "sample", newToken: "seat" };
    const replay = (messages: ReturnType<typeof step>["messages"]) => {
      for (const message of messages) if (["all", "participants", "public", "participant:sample"].includes(message.audience)) receive(message.event, message.payload);
    };
    step({ type: "configurePolicy", role: "control", pacing: "presenter-paced" });
    renderHooks(); replay(step(join).messages); replay(step({ type: "start" }).messages);
    replay(step({ type: "close" }).messages); replay(step({ type: "reveal" }).messages);
    receive("disconnect", undefined);
    step({ type: "disconnect", studentId: "sample", socketId: "sample" });
    step({ type: "rerun", role: "control", questionIndex: 0 }, 400);
    step({ type: "close" }, 500); step({ type: "reveal" }, 550);
    study.refresh(); renderHooks();
    requests.at(-1)!.resolve({ ok: true, json: async () => participantStudyPayload(session, goldenQuiz, "sample", 600) });
    await settle(); renderHooks();
    expect(sock.currentQuestion?.attempt).toBeUndefined();
    expect(sock.reveal).toBeNull();
    expect(render()).toContain("Loading question...");
    const retry = retryButton(interactiveView({}));
    expect(retry).toBeDefined();
    retry!.props.onClick(); renderHooks();
    const snapshot = step(join, 650).messages.filter(message => message.audience === "participant:sample");
    expect(snapshot.map(message => message.event)).toEqual(["student:joined", "session:availability", "session:state", "question:open", "results:reveal"]);
    replay(snapshot);
    expect(sock.currentQuestion?.attempt).toBe(2);
    expect(sock.reveal?.questionIndex).toBe(0);
    expect(render()).not.toContain("Loading question...");
    expect(render()).not.toMatch(/<button\b[^>]*>Retry<\/button>/);
    expect(render()).toContain(goldenQuiz.questions[0].textHtml);
  });
});
