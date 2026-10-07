import { NextResponse } from "next/server";
import { deleteUser, getUserById, resetUsage, setUserPassword, updateUser } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { requireAdmin } from "@/lib/admin-guard";
import type { Role } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function parseId(raw: string): number | null {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** PATCH -- change quota, toggle disabled, change role, reset usage, set password. */
export async function PATCH(request: Request, context: Ctx): Promise<Response> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id: raw } = await context.params;
  const id = parseId(raw);
  if (id === null) {
    return NextResponse.json({ error: "用户编号不合法" }, { status: 400 });
  }

  const target = getUserById(id);
  if (!target) return NextResponse.json({ error: "用户不存在" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 });
  }

  // Never let an admin demote or disable themselves and lock everyone out.
  if (id === guard.userId && (body.disabled === true || body.role === "user")) {
    return NextResponse.json(
      { error: "不能停用或降级自己的账号，否则会失去管理员权限。" },
      { status: 400 },
    );
  }

  if (typeof body.password === "string" && body.password.length > 0) {
    if (body.password.length < 8) {
      return NextResponse.json({ error: "密码至少 8 位。" }, { status: 400 });
    }
    setUserPassword(id, hashPassword(body.password));
  }

  if (body.resetUsage === true) resetUsage(id);

  const patch: { quota?: number; disabled?: boolean; role?: Role } = {};
  if (typeof body.quota === "number" && Number.isFinite(body.quota) && body.quota >= 0) {
    patch.quota = Math.floor(body.quota);
  }
  if (typeof body.disabled === "boolean") patch.disabled = body.disabled;
  if (body.role === "admin" || body.role === "user") patch.role = body.role;

  const user =
    patch.quota !== undefined || patch.disabled !== undefined || patch.role !== undefined
      ? updateUser(id, patch)
      : getUserById(id);

  return NextResponse.json({ user });
}

/** DELETE -- remove an account. Jobs cascade via the foreign key. */
export async function DELETE(_request: Request, context: Ctx): Promise<Response> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id: raw } = await context.params;
  const id = parseId(raw);
  if (id === null) {
    return NextResponse.json({ error: "用户编号不合法" }, { status: 400 });
  }
  if (id === guard.userId) {
    return NextResponse.json({ error: "不能删除自己的账号。" }, { status: 400 });
  }
  if (!deleteUser(id)) {
    return NextResponse.json({ error: "用户不存在" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
