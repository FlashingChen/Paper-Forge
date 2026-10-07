import { NextResponse } from "next/server";
import { reviewBetaApplication } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * PATCH /api/admin/beta-applications/:id  { status, quota? }
 *
 * `status` is the approve/reject decision; `quota` is the separate "give them
 * credits" decision and is only applied on approval. Approving with quota 0 is
 * legitimate: the account works, it just cannot start a generation yet.
 */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id: raw } = await context.params;
  const id = parseId(raw);
  if (id === null) {
    return NextResponse.json({ error: "申请编号不合法" }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 });
  }

  const status = body.status;
  if (status !== "approved" && status !== "rejected") {
    return NextResponse.json({ error: "status 只能是 approved 或 rejected" }, { status: 400 });
  }

  const patch: { status: "approved" | "rejected"; quota?: number; reviewerId: number } = {
    status,
    reviewerId: guard.userId,
  };

  if (body.quota !== undefined) {
    if (typeof body.quota !== "number" || !Number.isFinite(body.quota) || body.quota < 0) {
      return NextResponse.json({ error: "配额要填 0 或正整数。" }, { status: 400 });
    }
    patch.quota = Math.floor(body.quota);
  }

  const user = reviewBetaApplication(id, patch);
  if (!user) {
    return NextResponse.json({ error: "找不到这条内测申请" }, { status: 404 });
  }
  return NextResponse.json({ user });
}
