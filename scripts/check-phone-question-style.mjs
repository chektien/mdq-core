#!/usr/bin/env node
/**
 * Real-browser check that the phone's own question and result screens take the
 * deck header appearance settings (`accent-color:`, `background-color:`,
 * `text-color:`, `body-size:`). It starts the built server on a free port with
 * synthetic decks, joins as a phone at 390 x 844 and reads computed styles in
 * every state: the question open, an answer chosen, sent, time up and revealed.
 *
 * The deck with settings must repaint the screen, take the accent for the chosen
 * answer and Submit, enlarge the question and answer text, and keep every text
 * at 4.5:1 and every answer's edge at 3:1. A deck with a low-contrast accent or
 * a text colour the palette hides must fall back to readable colours, and a deck
 * with no settings must carry no deck attribute and keep Core's own sizes.
 *
 * Run `npm run build` first, then:
 *   node scripts/check-phone-question-style.mjs [--chrome <path>] [--baseline-dist <client dist>]
 *
 * With --baseline-dist (a client build from before the screens took the
 * settings) the plain deck is also loaded with that bundle, and every computed
 * style of every element on each of its screens must match the current bundle.
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

const QUESTION = `## Pick one

time-limit: 120

**Which one is **bold** here?**

A. One is the first option and it is fairly long so that it wraps on a phone screen
B. Two
C. Three

> Correct Answer: A
> Overall Feedback: One is right because it is first.`;
const OPEN = `## Say it

time-limit: 120
question-type: open-response

**Describe the idea in one sentence.**

b`;
const deck = (title, lines) => `# ${title}\ntheme: dark\npalette: tokyo-night\n${lines.join("\n")}\n\n---\n\n${QUESTION}\n\n---\n\n${OPEN}\n\n---\n`;
const DECKS = {
  plain: deck("Phone plain", []),
  styled: deck("Phone styled", ["accent-color: #0b5394", "background-color: #fdf6e3", "text-color: #101820", "body-size: large"]),
  // A yellow accent on cream is under 3:1, so the chosen answer takes the text colour instead.
  weak: deck("Phone weak", ["accent-color: #e6c229", "background-color: #fdf6e3", "text-color: #101820"]),
  // Dark text on the dark palette cannot be read, so it is not used.
  textonly: deck("Phone textonly", ["text-color: #101820"]),
};

const failures = [];
const check = (ok, message) => { console.log(`${ok ? "ok  " : "FAIL"} ${message}`); if (!ok) failures.push(message); };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

/** Read inside the page: colours, sizes and the contrast of each text, answer edge and button, blending translucent fills over what is behind. */
function measure() {
  const parse = (value) => {
    const c = value.match(/color\(srgb ([^)]+)\)/);
    if (c) { const [r, g, b, a = 1] = c[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [r * 255, g * 255, b * 255, a]; }
    const m = value.match(/rgba?\(([^)]+)\)/);
    if (!m) return [0, 0, 0, 0];
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [r, g, b, a];
  };
  const over = (top, bottom) => { const a = top[3] + bottom[3] * (1 - top[3]); return a === 0 ? [0, 0, 0, 0] : [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a).concat(a); };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const cs = (el) => getComputedStyle(el);
  const screen = document.querySelector(".option-btn, textarea, .reveal-banner, .student-closed-note")?.closest(".min-h-dvh");
  const fillOf = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) {
      const style = cs(node);
      let fill = parse(style.backgroundColor);
      // A gradient stands in by its last colour.
      const stops = [...style.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0]));
      if (style.backgroundImage.includes("gradient") && stops.length) fill = stops[stops.length - 1];
      layers.push(fill);
    }
    return layers.reduceRight((below, layer) => over(layer, below), [255, 255, 255, 1]);
  };
  const round = (n) => Math.round(n * 100) / 100;
  const texts = [];
  for (const el of screen.querySelectorAll("*")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(" ");
    const style = cs(el);
    if (!own || style.visibility === "hidden" || style.display === "none") continue;
    const fill = fillOf(el);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    texts.push({ text: own.slice(0, 24), ratio: round(ratio(over(parse(style.color), fill), fill)), min: large ? 3 : 4.5 });
  }
  const page = fillOf(screen);
  const edge = (el) => { const f = parse(cs(el).backgroundColor); return round(ratio(over(parse(f[3] > 0.5 ? cs(el).backgroundColor : cs(el).borderTopColor), page), page)); };
  const question = screen.querySelector(".quiz-html");
  const options = [...screen.querySelectorAll(".option-btn")].map((b) => ({
    checked: b.getAttribute("aria-checked") === "true", edge: edge(b), borderColor: cs(b).borderTopColor,
    textSize: parseFloat(cs(b.querySelector(".quiz-html")).fontSize), textColor: cs(b.querySelector(".quiz-html")).color,
  }));
  const submit = screen.querySelector(".student-submit-button");
  return {
    attributes: Object.fromEntries([...screen.attributes].filter((a) => a.name.startsWith("data-deck")).map((a) => [a.name, a.value])),
    inlineStyle: screen.getAttribute("style"),
    background: cs(screen).backgroundImage,
    questionColor: cs(question).color,
    questionSize: parseFloat(cs(question).fontSize),
    options,
    submit: submit ? { disabled: submit.disabled, fill: cs(submit).backgroundColor, edge: edge(submit) } : null,
    low: texts.filter((t) => t.ratio < t.min).map((t) => `"${t.text}" ${t.ratio}`),
  };
}

