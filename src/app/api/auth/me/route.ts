import { NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { isEmailSet } from "@/lib/registration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/me
 *
 * Returns the signed-in user and their remaining generations, or 401. The
 * frontend polls this to show "还剩 N 次" and to know whether the contact
 * address still has to be supplied. Deliberately readable before the email is
 * set, so the HUD can offer a way to go and set it.
 */
export async function GET(): Promise<Response> {
  initDb();
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  return NextResponse.json({
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      occupation: user.occupation,
      region: user.region,
      quota: user.quota,
      used: user.used,
      remaining: Math.max(0, user.quota - user.used),
      email: isEmailSet(user.email) ? user.email : null,
      needEmail: !isEmailSet(user.email),
    },
  });
}
