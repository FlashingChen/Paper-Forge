import { NextResponse } from "next/server";
import { createUser, findUserByEmail, getUserByUsername, listUsers } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { requireAdmin } from "@/lib/admin-guard";
import { EmailTakenError, EMAIL_HINT, EMAIL_TAKEN_MESSAGE, isValidEmail } from "@/lib/registration";
import type { Role } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/admin/users -- list every account with its usage. */
export async function GET(): Promise<Response> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  return NextResponse.json({ users: listUsers() });
}

/**
 * POST /api/admin/users -- create an account.
 *
 * The admin sets the initial password; it is hashed with scrypt before it ever
 * reaches the database. We never echo the password back.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const role: Role = body.role === "admin" ? "admin" : "user";
  const quota =
    typeof body.quota === "number" && Number.isFinite(body.quota) && body.quota >= 0
      ? Math.floor(body.quota)
      : 20;
  // Optional: with an address the account is ready to use, without one the user
  // is asked for it at their first sign-in.
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(username)) {
    return NextResponse.json(
      { error: "用户名只能用字母、数字、下划线、点、@ 或减号，长度 2~32。" },
      { status: 400 },
    );
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "密码至少 8 位。" }, { status: 400 });
  }
  if (email && !isValidEmail(email)) {
    return NextResponse.json({ error: EMAIL_HINT }, { status: 400 });
  }
  if (getUserByUsername(username)) {
    return NextResponse.json({ error: "这个用户名已经存在了。" }, { status: 409 });
  }
  if (email && findUserByEmail(email)) {
    return NextResponse.json({ error: EMAIL_TAKEN_MESSAGE }, { status: 409 });
  }

  try {
    const user = createUser({
      username,
      passwordHash: hashPassword(password),
      role,
      quota,
      email: email || undefined,
    });
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    // Same rule, re-checked while the insert holds the write lock.
    if (error instanceof EmailTakenError) {
      return NextResponse.json({ error: EMAIL_TAKEN_MESSAGE }, { status: 409 });
    }
    throw error;
  }
}
