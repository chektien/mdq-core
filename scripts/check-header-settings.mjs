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

A paragraph of body text with a [plain link](https://example.org/page) inside it.

### A small heading

- First point
  - Nested point
- Second point

![A blue block](../images/header-settings-check.png "A caption")

> Attendee Note: A note.

> Reference: Synthetic source`;
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
  };
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

// The presenter view needs a login session to reload, so the earlier-bundle comparison covers the projector and the phone.
const SURFACES = ["presenter", "projector", "phone"];

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-header-settings-"));
  const deckDir = path.join(tmp, "decks");
  fs.mkdirSync(deckDir);
  fs.writeFileSync(path.join(deckDir, "plain.md"), `# Plain deck\n\n---\n\n${BODY}\n\n---\n`);
  fs.writeFileSync(path.join(deckDir, "styled.md"), `# Styled deck\n${HEADER}\n\n---\n\n${BODY}\n\n---\n`);
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

      const { sessionId } = await (await fetch(`${base}/api/session/by-code/${code}`)).json();
      const projector = await desktop.newPage();
      await projector.goto(`${base}/present/${sessionId}`);
      await projector.waitForSelector(".slide-surface .slide-title");
      await projector.waitForSelector(".slide-media-figure img");
      results[deck].projector = await projector.evaluate(measure);

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
        const currentDump = { projector: await projector.evaluate(dumpAll), phone: await phone.evaluate(dumpAll) };
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
        dumps.projector = [currentDump.projector, await oldProjector.evaluate(dumpAll)];
        const oldPhone = await swap(phoneContext, phone.url(), ".slide-surface-student .slide-title").catch(() => null);
        if (oldPhone) dumps.phone = [currentDump.phone, await oldPhone.evaluate(dumpAll)];
        const hasKeys = (page) => page.evaluate(() => [...document.styleSheets].some((sheet) => { try { return [...sheet.cssRules].some((rule) => rule.cssText.includes("--mdq-title-scale")); } catch { return false; } }));
        dumps.bundles = [await hasKeys(projector), await hasKeys(oldProjector)];
        await projector.mouse.move(0, 0);
        await oldProjector.mouse.move(0, 0);
        await projector.waitForTimeout(1500);
        // The same session and the same window: the two bundles must paint the same pixels.
        dumps.pixels = [(await projector.screenshot()).equals(await oldProjector.screenshot()), oldPhone ? (await phone.screenshot()).equals(await oldPhone.screenshot()) : null];
      }
      await desktop.close();
      await phoneContext.close();
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
