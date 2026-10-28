/** Mounted participant refusal regressions. Synthetic data and an isolated socket double only. */
import { build } from "esbuild";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = process.env.MDQ_REJECTION_SCREENSHOT_DIR;
if (screenshotDir) await fs.mkdir(screenshotDir, { recursive: true });
const assets = path.join(root, "packages/client/dist/assets");
const cssName = (await fs.readdir(assets)).find(name => name.endsWith(".css"));
const css = await fs.readFile(path.join(assets, cssName), "utf8");
const reason = "This question changed. Refresh the page to answer it.";
const q = (index, type) => ({ questionIndex: index, questionType: type, topic: `Synthetic item ${index}`, text: "<p>Synthetic public test prompt</p>", options: type === "open_response" ? [] : [{ label: "A", text: "one" }, { label: "B", text: "two" }], allowsMultiple: false, isPoll: false, startedAt: 0, timeLimitSec: null, deadlineAt: null });
let pacing = "presenter-paced";
let items = [q(0, "multiple_choice"), q(1, "multiple_choice")];
const bundled = await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import StudentView from './packages/client/src/views/StudentView';
import {useSocket} from './packages/client/src/hooks/useSocket';
function Observer(){window.sock=useSocket('synthetic','student');return null}
createRoot(document.getElementById('root')).render(location.pathname === '/observer' ? <Observer/> : <StudentView {...(location.pathname === '/join' ? {initialSessionCode:'SYNTH1'} : {initialSessionId:'synthetic'})}/>);
` }, bundle: true, jsx: "automatic", write: false, format: "iife", platform: "browser", plugins: [{ name: "synthetic-socket", setup(builder) {
  builder.onResolve({ filter: /^socket.io-client$/ }, () => ({ path: "socket", namespace: "synthetic" }));
  builder.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ loader: "js", contents: `
