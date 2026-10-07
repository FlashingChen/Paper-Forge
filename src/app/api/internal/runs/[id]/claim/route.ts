import { initDb } from "@/lib/db";
import { authorizeRun, claimRun } from "@/lib/execution/store";

import { executionManifest } from "@/lib/security/model-proxy";
import { readLimitedJson, errorResponse } from "@/lib/security/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  initDb();
  const { id } = await context.params;
  if (!authorizeRun(id, request.headers.get("authorization"))) return new Response(null, { status: 401 });
  const body = await readLimitedJson(request, 1024).catch(() => null);
  if (typeof body?.execution !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(body.execution)) {
    return new Response("Invalid execution", { status: 400 });
  }
  const claim = claimRun(id, body.execution);
  if (claim !== "claimed") return Response.json({ claim }, { status: 409 });
  try { return Response.json(executionManifest(id, body.execution), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
