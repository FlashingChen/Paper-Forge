import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifySessionCookieEdge } from "@/lib/session-edge";

/**
 * Route guard.
 *
 * Middleware runs on the Edge runtime, so it uses `verifySessionCookieEdge`
 * (Web Crypto) rather than the Node auth module — importing that would drag
 * `node:crypto` / `node:path` into the Edge bundle and break the build.
 *
 * It can only check the cookie's HMAC, not re-read the user row, so it is a
 * cheap first gate rather than the real check. Every API route re-reads the
 * user from SQLite via `currentUser()`, which is what actually enforces a
 * disabled account, a deleted account, or an expired session, and every
 * per-job route additionally checks ownership via `requireJobAccess()`.
 * Never treat this file as the only gate.
 */

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // `/` is the public landing page: anyone with the URL can read the pitch and
  // then sign in. The tool itself lives at `/app` and stays behind auth.
  //
  // Static assets must be public too. Public pages serve images — without this the
  // auth wall issues a 307 to /login for every one of them, and the page loads
  // with broken images (found by loading the page, not by reading the code).
  const isStaticAsset = /\.[a-z0-9]{2,5}$/i.test(pathname);

  const isPublic =
    pathname === "/" ||
    pathname === "/beta" ||
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/register" ||
    pathname === "/api/auth/logout" ||
    // Internal execution endpoints authenticate a per-job bearer capability.
    pathname.startsWith("/api/internal/runs/") ||
    pathname.startsWith("/api/internal/nodes/") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/icon") ||
    isStaticAsset;

  if (isPublic) return NextResponse.next();

  const cookie = request.cookies.get("pf_session")?.value;

  try {
    const session = await verifySessionCookieEdge(cookie);
    if (session) return NextResponse.next();
  } catch {
    // A missing SESSION_SECRET in production throws here. Fall through to the
    // redirect/401 rather than crashing the whole app on every request; the Node
    // side will fail loudly on boot with a clearer message.
  }

  // Unauthenticated. API callers get JSON; browsers get the login page.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  // Preserve where they were headed so login can send them back. `/app` is the
  // default destination after signing in, so it needs no `next` hint.
  if (pathname !== "/app") url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next internals and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
