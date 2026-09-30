#!/usr/bin/env node
/**
 * Real-browser check for the deck header appearance settings (`title-size:`,
 * `accent-color:` and the rest). It starts the built server on a free port
 * with two synthetic decks, one without the keys and one with a handful, opens
 * the presenter, projector and phone pages in Chrome, and asserts that the
 * keys change the computed styles on all three while the plain deck keeps
 * Core's own values.
 *
 * Run `npm run build` first, then:
 *   node scripts/check-header-settings.mjs [--chrome <path>] [--baseline-dist <client dist>]
 *
 * With --baseline-dist (a client build from before the keys existed) the plain
 * deck is also loaded with that bundle, and every computed style of every
 * element on the slide must match the current bundle.
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
const baselineDist = option("--baseline-dist");

const BODY = `## Alpha: A steady subtitle

type: slide

A paragraph of **bold** body text with a [plain link](https://example.org/page) inside it.

### A small heading

- First point
  - Nested point
- Second point

![A blue block](../images/header-settings-check.png "A caption")

> Attendee Note: A note.

> Reference: Synthetic source`;
const QUESTION = `## Pick one

time-limit: 10

**Which one is **bold** here?**

A. One
B. Two

> Correct Answer: A
> Overall Feedback: One.`;
const HEADER = [
  "title-size: x-large", "body-size: large", "small-size: 1.2rem", "caption-size: large", "heading-size: 2rem",
  "accent-color: teal", "text-color: #101820", "muted-color: #445566", "background-color: #fdf6e3", "surface-color: #eee8d5",
  "link-color: navy", "bullet-color: tomato", "text-width: 30ch", "slide-padding: roomy", "block-spacing: roomy", "inline-spacing: 1.5rem",
  "list-spacing: roomy", "list-indent: large", "list-gap: roomy", "bullet-size: large", "image-corners: square", "image-spacing: roomy", "image-width: narrow",
].join("\n");

const failures = [];
const check = (ok, message) => { console.log(`${ok ? "ok  " : "FAIL"} ${message}`); if (!ok) failures.push(message); };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

/** Computed styles for the elements each key changes. Read inside the page. */
function measure() {
  const surface = document.querySelector(".slide-surface");
  const cs = (el, pseudo) => (el ? getComputedStyle(el, pseudo) : null);
  const one = (selector) => surface.querySelector(selector);
  const px = (value) => (value ? parseFloat(value) : NaN);
  const li = one(".slide-body ul > li");
  const nested = one(".slide-body li li");
  const ul = one(".slide-body ul");
  const figure = one(".slide-media-figure");
  const image = one(".slide-media-figure img");
  return {
    titleSize: px(cs(one(".slide-title")).fontSize),
    bodySize: px(cs(one(".slide-body")).fontSize),
    headingSize: px(cs(one(".slide-body h3")).fontSize),
    smallSize: px(cs(one(".foldout-note-body, .slide-references")).fontSize),
    captionSize: px(cs(one("figcaption")).fontSize),
    titleColor: cs(one(".slide-title")).color,
    bodyColor: cs(one(".slide-body p")).color,
    mutedColor: cs(one(".slide-references, .foldout-note-body")).color,
    linkColor: cs(one(".slide-body a")).color,
    bulletColor: cs(li, "::marker").color,
    bulletSize: px(cs(li, "::marker").fontSize) / px(cs(li).fontSize),
    background: `${cs(surface).backgroundColor} ${cs(surface).backgroundImage}`,
    padding: px(cs(one(".slide-safe")).paddingLeft),
    blockGap: px(cs(one(".slide-content-grid")).rowGap),
    headerGap: px(cs(one(".slide-header")).rowGap),
    listSpacing: px(cs(li).marginBottom),
    listIndent: px(cs(ul).paddingLeft) / px(cs(ul).fontSize),
    listGap: px(cs(ul).rowGap) / px(cs(ul).fontSize),
    nestedGap: nested ? px(cs(nested.parentElement).rowGap) / px(cs(nested.parentElement).fontSize) : NaN,
    textWidth: cs(one(".slide-body p")).maxWidth,
    imageCorners: px(cs(image).borderTopLeftRadius),
    imageWidth: figure.getBoundingClientRect().width,
    figureMaxWidth: cs(figure).maxWidth,
    canvas: getComputedStyle(document.documentElement).backgroundColor,
    strongColor: cs(one(".slide-body strong")) ? cs(one(".slide-body strong")).color : null,
  };
}

