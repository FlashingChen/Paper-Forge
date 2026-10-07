import { NextResponse } from "next/server";
import { initDb } from "./db";
import { currentUser } from "./auth";
import { requireEmailSet } from "./email-guard";

/** Require an admin session. Returns either the user id or a ready response. */
export async function requireAdmin(): Promise<
  { ok: true; userId: number } | { ok: false; response: Response }
> {
  initDb();
  const user = await currentUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "请先登录" }, { status: 401 }),
    };
  }
  if (user.role !== "admin") {
    return {
      ok: false,
      response: NextResponse.json({ error: "只有管理员可以访问" }, { status: 403 }),
    };
  }
  // The address requirement applies to administrators too — the seeded admin
  // starts without one. /account stays reachable, so nobody is locked out.
  const gate = await requireEmailSet();
  if (!gate.ok) return { ok: false, response: gate.response };
  return { ok: true, userId: user.id };
}
