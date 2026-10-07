import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { rawDb } from "../db";
import { appendLog } from "../jobs";
import { remoteRun, runToken, type RemoteRun } from "./store";

export interface NodeDefinition { id: string; tokenHash: string; concurrency: number }
export interface NodeAssignment { jobId: string; execution: string; token: string; claimed: boolean; deadline: number }

export function nodeRegistry(): NodeDefinition[] {
  const parsed: unknown = JSON.parse(process.env.PAPERFORGE_NODES ?? "[]");
  if (!Array.isArray(parsed) || !parsed.length || parsed.length > 100) throw new Error("Configure PAPERFORGE_NODES before enabling node execution");
  const ids = new Set<string>();
  for (const n of parsed) {
    if (!n || typeof n.id !== "string" || !/^[a-z0-9-]{1,48}$/.test(n.id) || ids.has(n.id) ||
      typeof n.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(n.tokenHash) ||
      !Number.isSafeInteger(n.concurrency) || n.concurrency < 1 || n.concurrency > 32) throw new Error("Invalid node registry");
    ids.add(n.id);
  }
  return parsed;
}

export function authorizeNode(authorization: string | null): NodeDefinition | undefined {
  if (!authorization?.startsWith("Bearer ")) return;
  const hash = createHash("sha256").update(authorization.slice(7)).digest();
  return nodeRegistry().find(n => timingSafeEqual(hash, Buffer.from(n.tokenHash, "hex")));
}

function fail(id: string, message: string) {
  const changed = rawDb().prepare("UPDATE jobs SET status = 'error', error = ? WHERE id = ? AND status IN ('queued','running')").run(message, id);
  if (changed.changes) appendLog(id, "error", message);
}

export function reconcileNodeRuns(now = Date.now()): void {
  const db = rawDb();
  const expired = db.prepare(`SELECT r.job_id FROM remote_runs r JOIN jobs j ON j.id = r.job_id
    WHERE r.backend = 'node' AND j.status IN ('queued','running') AND r.deadline < ?`).all(now) as { job_id: string }[];
  for (const row of expired) fail(row.job_id, "执行节点任务超过排队或执行回传期限，请查看节点状态后重新提交。");
  // Only reservations that never started an Agent may move to another node.
  db.prepare(`UPDATE remote_runs SET node_id = NULL, reserved_by = NULL, reserved_until = NULL
    WHERE backend = 'node' AND claimed_by IS NULL AND reserved_until < ?`).run(now);
}

export function pollNode(node: NodeDefinition, allowNew: boolean, now = Date.now()): NodeAssignment[] {
  reconcileNodeRuns(now);
  const db = rawDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO execution_nodes (id, heartbeat_at) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at`).run(node.id, now);
    const active = db.prepare(`SELECT r.* FROM remote_runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.backend = 'node' AND r.node_id = ? AND j.status IN ('queued','running') ORDER BY j.created_at`).all(node.id) as unknown as RemoteRun[];
    if (allowNew && active.length < node.concurrency) {
      const queued = db.prepare(`SELECT r.* FROM remote_runs r JOIN jobs j ON j.id = r.job_id
        WHERE r.backend = 'node' AND r.node_id IS NULL AND r.claimed_by IS NULL AND j.status = 'queued'
        ORDER BY j.created_at LIMIT ?`).all(node.concurrency - active.length) as unknown as RemoteRun[];
      for (const row of queued) {
        const execution = randomUUID();
        db.prepare("UPDATE remote_runs SET node_id = ?, reserved_by = ?, reserved_until = ? WHERE job_id = ?")
          .run(node.id, execution, now + 90_000, row.job_id);
        active.push({ ...row, node_id: node.id, reserved_by: execution, reserved_until: now + 90_000 });
      }
    }
    db.exec("COMMIT");
    return active.map(row => ({ jobId: row.job_id, execution: row.reserved_by!, token: runToken(row.job_id),
      claimed: Boolean(row.claimed_by), deadline: row.deadline }));
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function reportNodeFailure(node: NodeDefinition, id: string, execution: string, reason: "missing" | "exited" | "oom"): boolean {
  const row = remoteRun(id);
  if (!row || row.backend !== "node" || row.node_id !== node.id || row.reserved_by !== execution) return false;
  const messages = { missing: "执行容器丢失；不会自动重复运行 Agent，请检查节点后重新提交。",
    exited: "执行容器已退出，但未确认最终结果；任务文件保留在节点。", oom: "Agent 容器内存不足退出；请提高节点任务内存限制。" };
  fail(id, messages[reason]);
  return true;
}
