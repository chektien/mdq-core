/** Synthetic mounted final-result HTTP recovery and End modal, no live sessions or private data. */
import { build } from "esbuild";
import { chromium } from "playwright";
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const question={questionIndex:0,questionType:"multiple_choice",topic:"Synthetic question",text:"<p>A synthetic question</p>",options:[{label:"A",text:"One"},{label:"B",text:"Two"}],allowsMultiple:false,isPoll:false,startedAt:0,timeLimitSec:null,deadlineAt:null};
let final=true, fail=false, contentOnly=false, endPosts=0, endFail=false;
const calls=[];
const screenshotDir=process.env.MDQ_RESULTS_SCREENSHOT_DIR;
const assetDir=path.join(root,'packages/client/dist/assets');
const cssFile=(await fs.readdir(assetDir).catch(()=>[])).find(name=>name.endsWith('.css'));
const css=cssFile?await fs.readFile(path.join(assetDir,cssFile),'utf8'):'';
if(screenshotDir)await fs.mkdir(screenshotDir,{recursive:true});
const payload=()=>({schemaVersion:1,resultVersion:1,endedAt:0,deckTitle:"Synthetic finality",policy:{schemaVersion:1,pacing:"self-paced",ranking:"correctness",effectiveTiming:"untimed"},publicKey:"opaque-one",summary:contentOnly?{answeredCount:0,availableQuestionCount:0}:{answeredCount:2,availableQuestionCount:2,scoredQuestionCount:1},questions:contentOnly?[]:[{question,answer:{questionIndex:0,selectedOptions:[1]},correct:false,correctOptions:["A"],explanation:"OWN_FINAL_EXPLANATION"},{question:{...question,questionIndex:1,questionType:"open_response",topic:"Written",options:[]},answer:{questionIndex:1,selectedOptions:[],responseText:"OWN_RETAINED_RESPONSE"}}],...(contentOnly?{}:{leaderboard:[{publicKey:"opaque-one",label:"Synthetic one",rank:1,score:1},{publicKey:"opaque-two",label:"Synthetic two",rank:2,score:0}]})});
const bundle=await build({stdin:{resolveDir:root,loader:"tsx",contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import StudentView from './packages/client/src/views/StudentView';
import InstructorView from './packages/client/src/views/InstructorView';
import * as seats from './packages/client/src/participantSessionStorage';
window.seats=seats;const root=createRoot(document.getElementById('root'));
window.openSession=id=>root.render(<StudentView initialSessionId={id}/>);
root.render(location.pathname === '/instructor' ? <InstructorView/> : location.pathname === '/by-code' || location.pathname === '/second' ? <StudentView initialSessionCode={location.pathname === '/second' ? 'SYNTH2' : 'SYNTH1'}/> : <StudentView initialSessionId="synthetic"/>);
`},bundle:true,jsx:"automatic",write:false,format:"iife",platform:"browser",plugins:[{name:"fake-socket",setup(builder){builder.onResolve({filter:/^socket.io-client$/},()=>({path:"mock",namespace:"synthetic"}));builder.onLoad({filter:/.*/,namespace:"synthetic"},()=>({loader:"js",contents:`
export function io(options){const handlers={};const sock={connected:false,on(event,fn){handlers[event]=fn;return sock},emit(event,data){(window.sent??=[]).push({sessionId:options.auth.sessionId,event,data});if(event==='student:join'&&options.auth.sessionId==='second')setTimeout(()=>handlers['student:joined']?.({participantId:'synthetic-two',sessionToken:'second-seat',sessionState:'WAITING',answeredQuestions:[],answers:[],publicKey:'opaque-two',label:'Synthetic two'}),0)},connect(){if(window.socketAbsent)return;sock.connected=true;handlers.connect?.();if(options.auth.role==='student'&&options.auth.sessionId==='synthetic'&&window.rejectOnConnect)setTimeout(()=>{handlers['student:rejected']?.({reason:'Session has ended'});sock.disconnect()},0)},disconnect(){sock.connected=false;handlers.disconnect?.()}};window.serverEvent=(event,data)=>handlers[event]?.(data);window.syntheticSocket=sock;return sock}

`}))}}]});
const server=http.createServer((req,res)=>{
 const json=(status,data)=>{res.statusCode=status;res.setHeader("Content-Type","application/json");res.end(JSON.stringify(data))};
 if(req.url==="/styles.css"){res.setHeader("Content-Type","text/css");res.end(css);return}
 if(req.url==="/bundle.js"){res.setHeader("Content-Type","application/javascript");res.end(bundle.outputFiles[0].text);return}
 calls.push({url:req.url,method:req.method,authorization:req.headers.authorization});
 if(req.url==="/api/session/synthetic/own-results"){
   if(fail)return json(500,{});
   if(!final)return json(409,{error:"Results are not available yet"});
   if(req.headers.authorization!=="Bearer retained-seat")return json(410,{error:"This session has ended"});
   return json(200,payload());
 }
 if(req.url==="/api/session/by-code/SYNTH2")return json(200,{sessionId:"second",sessionCode:"SYNTH2",state:"WAITING",week:"second",title:"Synthetic second",theme:"dark",palette:"classic"});
 if(req.url==="/api/session/second/own-results")return json(409,{error:"Results are not available yet"});
 if(req.url==="/api/session/second/items")return json(200,{policy:{schemaVersion:1,pacing:"instructor",ranking:"correctness",effectiveTiming:"untimed"},state:"WAITING",currentQuestionIndex:0,items:[],answers:[],answeredQuestions:[],answerableQuestionIndexes:[]});
 if(req.url==="/api/session/by-code/SYNTH1")return json(200,{sessionId:"synthetic",sessionCode:"SYNTH1",state:final?"ENDED":"QUESTION_OPEN",week:"synthetic",title:"Synthetic finality",theme:"dark",palette:"classic"});
 if(req.url==="/api/session/synthetic/items")return json(200,{policy:{schemaVersion:1,pacing:"self-paced",ranking:"correctness",effectiveTiming:"untimed"},state:final?"ENDED":"QUESTION_OPEN",currentQuestionIndex:0,items:[question],answers:[],answeredQuestions:[],answerableQuestionIndexes:[0]});
 if(req.url==="/api/decks")return json(200,[{week:"synthetic",title:"Synthetic finality",theme:"dark",palette:"classic",questionCount:3}]);
 if(req.url==="/api/deck/synthetic/presenter-notes")return json(200,{enabled:false,defaultOpen:false,items:[]});
 if(req.url==="/api/session")return json(200,{sessionId:"synthetic",sessionCode:"SYNTH1",theme:"dark",palette:"classic",questionHeadings:["one","two","future"],questionSummaries:[{heading:"one",questionType:"multiple_choice",timeLimitSec:null},{heading:"two",questionType:"open_response",timeLimitSec:null},{heading:"future",questionType:"multiple_choice",timeLimitSec:null}]});
 if(req.url==="/api/session/synthetic/policy"||req.url==="/api/session/synthetic/start")return json(200,{});
 if(req.url==="/api/session/synthetic/end-advisory")return json(200,{unfinishedParticipantCount:2,unshownQuestionCount:1});
 if(req.url==="/api/session/synthetic/end"){setTimeout(()=>{if(endFail)return json(500,{error:'Synthetic End failed'});endPosts++;final=true;json(200,{state:"ENDED"})},200);return}
 if(req.url==="/api/session/synthetic/access-info")return json(404,{});
 res.setHeader("Content-Type","text/html");res.end(`<link rel="stylesheet" href="/styles.css"><div id="root"></div><script>window.rejectOnConnect=${final}</script><script src="/bundle.js"></script>`);
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let browser;
try{
 browser=await chromium.launch({headless:true,channel:process.env.MDQ_BROWSER_CHANNEL||"chrome",timeout:15000});
 const url=`http://127.0.0.1:${server.address().port}`;const errors=[];
 async function pageWithToken(token="retained-seat"){
   const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
   page.on("pageerror",error=>errors.push(String(error)));
   if(token)await page.addInitScript(value=>{if(!localStorage.getItem('mdquiz_session'))localStorage.setItem('mdquiz_session',JSON.stringify({sessionId:'synthetic',studentId:'synthetic-one',sessionToken:value,sessionWeek:'synthetic',sessionTheme:'dark',sessionPalette:'classic'}))},token);
   return page;
 }
 const page=await pageWithToken();await page.goto(url);
 await page.getByRole("heading",{name:"Your results for Synthetic finality"}).waitFor();
 assert.match(await page.locator("body").innerText(),/OWN_RETAINED_RESPONSE/);
 assert.match(await page.locator("body").innerText(),/OWN_FINAL_EXPLANATION/);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('mdquiz_session')).sessionToken),"retained-seat","End rejection preserves retained token");
 assert.equal(await page.locator('textarea').count(),0);
 const firstQuestion=page.getByRole('region',{name:'Synthetic question'});
 assert.match(await firstQuestion.innerText(),/Incorrect[\s\S]*Two[\s\S]*Correct answer: A[\s\S]*One/,'wrong selections still show correct option text');
 if(screenshotDir){
   for(const width of [390,768,1440]){
     await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(screenshotDir,`core-t421-results-${width}.png`),fullPage:true,animations:"disabled"});
   }
   await page.setViewportSize({width:390,height:844});
 }

 await page.getByRole('button',{name:'Done',exact:true}).click();await page.getByRole('heading',{name:'Done',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.seats.loadStoredSession('synthetic').sessionToken),'retained-seat','Done retains the original seat');
 await page.reload();await page.getByRole('heading',{name:'Your results for Synthetic finality'}).waitFor();
 await page.goto(url+'/second');await page.getByLabel('Student ID').fill('synthetic-two');
 await page.getByRole('button',{name:'Join',exact:true}).click();
 await page.waitForFunction(()=>window.seats.loadStoredSession('second')?.sessionToken==='second-seat');
 assert.deepEqual(await page.evaluate(()=>window.seats.loadStoredSession('synthetic')),{sessionId:'synthetic',studentId:'synthetic-one',sessionToken:'retained-seat',sessionWeek:'synthetic',sessionTheme:'dark',sessionPalette:'classic'},'joining S2 archives S1 including its deck appearance');
 assert.equal(await page.evaluate(()=>window.seats.loadStoredSession('unrelated')),null,'never use another session token');
 await page.goto(url+'/#/s/synthetic');await page.getByRole('heading',{name:'Your results for Synthetic finality'}).waitFor();
 assert.equal(await page.evaluate(()=>window.sent.find(item=>item.event==='student:join').data.sessionToken),'retained-seat','original S1 link rejoins its own seat');

 await page.reload();await page.getByRole("heading",{name:"Your results for Synthetic finality"}).waitFor();
 await page.goto(url+"/by-code");await page.getByRole("heading",{name:"Your results for Synthetic finality"}).waitFor();
 assert.equal(await page.evaluate(()=>window.sent.filter(item=>item.event==='answer:submit').length),0);
 const invalid=await pageWithToken("wrong");await invalid.goto(url);await invalid.getByRole("heading",{name:"This session has ended",exact:true}).waitFor();
 assert.doesNotMatch(await invalid.locator("body").innerText(),/OWN_RETAINED_RESPONSE|OWN_FINAL_EXPLANATION/);
 const none=await pageWithToken(null);await none.goto(url);await none.getByRole("heading",{name:"This session has ended",exact:true}).waitFor();assert.equal(await none.locator('input').count(),0);
 contentOnly=true;await page.reload();await page.getByRole("heading",{name:"Your participation for Synthetic finality"}).waitFor();
 assert.equal(await page.getByRole('list',{name:'Leaderboard rankings'}).count(),0);assert.doesNotMatch(await page.locator("body").innerText(),/0 of 0|1st|Correct answer/);contentOnly=false;
 fail=true;await page.reload();await page.getByRole('button',{name:'Retry results',exact:true}).waitFor();fail=false;
 await page.getByRole('button',{name:'Retry results',exact:true}).click();await page.getByRole("heading",{name:"Your results for Synthetic finality"}).waitFor();
 // A retained direct link must recover without a socket or terminal-state hint.
 for(const failure of ['http','network']){
   const offline=await pageWithToken();await offline.addInitScript(()=>{window.socketAbsent=true});
   if(failure==='http')fail=true;
   else await offline.route('**/own-results',route=>route.abort('failed'));
   await offline.goto(url+'/#/s/synthetic');await offline.getByRole('button',{name:'Retry results',exact:true}).waitFor();
   if(screenshotDir&&failure==='http')await offline.screenshot({path:path.join(screenshotDir,'core-t421-retry-phone.png'),fullPage:true,animations:"disabled"});
   assert.equal(await offline.evaluate(()=>window.syntheticSocket.connected),false);
   assert.equal(await offline.evaluate(()=>window.sent?.length??0),0);
   fail=false;if(failure==='network')await offline.unroute('**/own-results');
   await offline.getByRole('button',{name:'Retry results',exact:true}).click();await offline.getByRole('heading',{name:'Your results for Synthetic finality'}).waitFor();
 }
 // Scoped revocation leaves unrelated seats, and cannot erase a newer shared-browser replacement.
 const storage=await pageWithToken();await storage.goto(url);await storage.getByRole('heading',{name:'Your results for Synthetic finality'}).waitFor();
 await storage.evaluate(()=>{
   window.seats.saveStoredSession({sessionId:'second',studentId:'synthetic-two',sessionToken:'second-seat'});
   window.seats.clearStoredSession('second');
 });
 assert.equal(await storage.evaluate(()=>window.seats.loadStoredSession('synthetic').sessionToken),'retained-seat');
 assert.equal(await storage.evaluate(()=>window.seats.loadStoredSession('second')),null);
 await storage.evaluate(()=>{
   window.serverEvent('student:joined',{participantId:'synthetic-one',sessionToken:'retained-seat',sessionState:'ENDED',answeredQuestions:[],answers:[]});
   window.seats.saveStoredSession({sessionId:'second',studentId:'synthetic-two',sessionToken:'second-seat'});
   window.seats.saveStoredSession({sessionId:'synthetic',studentId:'synthetic-new',sessionToken:'new-seat'});
   window.serverEvent('seat:taken',{});
 });
 await storage.getByRole('heading',{name:'You joined on another device'}).waitFor();
 assert.equal(await storage.evaluate(()=>window.seats.loadStoredSession('synthetic').sessionToken),'new-seat','old screen cannot erase a new owner');
 assert.equal(await storage.evaluate(()=>window.seats.loadStoredSession('second').sessionToken),'second-seat');
 assert.doesNotMatch(await storage.locator('body').innerText(),/OWN_RETAINED_RESPONSE|OWN_FINAL_EXPLANATION/);
 const revoked=await pageWithToken();await revoked.goto(url);await revoked.getByRole('heading',{name:'Your results for Synthetic finality'}).waitFor();
 await revoked.evaluate(()=>{
   window.serverEvent('student:joined',{participantId:'synthetic-one',sessionToken:'retained-seat',sessionState:'ENDED',answeredQuestions:[],answers:[]});
   window.seats.saveStoredSession({sessionId:'second',studentId:'synthetic-two',sessionToken:'second-seat'});
   window.serverEvent('seat:taken',{});
 });
 await revoked.getByRole('heading',{name:'You joined on another device'}).waitFor();
 assert.equal(await revoked.evaluate(()=>window.seats.loadStoredSession('synthetic')),null,'takeover clears only the revoked credential');
 assert.equal(await revoked.evaluate(()=>window.seats.loadStoredSession('second').sessionToken),'second-seat');
 const missing=await pageWithToken();await missing.goto(url);await missing.getByRole('heading',{name:'Your results for Synthetic finality'}).waitFor();
 await missing.evaluate(()=>{
   window.seats.saveStoredSession({sessionId:'second',studentId:'synthetic-two',sessionToken:'second-seat'});
   window.serverEvent('student:rejected',{reason:'Session not found'});
 });
 await missing.waitForFunction(()=>window.seats.loadStoredSession('synthetic')===null);
 assert.equal(await missing.evaluate(()=>window.seats.loadStoredSession('second').sessionToken),'second-seat','not-found removal is session scoped');
 // Switch the mounted hook between sessions, not only reload the page.
 const switching=await pageWithToken();await switching.goto(url);await switching.getByRole('heading',{name:'Your results for Synthetic finality'}).waitFor();
 await switching.evaluate(()=>{
   window.seats.saveStoredSession({sessionId:'second',studentId:'synthetic-two',sessionToken:'second-seat'});
   window.openSession('second');
 });
 await switching.waitForFunction(()=>window.sent?.some(item=>item.sessionId==='second'&&item.data.sessionToken==='second-seat'));
 await switching.evaluate(()=>window.openSession('synthetic'));await switching.getByRole('heading',{name:'Your results for Synthetic finality'}).waitFor();
 assert.equal(calls.some(call=>call.url==='/api/session/synthetic/own-results'&&call.authorization==='Bearer second-seat'),false,'mounted session switch never sends S2 token to S1');
 assert.equal(calls.some(call=>call.url==='/api/session/second/own-results'&&call.authorization==='Bearer retained-seat'),false,'mounted session switch never sends S1 token to S2');
 // Miss End entirely on the socket. Only the disconnect + authoritative HTTP read recovers results.
 final=false;const live=await pageWithToken();await live.goto(url+'/active');await live.waitForFunction(()=>window.serverEvent);
 await live.evaluate(current=>{window.serverEvent('student:joined',{participantId:'synthetic-one',sessionToken:'retained-seat',sessionState:'QUESTION_OPEN',answeredQuestions:[],answers:[],publicKey:'opaque-one',label:'Synthetic one'});window.serverEvent('question:open',current)},question);
 await live.getByRole('button',{name:'Submit Answer',exact:true}).waitFor();
 assert.doesNotMatch(await live.locator('body').innerText(),/OWN_FINAL_EXPLANATION|OWN_RETAINED_RESPONSE/);
 final=true;await live.evaluate(()=>window.syntheticSocket.disconnect());await live.getByRole('heading',{name:'Your results for Synthetic finality'}).waitFor();
 // Native End modal traps focus, restores the opener, defaults Keep open and shows live hints.
 final=false;const instructor=await pageWithToken(null);await instructor.goto(url+'/instructor');
 await instructor.getByRole('button',{name:'Create Session',exact:true}).click();
 await instructor.getByRole('button',{name:'Start Session',exact:true}).click();
 await instructor.evaluate(current=>{window.serverEvent('question:open',current);window.serverEvent('session:state',{state:'QUESTION_OPEN',questionIndex:0})},question);
 const end=instructor.getByRole('button',{name:'End Session',exact:true}).first();await end.click();
 const dialog=instructor.getByRole('dialog',{name:'End session and show results?',exact:true});await dialog.waitFor();
 assert.match(await dialog.innerText(),/Answers will close and results will be available. This cannot be reopened./);
 await dialog.getByText("2 participants haven’t answered all available questions.").waitFor();
 await dialog.getByText("1 question hasn’t been shown and won’t count in results.").waitFor();
 assert.equal(await instructor.evaluate(()=>document.activeElement.textContent),"Keep session open");
 await instructor.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(endPosts,0);
 assert.equal(await instructor.evaluate(()=>document.activeElement.textContent.includes('End Session')),true);
 await end.click();await dialog.getByRole('button',{name:'Keep session open',exact:true}).click();assert.equal(endPosts,0);
 await end.click();endFail=true;await dialog.getByRole('button',{name:'End and show results',exact:true}).click();
 await dialog.getByRole('button',{name:'Ending…',exact:true}).waitFor();
 assert.equal(await dialog.getByRole('button',{name:'Keep session open',exact:true}).isDisabled(),true);
 await instructor.keyboard.press('Escape');assert.equal(await dialog.count(),1,'busy End cannot be dismissed');
 await dialog.getByRole('alert').getByText(/Synthetic End failed/).waitFor();
 assert.equal(endPosts,0,'failed End has not ended the session');
 endFail=false;await dialog.getByRole('button',{name:'End and show results',exact:true}).click();
 await instructor.waitForFunction(()=>!document.querySelector('dialog[open]'));
 assert.equal(endPosts,1);
 assert.equal(errors.length,0,errors.join('\n'));
 console.log(`PASS mounted retained results/StudentView/End dialog: reload+same-link+missed event, Done/S1→S2→S1, scoped takeover/removal/token isolation, invalid/no seat, content-only, HTTP/network retry without socket, correct-option text, private-data omission, advisory counts, Escape/focus/cancel/busy/failure/retry/commit (${calls.length} synthetic requests)`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
