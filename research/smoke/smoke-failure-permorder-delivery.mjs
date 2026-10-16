import fs from "node:fs";
const U="http://127.0.0.1:4096", AUTH="Basic "+Buffer.from("opencode:"+process.env.OC_PW).toString("base64");
const WS=process.argv[2]; const log=(...a)=>console.log(a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" "));
const call=async(m,p,b)=>{const r=await fetch(U+p,{method:m,headers:{authorization:AUTH,"content-type":"application/json"},body:b?JSON.stringify(b):undefined});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j=t.slice(0,200)}return{status:r.status,body:j}};
const ev=[];const ac=new AbortController();
(async()=>{const r=await fetch(U+"/api/event",{headers:{authorization:AUTH},signal:ac.signal});const dec=new TextDecoder();let buf="";for await(const c of r.body){buf+=dec.decode(c,{stream:true});let i;while((i=buf.indexOf("\n\n"))>=0){const b=buf.slice(0,i);buf=buf.slice(i+2);const l=b.split("\n").find(x=>x.startsWith("data:"));if(l)try{ev.push(JSON.parse(l.slice(5)))}catch{}}}})().catch(()=>{});
await new Promise(r=>setTimeout(r,400));
const done=async(sid,ms=90000)=>{const t0=Date.now();while(Date.now()-t0<ms){await new Promise(r=>setTimeout(r,1000));const s=(await call("GET",`/api/session/${sid}`)).body.data;if(s.outcome)return s.outcome;}return "timeout"};
const mk=async(body)=>(await call("POST","/api/session",{location:{directory:WS},...body})).body.data.id;
const prompt=(sid,text,extra={})=>call("POST",`/api/session/${sid}/prompt`,{text,...extra});
// 1 failure event
let sid=await mk({title:"fail",model:{id:"nope",providerID:"opencode"}});await prompt(sid,"hi");log("F outcome",await done(sid));
log("F events:",ev.filter(e=>e.data?.sessionID===sid).map(e=>e.type+(e.data.error?":"+JSON.stringify(e.data.error).slice(0,300):"")));
const fe=ev.find(e=>e.data?.sessionID===sid&&/fail/.test(e.type));log("F failed event full:",fe);
log("F idle msg:",(await call("GET",`/api/session/${sid}/message?order=desc&limit=1`)).body.data[0]);
// 2 permission order
for(const [name,perms] of [["allow-all then deny-write",[{action:"*",resource:"*",effect:"allow"},{action:"edit",resource:"*",effect:"deny"},{action:"write",resource:"*",effect:"deny"}]],["deny-write then allow-all",[{action:"edit",resource:"*",effect:"deny"},{action:"write",resource:"*",effect:"deny"},{action:"*",resource:"*",effect:"allow"}]]]){
 const f=name.startsWith("allow")?"t1.txt":"t2.txt";const s=await mk({title:name,permissions:perms});await prompt(s,`Create the file ${f} with content ok using your file tool, then reply DONE.`);
 log("P",name,"outcome",await done(s),"file created:",fs.existsSync(WS+"/"+f));
 log("  tools:",ev.filter(e=>e.data?.sessionID===s&&/session\.tool\.(called|success|failed)/.test(e.type)).map(e=>e.type.split(".").pop()+":"+(e.data.input?JSON.stringify(e.data.input).slice(0,40):JSON.stringify(e.data.error||e.data.content||"").slice(0,100))));
}
// 3 steer vs queue
sid=await mk({title:"delivery",permissions:[{action:"*",resource:"*",effect:"allow"}]});
await prompt(sid,"Count slowly: write the numbers 1 to 15 each into a separate append to nums.txt using separate tool calls, then say FIRST-DONE.");
await new Promise(r=>setTimeout(r,2500));
let r=await prompt(sid,"After you finish, also say SECOND-QUEUED.",{delivery:"queue"});log("Q queue prompt",r.status,JSON.stringify(r.body).slice(0,200));
r=await call("GET",`/api/session/${sid}/inbox`);log("Q inbox",JSON.stringify(r.body).slice(0,400));
log("Q outcome",await done(sid,120000));await new Promise(r=>setTimeout(r,3000));
log("Q inbox events:",ev.filter(e=>e.data?.sessionID===sid&&/inbox|execution/.test(e.type)).map(e=>e.type+(e.data.inboxID?"@"+e.data.inboxID.slice(-4):"")));
const m=(await call("GET",`/api/session/${sid}/message?order=asc&limit=50`)).body.data;log("Q msgs:",m.map(x=>x.type+(x.outcome?":"+x.outcome:"")).join(","));
log("Q final texts:",m.filter(x=>x.type==="assistant").map(x=>(x.content||[]).filter(c=>c.type==="text").map(c=>c.text).join("").slice(0,80)));
ac.abort();fs.writeFileSync(process.env.OUT+"/events4.json",JSON.stringify(ev));
