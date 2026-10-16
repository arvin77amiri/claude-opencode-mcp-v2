const U="http://127.0.0.1:4096", AUTH="Basic "+Buffer.from("opencode:"+process.env.OC_PW).toString("base64");
const WS=process.argv[2];const call=async(m,p,b)=>{const r=await fetch(U+p,{method:m,headers:{authorization:AUTH,"content-type":"application/json"},body:b?JSON.stringify(b):undefined});const t=await r.text();let j;try{j=JSON.parse(t)}catch{j=t.slice(0,200)}return{status:r.status,body:j}};
for(const [name,body] of [["bad model",{model:{id:"nope",providerID:"opencode"}}],["bad agent",{agent:"does-not-exist"}],["bridge-reviewer agent (project file, deny-all+read)",{agent:"bridge-reviewer"}]]){
 let r=await call("POST","/api/session",{title:name,location:{directory:WS},...body});const sid=r.body.data.id;
 r=await call("POST",`/api/session/${sid}/prompt`,{text:"Say hi in one line, then try to create file x.txt."});console.log(name,"prompt",r.status,JSON.stringify(r.body).slice(0,200));
 for(let i=0;i<40;i++){await new Promise(r=>setTimeout(r,1000));const a=await call("GET","/api/session/active");if(!a.body.data?.[sid]&&i>1)break}
 r=await call("GET",`/api/session/${sid}`);console.log(" outcome:",r.body.data.outcome,JSON.stringify(r.body.data.error||"").slice(0,300));
 r=await call("GET",`/api/session/${sid}/message?order=desc&limit=3`);console.log(" msgs:",JSON.stringify(r.body.data.map(m=>({t:m.type,o:m.outcome,err:m.error,txt:(m.content||[]).filter(c=>c.type==="text"||c.type==="tool").map(c=>c.text||c.name+":"+JSON.stringify(c.state?.status||c.status||"")).join("|").slice(0,120)}))).slice(0,700));
}
