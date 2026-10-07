/**
 * The HMAC secret used for session cookies and for encrypting the stored API
 * key.
 *
 * This lives in its own module with zero imports on purpose. It is needed by
 * config.ts, db.ts, auth.ts and the Edge middleware, and putting it in config.ts
 * creates a cycle (config reads admin settings from the DB, the DB needs the
 * secret to seed the admin). Keeping it dependency-free means every one of them
 * can import it normally, with no `require()` escape hatch and no cycle.
 */
/**
 * Whether we are running under `next build`.
 *
 * Next evaluates route modules while collecting page data, so anything that
 * throws at import time breaks the build rather than the running app. A missing
 * SESSION_SECRET must therefore fail loudly at *runtime* but stay quiet during
 * the build, where there is no server yet to protect.
 */
function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

export function sessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  if (process.env.NODE_ENV === "production" && !isBuildPhase()) {
    throw new Error(
      "SESSION_SECRET is required in production. Generate one with: " +
        "openssl rand -base64 32",
    );
  }
  // Development and build phase. Deliberately constant so `npm run dev` restarts
  // do not log you out.
  return "paperforge-development-secret-do-not-use-in-production";
}