export function io(){const handlers={};const socket={connected:false,on(event,fn){handlers[event]=fn;return socket},emit(event,data){(window.sent??=[]).push({event,data})},connect(){socket.connected=true;handlers.connect?.()},disconnect(){socket.connected=false;handlers.disconnect?.()}};window.serverEvent=(event,data)=>handlers[event]?.(data);return socket}
` }));
} }] });
// Intercept the synthetic origin rather than opening a local listener or touching a live server.
async function serve(route) {
  const req = route.request();
  const pathname = new URL(req.url()).pathname;
  const send = (status, data) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
  if (pathname === "/bundle.js") return route.fulfill({ contentType: "application/javascript", body: bundled.outputFiles[0].text });
  if (pathname === "/styles.css") return route.fulfill({ contentType: "text/css", body: css });
  if (pathname === "/api/session/by-code/SYNTH1") return send(200, { sessionId: "synthetic", sessionCode: "SYNTH1", state: "QUESTION_OPEN", studentIds: true, week: "synthetic", theme: "dark", palette: "classic" });
  if (pathname === "/api/session/synthetic/items") {
    assert.equal(req.headers().authorization, "Bearer synthetic-token");
    return send(200, { policy: { schemaVersion: 1, pacing, ranking: "correctness", effectiveTiming: "untimed" }, items, currentQuestionIndex: 0, state: "QUESTION_OPEN", answers: [], answeredQuestions: [], answerableQuestionIndexes: [0, 1] });
  }
  if (pathname === "/api/session/synthetic/availability" || pathname === "/api/session/synthetic/own-results") return send(404, {});
  return route.fulfill({ contentType: "text/html", body: '<link rel="stylesheet" href="/styles.css"><div id="root"></div><script src="/bundle.js"></script>' });
}
let browser;
let failures = 0;
let passes = 0;
const errors = [];
try {
  browser = await chromium.launch({ headless: true, channel: process.env.MDQ_BROWSER_CHANNEL || "chrome", timeout: 15000 });
  const url = "http://mdq-synthetic.test";
  async function fresh(joined = true, route = "/") {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(String(error)));
    if (joined) await page.addInitScript(() => localStorage.setItem("mdquiz_session", JSON.stringify({ sessionId: "synthetic", studentId: "synthetic-seat", sessionToken: "synthetic-token" })));
    await page.route("**/*", serve);
    await page.goto(url + route);
    return page;
  }
  async function event(page, name, data) { await page.evaluate(({ name, data }) => window.serverEvent(name, data), { name, data }); }
  async function join(page) {
    await page.waitForFunction(() => window.serverEvent);
    await event(page, "student:joined", { participantId: "synthetic-seat", sessionToken: "synthetic-token", sessionState: "QUESTION_OPEN", answeredQuestions: [], answers: [], publicKey: "synthetic-public", label: "Synthetic participant" });
    await event(page, "question:open", items[0]);
    await page.getByRole("button", { name: items[0].questionType === "open_response" ? "Submit Response" : "Submit Answer", exact: true }).waitFor();
    if (pacing === "self-paced") await page.getByRole("button", { name: "Next available item", exact: true }).waitFor();
  }
  const refusal = page => page.getByRole("status").filter({ hasText: reason });
  async function reject(page, index = 0, wording = reason) { await event(page, "answer:rejected", { questionIndex: index, reason: wording }); }
  async function expectRefusal(page) { await refusal(page).waitFor(); assert.equal(await refusal(page).textContent().then(text => text.trim()), reason); }
  async function noRefusal(page) { await refusal(page).waitFor({ state: "hidden" }); }
  async function submit(page, type) {
    if (type === "open_response") await page.locator("textarea").fill("Synthetic answer");
    else await page.getByRole("radio", { name: "A one", exact: true }).click();
    await page.getByRole("button", { name: type === "open_response" ? "Submit Response" : "Submit Answer", exact: true }).click();
  }
  async function test(name, body) {
    try { await body(); passes++; console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`); }
  }

  for (const mode of ["presenter-paced", "self-paced"]) {
    for (const type of ["multiple_choice", "open_response"]) {
      pacing = mode; items = [q(0, type), q(1, type)];
      const prefix = `${mode} / ${type}`;
      await test(`${prefix}: shown refusal uses server wording, polite feedback and no timeout`, async () => {
        const page = await fresh();
        try {
          await join(page); await submit(page, type);
          // The live region already exists before its text changes.
          const liveBefore = await page.locator('[role="status"][aria-live="polite"][aria-atomic="true"]').count();
          await reject(page); await expectRefusal(page);
          assert.ok(liveBefore > 0);
          assert.equal(await refusal(page).getAttribute("aria-live"), "polite");
          assert.equal(await refusal(page).getAttribute("aria-atomic"), "true");
          assert.equal(await refusal(page).evaluate(element => element.parentElement.contains(element.parentElement.querySelector(".student-submit-button"))), true, "feedback is beside answer controls");
          assert.doesNotMatch(await page.locator("body").innerText(), /Answer rejected:/);
          await page.waitForTimeout(3200);
          await expectRefusal(page);
          assert.equal(await page.getByText("Answer submitted", { exact: true }).count(), 0);
          if (screenshotDir && mode === "self-paced") {
            for (const width of [390, 768, 1440]) {
              await page.setViewportSize({ width, height: 900 });
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal overflow");
              await page.screenshot({ path: path.join(screenshotDir, `refusal-${type}-${width}.png`), fullPage: true, animations: "disabled" });
            }
          }
        } finally { await page.close(); }
      });
      await test(`${prefix}: other-item refusal preserves the shown item’s reason`, async () => {
        const page = await fresh();
        try {
          await join(page); await reject(page); await expectRefusal(page);
          await reject(page, 1, "Other item's refusal");
          await expectRefusal(page);
          assert.doesNotMatch(await page.locator("body").innerText(), /Other item's refusal|Answer rejected:/);
        } finally { await page.close(); }
      });
      await test(`${prefix}: opening and refusal in one React batch preserves the new item's reason`, async () => {
        const page = await fresh();
        try {
          await join(page); await reject(page); await expectRefusal(page);
          // One evaluate callback dispatches both events before React can commit.
          await page.evaluate(({ item, reason }) => {
            window.serverEvent("question:open", item);
            window.serverEvent("answer:rejected", { questionIndex: item.questionIndex, reason });
          }, { item: items[1], reason });
          await page.locator("#question-text-1").waitFor();
          await expectRefusal(page);
        } finally { await page.close(); }
      });
      await test(`${prefix}: expired review reads the shown item's entry and clears on navigation`, async () => {
        const page = await fresh();
        try {
          await join(page); await reject(page); await expectRefusal(page);
          await event(page, "session:availability", { schemaVersion: 1, phase: "expired", serverNow: Date.now() });
          await page.getByText("Availability ended. Released content is available for review. Answers are closed.", { exact: true }).waitFor();
          await reject(page, 1, "Other item's refusal");
          await expectRefusal(page);
          assert.equal(await page.locator(".student-submit-button").count(), 0, "expired review cannot submit");
          const answerControl = type === "open_response" ? page.locator("textarea") : page.getByRole("radio").first();
          assert.equal(await answerControl.isEnabled(), false, "expired review locks answer controls");
          await page.getByRole("button", { name: "Next available item", exact: true }).click();
          await page.locator("#question-text-1").waitFor();
          await page.getByRole("status").filter({ hasText: "Other item's refusal" }).waitFor();
          await noRefusal(page);
          await page.getByRole("button", { name: "Previous available item", exact: true }).click();
          await page.locator("#question-text-0").waitFor();
          await noRefusal(page);
          assert.doesNotMatch(await page.locator("body").innerText(), /Other item's refusal/);
        } finally { await page.close(); }
      });
      await test(`${prefix}: resubmit clears and another refusal is announced again`, async () => {
        const page = await fresh();
        try {
          await join(page); await submit(page, type); await reject(page); await expectRefusal(page);
          await page.getByRole("button", { name: type === "open_response" ? "Submit Response" : "Submit Answer", exact: true }).click();
          await noRefusal(page);
          assert.equal(await page.evaluate(() => window.sent.filter(value => value.event === "answer:submit").length), 2);
          await reject(page); await expectRefusal(page);
        } finally { await page.close(); }
      });
      await test(`${prefix}: item change clears permanently, repeated opening keeps reason`, async () => {
        const page = await fresh();
        try {
          await join(page); await reject(page); await expectRefusal(page);
          await event(page, "question:open", items[0]); await expectRefusal(page);
          if (mode === "self-paced") {
            await page.getByRole("button", { name: "Next available item", exact: true }).click();
          } else await event(page, "question:open", items[1]);
          await page.locator("#question-text-1").waitFor();
          await noRefusal(page);
          if (mode === "self-paced") {
            await page.getByRole("button", { name: "Previous available item", exact: true }).click();
          } else await event(page, "question:open", items[0]);
          await page.locator("#question-text-0").waitFor();
          await page.getByRole("button", { name: type === "open_response" ? "Submit Response" : "Submit Answer", exact: true }).waitFor();
          await noRefusal(page);
        } finally { await page.close(); }
      });
      await test(`${prefix}: matching ACK clears, other-item ACK preserves reason`, async () => {
        const page = await fresh();
        try {
          await join(page); await submit(page, type); await reject(page); await expectRefusal(page);
          await event(page, "answer:accepted", { questionIndex: 1 }); await expectRefusal(page);
          await event(page, "answer:accepted", { questionIndex: 0 }); await noRefusal(page);
          await page.getByText(mode === "self-paced" ? "Answer saved" : type === "open_response" ? "Response submitted" : "Answer submitted", { exact: true }).waitFor();
        } finally { await page.close(); }
      });
      await test(`${prefix}: accepted answer keeps existing feedback without refusal`, async () => {
        const page = await fresh();
        try {
          await join(page); await submit(page, type); await event(page, "answer:accepted", { questionIndex: 0 });
          await noRefusal(page);
          await page.getByText(mode === "self-paced" ? "Answer saved" : type === "open_response" ? "Response submitted" : "Answer submitted", { exact: true }).waitFor();
        } finally { await page.close(); }
      });
    }
  }
  await test("study: refusal is scoped to the browsed item, independent of presenter changes", async () => {
    pacing = "self-paced"; items = [q(0, "multiple_choice"), q(1, "open_response")];
    const page = await fresh();
    try {
      await join(page);
      await page.getByRole("button", { name: "Next available item", exact: true }).click();
      await submit(page, "open_response"); await reject(page, 1); await expectRefusal(page);
      await event(page, "question:open", items[1]); await expectRefusal(page);
      await event(page, "question:open", items[0]); await expectRefusal(page);
      await event(page, "answer:accepted", { questionIndex: 0 }); await expectRefusal(page);
      await event(page, "answer:accepted", { questionIndex: 1 }); await noRefusal(page);
    } finally { await page.close(); }
  });
  await test("join form: refusal alert, field association and focus are unchanged, and the refusal is not timed out", async () => {
    const page = await fresh(false, "/join");
    try {
      // The join fields appear after the session-code lookup. Find the field by its accessible name, which its label gives it.
      await page.getByRole("textbox", { name: "Participant ID", exact: true }).waitFor({ timeout: 15000 });
      await page.getByRole("textbox", { name: "Participant ID", exact: true }).fill("synthetic-seat");
      await page.getByRole("button", { name: "Join", exact: true }).click();
      await page.waitForFunction(() => window.sent?.some(value => value.event === "student:join"));
      const wording = 'The Participant ID "synthetic-seat" is already in this session on another device. Use that device, or check that you typed your own ID.';
      await event(page, "student:rejected", { reason: wording });
      const alert = page.getByRole("alert");
      await page.waitForFunction(expected => document.getElementById("join-error")?.textContent === expected, `${wording} If that device is not working, ask your instructor to let you join again.`);
      assert.equal(await alert.textContent(), `${wording} If that device is not working, ask your instructor to let you join again.`);
      const input = page.getByRole("textbox", { name: "Participant ID", exact: true });
      assert.equal(await input.getAttribute("aria-invalid"), "true");
      assert.equal(await input.getAttribute("aria-describedby"), "join-error");
      assert.equal(await input.evaluate(element => element === document.activeElement), true);
      await page.waitForTimeout(3200); assert.equal(await alert.isVisible(), true, "join refusal is not timed out");
    } finally { await page.close(); }
  });
  await test("socket: a new seat clears all entries, including older refusals", async () => {
    const page = await fresh(false, "/observer");
    try {
      await page.waitForFunction(() => window.sock?.connected);
      const joined = { participantId: "synthetic-seat", sessionToken: "synthetic-token", sessionState: "QUESTION_OPEN", answeredQuestions: [], answers: [] };
      await event(page, "student:joined", joined);
      await reject(page, 0); await reject(page, 1, "Other item's refusal");
      await page.waitForFunction(() => window.sock.answerRejectionFor(0) && window.sock.answerRejectionFor(1));
      await event(page, "student:joined", { ...joined, sessionToken: "synthetic-new-token" });
      await page.waitForFunction(() => window.sock.sessionToken === "synthetic-new-token");
      assert.deepEqual(await page.evaluate(() => [window.sock.answerRejection, window.sock.answerRejectionFor(0), window.sock.answerRejectionFor(1)]), [null, null, null]);
    } finally { await page.close(); }
  });
  await test("socket: legacy error prefix and three-second clear remain separate from answer feedback", async () => {
    const page = await fresh(false, "/observer");
    try {
      await page.waitForFunction(() => window.sock?.connected);
      await reject(page);
      await page.waitForFunction(expected => window.sock.error === `Answer rejected: ${expected}`, reason);
      await page.waitForTimeout(3200);
      await page.waitForFunction(() => window.sock.error === null);
      assert.deepEqual(await page.evaluate(() => window.sock.answerRejection), { questionIndex: 0, reason });
      await event(page, "student:rejected", { reason: "Synthetic join refusal" });
      await page.waitForFunction(() => window.sock.error === "Synthetic join refusal");
      await page.waitForTimeout(3200);
      assert.equal(await page.evaluate(() => window.sock.error), "Synthetic join refusal");
    } finally { await page.close(); }
  });
  assert.deepEqual(errors, [], "no browser runtime errors");
  assert.equal(failures, 0, `${failures} mounted refusal regressions failed`);
  console.log(`PASS all ${passes} mounted participant answer-refusal checks`);
} finally { await browser?.close(); }
