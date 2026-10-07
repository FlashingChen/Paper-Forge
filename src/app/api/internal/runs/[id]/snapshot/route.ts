import { initDb } from "@/lib/db";
import { acceptSnapshot, authorizeRun } from "@/lib/execution/store";
import { parseSnapshot } from "@/lib/execution/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  initDb();
  const { id } = await context.params;
  if (!authorizeRun(id, request.headers.get("authorization"))) return new Response(null, { status: 401 });
  try {
    const form = await request.formData();
    const value = form.get("snapshot");
    if (typeof value !== "string" || value.length > 8 * 1024 * 1024) throw new Error("Invalid snapshot");
    const snapshot = parseSnapshot(JSON.parse(value));
    const file = form.get("result");
    if (file instanceof File && file.size > 50 * 1024 * 1024) throw new Error("Result too large");
    const result = file instanceof File ? Buffer.from(await file.arrayBuffer()) : undefined;
    const accepted = acceptSnapshot(id, snapshot, result);
    return Response.json({ accepted }, { status: accepted === "conflict" ? 409 : 200 });
  } catch {
    return Response.json({ error: "Invalid snapshot or result" }, { status: 400 });
  }
}
