#!/usr/bin/env node
/**
 * Real-browser check that the presenter's controls and join card keep clear of
 * each other and of a question's answer options and result bars from 761 px
 * wide up to a 1920 x 1080 projector. It starts the built server on a free
 * port with a synthetic deck (long titles on the slides either side of a
 * four-option question), opens the presenter in Chrome at a range of sizes and
 * asserts that, with the question open (answer options), closed (result bars)
 * and revealed (answer bars) and the join card closed up and opened out:
 *   - no two toolbar controls, and no control and the join card, overlap;
 *   - at 700 px tall and more the join card never covers an option or a bar,
 *     the page does not scroll, and the card and all four options or bars are
 *     inside the viewport;
 *   - at any height the join card is inside the viewport (the cramped
 *     768 x 600 and 1024 x 500 windows check this and the controls only).
 * A table of the measured scroll, covered options or bars and what falls
 * outside the viewport is printed at the end.
 *
 * It also checks that the fit settles. With a question open and its timer
 * running, the page is sampled for several seconds, with the join card closed
 * up and opened out. At 700 px tall and more the question's density must not
 * change once it has settled and the page must not scroll in any sample. A
 * second table lists the density changes and scrolling samples per size.
 *
 * Run `npm run build` first, then:
 *   node scripts/check-presenter-fit.mjs [--chrome <path>] [--samples <n>] [--interval <ms>] [--only <WxH,WxH>]
 * --only limits the run to some sizes and --samples and --interval set how
 * often and how many times the stability check samples (default 25 x 160 ms).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(path.join(root, "package.json"))("playwright");
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const chromePath = option("--chrome") || process.env.MDQ_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const DECK = `# Fit deck
theme: dark
palette: classic

---

## An earlier slide with a fairly long title about the rollout plan for the autumn term

type: slide

- First point about rollout

---

## Quick check

time-limit: 60

**Which of these is a fruit?**

A. Apple
B. Brick
C. Chair
D. Drill

> Correct Answer: A
> Overall Feedback: Apple.

---

## Deployment check

time-limit: 60

**Which of these steps should a release engineer complete before promoting a build to production?**

A. Run the full regression suite and confirm that every check has passed on the release branch
B. Ask a colleague to review the change log and sign off on the list of known issues
C. Verify that the rollback procedure has been rehearsed against a copy of the production data
D. Announce the release window to every team that depends on the service being available

> Correct Answer: C
> Overall Feedback: Rehearsed rollback.

---

## The next slide has a very long title about observability dashboards and alerting thresholds

type: slide

- Point one

---
`;

const SAMPLES = Number(option("--samples")) || 25;
const INTERVAL = Number(option("--interval")) || 160;
const FULL_HEIGHT = 700; // from this height up the page must not scroll and everything must be in view
const SIZES = [
  [768, 700], [800, 800], [820, 1180], [1024, 768], [1180, 820], [1280, 720], [1280, 800], [1366, 768], [1440, 900], [1920, 1080],
  [768, 600], [1024, 500],
];

const only = option("--only");
const sizes = only ? only.split(",").map((size) => size.split("x").map(Number)) : SIZES;

const failures = [];
const rows = [];
const stabilityRows = [];
const check = (ok, message) => { console.log(`${ok ? "ok  " : "FAIL"} ${message}`); if (!ok) failures.push(message); };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

/** Read inside the page: pairs of overlapping controls, and the join card over any answer option. */
function scan() {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const label = (el) => (el.getAttribute("aria-label") || el.textContent || el.className).trim().replace(/\s+/g, " ").slice(0, 24);
  const overlap = (a, b) => {
    const [ra, rb] = [a.getBoundingClientRect(), b.getBoundingClientRect()];
    return Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)) * Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
  };
  const controls = [...document.querySelectorAll(".slide-toolbar button, .slide-toolbar a, .slide-join-panel")].filter(visible);
  const controlOverlaps = [];
  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
      const area = overlap(controls[i], controls[j]);
      if (area > 4) controlOverlaps.push(`${label(controls[i])} x ${label(controls[j])} (${Math.round(area)} px2)`);
    }
  }
  const card = document.querySelector(".slide-join-panel");
  const cardVisible = Boolean(card && visible(card));
  const options = [...document.querySelectorAll(".quiz-surface-content .grid > div, .quiz-surface-content .space-y-3 > div, .quiz-surface-content .space-y-2 > div")].filter(visible);
  const covered = cardVisible ? options.filter((option) => overlap(card, option) > 4).map((option) => label(option)) : [];
  const outside = (el) => {
    const r = el.getBoundingClientRect();
    return r.top < -1 || r.left < -1 || r.bottom > window.innerHeight + 1 || r.right > window.innerWidth + 1;
  };
  const scroller = document.scrollingElement || document.documentElement;
  return {
    controlOverlaps,
    covered,
    optionCount: options.length,
    scroll: Math.max(0, scroller.scrollHeight - window.innerHeight),
    optionsOutside: options.filter(outside).map((option) => label(option)),
    cardOutside: !cardVisible || outside(card),
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-presenter-fit-"));
  const deckDir = path.join(tmp, "decks");
  fs.mkdirSync(deckDir);
  fs.writeFileSync(path.join(deckDir, "fit.md"), DECK);
  const port = await freePort();
  const server = spawn(process.execPath, [path.join(root, "packages/server/dist/index.js")], {
    env: { ...process.env, PORT: String(port), MDQ_DECK_DIR: deckDir, PORT_FALLBACKS: "0", MDQ_DISABLE_TAILSCALE: "1" },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    for (let i = 0; i < 60; i += 1) {
      try { if ((await fetch(`${base}/api/decks`)).ok) break; } catch { /* still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    for (const [width, height] of sizes) {
      const full = height >= FULL_HEIGHT;
      // A new page for each size: the question's fit step keeps its density between resizes.
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.goto(`${base}/#/instructor`);
      await page.getByText("Fit deck").click();
      await page.getByRole("button", { name: "Create Session" }).click();
      await page.getByRole("button", { name: /start session/i }).click();
      await page.waitForSelector(".slide-surface .slide-title");
      const states = [];
      const sampleStability = async (expanded, question) => {
        const toggle = page.locator(".slide-join-panel .session-code-card-toggle");
        if (((await toggle.getAttribute("aria-expanded")) === "true") !== expanded) await toggle.click({ force: true });
        await page.evaluate(() => window.scrollTo(0, 0));
        // Give a fit step that is still moving after the toggle time to come to rest, then count what follows.
        await page.waitForTimeout(450);
        const samples = [];
        for (let i = 0; i < SAMPLES; i += 1) {
          samples.push(await page.evaluate(() => {
            const surface = document.querySelector(".quiz-surface-content-fit");
            const scroller = document.scrollingElement || document.documentElement;
            return {
              density: surface?.getAttribute("data-fit-density") ?? "none",
              scroll: Math.max(0, scroller.scrollHeight - window.innerHeight),
              timer: document.querySelector(".timer-label")?.textContent ?? "",
            };
          }));
          await page.waitForTimeout(INTERVAL);
        }
        const changes = samples.filter((sample, i) => i > 0 && sample.density !== samples[i - 1].density).length;
        const scrolling = samples.filter((sample) => sample.scroll > 1).length;
        const ticks = new Set(samples.map((sample) => sample.timer)).size;
        const row = { question, size: `${width}x${height}`, card: expanded ? "open" : "closed", densities: [...new Set(samples.map((sample) => sample.density))].join(","), changes, scrolling, samples: samples.length, ticks };
        stabilityRows.push(row);
        const where = `${width}x${height} ${question} question open with the timer running, join card ${row.card}`;
        check(ticks > 1, `${where}: the timer ticked while sampling (${ticks} values)`);
        if (full) {
          check(changes === 0, `${where}: the density does not change over ${samples.length} samples (${changes} changes, ${row.densities})`);
          check(scrolling === 0, `${where}: the page does not scroll in any of ${samples.length} samples (${scrolling} scrolling)`);
        }
      };
      const read = async (name, kind) => {
        for (const expanded of [false, true]) {
          const toggle = page.locator(".slide-join-panel .session-code-card-toggle");
          if (((await toggle.getAttribute("aria-expanded")) === "true") !== expanded) await toggle.click({ force: true });
          // Clicking the toggle can scroll a tall page. Measure from the top, where the presenter starts.
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(450);
          states.push({ name: `${name}, join card ${expanded ? "open" : "closed"}`, kind, ...(await page.evaluate(scan)) });
        }
      };
      await read("slide", "");
      await page.getByRole("button", { name: /^Next/ }).click();
      await page.waitForSelector(".quiz-surface-content .grid");
      await sampleStability(false, "short");
      await sampleStability(true, "short");
      await page.getByRole("button", { name: /^Next/ }).click({ force: true });
      await page.waitForSelector(".quiz-surface-content .grid");
      await sampleStability(false, "long");
      await sampleStability(true, "long");
      await read("question open", "answer option");
      await page.getByRole("button", { name: "Close Question" }).click({ force: true });
      await page.waitForTimeout(600);
      await read("question closed", "result bar");
      await page.getByRole("button", { name: /^Reveal/ }).click({ force: true });
      await page.waitForSelector(".quiz-surface-content-reveal .space-y-2");
      await page.waitForTimeout(600);
      await read("question revealed", "answer bar");
      for (const state of states) {
        const where = `${width}x${height} ${state.name}`;
        rows.push({ size: `${width}x${height}`, ...state });
        check(state.controlOverlaps.length === 0, `${where}: no control overlaps another${state.controlOverlaps.length ? ` (${state.controlOverlaps.join("; ")})` : ""}`);
        check(!state.cardOutside, `${where}: the join card is inside the viewport`);
        if (!full) continue;
        if (state.kind) check(state.covered.length === 0, `${where}: the join card covers no ${state.kind}${state.covered.length ? ` (${state.covered.join("; ")})` : ""}`);
        check(state.scroll <= 1, `${where}: the page does not scroll (${state.scroll} px)`);
        if (state.kind) check(state.optionCount === 4 && state.optionsOutside.length === 0, `${where}: all four ${state.kind}s are inside the viewport${state.optionsOutside.length ? ` (${state.optionsOutside.join("; ")} outside)` : ""}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log("\nsize        state                                 scroll  covered  options outside  card outside");
  for (const row of rows) console.log(`${row.size.padEnd(11)} ${row.name.padEnd(37)} ${String(row.scroll).padStart(6)}  ${String(row.covered.length).padStart(7)}  ${String(row.optionsOutside.length).padStart(15)}  ${row.cardOutside ? "yes" : "no"}`);
  console.log("\nsize        question join card  densities seen                     density changes  scrolling samples  timer values");
  for (const row of stabilityRows) console.log(`${row.size.padEnd(11)} ${row.question.padEnd(8)} ${row.card.padEnd(10)} ${row.densities.padEnd(34)} ${String(row.changes).padStart(15)}  ${`${row.scrolling} of ${row.samples}`.padStart(17)}  ${String(row.ticks).padStart(12)}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll presenter fit checks passed.");
}

main().catch((error) => { console.error(error); process.exit(1); });
