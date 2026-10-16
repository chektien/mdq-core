/** Mounted synthetic long-retention observer; no server/session/customer data. */
import { build } from 'esbuild';
import { chromium } from 'playwright';
import http from 'node:http';
import assert from 'node:assert/strict';
const LIMIT = 2_147_483_647, DAY = 86_400_000;
const start = 1_800_000_000_000, deleteAt = start + 90 * DAY;
let now = start, reads = 0;
const bundle = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react';import {createRoot} from 'react-dom/client';
import {useSessionAvailability} from './packages/client/src/hooks/useSessionAvailability';
function Observer(){const {availability}=useSessionAvailability('synthetic');return <pre>{JSON.stringify(availability)}</pre>}
createRoot(document.getElementById('root')).render(<Observer/>);
` }, bundle: true, jsx: 'automatic', write: false, format: 'iife', platform: 'browser' });
const server = http.createServer((req,res) => {
  if (req.url === '/api/session/synthetic/availability') {
    reads++; res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({schemaVersion:1,phase:'ended',serverNow:now,endedAt:start,deleteAt}));
  } else if (req.url === '/bundle.js') {
    res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].text);
  } else {res.setHeader('Content-Type','text/html');res.end('<div id="root"></div><script src="/bundle.js"></script>');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({headless:true,channel:process.env.MDQ_BROWSER_CHANNEL || 'chrome'});
  const page=await browser.newPage();
  await page.addInitScript(({start})=> {
    let clock=start, id=0;const timers=new Map(), delays=[];
    const realTimeout=window.setTimeout.bind(window), realClear=window.clearTimeout.bind(window);
    Date.now=()=>clock;
    window.setTimeout=(fn,delay,...args)=>{
      delays.push(delay);
      if(delay>=1000){const key=++id+1000000;timers.set(key,{fn:()=>fn(...args),delay});return key;}
      return realTimeout(fn,delay,...args);
    };
    window.clearTimeout=key=>{timers.delete(key);realClear(key);};
    // Polling is orthogonal; do not replay hundreds of thousands of intervals.
    window.setInterval=()=>++id;window.clearInterval=()=>{};
    window.timerQa={delays:()=>delays,active:()=>[...timers.values()].map(t=>t.delay),advance:(ms)=>{
      clock+=ms;const entry=[...timers].find(([,t])=>t.delay===ms);if(!entry)throw Error('Checkpoint timer absent');
      timers.delete(entry[0]);entry[1].fn();
    }};
  },{start});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(()=>JSON.parse(document.querySelector('pre').textContent)?.phase==='ended');
  await page.waitForFunction(limit=>window.timerQa.active().includes(limit),LIMIT);
  assert.ok((await page.evaluate(()=>window.timerQa.delays())).every(delay=>delay>=1&&delay<=2_147_483_647),'all registered delays fit browser limit');
  assert.ok(reads>=1&&reads<=3,'only mount/pageshow reads, no immediate polling storm');
  const initialReads=reads;
  let remaining=90*DAY, checkpoints=0;
  while(remaining>0){
    const delay=Math.min(LIMIT,remaining);now+=delay;remaining-=delay;checkpoints++;
    const expectedReads=reads+1;
    await page.evaluate(delay=>window.timerQa.advance(delay),delay);
    await page.waitForFunction(phase=>JSON.parse(document.querySelector('pre').textContent)?.phase===phase,remaining===0?'deleted':'ended');
    await page.waitForFunction(expected=>window.timerQa.delays().length>=expected,checkpoints+2);
    for(let retry=0;retry<100&&reads<expectedReads;retry++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(reads,expectedReads,'one refresh per bounded checkpoint');
    if(remaining)await page.waitForFunction(delay=>window.timerQa.active().includes(delay),Math.min(LIMIT,remaining));
  }
  assert.equal(checkpoints,4);
  assert.ok((await page.evaluate(()=>window.timerQa.delays())).every(delay=>delay>=1&&delay<=LIMIT));
  assert.equal(reads,initialReads+4);
  console.log('PASS 90-day mounted lifecycle: bounded timers, no early deletion or request storm, exact cutoff');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