/** Toolbar and control buttons: text colour, fill and the contrast between them, with translucent fills blended over what is behind. */
function measureControls() {
  const parse = (value) => { const m = value.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [r, g, b, a]; };
  const over = (top, bottom) => { const a = top[3] + bottom[3] * (1 - top[3]); return a === 0 ? [0, 0, 0, 0] : [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a); };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const fillOf = (el) => { const layers = []; for (let node = el; node; node = node.parentElement) layers.push(parse(getComputedStyle(node).backgroundColor)); return layers.reduceRight((below, layer) => over(layer, below), [255, 255, 255, 1]); };
  return [...document.querySelectorAll(".slide-surface .slide-toolbar button")].map((button) => {
    const fill = fillOf(button);
    const text = over(parse(getComputedStyle(button).color), fill);
    const [hi, lo] = [lum(text), lum(fill)].sort((a, b) => b - a);
    return { label: button.textContent.trim(), color: getComputedStyle(button).color, fill: fill.map((n) => Math.round(n * 100) / 100).join(","), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 };
  });
}

/** The question stem and its bold text, and the page canvas. */
function measureQuestion() {
  const stem = document.querySelector(".slide-surface .quiz-html.text-white");
  return {
    stemColor: getComputedStyle(stem).color,
    strongColor: getComputedStyle(stem.querySelector("strong")).color,
    canvas: getComputedStyle(document.documentElement).backgroundColor,
  };
}

/** Text on the slide with less than 4.5:1 against what is behind it, blending translucent fills over the layers below. */
function lowContrastText() {
  const parse = (value) => { const m = value.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 0]; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [r, g, b, a]; };
  const over = (top, bottom) => { const a = top[3] + bottom[3] * (1 - top[3]); return a === 0 ? [0, 0, 0, 0] : [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a); };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const solid = (value) => { const probe = document.createElement("i"); probe.style.color = value; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return parse(color); };
  // The slide paints its background as a gradient, so its end colour stands in for the fill.
  const fillOf = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      layers.push(node.classList.contains("slide-surface") && style.backgroundImage !== "none" ? solid(style.getPropertyValue("--mdq-slide-bg")) : parse(style.backgroundColor));
    }
    return layers.reduceRight((below, layer) => over(layer, below), [255, 255, 255, 1]);
  };
  const failures = [];
  for (const el of document.querySelectorAll(".slide-surface *")) {
    const own = [...el.childNodes].filter((node) => node.nodeType === 3 && node.textContent.trim()).map((node) => node.textContent.trim()).join(" ");
    const style = getComputedStyle(el);
    if (!own || style.visibility === "hidden" || style.display === "none") continue;
    const fill = fillOf(el);
    const [hi, lo] = [lum(over(parse(style.color), fill)), lum(fill)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    if (ratio < 4.5) failures.push(`${el.tagName.toLowerCase()} "${own.slice(0, 24)}" ${ratio.toFixed(2)}`);
  }
  return failures;
}

/** The timer count: its state, its colour, and the palette's warning colour for that state. The ring fades between colours, so it is not compared mid-fade. */
function measureTimer() {
  const label = document.querySelector(".slide-surface .timer-label");
  const probe = document.createElement("i");
  probe.style.color = `var(--mdq-timer-${label.dataset.timerState})`;
  label.parentElement.append(probe);
  const expected = getComputedStyle(probe).color;
  probe.remove();
  return { state: label.dataset.timerState, color: getComputedStyle(label).color, expected };
}

