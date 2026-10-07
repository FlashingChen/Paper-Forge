import { initDb } from "@/lib/db";
import { authorizeNode, pollNode } from "@/lib/execution/nodes";
import { executor } from "@/lib/execution/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  initDb();
  if (executor() !== "node") return new Response(null, { status: 503 });
  const node = authorizeNode(request.headers.get("authorization"));
  if (!node) return new Response(null, { status: 401 });
  const body = await request.json().catch(() => null);
  if (typeof body?.allowNew !== "boolean") return new Response(null, { status: 400 });
  const allowNew = body.allowNew && process.env.PAPERFORGE_DISPATCH_ENABLED !== "0";
  return Response.json({ nodeId: node.id, concurrency: node.concurrency, assignments: pollNode(node, allowNew) },
    { headers: { "Cache-Control": "no-store" } });
}
