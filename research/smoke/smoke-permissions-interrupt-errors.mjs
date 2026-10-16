import fs from "node:fs";
const U="http://127.0.0.1:4096", AUTH="Basic "+Buffer.from("opencode:"+process.env.OC_PW).toString("base64");
const WS=process.argv[2]; const log=(...a)=>console.log(a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" "));
const call=async(m,p,b)=>{const r=await fetch(U+p,{method:m,headers:{authorization:AUTH,"content-type":"application/json"},body:b?JSON.stringify(b):undefined});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j=t.slice(0,200)}return{status:r.status,body:j}};
const ev=[];const ac=new AbortController();
(async()=>{const r=await fetch(U+"/api/event",{headers:{authorization:AUTH},signal:ac.signal});const dec=new TextDecoder();let buf="";for await(const c of r.body){buf+=dec.decode(c,{stream:true});let i;while((i=buf.indexOf("\n\n"))>=0){const b=buf.slice(0,i);buf=buf.slice(i+2);const l=b.split("\n").find(x=>x.startsWith("data:"));if(l)try{ev.push(JSON.parse(l.slice(5)))}catch{}}}})().catch(()=>{});
await new Promise(r=>setTimeout(r,400));
const wait=async(sid,ms)=>{const t0=Date.now();let seen=false;while(Date.now()-t0<ms){await new Promise(r=>setTimeout(r,1000));const a=await call("GET","/api/session/active");const run=!!a.body.data?.[sid];seen||=run;if(seen&&!run)return true}return false};
// --- A: permission ask (default permissions, read outside workspace)
let r=await call("POST","/api/session",{title:"perm",location:{directory:WS}});const sid=r.body.data.id;log("A create",r.status);
await call("POST",`/api/session/${sid}/prompt`,{text:"Read the file C:\Windows\win.ini using your read tool and tell me its first line."});
let req=null;for(let i=0;i<40&&!req;i++){await new Promise(r=>setTimeout(r,1000));const p=await call("GET",`/api/session/${sid}/permission`);if(p.body.data?.length)req=p.body.data[0];}
log("A pending permission:",req);
const evp=ev.filter(e=>/permission/.test(e.type));log("A permission events:",evp.map(e=>e.type).join(","));log("A sample event:",evp[0]);
if(req){r=await call("POST",`/api/session/${sid}/permission/${req.id}/reply`,{decision:"reject",message:"no"});log("A reply reject",r.status);}
log("A finished:",await wait(sid,60000));
r=await call("GET",`/api/session/${sid}`);log("A session outcome:",r.body.data.outcome);
r=await call("GET",`/api/session/${sid}/message?order=desc&limit=3`);log("A last msgs:",JSON.stringify(r.body.data.map(m=>({t:m.type,o:m.outcome,err:m.error}))));
log("A exec events:",ev.filter(e=>/execution|permission|error|fail/.test(e.type)&&e.data?.sessionID===sid).map(e=>e.type).join(","));
// --- B: interrupt
r=await call("POST","/api/session",{title:"intr",location:{directory:WS},permissions:[{action:"*",resource:"*",effect:"allow"}]});const s2=r.body.data.id;
await call("POST",`/api/session/${s2}/prompt`,{text:"Write a 3000 word essay about the ocean into essay.txt, in 30 separate append steps."});
await new Promise(r=>setTimeout(r,3000));r=await call("POST",`/api/session/${s2}/interrupt`);log("B interrupt",r.status,r.body);
log("B finished:",await wait(s2,30000));r=await call("GET",`/api/session/${s2}`);log("B outcome:",r.body.data.outcome);
log("B exec events:",ev.filter(e=>/execution/.test(e.type)&&e.data?.sessionID===s2).map(e=>e.type).join(","));
r=await call("POST",`/api/session/${s2}/interrupt`);log("B interrupt again",r.body);
// --- C: bad model
r=await call("POST","/api/session",{title:"bad",location:{directory:WS},model:{id:"nope",providerID:"opencode"}});log("C create bad model",r.status,JSON.stringify(r.body).slice(0,250));
r=await call("POST","/api/session",{title:"bad2",location:{directory:WS},agent:"does-not-exist"});log("C create bad agent",r.status,JSON.stringify(r.body).slice(0,250));
r=await call("POST","/api/session/ses_nonexistent/prompt",{text:"x"});log("C prompt unknown session",r.status,JSON.stringify(r.body).slice(0,250));
r=await call("POST","/api/session",{title:"relpath",location:{directory:"Z:\no\such\dir"}});log("C bad dir",r.status,JSON.stringify(r.body).slice(0,250));
ac.abort();fs.writeFileSync(process.env.OUT+"/events2.json",JSON.stringify(ev));
