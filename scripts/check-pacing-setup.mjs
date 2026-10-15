/** Real built browser + synthetic native API, never a deployed/private deck. Run npm run build first. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const express = require('express');
const { createApp } = require('../packages/server/dist/app.js');
const { setupSocket, emitMessages } = require('../packages/server/dist/socket.js');
const { getSession, clearAllSessions } = require('../packages/server/dist/session.js');
const root = path.resolve(import.meta.dirname, '..');
const out = process.env.MDQ_PACING_SCREENSHOT_DIR;
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdq-pacing-browser-'));
await fs.writeFile(path.join(dir, 'synthetic.md'), '# Synthetic pacing\ndark: off\n---\n## Timed question\ntime-limit: 900\nChoose.\nA. One\nB. Two\n> Correct Answer: A\n---\n## Untimed question\ntime-limit: none\nChoose.\nA. One\nB. Two\n> Correct Answer: B\n');
const originalPassword = process.env.INSTRUCTOR_PASSWORD, originalKey = process.env.INSTRUCTOR_KEY;
delete process.env.INSTRUCTOR_PASSWORD; delete process.env.INSTRUCTOR_KEY;
let io, browser;
const app = createApp({ quizDir: dir, dataDir: path.join(dir, 'runtime'), shortUrlProviders: [], theme: 'light',
  onMessages(_s,id,result) { emitMessages(io,id,result.messages); },
  onStateChange(_s,id,_state,_quiz,result) { if (result) emitMessages(io,id,result.messages); },
});
app.use(express.static(path.join(root, 'packages/client/dist')));
app.get('*', (_req,res) => res.sendFile(path.join(root,'packages/client/dist/index.html')));
const server = createServer(app); io = setupSocket(server, app._quizzes);
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
try {
  if (out) await fs.mkdir(out,{recursive:true});
  browser = await chromium.launch({headless:true,channel:process.env.MDQ_BROWSER_CHANNEL || 'chrome'});
  const context = await browser.newContext({viewport:{width:1440,height:900},timezoneId:'Asia/Singapore'});
  const page = await context.newPage();
  const errors=[], posts=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('request',r=>{ if(r.method()==='POST'&&r.url().includes('/api/session'))posts.push({url:r.url(),body:r.postDataJSON()}); });
  await page.goto(`http://127.0.0.1:${server.address().port}/#/instructor`);
  await page.getByRole('heading',{name:'Start a Deck Session'}).waitFor();
  await page.getByRole('button',{name:/Synthetic pacing/}).click();
  assert.equal(await page.getByRole('checkbox',{name:/answer speed/}).count(),0);
  await page.getByLabel('Choose day and time',{exact:true}).check();
  const day = page.getByLabel('Day',{exact:true});
  await day.waitFor();
  const options = await day.locator('option').evaluateAll(nodes=>nodes.filter(n=>!n.disabled).map(n=>n.value));
  assert.ok(options.length >= 7 && options.length <= 8, JSON.stringify({ options, html: await day.innerHTML() }));
  await day.selectOption(options.at(-1));
  await page.getByLabel(/^Time \(/).fill('23:59');
  // Last-day time cannot exceed the absolute seven-day maximum.
  if (await page.getByRole('alert').count()) assert.equal(await page.getByRole('button',{name:'Create Session',exact:true}).isDisabled(),true);
  await page.getByLabel('24 hours from when you present',{exact:true}).check();
  await page.getByLabel('Self-paced',{exact:true}).check();
  if(out) await page.screenshot({path:path.join(out,'core-private-setup-desktop.png'),fullPage:true});
  await page.clock.install({time:new Date()});
  await page.clock.fastForward(3_600_000);
  await page.getByRole('button',{name:'Create Session',exact:true}).click();
  await page.getByRole('heading',{name:'Waiting for participants'}).waitFor();
  const create = posts.find(p=>new URL(p.url).pathname==='/api/session');
  assert.deepEqual(create.body,{week:'synthetic',mode:'open',pacing:'self-paced',availableForMs:86_400_000});
  const sessionId = await page.evaluate(()=>JSON.parse(sessionStorage.getItem('mdquiz_instructor_session')).sessionId);
  const session = getSession(sessionId);
  assert.equal(session.policy.pacing,'self-paced');
  assert.equal(session.availability.availableUntil-session.createdAt,86_400_000,'preset resolves on the server even after one hour in setup');
  await page.clock.resume();
  for (const [width,height,label] of [[1440,900,'desktop'],[1180,820,'tablet-landscape'],[820,1180,'tablet-portrait'],[390,844,'phone']]) {
    await page.setViewportSize({width,height});
    const text=await page.locator('body').innerText();
    assert.doesNotMatch(text,/Available until|Open until|Recover before|Data deleted|Session pacing|Include answer speed|Lock joining|Ranking is/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const floors=await page.locator('.instructor-qr-code-label,.instructor-qr-helper,.instructor-qr-presentation-link').evaluateAll(nodes=>nodes.map(n=>parseFloat(getComputedStyle(n).fontSize)));
    assert.ok(floors.every(n=>n>=14));
    if(out) await page.screenshot({path:path.join(out,`core-clean-lobby-${label}.png`),fullPage:true});
  }
  await page.getByRole('button',{name:'Session options',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByRole('heading',{name:'Session options'}).waitFor();
  assert.match(await dialog.innerText(),/self-paced/);
  await dialog.getByRole('button',{name:'Extend availability',exact:true}).click();
  assert.equal(await dialog.getByLabel('2 hours from now · already open longer',{exact:true}).isDisabled(),true);
  assert.equal(await dialog.getByLabel('24 hours from now',{exact:true}).isDisabled(),false);
  await dialog.getByLabel('Choose day and time',{exact:true}).check();
  assert.ok((await dialog.getByLabel('Day',{exact:true}).locator('option').count())<=8);
  if(out) await page.screenshot({path:path.join(out,'core-private-options-phone.png'),fullPage:true});
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(),0);
  assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Session options');
  await page.reload();
  await page.getByRole('heading',{name:'Waiting for participants'}).waitFor();
  await page.getByRole('button',{name:'Start Session',exact:true}).click();
  await page.getByRole('button',{name:/End/}).first().waitFor();
  assert.equal(getSession(sessionId).policy.pacing,'self-paced');
  assert.equal(getSession(sessionId).policyFrozen,true);
  assert.equal(posts.filter(p=>p.url.endsWith('/policy')).length,0,'Start never resends setup policy');
  assert.doesNotMatch(await page.locator('body').innerText(),/Open until|Recover before|Data deleted/);
  getSession(sessionId).availability.availableUntil = Date.now() - 1;
  for (const route of [`present/${sessionId}`, `join/${getSession(sessionId).sessionCode}`]) {
    const publicPage = await context.newPage();
    await publicPage.goto(`http://127.0.0.1:${server.address().port}/#/${route}`);
    await publicPage.getByText('Availability ended. Released content is available for review. Answers are closed.',{exact:true}).waitFor();
    assert.doesNotMatch(await publicPage.locator('body').innerText(),/Reopen or show results by|Recover before|Data deleted|Open until|Results kept until/);
    await publicPage.close();
  }
  const dstContext = await browser.newContext({ timezoneId: 'America/New_York' });
  const dstPage = await dstContext.newPage();
  await dstPage.clock.install({ time: new Date('2027-03-08T04:30:00Z') });
  await dstPage.goto(`http://127.0.0.1:${server.address().port}/#/instructor`);
  await dstPage.getByRole('button',{name:/Synthetic pacing/}).click();
  await dstPage.getByLabel('Choose day and time',{exact:true}).check();
  const dstDay = dstPage.getByLabel('Day',{exact:true});
  await dstDay.waitFor();
  const dstDays = await dstDay.locator('option').evaluateAll(nodes=>nodes.filter(n=>!n.disabled).map(n=>n.value));
  assert.equal(dstDays.at(-1),'2027-03-15','spring DST final allowed local day remains selectable');
  assert.equal(dstDays.length,9);
  await dstDay.selectOption('2027-03-14');
  await dstPage.getByLabel(/^Time \(/).fill('02:30');
  assert.match(await dstPage.getByRole('alert').innerText(),/local time is unavailable/);
  assert.equal(await dstPage.getByRole('button',{name:'Create Session',exact:true}).isDisabled(),true);
  await dstContext.close();
  assert.deepEqual(errors,[]);
  console.log('PASS real built Core pacing flow: bounded days/time, server-relative delayed creation, four lobby widths, private options, disabled preset reasons, Escape focus, restore and Start without policy overwrite, public expiry without admin dates, spring DST final day and nonexistent-time guard.');
} finally {
  if(browser)await browser.close();
  await new Promise(resolve=>io.close(resolve));
  clearAllSessions();
  if(originalPassword===undefined)delete process.env.INSTRUCTOR_PASSWORD;else process.env.INSTRUCTOR_PASSWORD=originalPassword;
  if(originalKey===undefined)delete process.env.INSTRUCTOR_KEY;else process.env.INSTRUCTOR_KEY=originalKey;
  await fs.rm(dir,{recursive:true,force:true});
}
