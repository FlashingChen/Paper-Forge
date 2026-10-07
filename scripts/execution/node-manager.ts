import fs from "node:fs";
import path from "node:path";
import type { NodeAssignment } from "../../src/lib/execution/nodes";
import { DockerClient } from "./docker-client";

export interface NodeConfig {
  scope?: "beta" | "main"; id: string; token: string; origin: string; image: string; volume: string; network: string;
  memory: number; cpus: number; concurrency: number; stateDir: string;
}
interface Container { Id: string; State: string; Labels: Record<string, string> }
interface Inspection { State: { Status: string; ExitCode: number; OOMKilled: boolean }; Config: { Labels: Record<string, string> } }
export function nodeConfig(): NodeConfig {
  const scope = process.env.PAPERFORGE_NODE_SCOPE ?? "beta";
  if (scope !== "beta" && scope !== "main") throw new Error("Invalid node scope");
  const id = process.env.PAPERFORGE_NODE_ID ?? "";
  const token = process.env.PAPERFORGE_NODE_TOKEN ?? "";
  const url = new URL(process.env.PAPERFORGE_CONTROL_URL ?? "");
  if (!/^[a-z0-9-]{1,48}$/.test(id) || token.length < 32 || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid node identity/control origin");
  const image = process.env.PAPERFORGE_AGENT_IMAGE ?? "";
  const volume = process.env.PAPERFORGE_NODE_VOLUME ?? "";
  if (!image || !new RegExp(`^paperforge-${scope}-[a-z0-9-]{1,64}$`).test(volume)) throw new Error("Configure immutable Agent image and matching PaperForge volume");
  const memory = Number(process.env.PAPERFORGE_AGENT_MEMORY_MB ?? 2048) * 1024 * 1024;
  const concurrency = Number(process.env.PAPERFORGE_NODE_CONCURRENCY ?? 1);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("Invalid node concurrency");
  const cpus = Number(process.env.PAPERFORGE_AGENT_CPUS ?? 1);
  if (!Number.isSafeInteger(memory) || memory < 256 * 1024 * 1024 || !Number.isFinite(cpus) || cpus < 0.25 || cpus > 32) throw new Error("Invalid Agent resource limits");
  return { scope, id, token, origin: url.origin, image, volume, memory, cpus, concurrency,
    network: process.env.PAPERFORGE_AGENT_NETWORK ?? "bridge", stateDir: process.env.PAPERFORGE_NODE_STATE_DIR ?? "/state" };
}
export function taskContainer(config: NodeConfig, assignment: NodeAssignment) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(assignment.jobId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(assignment.execution)) throw new Error("Invalid assignment");
  return {
    Image: config.image,
    User: "0:0",
    Env: [`PAPERFORGE_JOB_ID=${assignment.jobId}`, `PAPERFORGE_EXECUTION_ID=${assignment.execution}`,
      `PAPERFORGE_RUN_TOKEN=${assignment.token}`, `PAPERFORGE_CONTROL_URL=${config.origin}`,
      `PAPERFORGE_WORK_ROOT=/persist/tasks/${assignment.jobId}/${assignment.execution}`],
    Labels: { "paperforge.scope": config.scope ?? "beta", "paperforge.node": config.id, "paperforge.role": "task",
      "paperforge.job": assignment.jobId, "paperforge.execution": assignment.execution },
    HostConfig: { Binds: [`${config.volume}-task-${assignment.execution}:/persist`], NetworkMode: config.network,
      Memory: config.memory, MemorySwap: config.memory, NanoCpus: Math.round(config.cpus * 1e9), PidsLimit: 256,
      ReadonlyRootfs: true, Tmpfs: { "/work": "rw,nosuid,nodev,size=256m,uid=10001,gid=1001", "/tmp": "rw,nosuid,nodev,size=64m,uid=10001,gid=1001", "/home/paperforge": "rw,nosuid,nodev,size=16m,uid=10001,gid=1001" },
      CapDrop: ["ALL"], CapAdd: ["CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID"], SecurityOpt: ["no-new-privileges"], RestartPolicy: { Name: "no" },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } } },
  };
}