/** Every computed property of every element under the slide surface, for an exact before and after comparison. */
function dumpAll() {
  const surface = document.querySelector(".slide-surface");
  const out = [];
  for (const el of [surface, ...surface.querySelectorAll("*")]) {
    for (const pseudo of [null, "::before", "::after", "::marker"]) {
      const style = getComputedStyle(el, pseudo);
      const props = {};
      for (const name of [...style].sort()) props[name] = style.getPropertyValue(name);
      out.push([el.tagName + "." + (el.className?.toString?.() ?? ""), pseudo, props]);
    }
  }
  return out;
}

/** Dumps until two dumps in a row agree, so a transition still running does not count as a difference. */
async function stableDump(page) {
  let previous = JSON.stringify(await page.evaluate(dumpAll));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.waitForTimeout(400);
    const next = JSON.stringify(await page.evaluate(dumpAll));
    if (next === previous) return JSON.parse(next);
    previous = next;
  }
  return JSON.parse(previous);
}

// The presenter view needs a login session to reload, so the earlier-bundle comparison covers the projector and the phone.
const SURFACES = ["presenter", "projector", "phone"];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-header-settings-"));
  const deckDir = path.join(tmp, "decks");
  fs.mkdirSync(deckDir);
  // A dark palette under a light deck background is the hard case for the controls, which must keep the palette's own colours.
  const PALETTE = "theme: dark\npalette: tokyo-night";
  fs.writeFileSync(path.join(deckDir, "plain.md"), `# Plain deck\n${PALETTE}\n\n---\n\n${BODY}\n\n---\n`);
  fs.writeFileSync(path.join(deckDir, "styled.md"), `# Styled deck\n${PALETTE}\n${HEADER}\n\n---\n\n${BODY}\n\n---\n`);
  fs.writeFileSync(path.join(deckDir, "qplain.md"), `# Question plain\n${PALETTE}\n\n---\n\n${QUESTION}\n\n---\n`);
  fs.writeFileSync(path.join(deckDir, "qstyled.md"), `# Question styled\n${PALETTE}\n${HEADER}\n\n---\n\n${QUESTION}\n\n---\n`);
  const imagesDir = path.join(root, "data", "images");
  const imageFile = path.join(imagesDir, "header-settings-check.png");
  fs.mkdirSync(imagesDir, { recursive: true });
  // A 1x1 PNG. The slide stretches it, so only the file has to load.
  fs.writeFileSync(imageFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

  const port = await freePort();
  const server = spawn(process.execPath, [path.join(root, "packages/server/dist/index.js")], {
    env: { ...process.env, PORT: String(port), MDQ_DECK_DIR: deckDir, PORT_FALLBACKS: "0" },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    for (let i = 0; i < 60; i += 1) {
      try { if ((await fetch(`${base}/api/decks`)).ok) break; } catch { /* still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const results = {};
    const dumps = {};
    for (const [deck, title] of [["plain", "Plain deck"], ["styled", "Styled deck"]]) {
      results[deck] = {};
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const presenter = await desktop.newPage();
      await presenter.goto(`${base}/#/instructor`);
      await presenter.getByText(title).click();
      await presenter.getByRole("button", { name: "Create Session" }).click();
      await presenter.getByRole("button", { name: /start session/i }).click();
      await presenter.waitForSelector(".slide-surface .slide-title");
      const code = (await presenter.locator("button", { hasText: /online/ }).first().innerText()).match(/[A-Z0-9]{6}/)[0];
      await presenter.waitForSelector(".slide-media-figure img");
      results[deck].presenter = await presenter.evaluate(measure);
      results[deck].presenterControls = await presenter.evaluate(measureControls);

      const { sessionId } = await (await fetch(`${base}/api/session/by-code/${code}`)).json();
      const projector = await desktop.newPage();
      await projector.goto(`${base}/present/${sessionId}`);
      await projector.waitForSelector(".slide-surface .slide-title");
      await projector.waitForSelector(".slide-media-figure img");
      results[deck].projector = await projector.evaluate(measure);
      results[deck].projectorControls = await projector.evaluate(measureControls);

      const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const phone = await phoneContext.newPage();
      await phone.goto(`${base}/join/${code}`);
      await phone.fill('input[name="studentId"]', "1000001");
      await phone.fill('input[name="displayName"]', "Check");
      await phone.getByRole("button", { name: "Join" }).click();
      await phone.waitForSelector(".slide-surface-student .slide-title");
      await phone.waitForSelector(".slide-media-figure img");
      results[deck].phone = await phone.evaluate(measure);

      if (deck === "plain" && baselineDist) {
        // Serve the earlier client bundle in place of the current one and compare every computed style.
        // The tap that joined left the pointer over the slide, which would show a hover state only here.
        await phone.mouse.move(0, 0);
        await phone.evaluate(() => document.activeElement?.blur());
        await phone.waitForTimeout(600);
        const currentDump = { projector: await stableDump(projector), phone: await stableDump(phone) };
        const swap = async (context, url, ready) => {
          const page = await context.newPage();
          const baselineAssets = fs.readdirSync(path.join(baselineDist, "assets"));
          await page.route("**/assets/*", (route) => {
            const ext = path.extname(new URL(route.request().url()).pathname);
            const file = baselineAssets.find((name) => name.endsWith(ext));
            return route.fulfill({ path: path.join(baselineDist, "assets", file) });
          });
          await page.goto(url);
          await page.waitForSelector(ready);
          await page.waitForSelector(".slide-media-figure img");
          return page;
        };
        const oldProjector = await swap(desktop, `${base}/present/${sessionId}`, ".slide-surface .slide-title");
        dumps.projector = [currentDump.projector, await stableDump(oldProjector)];
        const oldPhone = await swap(phoneContext, phone.url(), ".slide-surface-student .slide-title").catch(() => null);
        if (oldPhone) dumps.phone = [currentDump.phone, await stableDump(oldPhone)];
        const hasKeys = (page) => page.evaluate(() => [...document.styleSheets].some((sheet) => { try { return [...sheet.cssRules].some((rule) => rule.cssText.includes("--mdq-title-scale")); } catch { return false; } }));
        dumps.bundles = [await hasKeys(projector), await hasKeys(oldProjector)];
        await projector.mouse.move(0, 0);
        await oldProjector.mouse.move(0, 0);
        await projector.waitForTimeout(1500);
        // The same session and the same window: the two bundles must paint the same pixels. The join card is masked because its online count changes as pages connect.
        dumps.pixels = [(await projector.screenshot({ animations: "disabled", mask: [projector.locator(".slide-join-panel")] })).equals(await oldProjector.screenshot({ animations: "disabled", mask: [oldProjector.locator(".slide-join-panel")] })), oldPhone ? (await phone.screenshot({ animations: "disabled" })).equals(await oldPhone.screenshot({ animations: "disabled" })) : null];
      }
      await desktop.close();
      await phoneContext.close();
    }

    const questions = {};
    for (const [deck, title] of [["plain", "Question plain"], ["styled", "Question styled"]]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const presenter = await context.newPage();
      await presenter.goto(`${base}/#/instructor`);
      await presenter.getByText(title).click();
      await presenter.getByRole("button", { name: "Create Session" }).click();
      await presenter.getByRole("button", { name: /start session/i }).click();
      await presenter.waitForSelector(".slide-surface .quiz-html.text-white strong");
      const code = (await presenter.locator("button", { hasText: /online/ }).first().innerText()).match(/[A-Z0-9]{6}/)[0];
      const { sessionId } = await (await fetch(`${base}/api/session/by-code/${code}`)).json();
      const projector = await context.newPage();
      await projector.goto(`${base}/present/${sessionId}`);
      await projector.waitForSelector(".slide-surface .quiz-html.text-white strong");
      questions[deck] = {};
      for (const [name, page] of [["presenter", presenter], ["projector", projector]]) {
        questions[deck][name] = { ...(await page.evaluate(measureQuestion)), controls: await page.evaluate(measureControls), open: await page.evaluate(lowContrastText) };
      }
      // Near the end of the time, the count takes the ring's warning colour, not the deck's text colour.
      for (const [name, page] of [["presenter", presenter], ["projector", projector]]) {
        await page.waitForSelector('.timer-label[data-timer-state="urgent"]', { timeout: 20000 });
        questions[deck][name].timerLow = await page.evaluate(measureTimer);
      }
      // Close the question, then reveal it, and read every text on the slide in each state.
      await fetch(`${base}/api/session/${sessionId}/close`, { method: "POST" });
      for (const page of [presenter, projector]) await page.waitForSelector(".quiz-surface-content > .text-amber-400");
      await projector.waitForTimeout(400);
      for (const [name, page] of [["presenter", presenter], ["projector", projector]]) questions[deck][name].closed = await page.evaluate(lowContrastText);
      await fetch(`${base}/api/session/${sessionId}/reveal`, { method: "POST" });
      for (const page of [presenter, projector]) await page.waitForSelector(".quiz-surface-content-reveal");
      await projector.waitForTimeout(800);
      for (const [name, page] of [["presenter", presenter], ["projector", projector]]) questions[deck][name].reveal = await page.evaluate(lowContrastText);
      await context.close();
    }

    for (const surface of SURFACES) {
      const plain = results.plain[surface];
      const styled = results.styled[surface];
      check(styled.titleSize > plain.titleSize, `${surface}: title-size x-large makes the title larger (${plain.titleSize} to ${styled.titleSize}px)`);
      check(styled.bodySize > plain.bodySize, `${surface}: body-size large makes the body larger (${plain.bodySize} to ${styled.bodySize}px)`);
      check(Math.abs(styled.headingSize - 32) < 0.5, `${surface}: heading-size 2rem gives a 32px heading (${styled.headingSize}px)`);
      check(Math.abs(styled.smallSize - 19.2) < 0.5, `${surface}: small-size 1.2rem gives 19.2px note text (${styled.smallSize}px)`);
      check(styled.captionSize > plain.captionSize, `${surface}: caption-size large makes the caption larger (${plain.captionSize} to ${styled.captionSize}px)`);
      check(styled.titleColor === "rgb(16, 24, 32)" && styled.bodyColor === "rgb(16, 24, 32)", `${surface}: text-color sets the title and body colour (${styled.titleColor})`);
      check(styled.mutedColor === "rgb(68, 85, 102)", `${surface}: muted-color sets the note and reference colour (${styled.mutedColor})`);
      check(styled.linkColor === "rgb(0, 0, 128)", `${surface}: link-color sets the link colour (${styled.linkColor})`);
      check(styled.bulletColor === "rgb(255, 99, 71)", `${surface}: bullet-color sets the marker colour (${styled.bulletColor})`);
      check(styled.bulletSize > plain.bulletSize, `${surface}: bullet-size large enlarges the marker (${plain.bulletSize.toFixed(2)} to ${styled.bulletSize.toFixed(2)}em)`);
      check(styled.background.startsWith("rgb(253, 246, 227)") || styled.background.includes("rgb(238, 232, 213)"), `${surface}: background-color and surface-color repaint the slide`);
      check(styled.padding > plain.padding, `${surface}: slide-padding roomy widens the padding (${plain.padding} to ${styled.padding}px)`);
      check(styled.blockGap > plain.blockGap, `${surface}: block-spacing roomy widens the gap (${plain.blockGap} to ${styled.blockGap}px)`);
      check(Math.abs(styled.headerGap - 24) < 0.5, `${surface}: inline-spacing 1.5rem gives a 24px header gap (${styled.headerGap}px)`);
      check(styled.listSpacing > plain.listSpacing, `${surface}: list-spacing roomy adds space under items (${plain.listSpacing} to ${styled.listSpacing}px)`);
      check(styled.listIndent > plain.listIndent, `${surface}: list-indent large deepens the indent (${plain.listIndent.toFixed(2)} to ${styled.listIndent.toFixed(2)}em)`);
      check(styled.listGap > plain.listGap && styled.nestedGap > plain.nestedGap, `${surface}: list-gap roomy widens both list gaps (${plain.listGap.toFixed(2)} to ${styled.listGap.toFixed(2)}em)`);
      check(styled.imageCorners === 0 && plain.imageCorners > 0, `${surface}: image-corners square removes the rounding (${plain.imageCorners} to ${styled.imageCorners}px)`);
      check(styled.imageWidth < plain.imageWidth, `${surface}: image-width narrow narrows the picture panel (${Math.round(plain.imageWidth)} to ${Math.round(styled.imageWidth)}px)`);
      if (surface !== "phone") {
        const [plainControls, styledControls] = [results.plain[`${surface}Controls`], results.styled[`${surface}Controls`]];
        check(plainControls.length > 0 && JSON.stringify(plainControls) === JSON.stringify(styledControls), `${surface}: control buttons keep the palette's text colour, fill and contrast with colour keys set (${styledControls.map((c) => `${c.label} ${c.ratio}`).join(", ")})`);
        check(styled.canvas === "rgb(253, 246, 227)" && plain.canvas !== styled.canvas, `${surface}: the page canvas follows background-color (${plain.canvas} to ${styled.canvas})`);
        const q = questions.styled[surface];
        check(q.stemColor === "rgb(16, 24, 32)" && q.strongColor === "rgb(16, 24, 32)" && questions.plain[surface].stemColor !== q.stemColor, `${surface}: question text and its bold text follow text-color (${questions.plain[surface].stemColor} to ${q.stemColor})`);
        const low = q.timerLow;
        check(low.state === "urgent" && low.color === low.expected && low.color !== "rgb(16, 24, 32)", `${surface}: the timer count keeps the palette's warning colour at low time (${low.color}, expected ${low.expected})`);
        for (const state of ["open", "closed", "reveal"]) {
          check(q[state].length === 0, `${surface}: every text on the ${state} question screen has at least 4.5:1 contrast on the light deck background${q[state].length ? ` (${q[state].join("; ")})` : ""}`);
        }
        check(JSON.stringify(q.controls) === JSON.stringify(questions.plain[surface].controls), `${surface}: control buttons on a question screen are unchanged too`);
      }
      check(surface === "phone" || styled.strongColor === "rgb(16, 24, 32)" || styled.strongColor === null, `${surface}: bold text in the slide body follows text-color (${styled.strongColor})`);
      if (surface !== "phone") check(styled.textWidth !== plain.textWidth, `${surface}: text-width 30ch limits paragraphs (${plain.textWidth} to ${styled.textWidth})`);
    }
    if (baselineDist) {
      check(dumps.bundles[0] === true && dumps.bundles[1] === false, "the swapped bundle is the earlier one (no header setting properties in its stylesheet)");
      check(dumps.pixels[0] === true, "projector: screenshots of the plain deck are identical with the earlier and the current bundle");
      if (dumps.pixels[1] !== null) check(dumps.pixels[1] === true, "phone: screenshots of the plain deck are identical with the earlier and the current bundle");
      for (const surface of ["projector", "phone"]) {
        if (!dumps[surface]) { console.log(`skip ${surface}: baseline page did not load`); continue; }
        const [now, before] = dumps[surface];
        let differences = 0;
        const rows = Math.max(now.length, before.length);
        for (let i = 0; i < rows; i += 1) {
          if (JSON.stringify(now[i]) === JSON.stringify(before[i])) continue;
          differences += 1;
          if (differences <= 3) {
            const names = new Set([...Object.keys(now[i]?.[2] ?? {}), ...Object.keys(before[i]?.[2] ?? {})]);
            const changed = [...names].filter((name) => now[i]?.[2][name] !== before[i]?.[2][name]).slice(0, 5);
            console.log(`  differs: ${now[i]?.[0]} ${now[i]?.[1] ?? ""} ${changed.map((name) => `${name}: ${before[i]?.[2][name]} -> ${now[i]?.[2][name]}`).join("; ")}`);
          }
        }
        check(rows > 0 && differences === 0, `${surface}: every computed style of ${rows} element states matches the earlier bundle (${differences} differ)`);
      }
    }
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(imageFile, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll header setting checks passed.");
}

main().catch((error) => { console.error(error); process.exit(1); });
