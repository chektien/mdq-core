/** Mounted synthetic availability/durable draft checks. No live server or private deck. */
import { build } from "esbuild";
import { chromium } from "playwright";
import http from "node:http";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = process.env.MDQ_AVAILABILITY_SCREENSHOT_DIR;
if (screenshotDir) await fs.mkdir(screenshotDir, { recursive: true });
const assets = path.join(root, "packages/client/dist/assets");
const cssName = (await fs.readdir(assets)).find(name => name.endsWith(".css"));
const css = await fs.readFile(path.join(assets, cssName), "utf8");
const item = { questionIndex: 0, questionType: "open_response", topic: "Synthetic written item", text: "<p>Released synthetic prompt</p>", options: [], allowsMultiple: false, isPoll: false, startedAt: 0, timeLimitSec: null, deadlineAt: null };
let until = Date.now() + 60_000, phase = "active", final = false;
const posts = []; const creates = []; const availabilityReads = [];
let pacing = "self-paced";
const secondItem = { ...item, questionIndex: 1, topic: "Second released", text: "<p>Second released synthetic prompt</p>" };
const availability = () => ({ schemaVersion: 1, phase, serverNow: Date.now(), availableUntil: until, ...(phase === "active" || phase === "expired" ? { recoverBefore: until + 604_800_000, deleteAt: until + 604_800_000 } : {}) });
const bundle = await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {useSocket} from './packages/client/src/hooks/useSocket';
import StudentView from './packages/client/src/views/StudentView';
import InstructorView from './packages/client/src/views/InstructorView';
function Observer(){const [id,setId]=useState('synthetic');const sock=useSocket(id,'student');window.switchObserver=setId;(window.observedLifecycles??=[]).push({id,availability:sock.availability});return <pre>{JSON.stringify({id,availability:sock.availability})}</pre>}
createRoot(document.getElementById('root')).render(location.pathname === '/observer' ? <Observer/> : location.pathname === '/instructor' ? <InstructorView/> : <StudentView {...(location.pathname === "/by-code" ? {initialSessionCode:"SYNTH1"} : {initialSessionId:"synthetic"})}/>);
` }, bundle: true, jsx: "automatic", write: false, format: "iife", platform: "browser", plugins: [{ name: "socket-double", setup(builder) {
  builder.onResolve({ filter: /^socket.io-client$/ }, () => ({ path: "socket", namespace: "synthetic" }));
  builder.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ loader: "js", contents: `
