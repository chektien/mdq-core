import path from "path";
import { buildSync } from "esbuild";
import { act, createElement } from "react";
import type { UseSocketReturn } from "../../../client/src/hooks/useSocket";
import type { useParticipantStudy } from "../../../client/src/hooks/useParticipantStudy";

// These observers render null. React DOM still runs the real mount/update/effect/
// cleanup lifecycle; the host only supplies an event target, never answer markup.
// No browser, listener port, custom hook scheduler or external DOM dependency.
const host = globalThis as any;
const saved = new Map<string, PropertyDescriptor | undefined>();
const install = (key: string, value: unknown) => {
  if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(host, key));
  Object.defineProperty(host, key, { configurable: true, writable: true, value });
};
let socket: any;
const rootPath = path.resolve(__dirname, "../../../..");
const bundle = buildSync({
  stdin: { resolveDir: rootPath, loader: "ts", contents: `
    export { useSocket } from './packages/client/src/hooks/useSocket';
    export { useParticipantStudy } from './packages/client/src/hooks/useParticipantStudy';
  ` },
  bundle: true, platform: "node", format: "cjs", write: false, packages: "external",
  alias: { "@mdq/shared": path.join(rootPath, "packages/shared/src/index.ts") },
});
const compiled = { exports: {} as any };
new Function("require", "module", "exports", bundle.outputFiles[0].text)((name: string) => name === "socket.io-client" ? {
  io: () => {
    const listeners = new Map<string, (payload?: any) => void>();
    socket = {
      connected: false,
      on: (name: string, fn: (payload?: any) => void) => { listeners.set(name, fn); return socket; },
      emit: jest.fn(),
      connect: () => { socket.connected = true; listeners.get("connect")?.(); },
      disconnect: () => { socket.connected = false; listeners.get("disconnect")?.(); },
      receive: (name: string, payload?: any) => listeners.get(name)?.(payload),
    };
    return socket;
  },
} : require(name), compiled, compiled.exports);
const hooks = compiled.exports as {
  useSocket: (sessionId: string, role: "student") => UseSocketReturn;
  useParticipantStudy: typeof useParticipantStudy;
};
const question = (questionIndex: number) => ({
  questionIndex, questionType: "multiple_choice", topic: "Synthetic item", text: "<p>Synthetic prompt</p>",
  options: [{ label: "A", text: "one" }], allowsMultiple: false, isPoll: false, startedAt: 0, timeLimitSec: null,
});
const joined = (sessionToken = "synthetic-token") => ({
  participantId: "synthetic-seat", sessionToken, sessionState: "QUESTION_OPEN", answers: [], answeredQuestions: [],
});
const reason = "This question changed. Refresh the page to answer it.";
let sock: UseSocketReturn;
let study: ReturnType<typeof useParticipantStudy>;
let root: ReturnType<typeof import("react-dom/client").createRoot>;
let sessionId: string;
let useStudy: boolean;
let pacing: string;
function Observer() {
  sock = hooks.useSocket(sessionId, "student");
  return useStudy ? createElement(StudyObserver) : null;
}
function StudyObserver() { study = hooks.useParticipantStudy(sessionId, sock); return null; }
const receive = (name: string, payload?: any) => socket.receive(name, payload);
const reject = (questionIndex: number, wording = reason) => receive("answer:rejected", { questionIndex, reason: wording });
// The fallback lets these same behavioral assertions run against the pre-fix API.
const refusalFor = (index: number) => {
  const accessor = (sock as unknown as { answerRejectionFor?: (index: number) => { questionIndex: number; reason: string } | null }).answerRejectionFor;
  return typeof accessor === "function" ? accessor(index)
    : sock.answerRejection?.questionIndex === index ? sock.answerRejection : null;
};
const shownReason = () => study.question ? refusalFor(study.question.questionIndex)?.reason ?? null : null;
const update = async (body: () => void) => { await act(async () => { body(); }); };