/** Every computed property of every element on the screen, for an exact before and after comparison. */
function dumpAll() {
  const screen = document.querySelector(".option-btn, textarea, .reveal-banner, .student-closed-note")?.closest(".min-h-dvh");
  const out = [];
  for (const el of [screen, ...screen.querySelectorAll("*")]) {
    for (const pseudo of [null, "::before", "::after"]) {
      const style = getComputedStyle(el, pseudo);
      const props = {};
      for (const name of [...style].sort()) props[name] = style.getPropertyValue(name);
      out.push([el.tagName, pseudo, props]);
    }
  }
  return out;
}

async function visit(browser, base, week, bundle) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (bundle) {
    const assets = fs.readdirSync(path.join(bundle, "assets"));
    await context.route("**/assets/*", (route) => {
      const ext = path.extname(new URL(route.request().url()).pathname);
      return route.fulfill({ path: path.join(bundle, "assets", assets.find((name) => name.endsWith(ext))) });
    });
  }
  const { sessionId, sessionCode } = await (await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ week }) })).json();
  const phone = await context.newPage();
  await phone.goto(`${base}/join/${sessionCode}`);
  await phone.fill('input[name="studentId"]', "1000001");
  await phone.fill('input[name="displayName"]', "Check");
  await phone.getByRole("button", { name: "Join" }).click();
  await phone.waitForSelector("text=Waiting for quiz");
  const post = (action) => fetch(`${base}/api/session/${sessionId}/${action}`, { method: "POST" });
  const states = {};
  const dumps = {};
  const read = async (state) => {
    await phone.mouse.move(0, 0);
    await phone.evaluate(() => document.activeElement?.blur());
    await phone.waitForTimeout(700);
    states[state] = await phone.evaluate(measure);
    dumps[state] = await phone.evaluate(dumpAll);
  };
  await post("start");
  await phone.waitForSelector(".option-btn");
  await read("open");
  await phone.locator(".option-btn").first().click();
  await read("chosen");
  await phone.getByRole("button", { name: /Submit Answer/ }).click();
  await phone.waitForSelector("text=Answer submitted");
  await read("sent");
  await post("close");
  await phone.waitForSelector(".student-closed-note");
  await read("closed");
  await post("reveal");
  await phone.waitForSelector(".reveal-banner");
  await read("revealed");
  await post("next");
  await phone.waitForSelector("textarea");
  await read("open response");
  await phone.fill("textarea", "An answer");
  await read("open response typed");
  await context.close();
  return { states, dumps };
}

