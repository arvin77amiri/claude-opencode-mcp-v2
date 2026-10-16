import fs from "node:fs";import os from "node:os";import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const { BridgeConfigSchema } = await import("file:///D:/Archivos/Javier/Proyectos/bridge-claude-opencode/v2/dist/config/config.js");
const { createMcpServer } = await import("file:///D:/Archivos/Javier/Proyectos/bridge-claude-opencode/v2/dist/mcp/server.js");
const { OpenCodeManager } = await import("file:///D:/Archivos/Javier/Proyectos/bridge-claude-opencode/v2/dist/opencode/manager.js");
const { SessionRegistry } = await import("file:///D:/Archivos/Javier/Proyectos/bridge-claude-opencode/v2/dist/opencode/sessions.js");
const { createLogger } = await import("file:///D:/Archivos/Javier/Proyectos/bridge-claude-opencode/v2/dist/util/logger.js");
const WS=process.argv[2]; const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),"co-e2e-"));
const config=BridgeConfigSchema.parse({defaults:{agent:process.env.AG??"deepseek-researcher",provider:"opencode",model:"opencode/ll-alpha-free"},timeouts:{execution:300000}});
const logger=createLogger({level:process.env.LOG??"warn"});const manager=new OpenCodeManager({logger});
const registry=new SessionRegistry(path.join(stateDir,"s.json"),logger);
const server=createMcpServer({logger,manager,registry,globalConfig:config,env:process.env,stateDir,loadProjectConfig:async()=>({config,sources:[]})});
const [ct,st]=InMemoryTransport.createLinkedPair();const client=new Client({name:"e",version:"0"});await Promise.all([server.connect(st),client.connect(ct)]);
const call=async(name,args)=>{const r=await client.callTool({name,arguments:args},undefined,{timeout:330000});console.log("==",name,r.isError?"ERROR":"ok");console.log(r.content?.[0]?.text?.slice(0,1500));try{return JSON.parse(r.content[0].text)}catch{return {}}};
try{
 await call("list_agents",{cwd:WS});
 const d=await call("delegate_task",{cwd:WS,agent:process.env.AG??"deepseek-researcher",task:"Reply with exactly: hi"});
 if(d.session_id){const rec=manager.record;const A="Basic "+Buffer.from(rec.auth.username+":"+rec.auth.password).toString("base64");const m=(await (await fetch(rec.baseUrl+"/api/session/"+d.session_id+"/message?order=asc&limit=5",{headers:{authorization:A}})).json()).data;console.log("AGENTS_USED",m.filter(x=>x.type==="assistant").map(x=>x.agent),"types:",m.map(x=>x.type).join(","),"preamble:",m.some(x=>x.type==="user"&&(x.text||"").includes("research agent")));} if(false) await call("get_diff",{cwd:WS,session_id:d.session_id??d.sessionId});
}finally{await manager.stopAll();}
