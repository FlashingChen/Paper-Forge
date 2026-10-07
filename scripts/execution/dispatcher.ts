import { initDb, rawDb } from "../../src/lib/db";
import { appendLog } from "../../src/lib/jobs";
import { cloudRunConfig, dispatchRun, googleRequest, type RunOperation } from "../../src/lib/execution/cloud-run";
import { nodeRegistry, reconcileNodeRuns } from "../../src/lib/execution/nodes";
import { executor, remoteRun, type RemoteRun } from "../../src/lib/execution/store";

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

function fail(id: string, message: string) {
  // A late reconciliation must never overwrite a successful callback.
  const changed = rawDb().prepare("UPDATE jobs SET status = 'error', error = ? WHERE id = ? AND status IN ('queued','running')").run(message, id);
  if (changed.changes) appendLog(id, "error", message);
}

export interface DispatchApi {
  dispatch: typeof dispatchRun;
  operation: (name: string) => Promise<RunOperation>;
  execution: (name: string) => Promise<{ completionTime?: string }>;
  resource: () => string;
}

export async function tick(api: DispatchApi = {
  dispatch: dispatchRun,
  operation: name => googleRequest<RunOperation>(name),
  execution: name => googleRequest<{ completionTime?: string }>(name),
  resource: () => cloudRunConfig().resource,
}) {
  const rows = rawDb().prepare(`SELECT r.* FROM remote_runs r JOIN jobs j ON j.id = r.job_id
    WHERE r.backend = 'cloud-run' AND j.status IN ('queued','running') ORDER BY j.created_at LIMIT 100`).all() as unknown as RemoteRun[];
  for (const row of rows) {
    if (stopping) break;
    if (Date.now() > row.deadline) { fail(row.job_id, "远程任务超过执行与回传期限，请重新提交。"); continue; }
    try {
      if (row.operation || row.claimed_by) {
        const operation = row.operation ? await api.operation(row.operation) : undefined;
        const currentOwner = remoteRun(row.job_id)?.claimed_by;
        if (operation?.done && operation.error && !currentOwner) {
          fail(row.job_id, "Cloud Run 启动失败，请检查执行面配置。");
        }
        const execution = currentOwner
          ? `${api.resource()}/executions/${currentOwner}`
          : operation?.response?.name ?? operation?.metadata?.name;
        if (execution && /\/executions\/[^/]+$/.test(execution)) {
          rawDb().prepare("UPDATE remote_runs SET execution = ? WHERE job_id = ?").run(execution, row.job_id);
          const state = await api.execution(execution);
          const latestOwner = remoteRun(row.job_id)?.claimed_by;
          if (state.completionTime && (!latestOwner || execution.endsWith(`/executions/${latestOwner}`))) {
            // Final callback precedes container exit. A completed container without it lost its output.
            fail(row.job_id, "Cloud Run 已结束，但未收到最终结果；请检查执行日志后重新提交。");
          }
        }
        continue;
      }
      if (row.claimed_by || row.next_dispatch_at > Date.now()) continue;
      // A durable lease prevents two dispatcher processes from launching concurrently.
      const leased = rawDb().prepare(`UPDATE remote_runs SET next_dispatch_at = ?, dispatch_attempts = dispatch_attempts + 1
        WHERE job_id = ? AND operation IS NULL AND claimed_by IS NULL AND next_dispatch_at <= ?`)
        .run(Date.now() + 90_000, row.job_id, Date.now());
      if (!leased.changes) continue;
      const operation = await api.dispatch(row.job_id);
      if (!operation.name) throw new Error("Missing operation name");
      rawDb().prepare("UPDATE remote_runs SET operation = ?, last_error = NULL WHERE job_id = ?").run(operation.name, row.job_id);
    } catch {
      // Do not persist OAuth errors: provider responses can include credentials.
      rawDb().prepare("UPDATE remote_runs SET last_error = ? WHERE job_id = ?").run("Cloud Run dispatch/reconciliation unavailable", row.job_id);
    }
  }
}

async function main() {
  if (executor() === "local") return;
  if (process.env.PAPERFORGE_DISPATCH_ENABLED === "0") return;
  if (executor() === "node") nodeRegistry(); else cloudRunConfig();
  initDb();
  console.info("PaperForge remote execution monitor started");
  while (!stopping) {
    if (executor() === "node") reconcileNodeRuns(); else await tick();
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

main().catch(error => {
  // Startup only validates local configuration/schema; Google API errors are handled in tick.
  console.error("PaperForge dispatcher configuration/startup failed:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
