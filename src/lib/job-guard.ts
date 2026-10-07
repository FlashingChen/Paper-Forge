import { NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { requireEmailSet } from "@/lib/email-guard";
import { getJob, jobBelongsTo } from "@/lib/jobs";

/**
 * Shared guard for the per-job routes (GET /api/jobs/:id, /events, /download).
 *
 * Middleware already blocks anonymous traffic, but ownership has to be
 * checked per job: teacher A must not be able to read teacher B's logs or
 * download their exam paper by guessing a job id. Admins are allowed through.
 */

export interface JobOwner {
  userId: number;
  role: string;
}

export type GuardResult =
  | { ok: true; owner: JobOwner }
  | { ok: false; response: Response };

export async function requireJobAccess(jobId: string): Promise<GuardResult> {
  initDb();

  // Signed in *and* past the "give us an email" gate: a job's logs and its
  // generated document are as much a part of using the product as uploading.
  const gate = await requireEmailSet();
  if (!gate.ok) return { ok: false, response: gate.response };
  const user = { id: gate.user.userId, role: gate.user.role };

  let job;
  try {
    job = getJob(jobId);
  } catch {
    // sanitizeJobId throws on a malformed id (e.g. path traversal attempt).
    return {
      ok: false,
      response: NextResponse.json({ error: "任务不存在" }, { status: 404 }),
    };
  }

  if (!job) {
    return {
      ok: false,
      response: NextResponse.json({ error: "任务不存在" }, { status: 404 }),
    };
  }

  if (!jobBelongsTo(job, user.id, user.role)) {
    // 404 rather than 403: a 403 would confirm the id exists, which leaks
    // nothing worth leaking but also helps nobody. Keep it uniform.
    return {
      ok: false,
      response: NextResponse.json({ error: "任务不存在" }, { status: 404 }),
    };
  }

  return { ok: true, owner: { userId: user.id, role: user.role } };
}