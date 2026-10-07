/**
 * Session verification for the Edge runtime.
 *
 * `src/middleware.ts` runs on the Edge runtime, where `node:crypto` and
 * `node:path` do not exist — importing the full auth module there breaks the
 * webpack build. This module is the Edge-safe subset: it only needs to check a
 * cookie's HMAC, which the Web Crypto API can do.
 *
 * It deliberately does NOT talk to the database. Middleware is a cheap first
 * gate that keeps anonymous traffic away; the authoritative checks (account
 * still exists, not disabled, job ownership) all happen in the Node route
 * handlers via `currentUser()`. Never rely on this file alone.
 *
 * Node and Edge must agree on the secret and the payload format, so the signing
 * side lives in `src/lib/auth.ts` and the two are kept in step by the shared
 * constants below.
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Matches sessionSecret() in src/lib/config.ts. */
function secret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  // Mirror secret.ts: throw in production so we never sign a cookie with a
  // guessable key, but stay quiet during `next build`, which evaluates route
  // modules without a live server.
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
    throw new Error("SESSION_SECRET is required in production");
  }
  return "paperforge-development-secret-do-not-use-in-production";
}

export interface EdgeSession {
  uid: number;
  username: string;
  role: string;
  iat: number;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  // Allocate over an explicit ArrayBuffer: TypeScript 5.7 made Uint8Array
  // generic over its buffer, and Web Crypto's BufferSource wants a plain
  // ArrayBuffer rather than a possibly-shared one.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes as Uint8Array<ArrayBuffer>;
}

/**
 * Verify a signed session cookie. Returns the payload, or null when the cookie
 * is absent, tampered with, malformed, or expired.
 */
export async function verifySessionCookieEdge(
  value: string | undefined,
): Promise<EdgeSession | null> {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = value.slice(0, dot);
  const mac = value.slice(dot + 1);

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  let valid: boolean;
  try {
    valid = await globalThis.crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(mac),
      new TextEncoder().encode(body) as Uint8Array<ArrayBuffer>,
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: EdgeSession;
  try {
    payload = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as EdgeSession;
  } catch {
    return null;
  }
  if (typeof payload.uid !== "number" || typeof payload.iat !== "number") return null;
  if (Date.now() - payload.iat > SESSION_TTL_MS) return null;
  return payload;
}