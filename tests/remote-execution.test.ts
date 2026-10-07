import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { test } from "node:test";
import type { RunManifest, RunSnapshot } from "../src/lib/execution/protocol";

test("remote jobs survive control restarts, authenticate, claim once, and accept idempotent monotonic callbacks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-remote-test-"));
  process.env.PAPERFORGE_DB_PATH = path.join(root, "control.db");
  process.env.PAPERFORGE_JOBS_DIR = path.join(root, "jobs");
  process.env.PAPERFORGE_EXECUTION_SECRET = "test-only-execution-secret-32-characters";
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  const db = await import("../src/lib/db");
  const jobs = await import("../src/lib/jobs");
  const store = await import("../src/lib/execution/store");
  const { parseSnapshot } = await import("../src/lib/execution/protocol");
  db.initDb();
  const manifest: RunManifest = { version: 1, jobId: "remote-test", provider: "example", model: "vision-model",
    baseUrl: "https://example.invalid/v1", apiKey: "private-model-key", timeoutMs: 3000,
    capabilities: { vision: true, contextWindow: 32000, maxTokens: 1000 }, imageEnv: {},
    images: [{ index: 0, filename: "photo.png" }], price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 3 } };
  let server: http.Server | undefined;
  try {
    jobs.createJob({ id: manifest.jobId, imageCount: 1 });
    jobs.createJob({ id: "legacy-local" });
    store.enqueueRun(manifest, [Buffer.from([0x89, 0x50, 0x4e, 0x47])]);
    assert(!store.remoteRun(manifest.jobId)!.payload.includes(manifest.apiKey!));
    assert.deepEqual(store.readManifest(manifest.jobId), manifest);
    db.migrate();
    assert.equal(jobs.getJob(manifest.jobId)?.status, "queued");
    assert.equal(jobs.getJob("legacy-local")?.status, "error");
    assert.equal(store.authorizeRun(manifest.jobId, "Bearer wrong"), false);
    assert.equal(store.authorizeRun("other", `Bearer ${store.runToken(manifest.jobId)}`), false);
    assert(store.authorizeRun(manifest.jobId, `Bearer ${store.runToken(manifest.jobId)}`));
    assert.equal(store.claimRun(manifest.jobId, "execution-a"), "claimed");
    assert.equal(store.claimRun(manifest.jobId, "execution-b"), "conflict");
    const running: RunSnapshot = { execution: "execution-a", sequence: 2, status: "running", logs: [], usage: [] };
    assert.equal(store.acceptSnapshot(manifest.jobId, running), "accepted");
    db.migrate();
    assert.equal(jobs.getJob(manifest.jobId)?.status, "running");
    assert.equal(store.acceptSnapshot(manifest.jobId, { ...running, sequence: 1, status: "error" }), "duplicate");
    assert.equal(store.acceptSnapshot(manifest.jobId, { ...running, execution: "execution-b" }), "conflict");
    assert.throws(() => store.acceptSnapshot(manifest.jobId, { ...running, sequence: 3, status: "done" }));
    assert.equal(jobs.getJob(manifest.jobId)?.status, "running");
    const finished: RunSnapshot = { ...running, sequence: 3, status: "done", usage: [{ sequence: 1, created_at: 1,
      provider: "example", model: "vision-model", input_tokens: 5, output_tokens: 2, cache_read_tokens: 0,
      cache_write_tokens: 0, total_tokens: 7, cost_usd: 0.00003, cost_source: "configured", price_json: null }] };
    assert.equal(store.acceptSnapshot(manifest.jobId, finished, Buffer.from("PKtest-result")), "accepted");
    assert.equal(store.acceptSnapshot(manifest.jobId, finished), "duplicate");
    assert.equal(store.acceptSnapshot(manifest.jobId, { ...running, sequence: 4 }), "duplicate");
    assert.equal(jobs.getJob(manifest.jobId)?.status, "done");
    assert.equal(db.rawDb().prepare("SELECT COUNT(*) AS n FROM model_usage").get()?.n, 1);
    assert.equal(fs.readFileSync(jobs.resolveResultFile(jobs.getJob(manifest.jobId)!)!.path).toString(), "PKtest-result");
    assert.throws(() => parseSnapshot({ ...running, usage: [{ sequence: -1 }] }));

    // Exercise the actual bundled wrapper + unchanged runner through a fake pi RPC process.
    const workerId = "worker-integration";
    jobs.createJob({ id: workerId, imageCount: 1 });
    store.enqueueRun({ ...manifest, jobId: workerId }, [Buffer.from([0x89, 0x50, 0x4e, 0x47])]);
    const fakePi = path.join(root, "fake-pi");
    fs.writeFileSync(fakePi, `#!/usr/bin/env node
const fs = require('fs');
let text = '';
process.stdin.on('data', chunk => {
  text += chunk;
  if (!text.includes('\\n')) return;
  if (process.env.PAPERFORGE_RUN_TOKEN || process.env.PAPERFORGE_EXECUTION_SECRET) process.exit(9);
  fs.mkdirSync('out', {recursive:true}); fs.writeFileSync('out/result.docx', 'PKfake-document');
  console.log(JSON.stringify({type:'message_end', message:{role:'assistant', content:[{type:'text', text:'complete'}], usage:{input:5, output:2, totalTokens:7}}}));
  console.log(JSON.stringify({type:'agent_settled'}));
  process.exit(0);
});
`, { mode: 0o755 });
    server = http.createServer(async (req, res) => {
      try {
        if (!store.authorizeRun(workerId, req.headers.authorization ?? null)) { res.writeHead(401).end(); return; }
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        if (req.url?.endsWith("/claim")) {
          const claim = store.claimRun(workerId, JSON.parse(body.toString()).execution);
          res.writeHead(claim === "claimed" ? 200 : 409, { "content-type": "application/json" });
          res.end(JSON.stringify(store.readManifest(workerId)));
        } else if (req.url?.endsWith("/inputs/0")) {
          res.writeHead(200).end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        } else {
          const request = new Request("http://localhost", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body });
          const form = await request.formData();
          const snapshot = parseSnapshot(JSON.parse(form.get("snapshot") as string));
          const file = form.get("result");
          const result = file instanceof File ? Buffer.from(await file.arrayBuffer()) : undefined;
          const status = store.acceptSnapshot(workerId, snapshot, result);
          res.writeHead(status === "conflict" ? 409 : 200).end();
        }
      } catch { res.writeHead(500).end(); }
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PAPERFORGE_JOB_ID: workerId, PAPERFORGE_RUN_TOKEN: store.runToken(workerId),
      PAPERFORGE_CONTROL_URL: `http://127.0.0.1:${address.port}`, PAPERFORGE_ALLOW_LOCAL_CONTROL: "1", PAPERFORGE_PI_BIN: fakePi,
      HOME: path.join(root, "worker-home") };
    delete childEnv.PAPERFORGE_EXECUTION_SECRET;
    const child = spawn(process.execPath, [".execution/worker.cjs"], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const kill = setTimeout(() => child.kill("SIGKILL"), 20000);
    const code = await new Promise<number | null>(resolve => child.on("close", resolve));
    clearTimeout(kill);
    assert.equal(code, 0, output);
    assert.equal(jobs.getJob(workerId)?.status, "done", JSON.stringify(jobs.getJob(workerId)));
    assert(jobs.getJob(workerId)!.logs.length > 0);
    assert.equal(db.rawDb().prepare("SELECT COUNT(*) AS n FROM model_usage WHERE job_id = ?").get(workerId)?.n, 1);
    assert.equal(fs.readFileSync(jobs.resolveResultFile(jobs.getJob(workerId)!)!.path).toString(), "PKfake-document");
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    db.rawDb().close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