/** The deck's colours are checked against the theme the screen has, so a theme switch on an open question re-checks them. */
async function switchTheme(browser, base, week) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const { sessionId, sessionCode } = await (await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ week }) })).json();
  const phone = await context.newPage();
  await phone.goto(`${base}/join/${sessionCode}`);
  await phone.fill('input[name="studentId"]', "1000001");
  await phone.fill('input[name="displayName"]', "Check");
  await phone.getByRole("button", { name: "Join" }).click();
  await phone.waitForSelector("text=Waiting for quiz");
  await fetch(`${base}/api/session/${sessionId}/start`, { method: "POST" });
  await phone.waitForSelector(".option-btn");
  const questionColor = () => phone.evaluate(() => getComputedStyle(document.querySelector(".student-question-text, .quiz-html")).color);
  const before = await questionColor();
  // Nothing on the screen changes but the theme.
  await phone.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await phone.waitForTimeout(700);
  const after = await questionColor();
  await context.close();
  return { before, after };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-phone-question-"));
  const deckDir = path.join(tmp, "decks");
  fs.mkdirSync(deckDir);
  for (const [name, text] of Object.entries(DECKS)) fs.writeFileSync(path.join(deckDir, `${name}.md`), text);
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
    const results = {};
    for (const name of Object.keys(DECKS)) results[name] = await visit(browser, base, name);
    const switched = await switchTheme(browser, base, "textonly");
    check(switched.before !== "rgb(16, 24, 32)" && switched.after === "rgb(16, 24, 32)", `textonly deck: dark text is used once the theme switches to light, with no other change (${switched.before} to ${switched.after})`);
    const earlier = baselineDist ? await visit(browser, base, "plain", baselineDist) : null;

    const plain = results.plain.states;
    for (const [state, m] of Object.entries(plain)) {
      check(Object.keys(m.attributes).length === 0 && !m.inlineStyle, `plain deck, ${state}: the screen carries no deck attribute and no inline style`);
      check(m.background === "none", `plain deck, ${state}: the screen paints no background of its own`);
      check(m.low.length === 0, `plain deck, ${state}: every text holds its contrast (${m.low.join("; ")})`);
    }
    check(plain.open.questionSize === 18 && plain.open.options[0].textSize === 16, `plain deck: question 18px and answers 16px (${plain.open.questionSize}, ${plain.open.options[0].textSize})`);
    check(plain.revealed.questionSize === 16, `plain deck: the revealed question is 16px (${plain.revealed.questionSize})`);
    for (const name of ["textonly"]) {
      for (const [state, m] of Object.entries(results[name].states)) {
        check(m.questionColor === plain[state].questionColor && !m.attributes["data-deck-text"], `${name} deck, ${state}: dark text on the dark palette is not used (${m.questionColor})`);
        check(m.low.length === 0, `${name} deck, ${state}: every text holds its contrast (${m.low.join("; ")})`);
      }
    }

    const styled = results.styled.states;
    for (const [state, m] of Object.entries(styled)) {
      check(m.background.includes("rgb(253, 246, 227)"), `styled deck, ${state}: background-color repaints the screen`);
      check(m.questionColor === "rgb(16, 24, 32)", `styled deck, ${state}: text-color sets the question text (${plain[state].questionColor} to ${m.questionColor})`);
      check(m.low.length === 0, `styled deck, ${state}: every text holds 4.5:1 (3:1 for large text)${m.low.length ? ` (${m.low.join("; ")})` : ""}`);
      for (const [index, answer] of m.options.entries()) {
        check(answer.edge >= 3, `styled deck, ${state}, answer ${index + 1}: its edge holds 3:1 against the background (${answer.edge})`);
      }
      if (m.submit) check(m.submit.edge >= 3, `styled deck, ${state}: Submit holds 3:1 against the background (${m.submit.edge})`);
    }
    check(styled.open.questionSize === 21.6 && styled.open.options[0].textSize === 19.2, `styled deck: body-size large gives a 21.6px question and 19.2px answers (${styled.open.questionSize}, ${styled.open.options[0].textSize})`);
    check(styled.revealed.questionSize === 19.2, `styled deck: the revealed question is 19.2px (${styled.revealed.questionSize})`);
    for (const state of ["chosen", "sent", "closed"]) {
      const chosen = styled[state].options.find((answer) => answer.checked);
      check(chosen.borderColor === "rgb(11, 83, 148)", `styled deck, ${state}: accent-color outlines the chosen answer (${plain[state].options.find((answer) => answer.checked).borderColor} to ${chosen.borderColor})`);
    }
    check(styled.chosen.submit.fill === "rgb(11, 83, 148)", `styled deck: Submit is filled with the accent (${plain.chosen.submit.fill} to ${styled.chosen.submit.fill})`);
    check(styled["open response typed"].submit.fill === "rgb(11, 83, 148)", "styled deck: Submit is filled with the accent on an open response too");

    for (const state of ["chosen", "sent", "closed"]) {
      const chosen = results.weak.states[state].options.find((answer) => answer.checked);
      check(chosen.borderColor === "rgb(16, 24, 32)", `weak deck, ${state}: a yellow accent under 3:1 is not used, the chosen answer takes the text colour (${chosen.borderColor})`);
      check(results.weak.states[state].low.length === 0, `weak deck, ${state}: every text holds its contrast`);
    }

    if (earlier) {
      for (const [state, now] of Object.entries(results.plain.dumps)) {
        const before = earlier.dumps[state];
        let differences = 0;
        for (let i = 0; i < Math.max(now.length, before.length); i += 1) if (JSON.stringify(now[i]) !== JSON.stringify(before[i])) differences += 1;
        check(differences === 0, `plain deck, ${state}: every computed style of ${now.length} element states matches the earlier bundle (${differences} differ)`);
      }
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
  console.log("\nAll phone question checks passed.");
}

main().catch((error) => { console.error(error); process.exit(1); });