beforeEach(async () => {
  jest.useFakeTimers();
  install("IS_REACT_ACT_ENVIRONMENT", true);
  const win = Object.assign(new EventTarget(), { HTMLIFrameElement: class {} });
  const doc = Object.assign(new EventTarget(), { nodeType: 9, defaultView: win, activeElement: null });
  install("window", win);
  install("document", doc);
  const storage = new Map<string, string>();
  install("localStorage", { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  install("fetch", jest.fn(async (url: string) => ({ ok: url.endsWith("/items"), status: 404,
    json: async () => ({ policy: { schemaVersion: 1, pacing, ranking: "correctness", effectiveTiming: "untimed" },
      items: [question(0), question(1)], currentQuestionIndex: 0, answers: [], answeredQuestions: [], answerableQuestionIndexes: [0, 1] }) })));
  const container = Object.assign(new EventTarget(), { nodeType: 1, tagName: "DIV", ownerDocument: doc });
  const { createRoot } = require("react-dom/client");
  root = createRoot(container as any);
  sessionId = "synthetic"; useStudy = true; pacing = "self-paced";
});
afterEach(async () => {
  await update(() => root.unmount());
  jest.useRealTimers();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(host, key, descriptor); else delete host[key];
  }
  saved.clear();
});
async function mount() {
  await update(() => root.render(createElement(Observer)));
  await update(() => { receive("student:joined", joined()); receive("question:open", question(0)); });
}

for (const mode of ["presenter-paced", "self-paced"]) {
  it(`${mode}: preserves a new item's refusal when opening and rejection share one React batch (P2 #1)`, async () => {
    pacing = mode; await mount();
    await update(() => reject(0, "Old item's refusal"));
    await update(() => { receive("question:open", question(1)); reject(1); });
    expect(study.question?.questionIndex).toBe(1);
    expect(shownReason()).toBe(reason);
    expect(refusalFor(0)).toBeNull();
  });
}
it("study: Q1's delayed refusal preserves the shown Q0 reason (P2 #2)", async () => {
  await mount();
  await update(() => study.submitAnswer({ questionIndex: 0, selectedOptions: ["A"] }));
  await update(() => study.browse(1));
  await update(() => study.submitAnswer({ questionIndex: 1, selectedOptions: ["A"] }));
  await update(() => study.browse(0));
  await update(() => reject(0));
  expect(shownReason()).toBe(reason);
  await update(() => reject(1, "Other item's refusal"));
  expect(shownReason()).toBe(reason);
  expect(sock.answerRejection).toEqual({ questionIndex: 1, reason: "Other item's refusal" });
  expect(refusalFor(1)?.reason).toBe("Other item's refusal");
});
it("clears only the submitted/acknowledged entry, retaining other outstanding reasons", async () => {
  useStudy = false; await mount();
  await update(() => { reject(0); reject(1, "Other item's refusal"); });
  await update(() => sock.submitAnswer({ questionIndex: 1, selectedOptions: ["A"] }));
  expect(refusalFor(1)).toBeNull();
  expect(refusalFor(0)?.reason).toBe(reason);
  expect(sock.answerRejection).toEqual({ questionIndex: 0, reason });
  await update(() => reject(1, "Other item's refusal"));
  await update(() => receive("answer:accepted", { questionIndex: 0 }));
  expect(refusalFor(0)).toBeNull();
  expect(refusalFor(1)?.reason).toBe("Other item's refusal");
});
it("clears the departed item, preserves same-item snapshots and presenter changes while browsing", async () => {
  await mount(); await update(() => study.browse(1)); await update(() => reject(1));
  await update(() => receive("question:open", question(1)));
  await update(() => receive("question:open", question(0)));
  expect(shownReason()).toBe(reason);
  await update(() => study.browse(0));
  expect(shownReason()).toBeNull();
  await update(() => study.browse(1));
  expect(shownReason()).toBeNull();
});
it("study navigation and a new refusal in one batch preserve the new item's reason", async () => {
  await mount(); await update(() => reject(0, "Old item's refusal"));
  await update(() => { study.browse(1); reject(1); });
  expect(study.question?.questionIndex).toBe(1);
  expect(shownReason()).toBe(reason); expect(refusalFor(0)).toBeNull();
});
it("expired presenter-paced review preserves each reason until its own item is left", async () => {
  pacing = "presenter-paced"; await mount(); await update(() => reject(0));
  await update(() => receive("session:availability", { schemaVersion: 1, phase: "expired", serverNow: Date.now() }));
  await update(() => reject(1, "Other item's refusal"));
  expect(study.canBrowse).toBe(true); expect(study.canAnswer).toBe(false);
  expect(shownReason()).toBe(reason);
  await update(() => study.browse(1));
  expect(shownReason()).toBe("Other item's refusal"); expect(refusalFor(0)).toBeNull();
  await update(() => study.browse(0)); expect(shownReason()).toBeNull();
});
it("a new-seat refusal arriving in the join batch survives the previous seat's reset", async () => {
  await mount(); await update(() => { reject(0); reject(1); });
  await update(() => { receive("student:joined", joined("synthetic-other-token")); reject(0, "New seat's refusal"); });
  expect(shownReason()).toBe("New seat's refusal"); expect(refusalFor(1)).toBeNull();
});
for (const change of ["session", "seat token", "seat taken", "disconnect"]) {
  it(`socket alone clears all entries on ${change} change`, async () => {
    useStudy = false; await mount(); await update(() => { reject(0); reject(1); });
    await update(() => {
      if (change === "session") { sessionId = "synthetic-other"; root.render(createElement(Observer)); }
      if (change === "seat token") receive("student:joined", joined("synthetic-other-token"));
      if (change === "seat taken") receive("seat:taken");
      if (change === "disconnect") sock.disconnect();
    });
    expect(refusalFor(0)).toBeNull(); expect(refusalFor(1)).toBeNull(); expect(sock.answerRejection).toBeNull();
  });
}
it("keeps indexed feedback beyond the legacy error timeout and preserves same-seat reconnect", async () => {
  await mount(); await update(() => reject(0));
  expect(sock.error).toBe(`Answer rejected: ${reason}`);
  await update(() => jest.advanceTimersByTime(3000));
  expect(sock.error).toBeNull(); expect(shownReason()).toBe(reason);
  await update(() => sock.reconnect());
  await update(() => receive("student:joined", joined()));
  expect(shownReason()).toBe(reason);
  await update(() => receive("student:rejected", { reason: "Synthetic join refusal" }));
  await update(() => jest.advanceTimersByTime(3000));
  expect(sock.error).toBe("Synthetic join refusal");
});
