/** Keep post-login and post-onboarding navigation inside the application. */
export function loginReturnTarget(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || /[\\\x00-\x20]/.test(next)) return "/app";
  return next;
}

export function accountReturnTarget(next: string | null | undefined): string {
  const target = loginReturnTarget(next);
  // Returning to settings would otherwise trap the onboarding flow there.
  const pathname = target.split(/[?#]/)[0];
  if (pathname === "/account" || pathname.startsWith("/account/") || pathname === "/login" || pathname === "/register") return "/app";
  return target;
}
