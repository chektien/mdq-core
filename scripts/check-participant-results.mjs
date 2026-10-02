/** Synthetic mounted final-result HTTP recovery and End modal, no live sessions or private data. */
import { build } from "esbuild";
import { chromium } from "playwright";
import http from "node:http";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const question={questionIndex:0,questionType:"multiple_choice",topic:"Synthetic question",text:"<p>A synthetic question</p>",options:[{label:"A",text:"One"},{label:"B",text:"Two"}],allowsMultiple:false,isPoll:false,startedAt:0,timeLimitSec:null,deadlineAt:null};
let final=true, fail=false, contentOnly=false, endPosts=0;
const calls=[];
const payload=()=>({schemaVersion:1,resultVersion:1,endedAt:0,deckTitle:"Synthetic finality",policy:{schemaVersion:1,pacing:"self-paced",ranking:"correctness",effectiveTiming:"untimed"},publicKey:"opaque-one",summary:contentOnly?{answeredCount:0,availableQuestionCount:0}:{answeredCount:2,availableQuestionCount:2,scoredQuestionCount:1},questions:contentOnly?[]:[{question,answer:{questionIndex:0,selectedOptions:[0]},correct:true,correctOptions:["A"],explanation:"OWN_FINAL_EXPLANATION"},{question:{...question,questionIndex:1,questionType:"open_response",topic:"Written",options:[]},answer:{questionIndex:1,selectedOptions:[],responseText:"OWN_RETAINED_RESPONSE"}}],...(contentOnly?{}:{leaderboard:[{publicKey:"opaque-one",label:"Synthetic one",rank:1,score:1},{publicKey:"opaque-two",label:"Synthetic two",rank:2,score:0}]})});
const bundle=await build({stdin:{resolveDir:root,loader:"tsx",contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import StudentView from './packages/client/src/views/StudentView';
import InstructorView from './packages/client/src/views/InstructorView';
createRoot(document.getElementById('root')).render(location.pathname === '/instructor' ? <InstructorView/> : location.pathname === '/by-code' ? <StudentView initialSessionCode="SYNTH1"/> : <StudentView initialSessionId="synthetic"/>);
`},bundle:true,jsx:"automatic",write:false,format:"iife",platform:"browser",plugins:[{name:"fake-socket",setup(builder){builder.onResolve({filter:/^socket.io-client$/},()=>({path:"mock",namespace:"synthetic"}));builder.onLoad({filter:/.*/,namespace:"synthetic"},()=>({loader:"js",contents:`
export function io(options){const handlers={};const sock={connected:false,on(event,fn){handlers[event]=fn;return sock},emit(event,data){(window.sent??=[]).push({event,data})},connect(){sock.connected=true;handlers.connect?.();if(options.auth.role==='student'&&window.rejectOnConnect)setTimeout(()=>{handlers['student:rejected']?.({reason:'Session has ended'});sock.disconnect()},0)},disconnect(){sock.connected=false;handlers.disconnect?.()}};window.serverEvent=(event,data)=>handlers[event]?.(data);window.syntheticSocket=sock;return sock}
`}))}}]});
const server=http.createServer((req,res)=>{
 const json=(status,data)=>{res.statusCode=status;res.setHeader("Content-Type","application/json");res.end(JSON.stringify(data))};
 if(req.url==="/bundle.js"){res.setHeader("Content-Type","application/javascript");res.end(bundle.outputFiles[0].text);return}
 calls.push({url:req.url,method:req.method,authorization:req.headers.authorization});
 if(req.url==="/api/session/synthetic/own-results"){
   if(fail)return json(500,{});
   if(!final)return json(409,{error:"Results are not available yet"});
   if(req.headers.authorization!=="Bearer retained-seat")return json(410,{error:"This session has ended"});
   return json(200,payload());
 }
 if(req.url==="/api/session/by-code/SYNTH1")return json(200,{sessionId:"synthetic",sessionCode:"SYNTH1",state:final?"ENDED":"QUESTION_OPEN",week:"synthetic",title:"Synthetic finality",theme:"dark",palette:"classic"});
 if(req.url==="/api/session/synthetic/items")return json(200,{policy:{schemaVersion:1,pacing:"self-paced",ranking:"correctness",effectiveTiming:"untimed"},state:final?"ENDED":"QUESTION_OPEN",currentQuestionIndex:0,items:[question],answers:[],answeredQuestions:[],answerableQuestionIndexes:[0]});
 if(req.url==="/api/decks")return json(200,[{week:"synthetic",title:"Synthetic finality",theme:"dark",palette:"classic",questionCount:3}]);
 if(req.url==="/api/deck/synthetic/presenter-notes")return json(200,{enabled:false,defaultOpen:false,items:[]});
 if(req.url==="/api/session")return json(200,{sessionId:"synthetic",sessionCode:"SYNTH1",theme:"dark",palette:"classic",questionHeadings:["one","two","future"],questionSummaries:[{heading:"one",questionType:"multiple_choice",timeLimitSec:null},{heading:"two",questionType:"open_response",timeLimitSec:null},{heading:"future",questionType:"multiple_choice",timeLimitSec:null}]});
 if(req.url==="/api/session/synthetic/policy"||req.url==="/api/session/synthetic/start")return json(200,{});
 if(req.url==="/api/session/synthetic/end-advisory")return json(200,{unfinishedParticipantCount:2,unshownQuestionCount:1});
 if(req.url==="/api/session/synthetic/end"){endPosts++;final=true;return json(200,{state:"ENDED"})}
 if(req.url==="/api/session/synthetic/access-info")return json(404,{});
 res.setHeader("Content-Type","text/html");res.end(`<div id="root"></div><script>window.rejectOnConnect=${final}</script><script src="/bundle.js"></script>`);
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let browser;
try{
 browser=await chromium.launch({headless:true,channel:process.env.MDQ_BROWSER_CHANNEL||"chrome",timeout:15000});
 const url=`http://127.0.0.1:${server.address().port}`;const errors=[];
 async function pageWithToken(token="retained-seat"){
   const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
   page.on("pageerror",error=>errors.push(String(error)));
   if(token)await page.addInitScript(value=>{if(!localStorage.getItem('mdquiz_session'))localStorage.setItem('mdquiz_session',JSON.stringify({sessionId:'synthetic',studentId:'synthetic-one',sessionToken:value}))},token);
   return page;
 }
 const page=await pageWithToken();await page.goto(url);
 await page.getByRole("heading",{name:"Your results for Synthetic finality"}).waitFor();
 assert.match(await page.locator("body").innerText(),/OWN_RETAINED_RESPONSE/);
 assert.match(await page.locator("body").innerText(),/OWN_FINAL_EXPLANATION/);
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('mdquiz_session')).sessionToken),"retained-seat","End rejection preserves retained token");
 assert.equal(await page.locator('textarea').count(),0);
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
 await end.click();await dialog.getByRole('button',{name:'End and show results',exact:true}).click();
 await instructor.waitForFunction(()=>!document.querySelector('dialog[open]'));
 assert.equal(endPosts,1);
 assert.equal(errors.length,0,errors.join('\n'));
 console.log(`PASS mounted retained results/StudentView/End dialog: reload+same-link+missed event, storage preservation, invalid/no seat, content-only, retry, private-data omission, advisory counts, Escape/focus/cancel/commit (${calls.length} synthetic requests)`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
