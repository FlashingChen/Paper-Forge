import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { nodeConfig, nodeTick, taskContainer, type NodeConfig } from "../scripts/execution/node-manager";
import type { DockerClient } from "../scripts/execution/docker-client";

test("node manager adopts a container after a lost create response, only resumes delivery, and never recreates a claimed Agent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-manager-test-"));
  const config: NodeConfig = { id: "test", token: "private-node-credential", origin: "https://example.invalid", image: "paperforge-agent:test",
    volume: "paperforge-beta-test", network: "bridge", memory: 2 * 1024 ** 3, cpus: 1, concurrency: 1, stateDir: root };
  const assignment = { jobId: "a", execution: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", token: "job-only-token", claimed: false, deadline: Date.now()+60000 };
  const payload = taskContainer(config, assignment);
  assert(!JSON.stringify(payload).includes(config.token));
  assert.deepEqual(payload.HostConfig.Binds, [`paperforge-beta-test-task-${assignment.execution}:/persist`]);
  assert.equal(payload.HostConfig.RestartPolicy.Name, "no");
  assert(payload.HostConfig.CapDrop.includes("ALL"));
  const calls: string[] = [];
  const containers: { Id: string; State: string; Labels: Record<string, string> }[] = [];
  let status = "created", exitCode = 0, claimed = false;
  const docker = { request: async (method: string, route: string) => {
    calls.push(`${method} ${route.split('?')[0]}`);
    if (route.startsWith('/containers/json?')) return containers;
    if (route.startsWith('/containers/create?')) {
      containers.push({ Id: 'container-a', State: 'created', Labels: payload.Labels });
      throw new Error('lost create response');
    }
    if (route.endsWith('/json')) return { State: { Status: status, ExitCode: exitCode, OOMKilled: false } };
    if (route.endsWith('/start')) { status = 'running'; containers[0].State = 'running'; }
  } } as unknown as DockerClient;
  const failures: unknown[] = [];
  const control = async (endpoint: string, body: unknown) => {
    if (endpoint === 'failure') { failures.push(body); return; }
    return { nodeId: config.id, concurrency: 1, assignments: [{ ...assignment, claimed }] };
  };
  try {
    await assert.rejects(nodeTick(config, docker, control));
    await nodeTick(config, docker, control);
    assert.equal(calls.filter(c => c.includes('/containers/create')).length, 1);
    assert.equal(status, 'running');
    claimed = true;
    await nodeTick(config, docker, control);
    assert.equal(calls.filter(c => c.endsWith('/start')).length, 1);
    status = 'exited'; containers[0].State = 'exited'; exitCode = 2;
    await nodeTick(config, docker, control);
    assert.equal(calls.filter(c => c.endsWith('/start')).length, 2, 'only pending delivery is restarted');
    status = 'exited'; exitCode = 1;
    await nodeTick(config, docker, control);
    assert.equal(failures.length, 1);
    containers.length = 0;
    await nodeTick(config, docker, control);
    assert.equal(failures.length, 2);
    assert.equal(calls.filter(c => c.includes('/containers/create')).length, 1, 'missing claimed container is never recreated');
    assert(fs.existsSync(path.join(root, 'node-health.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test("Main task resources and adoption filters stay separate from BETA", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-main-manager-"));
  const config: NodeConfig = { scope: "main", id: "main-node", token: "private-node-credential", origin: "https://example.invalid", image: "agent:main",
    volume: "paperforge-main-node", network: "bridge", memory: 1024 ** 3, cpus: 1, concurrency: 1, stateDir: root };
  const assignment = { jobId: "a", execution: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", token: "job-only-token", claimed: false, deadline: Date.now() + 60000 };
  const payload = taskContainer(config, assignment);
  assert.equal(payload.Labels["paperforge.scope"], "main");
  assert.equal(payload.HostConfig.Binds[0], `paperforge-main-node-task-${assignment.execution}:/persist`);
  const routes: string[] = [];
  const docker = { request: async (_method: string, route: string) => {
    routes.push(route);
    if (route.startsWith("/containers/json?")) return [];
    if (route.startsWith("/containers/create?")) return { Id: "main-task" };
  } } as unknown as DockerClient;
  try {
    await nodeTick(config, docker, async () => ({ nodeId: config.id, concurrency: 1, assignments: [assignment] }));
    assert(decodeURIComponent(routes[0]).includes("paperforge.scope=main"));
    assert(routes.some(route => route.includes(`name=paperforge-main-task-${assignment.execution}`)));
    assert(!routes.some(route => route.includes("paperforge-beta")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a Main manager rejects a BETA volume prefix", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { PAPERFORGE_NODE_SCOPE: "main", PAPERFORGE_NODE_ID: "main-node", PAPERFORGE_NODE_TOKEN: "x".repeat(40),
      PAPERFORGE_CONTROL_URL: "https://control.invalid", PAPERFORGE_AGENT_IMAGE: "agent:fixed", PAPERFORGE_NODE_VOLUME: "paperforge-beta-node" });
    assert.throws(nodeConfig, /matching PaperForge volume/);
    process.env.PAPERFORGE_NODE_VOLUME = "paperforge-main-node";
    assert.equal(nodeConfig().scope, "main");
  } finally { process.env = saved; }
});
