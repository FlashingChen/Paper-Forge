import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { findUserByEmail, initDb, setUserEmail } from "@/lib/db";
import {
  EmailTakenError,
  EMAIL_HINT,
  EMAIL_TAKEN_MESSAGE,
  isValidEmail,
} from "@/lib/registration";
import { isSameOriginRequest } from "@/lib/request-origin";

/**
 * POST /api/auth/email  { email }
 *
 * Records the signed-in user's contact address. This is the one action an
 * account without an address is allowed to take, so it deliberately does not
 * require the account to have one already — see requireEmailSet().
 *
 * No password confirmation: the address is contact information, not a
 * credential, and the user is already authenticated.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源不受信任。" }, { status: 403 });
  }
  initDb();

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 });
  }
  const value = (body as { email?: unknown }).email;
  const email = typeof value === "string" ? value.trim() : "";
  if (!email) {
    return NextResponse.json({ error: "请填写邮箱。" }, { status: 400 });
  }
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: EMAIL_HINT }, { status: 400 });
  }

  // The account's own address is excluded, so re-saving what it already owns
  // stays a no-op rather than a conflict.
  if (findUserByEmail(email, user.id)) {
    return NextResponse.json({ error: EMAIL_TAKEN_MESSAGE }, { status: 409 });
  }

  try {
    setUserEmail(user.id, email);
  } catch (error) {
    // Same rule, re-checked while the update holds the write lock.
    if (error instanceof EmailTakenError) {
      return NextResponse.json({ error: EMAIL_TAKEN_MESSAGE }, { status: 409 });
    }
    throw error;
  }
  return NextResponse.json({ ok: true, email });
}
