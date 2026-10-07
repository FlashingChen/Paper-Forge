import { NextResponse } from "next/server";
import { currentUser, endSession } from "@/lib/auth";
import { initDb } from "@/lib/db";
import { changeOwnPassword } from "@/lib/password";
import { isSameOriginRequest } from "@/lib/request-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Browser requests must originate from this app.
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源不受信任。" }, { status: 403 });
  }
  initDb();
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 });
  }
  const result = changeOwnPassword(user.id, input);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  await endSession();
  return NextResponse.json({ ok: true });
}
