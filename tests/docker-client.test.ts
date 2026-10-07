import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import { DockerClient } from "../scripts/execution/docker-client";

test("Docker client negotiates the daemon API version and rejects failed create calls without exposing their body", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-docker-test-"));
  const socket = path.join(root, "docker.sock");
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url!);
    if (req.url === '/version') { res.end(JSON.stringify({ ApiVersion: '1.54' })); return; }
    if (req.url === '/v1.54/containers/json') { res.end('[]'); return; }
    res.writeHead(400).end(JSON.stringify({ message: 'private-token-in-Docker-error' }));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const client = new DockerClient(socket);
    assert.deepEqual(await client.request('GET', '/containers/json'), []);
    await assert.rejects(client.request('POST', '/containers/create', { Env: ['TOKEN=private-token'] }), error => {
      assert.equal((error as Error).message, 'Docker HTTP 400'); return true;
    });
    assert.deepEqual(paths, ['/version', '/v1.54/containers/json', '/v1.54/containers/create']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
});
