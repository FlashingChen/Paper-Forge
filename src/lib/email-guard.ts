import { NextResponse } from "next/server";
import { currentUser } from "./auth";
import { isEmailSet } from "./registration";

/**
 * "Every account must have a contact address" — enforced, not just suggested.
 *
 * Accounts that predate the email field hold the `'null'` sentinel, so the very
 * next sign-in has to collect one. The login route reports that state and the
 * sign-in page sends the user to /account, but a redirect is not a rule:
 * this is what actually stops an address-less account from doing any work if it
 * skips the prompt and calls the API directly.
 *
 * What stays reachable while the address is missing, by design:
 *   POST /api/auth/email     (the point of the exercise)
 *   GET  /api/auth/me        (so the UI knows to nag)
 *   POST /api/auth/logout
 *   POST /api/auth/password  (unrelated to contact info; also uses currentUser)
 */

export interface EmailGate {
  userId: number;
  username: string;
  role: "user" | "admin";
  /** Carried along so callers need not re-read the account just for the quota. */
  quota: number;
  used: number;
}

export type EmailGuardResult =
  | { ok: true; user: EmailGate }
  | { ok: false; response: Response };

export const EMAIL_REQUIRED_CODE = "email_required";

export const EMAIL_REQUIRED_MESSAGE =
  "请先填写邮箱，我们再开始生成。这是内测期间的联系方式，填一次就好。";

export async function requireEmailSet(): Promise<EmailGuardResult> {
  const user = await currentUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "请先登录" }, { status: 401 }),
    };
  }
  if (!isEmailSet(user.email)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: EMAIL_REQUIRED_MESSAGE, code: EMAIL_REQUIRED_CODE },
        { status: 409 },
      ),
    };
  }
  return {
    ok: true,
    user: {
      userId: user.id,
      username: user.username,
      role: user.role,
      quota: user.quota,
      used: user.used,
    },
  };
}