export function io(options){const handlers={};const sock={connected:false,on(event,fn){handlers[event]=fn;return sock},emit(event,data){(window.sent??=[]).push({event,data});if(event==='student:join')setTimeout(()=>{handlers['student:joined']?.({participantId:'synthetic-seat',sessionToken:'seat-token',sessionState:'QUESTION_OPEN',answeredQuestions:[],answers:[],publicKey:'opaque',label:'Synthetic participant'});handlers['question:open']?.(${JSON.stringify(item)})},0)},connect(){sock.connected=true;handlers.connect?.()},disconnect(){sock.connected=false;handlers.disconnect?.()}};window.serverEvent=(event,data)=>handlers[event]?.(data);return sock}
` }));
} }] });
const server = http.createServer((req, res) => {
  const json = (status, data) => { res.statusCode = status;res.setHeader("Content-Type", "application/json");res.end(JSON.stringify(data)); };
  if (req.url === "/styles.css") { res.setHeader("Content-Type", "text/css");res.end(css);return; }
  if (req.url === "/bundle.js") { res.setHeader("Content-Type", "application/javascript");res.end(bundle.outputFiles[0].text);return; }
  if (req.url === "/api/session/second/availability") { setTimeout(()=>json(200,{schemaVersion:1,phase:"active",serverNow:Date.now(),availableUntil:Date.now()+604_800_000}),100);return; }
  if (req.url === "/api/session/synthetic/availability") {
    if (req.method === "POST") { let body = "";req.on("data", chunk => body += chunk);req.on("end", () => { const data = JSON.parse(body);posts.push(data);until = data.availableUntil;phase = "active";json(200, availability()); });return; }
    availabilityReads.push(req.headers.authorization);json(200, availability());return;
  }
  if (req.url === "/api/session/by-code/SYNTH1") { json(200, {sessionId:"synthetic",sessionCode:"SYNTH1",state:"QUESTION_OPEN",week:"synthetic",theme:"dark",palette:"classic",availability:availability()});return; }
  if (req.url === "/api/session/synthetic/items") { json(200, { availability: availability(), policy: { schemaVersion: 1, pacing, ranking: "correctness", effectiveTiming: "untimed" }, items: phase === "deleted" ? [] : [item, secondItem], currentQuestionIndex: 0, state: "QUESTION_OPEN", answers: [], answeredQuestions: [], answerableQuestionIndexes: phase === "active" ? [0] : [] });return; }
  if (req.url === "/api/session/synthetic/own-results") { json(409, { error: "Results are not available yet" });return; }
  if (req.url === "/api/decks") { json(200, [{ week: "synthetic", title: "Synthetic availability", theme: "dark", palette: "classic", questionCount: 1 }]);return; }
  if (req.url === "/api/deck/synthetic/presenter-notes") { json(200, { enabled: false, items: [] });return; }
  if (req.url === "/api/session") { let body = "";req.on("data",chunk => body += chunk);req.on("end",() => { creates.push(JSON.parse(body));json(201, { sessionId: "synthetic", sessionCode: "SYNTH1", theme: "dark", palette: "classic", questionHeadings: ["Synthetic item"], questionSummaries: [{ heading: "Synthetic item", questionType: "open_response", timeLimitSec: null }], availability: availability() }); });return; }
  if (req.url === "/api/session/synthetic/access-info") { json(404, {});return; }
  if (req.url === "/api/session/synthetic/policy" || req.url === "/api/session/synthetic/start") { json(200, {});return; }
  res.setHeader("Content-Type", "text/html");res.end('<link rel="stylesheet" href="/styles.css"><div id="root"></div><script src="/bundle.js"></script>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.MDQ_BROWSER_CHANNEL || "chrome", timeout: 15000 });
  const url = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(String(error)));
  await page.addInitScript(() => localStorage.setItem("mdquiz_session", JSON.stringify({ sessionId: "synthetic", studentId: "synthetic-seat", sessionToken: "seat-token" })));
  await page.goto(url);await page.locator("textarea").fill("DURABLE_LOCAL_DRAFT");
  phase = "expired";until = Date.now() - 1;
  await page.evaluate(value => window.serverEvent("session:availability", value), availability());
  await page.getByText("Availability ended. Released content is available for review. Answers are closed.").waitFor();
  assert.equal(await page.getByText("Availability ended. Released content is available for review. Answers are closed.").count(), 1);
  assert.equal(await page.getByRole("button", { name: "Submit Response", exact: true }).count(), 0, "no expired submit control");
  assert.match(await page.locator("body").innerText(), /Released synthetic prompt/);
  assert.doesNotMatch(await page.locator("body").innerText(), /Correct answer|Correct!|Incorrect|Leaderboard/);
  assert.equal(await page.evaluate(() => window.sent.filter(item => item.event === "answer:submit").length), 0);
  await page.reload();await page.getByText("Availability ended. Released content is available for review. Answers are closed.").waitFor();
  assert.equal(await page.evaluate(() => window.sent.find(item => item.event === "student:join").data.sessionToken), "seat-token");
  const draft = await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes("draft")).map(key => localStorage.getItem(key)).join(""));
  assert.match(draft, /DURABLE_LOCAL_DRAFT/);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no horizontal overflow");
    if (screenshotDir) await page.screenshot({ path: path.join(screenshotDir, `core-t422-expired-${width}.png`), fullPage: true, animations: "disabled" });
  }
  const observer = await browser.newPage();await observer.goto(url + "/observer");
  await observer.waitForFunction(() => window.observedLifecycles?.some(value => value.availability?.phase === "expired"));
  await observer.evaluate(value => window.serverEvent("session:availability",value),availability());
  await observer.evaluate(() => window.switchObserver("second"));
  await observer.waitForFunction(() => window.observedLifecycles?.some(value => value.id === "second" && value.availability?.phase === "active"));
  assert.equal(await observer.evaluate(() => window.observedLifecycles.some(value => value.id === "second" && value.availability?.phase === "expired")),false,"S1 socket lifecycle is never adopted under S2");
  const stranger = await browser.newPage();await stranger.goto(url + "/by-code");
  await stranger.getByRole("heading", { name: "Availability ended", exact: true }).waitFor();
  assert.equal(await stranger.getByLabel("Student ID", { exact: true }).count(), 0, "expired original link never invites identity-only join");
  assert.equal(await stranger.evaluate(() => window.sent?.some(value => value.event === "student:join") ?? false), false);
  pacing = "presenter-paced";
  const reviewer = await browser.newPage();await reviewer.addInitScript(() => localStorage.setItem("mdquiz_session",JSON.stringify({sessionId:"synthetic",studentId:"synthetic-seat",sessionToken:"seat-token"})));
  await reviewer.goto(url + "/by-code");await reviewer.getByRole("button",{name:"Next available item",exact:true}).waitFor();
  await reviewer.getByRole("button",{name:"Next available item",exact:true}).click();await reviewer.getByText("Second released synthetic prompt",{exact:true}).waitFor();
  assert.equal(await reviewer.getByRole("button",{name:"Submit Response",exact:true}).count(),0,"expired presenter-paced browse remains review-only");
  assert.ok(availabilityReads.includes("Bearer seat-token"), "hosted-compatible availability reads carry seat credentials");
  pacing = "self-paced";
  const instructor = await browser.newPage({ viewport: { width: 390, height: 844 } });instructor.on("pageerror", error => errors.push(String(error)));
  await instructor.goto(url + "/instructor");await instructor.getByRole("button", { name: "Synthetic availability", exact: false }).click();
  const createDate = new Date(Date.now() + 7_200_000);const createLocal = new Date(createDate.getTime() - createDate.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await instructor.getByLabel(/^Available until/).fill(createLocal);
  await instructor.getByRole("button", { name: "Create Session", exact: true }).click();
  assert.equal(creates[0].availableUntil, new Date(createLocal).getTime(), "exact creation deadline uses the latest form value");
  await instructor.getByRole("button", { name: "Extend & reopen", exact: true }).waitFor();
  const input = instructor.getByLabel(/New available-until date and time/);
  const chosen = new Date(Date.now() + 3_600_000);const local = new Date(chosen.getTime() - chosen.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await input.fill(local);await instructor.getByRole("button", { name: "Extend & reopen", exact: true }).click();
  await instructor.getByRole("button", { name: "Extend availability", exact: true }).waitFor();
  assert.equal(posts.length, 1);assert.equal(posts[0].availableUntil, new Date(local).getTime());
  for (const width of [390, 768, 1440]) {
    await instructor.setViewportSize({ width, height: 1000 });
    assert.equal(await instructor.getByRole("heading", { name: "Waiting for Students", exact: true }).count(), 1);
    assert.equal(await instructor.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "presenter controls fit");
    if (screenshotDir) await instructor.screenshot({ path: path.join(screenshotDir, `core-t422-presenter-${width}.png`), fullPage: true, animations: "disabled" });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(value => window.serverEvent("session:availability", value), availability());
  await page.getByRole("button", { name: "Submit Response", exact: true }).waitFor();
  assert.equal(await page.locator("textarea").inputValue(), "DURABLE_LOCAL_DRAFT", "same-device draft survives expiry, reload and recovery");
  assert.equal(await page.evaluate(() => window.sent.filter(item => item.event === "answer:submit").length), 0, "recovery never auto-submits");
  assert.deepEqual(errors, []);
  console.log("Mounted availability passed: expired review, result suppression, token reload, durable unsent draft, exact timezone extension, three widths.");
} finally { if (browser) await browser.close();await new Promise(resolve => server.close(resolve)); }
