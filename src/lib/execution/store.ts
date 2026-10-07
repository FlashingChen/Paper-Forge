import { publicLogs } from "../security/public-job";
import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { rawDb, getJobRow, saveJobLogs, updateJobRow } from "../db";
import { jobDirFor } from "../jobs";
import type { RunManifest, RunSnapshot } from "./protocol";

export function executor(): "local" | "cloud-run" | "node" {
  const value = process.env.PAPERFORGE_EXECUTOR ?? "local";
  if (value !== "local" && value !== "cloud-run" && value !== "node") throw new Error("PAPERFORGE_EXECUTOR must be local, node or cloud-run");
  if (process.env.PAPERFORGE_CONTROL_ONLY === "1" && value === "local") throw new Error("The control image requires remote execution");
  return value;
}

function key(): Buffer {
  const secret = process.env.PAPERFORGE_EXECUTION_SECRET;
  if (!secret || secret.length < 32) throw new Error("PAPERFORGE_EXECUTION_SECRET must contain at least 32 characters");
  return createHash("sha256").update(secret).digest();
}

export function runToken(id: string): string {
  return createHmac("sha256", key()).update(`paperforge-run-v1:${id}`).digest("base64url");
}

export function authorizeRun(id: string, authorization: string | null): boolean {
  // Exact lookup, without sanitizing an attacker-controlled id into another id.
  if (!getJobRow(id) || !remoteRun(id)) return false;
  const actual = Buffer.from(authorization ?? "");
  const expected = Buffer.from(`Bearer ${runToken(id)}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function encryptManifest(manifest: RunManifest): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(manifest.jobId));
  const data = Buffer.concat([cipher.update(JSON.stringify(manifest)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function readManifest(id: string): RunManifest {
  const row = remoteRun(id);
  if (!row) throw new Error("Unknown remote run");
  const data = Buffer.from(row.payload, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()) as RunManifest;
}

export interface RemoteRun {
  backend: "cloud-run" | "node";
  node_id: string | null;
  reserved_by: string | null;
  reserved_until: number | null;
  started_at: number | null;
  timeout_ms: number;
  job_id: string;
  payload: string;
  operation: string | null;
  execution: string | null;
  claimed_by: string | null;
  sequence: number;
  next_dispatch_at: number;
  dispatch_attempts: number;
  last_error: string | null;
  heartbeat_at: number | null;
  deadline: number;
}

export function remoteRun(id: string): RemoteRun | undefined {
  return rawDb().prepare("SELECT * FROM remote_runs WHERE job_id = ?").get(id) as RemoteRun | undefined;
}

export function enqueueRun(manifest: RunManifest, images: Buffer[]): void {
  const dir = path.join(jobDirFor(manifest.jobId), "in");
  fs.mkdirSync(dir, { recursive: true });
  images.forEach((buffer, index) => fs.writeFileSync(path.join(dir, `${index}.upload`), buffer));
  // Publish only after all inputs are durable. Dispatchers cannot see partial uploads.
  rawDb().prepare(`INSERT INTO remote_runs (job_id, payload, deadline, backend, timeout_ms) VALUES (?, ?, ?, ?, ?)`)
    .run(manifest.jobId, encryptManifest(manifest), Date.now() + (executor() === "node" ? 24 * 60 * 60_000 : manifest.timeoutMs + 20 * 60_000),
      executor() === "node" ? "node" : "cloud-run", manifest.timeoutMs);
}

export function claimRun(id: string, execution: string): "claimed" | "conflict" | "finished" {
  const db = rawDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const job = getJobRow(id);
    const row = remoteRun(id);
    let result: "claimed" | "conflict" | "finished" = "conflict";
    if (job?.status === "done" || job?.status === "error") result = "finished";
    else if (row && (!row.claimed_by || row.claimed_by === execution) &&
      (row.backend !== "node" || (row.reserved_by === execution &&
        (row.claimed_by === execution || (row.reserved_until ?? 0) > Date.now())))) {
      db.prepare(`UPDATE remote_runs SET claimed_by = ?, heartbeat_at = ?, started_at = COALESCE(started_at, ?),
        deadline = CASE WHEN backend = 'node' AND started_at IS NULL THEN ? + timeout_ms + 1200000 ELSE deadline END WHERE job_id = ?`)
        .run(execution, Date.now(), Date.now(), Date.now(), id);
      result = "claimed";
    }
    db.exec("COMMIT");
    return result;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function acceptSnapshot(id: string, snapshot: RunSnapshot, result?: Buffer): "accepted" | "duplicate" | "conflict" {
  const db = rawDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = remoteRun(id);
    const job = getJobRow(id);
    if (!row || row.claimed_by !== snapshot.execution) { db.exec("ROLLBACK"); return "conflict"; }
    if (snapshot.sequence <= row.sequence || job?.status === "done" || job?.status === "error") {
      db.exec("ROLLBACK"); return "duplicate";
    }
    let resultPath: string | undefined;
    if (snapshot.status === "done") {
      if (!result || result.length < 2 || result.length > 10 * 1024 * 1024 || result.readUInt16LE(0) !== 0x4b50) throw new Error("Missing or invalid DOCX");
      const out = path.join(jobDirFor(id), "out");
      fs.mkdirSync(out, { recursive: true });
      resultPath = path.join(out, "result.docx");
      const temp = path.join(out, "result.upload");
      fs.writeFileSync(temp, result);
      fs.renameSync(temp, resultPath);
    }
    for (const u of snapshot.usage) {
      db.prepare(`INSERT OR IGNORE INTO model_usage (job_id, sequence, created_at, provider, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, cost_source, price_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, u.sequence, u.created_at, u.provider, u.model,
          u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.total_tokens, u.cost_usd, u.cost_source, u.price_json);
    }
    saveJobLogs(id, JSON.stringify(publicLogs(snapshot.logs)));
    updateJobRow(id, { status: snapshot.status, note: undefined,
      error: snapshot.status === "error" ? "执行面任务失败" : null,
      resultPath, resultSize: result?.length });
    db.prepare("UPDATE remote_runs SET sequence = ?, heartbeat_at = ? WHERE job_id = ?")
      .run(snapshot.sequence, Date.now(), id);
    db.exec("COMMIT");
    return "accepted";
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
