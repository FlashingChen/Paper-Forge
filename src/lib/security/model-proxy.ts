import { createHash,createHmac,timingSafeEqual } from "node:crypto";
import { getJobRow } from "../db";
import { readManifest,remoteRun } from "../execution/store";
import type { RunManifest } from "../execution/protocol";
import { readLimitedJson,RequestRejected } from "./request";
function modelMac(id:string,execution:string,expires:number):string {
  const secret=process.env.PAPERFORGE_EXECUTION_SECRET;
  if(!secret||secret.length<32)throw new Error("Execution secret missing");
  return createHmac("sha256",createHash("sha256").update(secret).digest()).update(`model-v1:${id}:${execution}:${expires}`).digest("base64url");
}
export function modelToken(id:string,execution:string):string {
  const run=remoteRun(id);if(!run?.started_at)throw new Error("Not claimed");
  const expires=Math.min(run.deadline,run.started_at+run.timeout_ms);
  return `${expires}.${modelMac(id,execution,expires)}`;
}
export function authorizeModel(id:string,execution:string,header:string|null):boolean {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(id)||!/^[a-f0-9-]{36}$/.test(execution))return false;
  const run=remoteRun(id),job=getJobRow(id);
  if(!run||run.claimed_by!==execution||!run.started_at||!job||!["queued","running"].includes(job.status)||run.deadline<=Date.now())return false;
  const expected=`Bearer ${modelToken(id,execution)}`,actual=header??"";
  return Number(expected.slice(7).split('.')[0])>Date.now()&&actual.length===expected.length&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected));
}
function allowedUpstream(manifest:RunManifest):URL {
  const url=new URL(manifest.baseUrl);
  const allowed=(process.env.PAPERFORGE_MODEL_ALLOWED_ORIGINS??"").split(",");
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||!allowed.includes(url.origin))throw new RequestRejected(503,"模型代理尚未配置");
  if(manifest.declared?.api&&manifest.declared.api!=="openai-completions")throw new RequestRejected(503,"模型代理仅支持 OpenAI 兼容接口");
  return url;
}
export function executionManifest(id:string,execution:string):RunManifest {
  const original=readManifest(id);allowedUpstream(original);
  const gateway=new URL(process.env.PAPERFORGE_MODEL_GATEWAY_URL??"");
  if(gateway.protocol!=="https:"||gateway.username||gateway.password||gateway.search||gateway.hash||gateway.pathname!=="/")throw new RequestRejected(503,"独立模型代理尚未配置");
  const baseUrl=`${gateway.origin}/model/${encodeURIComponent(id)}/${encodeURIComponent(execution)}/v1`;
  // Reconstruct provider configuration; never forward upstream headers or keys.
  return {...original,baseUrl,apiKey:modelToken(id,execution),declared:{baseUrl,api:"openai-completions",models:[{
    id:original.model,input:["text","image"],contextWindow:original.capabilities.contextWindow??1000000,
    maxTokens:original.capabilities.maxTokens??32768,reasoning:original.capabilities.reasoning??false}],
    ...(original.capabilities.compat?{compat:original.capabilities.compat}:{})}};
}
export async function handleModelRequest(request:Request,id:string,execution:string):Promise<Response> {
  if(request.method!=="POST")return new Response(null,{status:405});
  if(!authorizeModel(id,execution,request.headers.get("authorization")))return new Response(null,{status:401});
  const manifest=readManifest(id),url=allowedUpstream(manifest);
  if(request.headers.get("content-type")?.split(";")[0].trim()!=="application/json")throw new RequestRejected(415,"模型请求格式无效");
  const body=await readLimitedJson(request,8*1024*1024);
  if(body.model!==manifest.model||!Array.isArray(body.messages))throw new RequestRejected(400,"模型请求不匹配");
  const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),Math.min(manifest.timeoutMs,180000));
  request.signal.addEventListener("abort",()=>abort.abort(),{once:true});
  let upstream:Response;
  try {upstream=await fetch(url.toString().replace(/\/$/,"")+"/chat/completions",{method:"POST",redirect:"error",headers:{authorization:`Bearer ${manifest.apiKey}`,"content-type":"application/json"},body:JSON.stringify(body),signal:abort.signal});}
  catch {clearTimeout(timer);return Response.json({error:{message:"模型连接失败"}},{status:502});}
  if(!upstream.ok||!upstream.body){abort.abort();clearTimeout(timer);return Response.json({error:{message:"模型服务暂时不可用"}},{status:502});}
  const reader=upstream.body.getReader();let bytes=0;
  const stream=new ReadableStream<Uint8Array>({
    async pull(controller){try {const n=await reader.read();if(n.done){clearTimeout(timer);controller.close();return;}bytes+=n.value.byteLength;if(bytes>16*1024*1024)throw new Error("Stream limit");controller.enqueue(n.value);}catch {clearTimeout(timer);abort.abort();controller.error(new Error("模型响应中断"));}},
    async cancel(){clearTimeout(timer);abort.abort();await reader.cancel().catch(()=>{});}
  });
  return new Response(stream,{headers:{"content-type":body.stream?"text/event-stream":"application/json","cache-control":"no-store","x-accel-buffering":"no"}});
}
