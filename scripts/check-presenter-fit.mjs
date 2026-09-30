#!/usr/bin/env node
/**
 * Real-browser check that the presenter's controls and join card keep clear of
 * each other and of a question's answer options on a tablet-width window. It
 * starts the built server on a free port with a synthetic deck (long titles on
 * the slides either side of a four-option question), opens the presenter in
 * Chrome at several sizes and asserts that, with the question open and closed
 * and the join card closed up and opened out:
 *   - no two toolbar controls, and no control and the join card, overlap;
 *   - the join card never covers an answer option (up to 1099 px wide);
 *   - a window 1280 px wide keeps no control overlap.
 *
 * Run `npm run build` first, then:
 *   node scripts/check-presenter-fit.mjs [--chrome <path>]
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

## Deployment check

time-limit: 120

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

const SIZES = [];
for (const width of [768, 800, 820, 860]) for (const height of [600, 768, 1024]) SIZES.push([width, height]);
SIZES.push([1280, 800]);

const failures = [];
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
  const covered = card && visible(card)
    ? [...document.querySelectorAll(".quiz-surface-content .grid > div")].filter(visible).filter((option) => overlap(card, option) > 4).map((option) => label(option))
    : [];
  return { controlOverlaps, covered };
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
    for (const [width, height] of SIZES) {
      // A new page for each size: the question's fit step keeps its density between resizes.
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      await page.goto(`${base}/#/instructor`);
      await page.getByText("Fit deck").click();
      await page.getByRole("button", { name: "Create Session" }).click();
      await page.getByRole("button", { name: /start session/i }).click();
      await page.waitForSelector(".slide-surface .slide-title");
      const states = [];
      const read = async (name) => {
        for (const expanded of [false, true]) {
          const toggle = page.locator(".slide-join-panel .session-code-card-toggle");
          if (((await toggle.getAttribute("aria-expanded")) === "true") !== expanded) await toggle.click({ force: true });
          await page.waitForTimeout(450);
          states.push({ name: `${name}, join card ${expanded ? "open" : "closed"}`, ...(await page.evaluate(scan)) });
        }
      };
      await read("slide");
      await page.getByRole("button", { name: /^Next/ }).click();
      await page.waitForSelector(".quiz-surface-content .grid");
      await read("question open");
      await page.getByRole("button", { name: "Close Question" }).click({ force: true });
      await page.waitForTimeout(600);
      await read("question closed");
      for (const state of states) {
        const where = `${width}x${height} ${state.name}`;
        check(state.controlOverlaps.length === 0, `${where}: no control overlaps another${state.controlOverlaps.length ? ` (${state.controlOverlaps.join("; ")})` : ""}`);
        // Above 1099 px the open card is the tall projector card, which this change leaves as it was.
        if (width < 1100) check(state.covered.length === 0, `${where}: the join card covers no answer option${state.covered.length ? ` (${state.covered.join("; ")})` : ""}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll presenter fit checks passed.");
}

main().catch((error) => { console.error(error); process.exit(1); });
