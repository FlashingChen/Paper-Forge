import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RunManifest, RunSnapshot, UsageRow } from "../../src/lib/execution/protocol";
import { parseSnapshot, snapshotFor } from "../../src/lib/execution/protocol";

async function main() {
  const id = process.env.PAPERFORGE_JOB_ID;
  const token = process.env.PAPERFORGE_RUN_TOKEN;
  const origin = process.env.PAPERFORGE_CONTROL_URL;
  if (!id || !token || !origin || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("Missing execution bootstrap");
  const url = new URL(origin);
  if (url.protocol !== "https:" && !(process.env.PAPERFORGE_ALLOW_LOCAL_CONTROL === "1" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Control origin must use HTTPS");
  }
  if (Number(process.env.CLOUD_RUN_TASK_ATTEMPT ?? 0) !== 0) throw new Error("Agent retries are disabled; submit a new job instead");
  const execution = process.env.PAPERFORGE_EXECUTION_ID ?? process.env.CLOUD_RUN_EXECUTION ?? randomUUID();
  const base = `${url.origin}/api/internal/runs/${encodeURIComponent(id)}`;
  const headers = { authorization: `Bearer ${token}`, "x-paperforge-execution": execution };
  // The unmodified agent inherits process.env. Keep control-plane credentials out of it.
  delete process.env.PAPERFORGE_RUN_TOKEN;
  delete process.env.PAPERFORGE_CONTROL_URL;
  delete process.env.PAPERFORGE_EXECUTION_SECRET;
  const request = async (endpoint: string, init: RequestInit, retry = false): Promise<Response> => {
    const deadline = Date.now() + (retry ? 10 * 60_000 : 0);
    for (;;) {
      try {
        const response = await fetch(`${base}/${endpoint}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
        if (response.ok || response.status === 409) return response;
        if (response.status < 500 && response.status !== 429) throw new Error(`Control request rejected (${response.status})`);
      } catch (error) {
        if (!retry || Date.now() >= deadline || (error instanceof Error && error.message.startsWith("Control request rejected"))) throw error;
      }
      if (!retry || Date.now() >= deadline) throw new Error("Control plane unavailable");
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  };

  const root = process.env.PAPERFORGE_WORK_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), "paperforge-worker-"));
  if (!path.isAbsolute(root)) throw new Error("Worker root must be absolute");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const finalFile = path.join(root, "final.json");
  const receipt = path.join(root, "delivered");
  const deliver = async (saved: { snapshot: RunSnapshot; resultPath?: string }) => {
    const form = new FormData();
    form.set("snapshot", JSON.stringify(saved.snapshot));
    if (saved.resultPath) form.set("result", new Blob([fs.readFileSync(saved.resultPath)]), "result.docx");
    const response = await request("snapshot", { method: "POST", body: form }, true);
    if (response.status === 409) throw new Error("Execution ownership lost");
    fs.writeFileSync(receipt, "acknowledged", { mode: 0o600 });
  };
  // Restarting a delivery attempt must never invoke the Agent a second time.
  if (fs.existsSync(finalFile)) {
    const saved = JSON.parse(fs.readFileSync(finalFile, "utf8")) as { snapshot: RunSnapshot; resultPath?: string };
    parseSnapshot(saved.snapshot);
    if (saved.snapshot.execution !== execution) throw new Error("Execution mismatch");
    try { await deliver(saved); } catch { process.exitCode = 2; }
    return;
  }
  const interrupted = fs.existsSync(path.join(root, "started"));
  const claim = await request("claim", { method: "POST", body: JSON.stringify({ execution }) }, true);
  if (claim.status === 409) return; // Another execution already owns this job, or it finished.
  const manifest = await claim.json() as RunManifest;
  if (manifest.version !== 1 || manifest.jobId !== id) throw new Error("Unsupported execution manifest");
  process.env.PAPERFORGE_DB_PATH = path.join(root, "runtime.db");
  process.env.PAPERFORGE_JOBS_DIR = process.env.PAPERFORGE_ISOLATED_AGENT === "1" ? "/work/jobs" : path.join(root, "jobs");
  process.env.SESSION_SECRET = randomUUID() + randomUUID();
  process.env.PAPERFORGE_PROVIDER = manifest.provider;
  process.env.PAPERFORGE_MODEL = manifest.model;
  process.env.PAPERFORGE_BASE_URL = manifest.baseUrl;
  process.env.PAPERFORGE_API_KEY = manifest.apiKey ?? "";
  process.env.PAPERFORGE_TIMEOUT_MS = String(manifest.timeoutMs);
  Object.assign(process.env, manifest.imageEnv);
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;

  // These modules initialize SQLite on import; initialize the ephemeral paths first.
  const db = await import("../../src/lib/db");
  const jobs = await import("../../src/lib/jobs");
  const auth = await import("../../src/lib/auth");
  const usage = await import("../../src/lib/usage");
  const config = await import("../../src/lib/config");
  const { runAgent } = await import("../../src/lib/pi-runner");
  db.initDb();
  if (!jobs.getJob(id)) jobs.createJob({ id, imageCount: manifest.images.length });
  const dir = jobs.prepareJobDir(id);
  if (process.env.PAPERFORGE_ISOLATED_AGENT === "1") {
    if (process.getuid?.() !== 0) throw new Error("Trusted wrapper must own the delivery volume");
    fs.chmodSync(root, 0o700);
    const own = (p: string) => {
      const info = fs.lstatSync(p);
      if (info.isSymbolicLink()) throw new Error("Unexpected bootstrap symlink");
      fs.chownSync(p, 10001, 1001);
      if (info.isDirectory()) for (const child of fs.readdirSync(p)) own(path.join(p, child));
    };
    own(dir);
  }
  auth.writeModelSettings({ provider: manifest.provider, model: manifest.model,
    baseUrl: manifest.baseUrl, apiKey: manifest.apiKey, capabilities: manifest.capabilities });
  if (manifest.price) usage.saveUsagePrice(manifest.provider, manifest.model, manifest.price);
  if (manifest.declared) {
    // Carry the original provider declaration so catalog/API compatibility stays identical.
    fs.mkdirSync(config.piAgentDir(), { recursive: true });
    fs.writeFileSync(config.modelsJsonPath(), JSON.stringify({ providers: {
      [manifest.provider]: { ...manifest.declared, apiKey: undefined },
    } }), { mode: 0o600 });
  }

  const sequenceFile = path.join(root, "sequence");
  let sequence = fs.existsSync(sequenceFile) ? Number(fs.readFileSync(sequenceFile, "utf8")) : 0;
  const report = async () => {
    const job = jobs.getJob(id)!;
    const rows = db.rawDb().prepare("SELECT * FROM model_usage WHERE job_id = ? ORDER BY sequence").all(id) as unknown as UsageRow[];
    const snapshot = snapshotFor(job, execution, ++sequence, rows);
    fs.writeFileSync(sequenceFile, String(sequence), { mode: 0o600 });
    // A heartbeat must not publish a terminal state before the result is durable.
    snapshot.status = "running";
    const form = new FormData();
    form.set("snapshot", JSON.stringify(snapshot));
    const response = await request("snapshot", { method: "POST", body: form });
    if (response.status === 409) throw new Error("Execution ownership lost");
  };
  let inFlight: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = report().catch(() => { /* Retry the complete snapshot on the next heartbeat. */ })
      .finally(() => { inFlight = undefined; });
  }, 5000);
  try {
    if (interrupted) throw new Error("Agent 容器曾中断，不会自动重复执行。请重新提交任务。");
    await report().catch(() => {}); // A transient Web restart must not stop the agent.
    const images = [];
    for (const image of manifest.images) {
      const response = await request(`inputs/${image.index}`, { method: "GET" }, true);
      if (!response.ok) throw new Error("Input unavailable");
      images.push({ ...image, buffer: Buffer.from(await response.arrayBuffer()) });
    }
    fs.writeFileSync(path.join(root, "started"), "started", { mode: 0o600 });
    await runAgent({ jobId: id, jobDir: dir, images, onLog: () => {} });
  } catch (error) {
    jobs.updateJob(id, { status: "error", error: error instanceof Error ? error.message : "Execution failed" });
  } finally {
    clearInterval(timer);
    await inFlight;
  }
  const job = jobs.getJob(id)!;
  const rows = db.rawDb().prepare("SELECT * FROM model_usage WHERE job_id = ? ORDER BY sequence").all(id) as unknown as UsageRow[];
  let durableResult: string | undefined;
  if (job.status === "done" && job.resultPath && process.env.PAPERFORGE_ISOLATED_AGENT === "1") {
    try {
      const real = fs.realpathSync(job.resultPath);
      const info = fs.lstatSync(job.resultPath);
      if (!info.isFile() || info.isSymbolicLink() || !real.startsWith(dir + path.sep) || info.size > 10 * 1024 * 1024) throw new Error("Unsafe output");
      const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let content: Buffer;
      try { const opened=fs.fstatSync(fd); if (!opened.isFile() || opened.size > 10*1024*1024) throw new Error("Unsafe output"); content=fs.readFileSync(fd); } finally { fs.closeSync(fd); }
      if (content.length > 10*1024*1024) throw new Error("Output too large");
      durableResult = path.join(root, "result.docx"); fs.writeFileSync(durableResult, content, { mode: 0o600 });
    } catch {
      jobs.updateJob(id, { status: "error", error: "结果文件未通过安全校验" }); job.status = "error"; job.error = "结果文件未通过安全校验";
    }
  }
  const saved = { snapshot: snapshotFor(job, execution, ++sequence, rows), resultPath: job.status === "done" ? durableResult ?? job.resultPath : undefined };
  fs.writeFileSync(finalFile + ".tmp", JSON.stringify(saved), { mode: 0o600 });
  fs.renameSync(finalFile + ".tmp", finalFile);
  try { await deliver(saved); } catch { process.exitCode = 2; return; }
  if (job.status === "error") process.exitCode = 1;
}

main().catch(() => { console.error("PaperForge execution failed; check control-plane job status and node container logs."); process.exitCode = 1; });
