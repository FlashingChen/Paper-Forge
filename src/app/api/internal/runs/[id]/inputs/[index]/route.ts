import fs from "node:fs";
import path from "node:path";
import { initDb } from "@/lib/db";
import { jobDirFor } from "@/lib/jobs";
import { authorizeRun, readManifest, remoteRun } from "@/lib/execution/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string; index: string }> }) {
  initDb();
  const { id, index } = await context.params;
  if (!authorizeRun(id, request.headers.get("authorization"))) return new Response(null, { status: 401 });
  if (remoteRun(id)?.claimed_by !== request.headers.get("x-paperforge-execution")) return new Response(null, { status: 409 });
  const manifest = readManifest(id);
  if (!/^\d+$/.test(index) || !manifest.images.some(image => String(image.index) === index)) return new Response(null, { status: 404 });
  const data = fs.readFileSync(path.join(jobDirFor(id), "in", `${index}.upload`));
  return new Response(data, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
}
