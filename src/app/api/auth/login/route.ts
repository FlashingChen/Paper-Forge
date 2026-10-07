import { NextResponse } from "next/server";
import {
  getLoginCredentialsByUsername,
  getUserByUsername,
  initDb,
  touchLogin,
} from "@/lib/db";
import { startSession, verifyPassword } from "@/lib/auth";
import { isEmailSet } from "@/lib/registration";

/**
 * POST /api/auth/login  { username, password }
 *
 * Sets an httpOnly signed cookie on success.
 *
 * Two things are deliberate here:
 *
 *  - The failure message is the same for "no such user" and "wrong password",
 *    so the endpoint cannot be used to discover which usernames exist.
 *  - A dummy hash is verified when the account does not exist, so the response
 *    takes about the same time either way. Without it, a missing account would
 *    return instantly and leak existence through timing.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENERIC_ERROR = "用户名或密码不对";

/** A well-formed hash that verifies against nothing, used to burn CPU time. */
const DUMMY_HASH = `scrypt$16384$8$1$${"00".repeat(16)}${"00".repeat(64)}`;

export async function POST(request: Request): Promise<Response> {
  initDb();

  let body: { username?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 });
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    return NextResponse.json({ error: "请填写用户名和密码" }, { status: 400 });
  }

  const credentials = getLoginCredentialsByUsername(username);
  const user = getUserByUsername(username);

  // Always run a verification, even for a missing account.
  const passwordOk = verifyPassword(password, credentials?.passwordHash ?? DUMMY_HASH);

  if (!user || !credentials || !passwordOk) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  if (user.disabled) {
    return NextResponse.json({ error: "这个账号已被停用，请联系管理员" }, { status: 403 });
  }

  // A self-registered account only works once its beta application is approved.
  // This runs after the password check so it cannot be used to probe for names.
  if (user.betaStatus === "pending") {
    return NextResponse.json(
      { error: "你的内测申请还在审核中，通过后就能登录了。" },
      { status: 403 },
    );
  }
  if (user.betaStatus === "rejected") {
    return NextResponse.json(
      { error: "这次内测申请没有通过。想了解原因可以联系内测联系人。" },
      { status: 403 },
    );
  }

  await startSession(user, credentials.sessionVersion);
  touchLogin(user.id);

  // Signing in still succeeds so the user can reach /account — the session
  // is what lets them save it. But every route that does actual work is closed
  // until the address is on file (see requireEmailSet), and this flag is how the
  // sign-in page knows to send them there instead of to the upload page.
  const needEmail = !isEmailSet(user.email);

  return NextResponse.json({
    ok: true,
    needEmail,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      quota: user.quota,
      used: user.used,
      remaining: Math.max(0, user.quota - user.used),
    },
  });
}
