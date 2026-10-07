import http from "node:http";
import fs from "node:fs";
import { Readable } from "node:stream";
import { errorResponse } from "../../src/lib/security/request";
let ready = false;
let handler: typeof import("../../src/lib/security/model-proxy").handleModelRequest;
async function initialize() {
  try {
    const file = process.env.PAPERFORGE_DB_PATH ?? "/data/paperforge.db";
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error("CONTROL_DB_MISSING");
    const db = await import("../../src/lib/db"); db.initDb();
    const users = db.rawDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
    if (!users.n) throw new Error("CONTROL_DB_NOT_READY");
    handler = (await import("../../src/lib/security/model-proxy")).handleModelRequest;
    ready = true;
    console.info("Model gateway ready");
  } catch (e) {
    const error = e as { code?: string; message?: string };
    const msg = error.message ?? "";
    const code = msg.startsWith("CONTROL_DB_") ? msg : /readonly/i.test(msg) ? "CONTROL_DB_READONLY" : /unable to open/i.test(msg) ? "CONTROL_DB_OPEN" : error.code ?? "CONTROL_DB_INIT";
    console.error("Model gateway unavailable:", code);
  }
}
const server = http.createServer(async (req, res) => {
  if (req.url === "/health" && req.method === "GET") { res.writeHead(ready ? 200 : 503).end(ready ? "healthy" : "unavailable"); return; }
  if (!ready) { res.writeHead(503).end(); req.resume(); return; }
  const match = /^\/model\/([A-Za-z0-9_-]{1,128})\/([A-Za-z0-9._-]{1,256})\/v1\/chat\/completions$/.exec(req.url ?? "");
  if (!match) { res.writeHead(404).end(); req.resume(); return; }
  const abort = new AbortController(); res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  const headers = new Headers();
  for (const key of ["authorization", "content-type", "content-length"]) if (typeof req.headers[key] === "string") headers.set(key, req.headers[key]!);
  const request = new Request("http://localhost" + req.url, { method: req.method, headers,
    body: req.method === "POST" ? Readable.toWeb(req) as ReadableStream<Uint8Array> : undefined, signal: abort.signal,
    ...({ duplex: "half" } as object) });
  let response: Response;
  try { response = await handler(request, match[1], match[2]); }
  catch (error) { response = errorResponse(error); }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) { res.end(); req.resume(); return; }
  try {
    for await (const data of response.body as unknown as AsyncIterable<Uint8Array>) {
      if (res.destroyed) break;
      if (!res.write(data)) await new Promise<void>(resolve => { res.once("drain", resolve); res.once("close", resolve); });
    }
    res.end();
  } catch { res.destroy(); }
});
server.maxConnections = 64; server.headersTimeout = 10_000; server.requestTimeout = 15_000;
server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () => { void initialize(); });
