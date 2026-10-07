import { requireAdmin } from "@/lib/admin-guard";
import { rawDb } from "@/lib/db";
import { executor } from "@/lib/execution/store";
import { nodeRegistry } from "@/lib/execution/nodes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  return Response.json({ executor: executor(), enabled: process.env.PAPERFORGE_DISPATCH_ENABLED !== "0",
    nodes: executor() === "node" ? nodeRegistry().map(node => {
      const row = rawDb().prepare("SELECT heartbeat_at FROM execution_nodes WHERE id = ?").get(node.id) as { heartbeat_at: number } | undefined;
      const active = rawDb().prepare(`SELECT COUNT(*) AS n FROM remote_runs r JOIN jobs j ON j.id = r.job_id
        WHERE r.backend = 'node' AND r.node_id = ? AND j.status IN ('queued','running')`).get(node.id) as { n: number };
      return { id: node.id, concurrency: node.concurrency, lastHeartbeat: row?.heartbeat_at ?? null,
        online: Boolean(row && Date.now() - row.heartbeat_at < 120_000), activeTasks: active.n };
    }) : [] }, { headers: { "Cache-Control": "no-store" } });
}
