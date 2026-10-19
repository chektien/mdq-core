#!/usr/bin/env node
/** Synthetic shared-component geometry and interaction regression check.
 * No MDQ server, sessions, sockets, deck data or production services are used.
 * node scripts/check-popup-fit.mjs [--screenshots <directory>] [--chrome <path>] [--only WxH,WxH]
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = path.join(root, "packages/client");
const require = createRequire(path.join(root, "package.json"));
const { chromium } = require("playwright");
const { createServer } = await import(pathToFileURL(require.resolve("vite", { paths: [client] })));
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const screenshotDir = option("--screenshots");
const fixture = await fs.mkdtemp(path.join(client, ".popup-fit-"));
const chrome = option("--chrome") || process.env.MDQ_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (screenshotDir) await fs.mkdir(screenshotDir, { recursive: true });

await fs.writeFile(path.join(fixture, "fixture.tsx"), `
import React from "react";
import { createRoot } from "react-dom/client";
import LiveSurface from ${JSON.stringify(path.join(client, "src/components/LiveSurface.tsx"))};
import { ExpandableImage } from ${JSON.stringify(path.join(client, "src/components/ImageExpansion.tsx"))};
import ${JSON.stringify(path.join(client, "src/index.css"))};
import ${JSON.stringify(path.join(client, "src/theme.css"))};
const url = new URL(location.href);
document.documentElement.dataset.theme = url.searchParams.get("theme") || "light";
const svg = (w, h) => "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><rect width="100%" height="100%" fill="#0f766e"/><path d="M0 0L'+w+' '+h+'M'+w+' 0L0 '+h+'" stroke="#ffffff" stroke-width="4"/><rect x="2" y="2" width="'+(w-4)+'" height="'+(h-4)+'" fill="none" stroke="#ffffff" stroke-width="4"/></svg>');
const size = url.searchParams.get("image") || "wide";
const [width, height] = ({wide:[1600,400], tall:[400,1600], square:[600,600], tiny:[20,12], veryTall:[100,4000]})[size];
const caption = url.searchParams.get("caption") === "none" ? "" : "Synthetic image caption with enough readable text to wrap within a narrow image frame. ".repeat(url.searchParams.get("caption") === "long" ? 12 : 1);
const joinUrl = url.searchParams.get("url") === "long" ? "https://example.test/join/" + "long-address-".repeat(25) : "https://quiz.example.test/join/AB12CD";
createRoot(document.getElementById("root")!).render(<>
  <LiveSurface qrDataUrl={svg(200,200)} sessionCode="AB12CD" participantCount={12} joinUrl={joinUrl} showFullscreenButton={false} surfaceClassName={url.searchParams.get("quiz") ? "quiz-surface" : undefined}>
    <h1 className="slide-title">Synthetic popup fit</h1>
    <ExpandableImage src={svg(width,height)} alt={caption} />
  </LiveSurface>
</>);
`);

let server;
let browser;
try {
  server = await createServer({ root: client, configFile: path.join(client, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, fixture] } },
    plugins: [{ name: "synthetic-popup-fixture", configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.startsWith("/__popup-fit")) {
          res.setHeader("Content-Type", "text/html");
          res.end(await vite.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/@fs/' + path.join(fixture, "fixture.tsx") + '"></script></body></html>'));
        } else next();
      });
    } }],
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}/__popup-fit`;
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
  const sizes = [[1920,1080], [1440,900], [834,1194], [1194,834], [390,844], [844,390], [320,568]].filter(([w,h]) => !option("--only") || option("--only").split(",").includes(`${w}x${h}`));
  let imageCases = 0;
  let cardCases = 0;
  const inside = (box, viewport, label) => {
    assert(box.x >= -1 && box.y >= -1 && box.right <= viewport.width + 1 && box.bottom <= viewport.height + 1,
      `${label} outside ${JSON.stringify(viewport)}: ${JSON.stringify(box)}`);
  };
  const rect = (element) => {
    const r = element.getBoundingClientRect();
    return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
  };
  for (const [width,height] of sizes) {
    await page.setViewportSize({width,height});
    for (const theme of ["light", "dark"]) {
      for (const quiz of [false, true]) {
        await page.goto(`${origin}?theme=${theme}${quiz ? "&quiz=1" : ""}`);
        await page.locator(".session-code-card-qr").waitFor();
        await page.waitForTimeout(80);
        const card = await page.evaluate(() => {
          const rect = (element) => { const r = element.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
          const card = document.querySelector(".session-code-card");
          const link = document.querySelector(".session-code-card-link-text");
          const range = document.createRange(); range.selectNodeContents(link);
          return {box:rect(card), qr:rect(card.querySelector("img")), toggle:rect(card.querySelector("button")),
            lineCount:range.getClientRects().length, reserve:parseFloat(document.querySelector(".slide-safe").style.getPropertyValue("--slide-expanded-join-width"))};
        });
        inside(card.box, {width,height}, "join card");
        assert(card.qr.width >= (quiz && width <= 1499 ? 70 : width > 760 ? 143 : 70), `QR shrank ${width}x${height} quiz=${quiz}: ${JSON.stringify(card)}`);
        assert(card.toggle.height >= 44, "toggle touch target shrank");
        assert(Math.abs(card.reserve - card.box.width) <= 1, "join reserve did not follow intrinsic width");
        if (width > 760) assert.equal(card.lineCount, 1, "unconstrained URL wrapped");
        if (screenshotDir && theme === "light" && !quiz) await page.screenshot({path:path.join(screenshotDir, `join-${width}x${height}.png`)});
        await page.locator(".session-code-card-toggle").click();
        assert.equal(await page.locator(".session-code-card-body").count(), 0);
        await page.locator(".session-code-card-toggle").click();
        await page.locator(".session-code-card-qr-button").click();
        await page.getByRole("dialog", {name:"Join QR code"}).waitFor();
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".qr-enlarged").count(), 0);
        cardCases++;
      }
      for (const image of ["wide","tall","square","tiny","veryTall"]) {
        for (const caption of ["none","short","long"]) {
          await page.goto(`${origin}?theme=${theme}&image=${image}&caption=${caption}`);
          await page.locator(".expandable-image-button").click();
          await page.waitForFunction(() => document.querySelector(".image-expansion-image")?.style.width);
          await page.waitForTimeout(100);
          const geometry = await page.evaluate(() => {
            const rect = (element) => { const r = element.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
            const frame = document.querySelector(".image-expansion-frame");
            const img = document.querySelector(".image-expansion-image");
            const style = getComputedStyle(frame);
            return {frame:rect(frame), img:rect(img), close:rect(document.querySelector(".image-expansion-close")),
              ratio:img.naturalWidth/img.naturalHeight, padding:parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+2,
              minWidth:parseFloat(style.minWidth), caption:document.querySelector(".image-expansion-caption") ? rect(document.querySelector(".image-expansion-caption")) : null};
          });
          const label = `${theme} ${image} ${caption} ${width}x${height}`;
          inside(geometry.frame,{width,height},label);
          inside(geometry.img,{width,height},label + " image");
          inside(geometry.close,{width,height},label + " close");
          assert(Math.abs(geometry.img.width/geometry.img.height - geometry.ratio) < 0.01, label + " bitmap letterboxed");
          assert(Math.abs(geometry.frame.width - Math.max(geometry.img.width + geometry.padding, geometry.minWidth)) < 2, label + " frame has blank side bars");
          assert(geometry.close.width >= 44 && geometry.close.height >= 44, label + " close touch target");
          if (geometry.caption) assert(geometry.caption.right <= geometry.frame.right + 1, label + " caption overflow");
          if (screenshotDir && caption === "short" && ["wide","tall","tiny"].includes(image)) await page.screenshot({path:path.join(screenshotDir, `image-${theme}-${image}-${width}x${height}.png`)});
          if (image === "wide") await page.locator(".image-expansion-close").click();
          else await page.keyboard.press("Escape");
          assert.equal(await page.locator(".image-expansion-overlay").count(), 0);
          await page.waitForFunction(() => document.activeElement === document.querySelector(".expandable-image-button"), {timeout:1000});
          imageCases++;
        }
      }
    }
  }
  // Resize an already-open image rather than remounting it.
  await page.goto(`${origin}?image=tall&caption=long`);
  await page.locator(".expandable-image-button").click();
  for (const [width,height] of sizes) {
    await page.setViewportSize({width,height});
    await page.waitForTimeout(150);
    inside(await page.locator(".image-expansion-frame").evaluate(rect),{width,height},"resized image");
  }
  await page.keyboard.press("Escape");
  for (const [width,height] of sizes) {
    await page.setViewportSize({width,height});
    for (const quiz of [false,true]) {
      await page.goto(`${origin}?url=long${quiz ? "&quiz=1" : ""}`);
      await page.locator(".session-code-card-qr").waitFor();
      await page.waitForTimeout(100);
      inside(await page.locator(".session-code-card").evaluate(rect),{width,height},"long URL card");
    }
  }
  await page.goto(`${origin}?image=wide&caption=none`);
  await page.locator(".expandable-image-button").click();
  await page.locator(".image-expansion-backdrop").click({position:{x:2,y:2}});
  assert.equal(await page.locator(".image-expansion-overlay").count(),0);
  assert.equal(errors.length,0,errors.join("\n"));
  console.log(`PASS ${cardCases} join-card cases, ${imageCases} image cases, open-image resize and long URL clamp.`);
} finally {
  await browser?.close();
  await server?.close();
  await fs.rm(fixture, {recursive:true,force:true});
}