export async function nodeTick(config: NodeConfig, docker: DockerClient, control: (endpoint: string, body: unknown) => Promise<unknown>, draining = false) {
  const filters = encodeURIComponent(JSON.stringify({ label: [`paperforge.scope=${config.scope ?? "beta"}`, `paperforge.node=${config.id}`, "paperforge.role=task"] }));
  const containers = await docker.request<Container[]>("GET", `/containers/json?all=true&filters=${filters}`);
  const busy = containers.filter(c => ["running", "restarting", "paused"].includes(c.State)).length >= config.concurrency;
  fs.mkdirSync(config.stateDir, { recursive: true });
  const disk = fs.statfsSync(config.stateDir);
  const diskSafe = disk.bavail * disk.bsize >= 1024 * 1024 * 1024;
  const response = await control("poll", { allowNew: !draining && !busy && diskSafe }) as { nodeId: string; concurrency: number; assignments: NodeAssignment[] };
  if (response.nodeId !== config.id || !Number.isInteger(response.concurrency) || response.concurrency < 1 || response.concurrency > 32 || !Array.isArray(response.assignments)) throw new Error("Invalid control response");
  let running = containers.filter(c => ["running", "restarting", "paused"].includes(c.State)).length;
  for (const assignment of response.assignments) {
    const found = containers.find(c => c.Labels["paperforge.execution"] === assignment.execution && c.Labels["paperforge.job"] === assignment.jobId);
    if (found) {
      const state = await docker.request<Inspection>("GET", `/containers/${found.Id}/json`);
      if (["running", "restarting", "paused"].includes(state.State.Status)) continue;
      if (state.State.Status === "created") {
        if (!draining && running < Math.min(config.concurrency, response.concurrency)) {
          await docker.request("POST", `/containers/${found.Id}/start`);
          running++;
        }
      } else if (state.State.ExitCode === 2 && !state.State.OOMKilled) {
        // Exit 2 means the durable final snapshot still needs delivery. Agent is not re-run.
        if (!draining && running < Math.min(config.concurrency, response.concurrency)) {
          await docker.request("POST", `/containers/${found.Id}/start`);
          running++;
        }
      } else {
        await control("failure", { jobId: assignment.jobId, execution: assignment.execution, reason: state.State.OOMKilled ? "oom" : "exited" });
      }
      continue;
    }
    if (assignment.claimed) {
      await control("failure", { jobId: assignment.jobId, execution: assignment.execution, reason: "missing" });
      continue;
    }
    if (draining || !diskSafe || running >= Math.min(config.concurrency, response.concurrency)) continue;
    const name = `paperforge-${config.scope ?? "beta"}-task-${assignment.execution}`;
    await docker.request("POST", "/volumes/create", { Name: `${config.volume}-task-${assignment.execution}`,
      Labels: { "paperforge.scope": config.scope ?? "beta", "paperforge.node": config.id, "paperforge.role": "task-data", "paperforge.execution": assignment.execution } });
    const created = await docker.request<{ Id: string }>("POST", `/containers/create?name=${name}`, taskContainer(config, assignment));
    await docker.request("POST", `/containers/${created.Id}/start`);
    running++;
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(path.join(config.stateDir, "node-health.json"), JSON.stringify({ lastPollAt: Date.now(), nodeId: config.id }));
}

async function main() {
  const config = nodeConfig();
  const docker = new DockerClient(process.env.PAPERFORGE_DOCKER_SOCKET);
  let draining = false;
  process.on("SIGTERM", () => { draining = true; });
  process.on("SIGINT", () => { draining = true; });
  const control = async (endpoint: string, body: unknown) => {
    const res = await fetch(`${config.origin}/api/internal/nodes/${endpoint}`, { method: "POST",
      headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Control HTTP ${res.status}`);
    return res.status === 204 ? undefined : res.json();
  };
  console.info("PaperForge node manager started", config.id);
  while (!draining) {
    try { await nodeTick(config, docker, control); }
    catch { console.error("Node poll/reconcile unavailable; existing Agent containers continue running."); }
    if (!draining) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
if (require.main === module) main().catch(() => { console.error("Node configuration invalid"); process.exitCode = 1; });
