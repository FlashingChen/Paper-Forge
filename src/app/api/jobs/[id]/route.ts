import { NextResponse } from "next/server";
import { jobSnapshot } from "@/lib/jobs";
import { requireJobAccess } from "@/lib/job-guard";

/**
 * GET /api/jobs/:id
 *
 * Snapshot of a job, including its full log list. The progress page uses this
 * as the fallback when the SSE stream is unavailable, and as the very first
 * paint so a reloaded page shows history immediately.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  // Ownership check: anonymous -> 401, someone else's job -> 404.
  const guard = await requireJobAccess(id);
  if (!guard.ok) return guard.response;

  let job;
  try {
    job = jobSnapshot(id);
  } catch {
    return NextResponse.json({ error: "任务编号不合法。" }, { status: 400 });
  }

  if (!job) {
    return NextResponse.json({ error: "找不到这个任务。" }, { status: 404 });
  }

  return NextResponse.json(job, {
    headers: { "Cache-Control": "no-store" },
  });
}
