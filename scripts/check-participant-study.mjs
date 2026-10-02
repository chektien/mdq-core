/** Synthetic mounted Core hook/view/socket regressions, no classroom data or live session. */
import { build } from "esbuild";
import { chromium } from "playwright";
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const q = (index, type = "multiple_choice") => ({ questionIndex: index, questionType: type, topic: `Synthetic ${index}`, text: `<p>Synthetic ${index}</p>`, options: type === "open_response" ? [] : [{ label: "A", text: "one" }, { label: "B", text: "two" }], allowsMultiple: false, isPoll: false, startedAt: 0, timeLimitSec: null, deadlineAt: null });
let items = [q(0, "cover"), q(1, "open_response"), q(2)];
let answers = [];
let pacing = "self-paced";
let presenter = 1;
let requestCount = 0;
let requestFailure = false;
let authoredTime = 10;
const policyPosts = [];
const bundled = await build({ stdin: { resolveDir: root, loader: "tsx", contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {useSocket} from './packages/client/src/hooks/useSocket';
import {useParticipantStudy} from './packages/client/src/hooks/useParticipantStudy';
import Controls from './packages/client/src/components/ParticipantStudyControls';
import {QuestionView} from './packages/client/src/views/StudentView';
import InstructorView from './packages/client/src/views/InstructorView';
function Harness() {
 const sock = useSocket('synthetic', 'student'); const study = useParticipantStudy('synthetic',sock);
 window.study = study; window.sock = sock;
 return <><Controls study={study}/><QuestionView question={study.question} state="QUESTION_OPEN" remainingSec={null} submitted={study.submitted} submittedOptions={study.submittedOptions} submittedResponseText={study.submittedResponseText} timedOut={false} connected={sock.connected} onSubmit={study.submitAnswer} draft={study.draft} onDraftChange={study.setDraft} draftPersisted={study.draftPersisted} selfPaced={study.selfPaced}/></>;
}
createRoot(document.getElementById('root')).render(location.pathname === '/instructor' ? <InstructorView/> : <Harness/>);
` }, bundle: true, jsx:"automatic", write: false, format: "iife", platform: "browser", plugins: [{ name: "synthetic-socket", setup(builder) {
 builder.onResolve({ filter: /^socket.io-client$/ }, () => ({ path: "mock", namespace: "synthetic" }));
 builder.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ loader: "js", contents: `
export function io(){ const handlers = {}; const socket = {connected:false,on(name,callback){handlers[name]=callback;return socket},emit(name,data){(window.sent??=[]).push({name,data})},connect(){socket.connected=true;handlers.connect?.()},disconnect(){socket.connected=false;handlers.disconnect?.()}};window.serverEvent=(name,data)=>handlers[name]?.(data);return socket;}
` }));
} }] });
const server = http.createServer((req, res) => {
 if (req.url === "/bundle.js") {res.setHeader("Content-Type", "application/javascript");res.end(bundled.outputFiles[0].text);return;}
 if (req.url === "/api/session/synthetic/items") {
   requestCount++; if(requestFailure){res.statusCode=503;res.end("{}");return;} assert.match(req.headers.authorization ?? "", /^Bearer seat-/);
   res.setHeader("Content-Type", "application/json");res.end(JSON.stringify({policy:{schemaVersion:1,pacing,ranking:"correctness",effectiveTiming:pacing === "self-paced" ? "untimed" : "authored"},items,currentQuestionIndex:presenter,state:"QUESTION_OPEN",answers,answeredQuestions:answers.map(a=>a.questionIndex),answerableQuestionIndexes:items.filter(i=>i.questionType!=="cover").map(i=>i.questionIndex)}));return;
 }
 if (req.url === "/api/decks") {res.setHeader("Content-Type","application/json");res.end(JSON.stringify([{week:"synthetic",title:"Synthetic",theme:"dark",palette:"classic",questionCount:2}]));return;}
 if(req.url === "/api/deck/synthetic/presenter-notes") {res.setHeader("Content-Type","application/json");res.end(JSON.stringify({enabled:false,defaultOpen:false,items:[]}));return;}
 if(req.url === "/api/session") {res.setHeader("Content-Type","application/json");res.end(JSON.stringify({sessionId:"synthetic",sessionCode:"SYNTH1",joinUrl:"/join/SYNTH1",theme:"dark",palette:"classic",questionHeadings:["one","two"],questionSummaries:[{heading:"one",questionType:"multiple_choice",timeLimitSec:authoredTime},{heading:"two",questionType:"multiple_choice",timeLimitSec:authoredTime}]}));return;}
 if(req.url === "/api/session/synthetic/policy") {let body="";req.on("data",chunk=>body+=chunk);req.on("end",()=>{policyPosts.push(JSON.parse(body));res.setHeader("Content-Type","application/json");res.end("{}");});return;}
 if(req.url === "/api/session/synthetic/start") {res.setHeader("Content-Type","application/json");res.end("{}");return;}
 if(req.url === "/api/session/synthetic/access-info") {res.statusCode=404;res.end("{}");return;}
 res.setHeader("Content-Type", "text/html"); res.end('<div id="root"></div><script src="/bundle.js"></script>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
console.log("Mounted synthetic check launching isolated Chrome");
try {
 browser = await chromium.launch({headless:true,channel:process.env.MDQ_BROWSER_CHANNEL || "chrome",timeout:15000}); const page = await browser.newPage({viewport:{width:390,height:844}});
 page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
 const errors=[]; page.on('pageerror',error=>{errors.push(String(error));console.error(String(error))});
 const url=`http://127.0.0.1:${server.address().port}`;
 async function join(token="seat-one",selfPaced=true) {await page.waitForFunction(()=>window.serverEvent);await page.evaluate(({token,current})=>{window.serverEvent('student:joined',{participantId:'synthetic-seat',sessionToken:token,sessionState:'QUESTION_OPEN',answeredQuestions:[],answers:[],publicKey:token,label:'Synthetic'});window.serverEvent('question:open',current)}, {token,current:q(presenter, presenter===1 ? "open_response" : "multiple_choice")});await page.waitForFunction(expected=>window.study?.selfPaced===expected,selfPaced);}
 await page.goto(url); await join();
 await page.locator('textarea').fill('Draft before send');
 await page.getByRole('button',{name:'Submit Response',exact:true}).click();
 await page.locator('textarea').fill('Newer local text');
 await page.evaluate(()=>window.serverEvent('answer:accepted',{questionIndex:1}));
 assert.equal(await page.locator('textarea').inputValue(),'Newer local text','late ACK preserves newer edit');
 // Lost ACK on the old transport, authoritative rejoin, then an updated answer ACK.
 await page.locator('textarea').fill('Lost-ack response');
 await page.getByRole('button',{name:'Update Response',exact:true}).click();
 await page.evaluate(()=>{window.sock.reconnect();window.serverEvent('student:joined',{participantId:'synthetic-seat',sessionToken:'seat-one',sessionState:'QUESTION_OPEN',answeredQuestions:[1],answers:[{questionIndex:1,selectedOptions:[],responseText:'Lost-ack response'}],publicKey:'seat-one',label:'Synthetic'})});
 await page.locator('textarea').fill('Updated after reconnect');
 await page.getByRole('button',{name:'Update Response',exact:true}).click();
 await page.evaluate(()=>window.serverEvent('answer:accepted',{questionIndex:1}));
 await page.waitForFunction(()=>window.sock.ownAnswers.get(1).responseText==='Updated after reconnect');
 await page.locator('textarea').fill('Newer local text');
 
 await page.getByRole('button',{name:'Next available item',exact:true}).click();
 await page.getByRole('radio',{name:'Btwo',exact:true}).click();
 await page.evaluate(()=>window.serverEvent('answer:accepted',{questionIndex:1}));
 assert.equal(await page.evaluate(()=>window.study.submitted),false,'other-item ACK cannot mark viewed item submitted');
 await page.getByRole('button',{name:'Previous available item',exact:true}).click();
 assert.equal(await page.locator('textarea').inputValue(),'Newer local text','browse restores draft');
 presenter=2; items.push(q(3)); await page.evaluate(current=>window.serverEvent('question:open',current),q(2));
 await page.waitForFunction(()=>window.study.items.length===4);
 assert.equal(await page.locator('textarea').inputValue(),'Newer local text','new release does not move explorer');
 assert.equal(await page.evaluate(()=>window.study.progressLabel),'1 of 3 available questions answered');
 await page.getByRole('button',{name:'Back to presenter',exact:true}).click();
 assert.equal(await page.evaluate(()=>window.study.question.questionIndex),2);
 await page.getByRole('button',{name:'Previous available item',exact:true}).click();
 await page.reload(); presenter=1; await join();
 assert.equal(await page.locator('textarea').inputValue(),'Newer local text','reload restores without submission');
 assert.equal(await page.evaluate(()=>window.sent.filter(e=>e.name==='answer:submit').length),0,'reload never auto submits');
 await page.evaluate(current=>window.serverEvent('question:open',current),q(2));
 await page.waitForFunction(()=>window.study.question.questionIndex===2);
 assert.deepEqual(await page.evaluate(()=>window.study.draft.selectedOptions),['B'],'selection draft restores');
 await page.evaluate(()=>window.serverEvent('student:joined',{participantId:'other-seat',sessionToken:'seat-two',sessionState:'QUESTION_OPEN',answeredQuestions:[],answers:[],publicKey:'two',label:'Other'}));
 await page.waitForFunction(()=>window.sock.sessionToken==='seat-two');
 assert.deepEqual(await page.evaluate(()=>window.study.draft.selectedOptions),[],'seat change isolates draft');
 assert.equal(await page.evaluate(()=>window.study.following),true,'new seat initially follows');
 await page.evaluate(()=>window.study.browse(999)); assert.equal(await page.evaluate(()=>window.study.question.questionIndex),2,'future browse fails closed');
 // Mixed-content progress and up-to-date state are submitted evidence only.
 answers=[{questionIndex:1,selectedOptions:[],responseText:'saved'},{questionIndex:2,selectedOptions:[1]},{questionIndex:3,selectedOptions:[0]}];
 await page.evaluate(()=>window.study.refresh()); await page.waitForFunction(()=>window.study.upToDate);
 assert.equal(await page.evaluate(()=>window.study.progressLabel),'3 of 3 available questions answered');
 items.push(q(4)); await page.evaluate(()=>window.study.refresh()); await page.waitForFunction(()=>window.study.items.length===5);
 assert.equal(await page.evaluate(()=>window.study.upToDate),false);
 assert.equal(await page.evaluate(()=>window.study.progressLabel),'3 of 4 available questions answered');
 pacing='presenter-paced'; items=[q(0,"cover")]; answers=[]; presenter=0;
 await page.evaluate(current=>window.serverEvent('question:open',current),q(0,"cover"));
 await page.evaluate(()=>window.study.refresh());await page.waitForFunction(()=>!window.study.selfPaced);
 assert.equal(await page.locator('nav').count(),0,'presenter-paced has no browse controls');
 assert.equal(await page.evaluate(()=>window.study.progressLabel),null,'content-only has no 0/0');

 // Presenter navigation also preserves drafts without exposing browse controls.
 items=[q(1,"open_response"),q(2)]; presenter=1;
 await page.evaluate(current=>window.serverEvent('question:open',current),q(1,"open_response"));
 await page.locator('textarea').fill('Presenter-paced draft');
 await page.evaluate(current=>window.serverEvent('question:open',current),q(2));
 await page.evaluate(current=>window.serverEvent('question:open',current),q(1,"open_response"));
 await page.waitForFunction(()=>window.study.question.questionIndex===1);
 assert.equal(await page.locator('textarea').inputValue(),'Presenter-paced draft');
 await page.reload(); await join('seat-two',false);
 assert.equal(await page.locator('textarea').inputValue(),'Presenter-paced draft');
 assert.equal(await page.evaluate(()=>window.sent.filter(e=>e.name==='answer:submit').length),0);
 // Storage failures never claim the draft was saved.
 await page.evaluate(()=>{const save=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('mdq_draft'))throw Error('synthetic storage blocked');return save.call(this,key,value)}});
 await page.locator('textarea').fill('Memory-only edit');
 await page.getByRole('status').filter({hasText:'Draft on this screen'}).waitFor();
 // Initial-policy failure remains actionable and retry reconciles.
 requestFailure=true;
 await page.evaluate(()=>window.serverEvent('student:joined',{participantId:'third',sessionToken:'seat-three',sessionState:'QUESTION_OPEN',answeredQuestions:[],answers:[],publicKey:'three',label:'Third'}));
 await page.getByRole('alert').filter({hasText:'Available items could not be refreshed'}).waitFor();
 requestFailure=false; await page.getByRole('button',{name:'Retry',exact:true}).click();
 await page.waitForFunction(()=>window.study.error===null);
 // Actual mounted instructor chooser: default, optional speed, self-paced override and Start request.
 await page.evaluate(()=>sessionStorage.clear());await page.goto(url+'/instructor');
 await page.getByRole('button',{name:'Create Session',exact:true}).click();
 await page.getByRole('radio',{name:'Presenter-paced',exact:true}).waitFor();
 assert.equal(await page.getByRole('radio',{name:'Presenter-paced',exact:true}).isChecked(),true);
 const speed=page.getByRole('checkbox',{name:'Include answer speed in ranking'});
 assert.equal(await speed.isChecked(),false); assert.equal(await speed.isEnabled(),true);
 await speed.check();await page.getByRole('radio',{name:'Self-paced',exact:true}).check();
 assert.equal(await speed.isChecked(),false);assert.equal(await speed.isDisabled(),true);
 await page.getByRole('button',{name:'Start Session',exact:true}).click();
 await page.waitForTimeout(100);
 assert.deepEqual(policyPosts.at(-1),{pacing:'self-paced',ranking:'correctness'});
 // Untimed scored questions disable speed, including after recreating the console.
 authoredTime=null;await page.evaluate(()=>sessionStorage.clear());await page.goto(url+'/instructor');
 await page.getByRole('button',{name:'Create Session',exact:true}).click();
 await page.getByRole('radio',{name:'Presenter-paced',exact:true}).waitFor();
 assert.equal(await page.getByRole('checkbox',{name:'Include answer speed in ranking'}).isDisabled(),true);
 assert.equal(errors.length,0,errors.join('\n'));
 console.log(`PASS mounted Core hook/view/socket: draft navigation/reload/seat isolation, no auto-submit, late ACK/reconnect, presenter drafts, storage errors/retry, instructor pacing/speed chooser, follow/explore, progress/release/content-only (${requestCount} requests)`);
} finally {await browser?.close(); await new Promise(resolve=>server.close(resolve));}
