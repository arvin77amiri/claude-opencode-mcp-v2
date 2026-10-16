import {spawn} from "node:child_process";
const env={...process.env,OPENCODE_SERVER_PASSWORD:"pw",OPENCODE_CONFIG_CONTENT:JSON.stringify({agents:{"cold-agent":{description:"d",mode:"subagent",system:"s"}}})};
const c=spawn("opencode serve --hostname=127.0.0.1 --port=47320",{shell:true,cwd:process.argv[2],env,stdio:["ignore","pipe","pipe"]});
const A="Basic "+Buffer.from("opencode:pw").toString("base64");const t0=Date.now();
let up=false;c.stdout.on("data",d=>{if(!up&&/listening/.test(d)){up=true;go()}});
async function go(){for(let i=0;i<12;i++){const r=await fetch("http://127.0.0.1:47320/api/agent/cold-agent",{headers:{authorization:A}}).catch(e=>({status:"ERR "+e.message,text:async()=>""}));console.log(((Date.now()-t0)/1000).toFixed(1)+"s agent-by-id",r.status);if(r.status===200)break;await new Promise(r=>setTimeout(r,500))}
 const l=await (await fetch("http://127.0.0.1:47320/api/agent",{headers:{authorization:A}})).json();console.log("list has cold-agent:",l.data.some(a=>a.id==="cold-agent"),l.data.length);
 spawn("taskkill",["/PID",String(c.pid),"/T","/F"]);setTimeout(()=>process.exit(0),1500)}
