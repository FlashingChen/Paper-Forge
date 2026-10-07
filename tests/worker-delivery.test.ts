import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { test } from "node:test";

test("a restarted worker replays its persisted final result without claiming, downloading, or invoking pi", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-delivery-test-"));
  const execution = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const resultPath = path.join(root, "result.docx");
  fs.writeFileSync(resultPath, "PKdurable-document");
  fs.writeFileSync(path.join(root, "final.json"), JSON.stringify({ snapshot: {
    execution, sequence: 9, status: "done", logs: [], usage: [] }, resultPath }));
  let deliveries = 0;
  const server = http.createServer(async (req, res) => {
    try {
      assert(req.url?.endsWith('/snapshot'), "replay must not fetch a manifest or input");
      assert.equal(req.headers.authorization, "Bearer job-token");
      assert.equal(req.headers['x-paperforge-execution'], execution);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const form = await new Request('http://localhost', { method: 'POST', headers: {
        'content-type': req.headers['content-type']! }, body: Buffer.concat(chunks) }).formData();
      const snapshot = JSON.parse(String(form.get('snapshot')));
      assert.equal(snapshot.sequence, 9);
      assert.equal(snapshot.status, 'done');
      assert.equal(Buffer.from(await (form.get('result') as File).arrayBuffer()).toString(), 'PKdurable-document');
      deliveries++;
      res.writeHead(200).end();
    } catch { res.writeHead(400).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, ['.execution/worker.cjs'], { env: { ...process.env,
        PAPERFORGE_JOB_ID: 'delivery', PAPERFORGE_EXECUTION_ID: execution, PAPERFORGE_RUN_TOKEN: 'job-token',
        PAPERFORGE_CONTROL_URL: `http://127.0.0.1:${port}`, PAPERFORGE_ALLOW_LOCAL_CONTROL: '1',
        PAPERFORGE_WORK_ROOT: root, PAPERFORGE_PI_BIN: '/must-not-be-invoked' }, stdio: 'pipe' });
      let output = ''; child.stderr.on('data', d => { output += d; });
      const kill = setTimeout(() => child.kill('SIGKILL'), 15000);
      const code = await new Promise<number | null>(resolve => child.on('close', resolve));
      clearTimeout(kill);
      assert.equal(code, 0, output);
      assert(fs.existsSync(path.join(root, 'delivered')));
    }
    assert.equal(deliveries, 2);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
