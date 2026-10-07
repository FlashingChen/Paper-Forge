import { NextResponse } from "next/server";
import { getJob, resolveResultFile } from "@/lib/jobs";
import { requireJobAccess } from "@/lib/job-guard";
import { previewForFile } from "@/lib/preview";

/**
 * GET /api/jobs/:id/preview
 *
 * The generated .docx parsed into a JSON tree the page can paint as a sheet
 * (see scripts/docx_preview.py and src/lib/preview-types.ts).
 *
 * Shape on success:
 *   { ok: true, page, stats, blocks, truncated, warnings }
 *
 * On failure the body is always `{ ok: false, error }` with a Chinese sentence
 * the UI can show as-is — including the 404 "not generated yet" case, so the
 * client has exactly one error shape to handle.
 *
 * Ownership is enforced exactly as on /download: another teacher's paper must
 * not be readable through this route either.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function failure(error: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  const guard = await requireJobAccess(id);
  if (!guard.ok) return guard.response;

  const job = getJob(id);
  if (!job) return failure("找不到这个任务。", 404);

  const file = resolveResultFile(job);
  if (!file) {
    return failure(
      job.status === "done" ? "文档不见了，请重新生成。" : "文档还没生成好。",
      404,
    );
  }

  const result = await previewForFile(file);
  if (!result.ok) return failure(result.error, 500);

  return NextResponse.json(result, { headers: NO_STORE });
}
