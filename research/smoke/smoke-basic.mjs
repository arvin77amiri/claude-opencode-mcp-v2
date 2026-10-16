import fs from "node:fs";
const U="http://127.0.0.1:4096", AUTH="Basic "+Buffer.from("opencode:"+process.env.OC_PW /* contraseña de `opencode serve` */).toString("base64");
const WS=process.argv[2]; const out=[]; const log=(...a)=>{const l=a.map(x=>typeof x==="string"?x:JSON.stringify(x)).join(" ");console.log(l);};
const call=async(m,p,b)=>{const r=await fetch(U+p,{method:m,headers:{authorization:AUTH,"content-type":"application/json"},body:b?JSON.stringify(b):undefined});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j=t.slice(0,200)}return{status:r.status,body:j}};
// SSE
const events=[]; const ac=new AbortController();
(async()=>{const r=await fetch(U+"/api/event",{headers:{authorization:AUTH},signal:ac.signal});log("SSE status",r.status,r.headers.get("content-type"));
 const dec=new TextDecoder();let buf="";for await(const c of r.body){buf+=dec.decode(c,{stream:true});let i;while((i=buf.indexOf("\n\n"))>=0){events.push(buf.slice(0,i));buf=buf.slice(i+2)}}})().catch(e=>{if(e.name!=="AbortError")log("SSE err",e.message)});
await new Promise(r=>setTimeout(r,500));
let r=await call("POST","/api/session",{title:"smoke",location:{directory:WS},permissions:[{action:"*",resource:"*",effect:"allow"}]});
log("create",r.status,r.body); const sid=r.body.data?.id; if(!sid) process.exit(1);
r=await call("POST",`/api/session/${sid}/prompt`,{text:"Create a file named hello.txt containing exactly the word 'pong' in the current directory, then reply with DONE."});
log("prompt",r.status,r.body);
const t0=Date.now(); let seenRunning=false;
while(Date.now()-t0<180000){await new Promise(r=>setTimeout(r,1500));const a=await call("GET","/api/session/active");const running=!!a.body.data?.[sid];seenRunning||=running;log("active",a.status,running,Math.round((Date.now()-t0)/1000)+"s");if(seenRunning&&!running)break;}
r=await call("GET",`/api/session/${sid}/message?limit=20&order=asc`);
fs.writeFileSync(process.env.OUT+"/messages.json",JSON.stringify(r.body,null,1));log("messages",r.status);
r=await call("GET",`/api/session/${sid}/diff`);log("diff",r.status,JSON.stringify(r.body).slice(0,600));
r=await call("GET",`/api/session/${sid}`);log("session",r.status,JSON.stringify(r.body).slice(0,500));
ac.abort(); fs.writeFileSync(process.env.OUT+"/events.txt",events.join("\n\n"));log("events captured",events.length);
log("hello.txt exists:",fs.existsSync(WS+"/hello.txt")&&fs.readFileSync(WS+"/hello.txt","utf8"));
