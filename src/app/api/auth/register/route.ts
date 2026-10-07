import { NextResponse } from "next/server";
import { hashPassword } from "@/lib/auth";
import { createUser, findUserByEmail, getUserByUsername, initDb, rawDb } from "@/lib/db";
import { EmailTakenError, EMAIL_TAKEN_MESSAGE, parseRegistration } from "@/lib/registration";
import { isSameOriginRequest } from "@/lib/request-origin";
import { consumeRegistrationAttempt } from "@/lib/registration-rate-limit";

/**
 * POST /api/auth/register  { username, password, occupation, region }
 *
 * Creates a pending account and its beta application in one row. Nothing is
 * granted here: the account starts with quota 0 and `beta_status = 'pending'`,
 * so it can neither sign in nor spend anything until an administrator approves
 * it from `/admin/applications`.
 *
 * No session cookie is issued on purpose — a pending applicant has nothing to
 * sign in to, and issuing a cookie would imply the account is usable.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ error: "请求来源不受信任。" }, { status: 403 });
  }
  initDb();

  const limit = consumeRegistrationAttempt(rawDb(), request);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "申请提交过于频繁，请稍后再试。" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter), "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 });
  }

  const parsed = parseRegistration(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { username, password, email, occupation, region } = parsed.value;

  if (getUserByUsername(username)) {
    return NextResponse.json({ error: "这个用户名已经有人用了，换一个吧。" }, { status: 409 });
  }
  // Checked here so the refusal is immediate and the password is not hashed for
  // nothing; createUser enforces the same rule again while it holds the write
  // lock, which is what settles a race between two applicants.
  if (findUserByEmail(email)) {
    return NextResponse.json({ error: EMAIL_TAKEN_MESSAGE }, { status: 409 });
  }

  try {
    createUser({
      username,
      passwordHash: hashPassword(password),
      role: "user",
      quota: 0,
      email,
      application: { occupation, region },
    });
  } catch (error) {
    // The unique username index is the tie-breaker when two people register the
    // same name between the check above and this insert.
    if (error instanceof EmailTakenError) {
      return NextResponse.json({ error: EMAIL_TAKEN_MESSAGE }, { status: 409 });
    }
    return NextResponse.json({ error: "这个用户名已经有人用了，换一个吧。" }, { status: 409 });
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
