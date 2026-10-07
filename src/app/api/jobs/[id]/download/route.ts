import fs from "node:fs";
import { getJob, resolveResultFile } from "@/lib/jobs";
import { requireJobAccess } from "@/lib/job-guard";

/**
 * GET /api/jobs/:id/download
 *
 * Streams out/result.docx with a Word content type and an RFC 5987 filename
 * that keeps the Chinese name intact in every browser.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Windows-forbidden characters plus control codes, collapsed to "_". */
function sanitizeStem(value: string): string {
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const trimmed = cleaned.replace(/^\.+/, "").slice(0, 80).trim();
  return trimmed.length > 0 ? trimmed : "试卷";
}

function draftFilename(jobId: string, createdAt: number): string {
  const date = new Date(createdAt);
  const stamp = Number.isNaN(date.getTime())
    ? new Date().toISOString().slice(0, 10)
    : `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
  const short = jobId.replace(/[^A-Za-z0-9]/g, "").slice(0, 6) || "job";
  return `${sanitizeStem(`试卷_${stamp}_${short}`)}.docx`;
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;

  // Never serve one teacher's exam paper to another.
  const guard = await requireJobAccess(id);
  if (!guard.ok) return guard.response;

  const job = getJob(id);
  if (!job) {
    return new Response(JSON.stringify({ error: "找不到这个任务。" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // Shared with /preview so both routes always serve the same file: what the
  // teacher previews is byte-for-byte what they download.
  const result = resolveResultFile(job);
  const resultPath = result?.path;

  if (!resultPath) {
    return new Response(
      JSON.stringify({
        error: "文档还没生成好。",
        status: job.status,
      }),
      {
        status: 404,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }

  let data: Buffer;
  try {
    data = fs.readFileSync(resultPath);
  } catch (error) {
    return new Response(
      JSON.stringify({ error: `读取文档失败：${(error as Error).message}` }),
      {
        status: 500,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
  }

  const filename = draftFilename(job.id, job.createdAt);
  // ASCII fallback for ancient clients, plus the UTF-8 form every modern
  // browser prefers.
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  const body = new Uint8Array(data);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": DOCX_MIME,
      "Content-Length": String(data.length),
      "Content-Disposition":
        `attachment; filename="${asciiFallback}"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
