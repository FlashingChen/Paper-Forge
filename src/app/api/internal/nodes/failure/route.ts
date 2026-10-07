import { initDb } from "@/lib/db";
import { authorizeNode, reportNodeFailure } from "@/lib/execution/nodes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  initDb();
  const node = authorizeNode(request.headers.get("authorization"));
  if (!node) return new Response(null, { status: 401 });
  const body = await request.json().catch(() => null);
  if (typeof body?.jobId !== "string" || typeof body?.execution !== "string" || !["missing", "exited", "oom"].includes(body?.reason)) {
    return new Response(null, { status: 400 });
  }
  return new Response(null, { status: reportNodeFailure(node, body.jobId, body.execution, body.reason) ? 204 : 409 });
}
