import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { taskContainer, type NodeConfig } from "../scripts/execution/node-manager";
import { publicJob, publicLogs } from "../src/lib/security/public-job";
const securityRoot = fs.mkdtempSync(path.join(os.tmpdir(),"pf-security-"));
process.env.PAPERFORGE_DB_PATH=path.join(securityRoot,"db");
process.env.PAPERFORGE_JOBS_DIR=path.join(securityRoot,"jobs");

test("public logs and historical snapshots never expose provider, endpoint, tool output, notes, paths or errors", () => {
  const logs = ["Starting pi (provider private-provider, model private-model)", "Endpoint https://private.invalid/v1", "tool: secret=private-key", "Result ready: private.docx (20 bytes)"].map(text=>({text,level:"info" as const,ts:1}));
  assert.deepEqual(publicLogs(logs).map(x=>x.text),["开始处理","文档已生成"]);
  const value = JSON.stringify(publicJob({ id:"abcdefgh-test",createdAt:1,status:"error",imageCount:1,logs,resultPath:"/private",error:"private-key",note:"private-provider" }));
  assert(!value.includes("private")); assert(value.includes("abcdefgh"));
});
test("streamed request body is bounded without a content-length header", async () => {
  const { readLimitedBody } = await import("../src/lib/security/request");
  const request = new Request("https://control.invalid",{method:"POST",body:new ReadableStream({start(c){c.enqueue(new Uint8Array(20));c.enqueue(new Uint8Array(20));c.close();}}),...({duplex:"half"} as any)});
  await assert.rejects(readLimitedBody(request,32),e=>(e as any).status===413);
});
test("Agent manifest contains only a task-scoped model capability, never the real key or provider headers", async () => {
  process.env.PAPERFORGE_EXECUTION_SECRET="test-only-"+"s".repeat(40);process.env.SESSION_SECRET="test-only-"+"s".repeat(40);
  process.env.PAPERFORGE_MODEL_GATEWAY_URL="https://gateway.invalid";process.env.PAPERFORGE_MODEL_ALLOWED_ORIGINS="https://upstream.invalid";
  delete process.env.ADMIN_USERNAME;delete process.env.ADMIN_PASSWORD;
  const db=await import("../src/lib/db"),jobs=await import("../src/lib/jobs"),store=await import("../src/lib/execution/store"),proxy=await import("../src/lib/security/model-proxy");
  db.initDb();const id="security-task",execution="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  jobs.createJob({id});store.enqueueRun({version:1,jobId:id,provider:"example",model:"vision",baseUrl:"https://upstream.invalid/v1",apiKey:"never-forward-private-key",timeoutMs:60000,capabilities:{vision:true},imageEnv:{},images:[],price:null,
    declared:{baseUrl:"https://upstream.invalid/v1",api:"openai-completions",headers:{"x-secret":"never-forward-private-key"},models:[]}},[]);store.claimRun(id,execution);
  const manifest=proxy.executionManifest(id,execution);
  assert(!JSON.stringify(manifest).includes("never-forward-private-key"));assert(!manifest.baseUrl.includes("upstream"));
  assert(proxy.authorizeModel(id,execution,`Bearer ${manifest.apiKey}`));assert(!store.authorizeRun(id,`Bearer ${manifest.apiKey}`));assert(!proxy.authorizeModel(id,execution,`Bearer ${store.runToken(id)}`));
  const originalFetch=globalThis.fetch;let upstreamCalls=0;
  try {
    globalThis.fetch=async (url,options)=>{upstreamCalls++;assert.equal(String(url),"https://upstream.invalid/v1/chat/completions");assert.equal((options!.headers as Record<string,string>).authorization,"Bearer never-forward-private-key");assert.equal(options!.redirect,"error");return new Response('{"choices":[]}',{headers:{"x-internal-key":"never-forward-private-key"}});};
    const request=new Request("https://gateway.invalid",{method:"POST",headers:{authorization:`Bearer ${manifest.apiKey}`,"content-type":"application/json"},body:JSON.stringify({model:"vision",messages:[{role:"user",content:"test"}]})});
    const response=await proxy.handleModelRequest(request,id,execution);assert.equal(response.status,200);assert(!response.headers.has("x-internal-key"));assert.equal(await response.text(),'{"choices":[]}');assert.equal(upstreamCalls,1);
    const unauth=new Request("https://gateway.invalid",{method:"POST",headers:{authorization:"Bearer wrong"}});assert.equal((await proxy.handleModelRequest(unauth,id,execution)).status,401);assert.equal(upstreamCalls,1);
    globalThis.fetch=async()=>new Response("upstream-private-detail",{status:401});
    const failure=await proxy.handleModelRequest(new Request("https://gateway.invalid",{method:"POST",headers:{authorization:`Bearer ${manifest.apiKey}`,"content-type":"application/json"},body:JSON.stringify({model:"vision",messages:[]})}),id,execution);
    assert.equal(failure.status,502);assert(!(await failure.text()).includes("upstream-private-detail"));
  } finally {globalThis.fetch=originalFetch;}
  jobs.updateJob(id,{status:"done"});assert(!proxy.authorizeModel(id,execution,`Bearer ${manifest.apiKey}`));
});
test("untrusted task writes are bounded tmpfs; only the root wrapper can write persistent delivery data", () => {
  const c:NodeConfig={id:"test",token:"private-node-token",origin:"https://control.invalid",image:"agent:fixed",volume:"paperforge-beta-test",network:"bridge",memory:2048*1024**2,cpus:1,concurrency:1,stateDir:"/state"};
  const a={jobId:"job",execution:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",token:"task-token",claimed:false,deadline:Date.now()+60000};
  const p=taskContainer(c,a);assert.equal(p.User,"0:0");assert(p.HostConfig.ReadonlyRootfs);assert(p.HostConfig.Tmpfs['/work'].includes('size=256m'));assert(p.HostConfig.Tmpfs['/tmp'].includes('size=64m'));assert(p.HostConfig.Tmpfs['/home/paperforge'].includes('size=16m'));
  assert(!JSON.stringify(p).includes('/var/run/docker.sock'));assert.deepEqual(p.HostConfig.Binds,[`paperforge-beta-test-task-${a.execution}:/persist`]);
  assert(!JSON.stringify(p.Env).includes(c.token));
});
