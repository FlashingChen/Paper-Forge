import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { sessionSecret } from "./secret";

const WINDOW_MS = 10 * 60 * 1000;
const SOURCE_LIMIT = 5;
const TOTAL_LIMIT = 60;

function normalizeAddress(address: string): string {
  if (isIP(address) === 4) return address;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  const [left, right] = canonical.split("::");
  const first = left ? left.split(":") : [];
  const last = right ? right.split(":") : [];
  const words = right !== undefined
    ? [...first, ...Array(8 - first.length - last.length).fill("0"), ...last]
    : first;
  // Group IPv6 clients by /64 so rotating interface addresses cannot bypass it.
  return `${words.slice(0, 4).map(word => parseInt(word, 16).toString(16)).join(":")}/64`;
}

function sourceKey(request: Request): string {
  // Enable only for a header overwritten by a trusted ingress, with direct
  // access to the application blocked. Never trust arbitrary forwarded headers.
  const header = process.env.PAPERFORGE_CLIENT_IP_HEADER?.trim();
  let address = header ? request.headers.get(header)?.trim() : undefined;
  const peerHeader = process.env.PAPERFORGE_CLIENT_IP_PEER_HEADER?.trim();
  if (peerHeader) {
    const peer = request.headers.get(peerHeader)?.trim();
    const trusted = (process.env.PAPERFORGE_CLIENT_IP_TRUSTED_PEERS ?? "")
      .split(",").map(value => value.trim()).filter(value => isIP(value));
    // A CDN client header is authoritative only from a verified origin peer.
    // Other peers use the address overwritten by the ingress instead.
    if (!peer || !isIP(peer) || !trusted.includes(peer) || !address || !isIP(address)) {
      address = peer;
    }
  }
  if (!address || !isIP(address)) return "unknown";
  return createHmac("sha256", sessionSecret())
    .update(`registration:${normalizeAddress(address)}`).digest("hex");
}

/** Rolling limits shared by all processes using the application database. */
export function consumeRegistrationAttempt(
  db: DatabaseSync,
  request: Request,
  now = Date.now(),
): { allowed: true } | { allowed: false; retryAfter: number } {
  const source = sourceKey(request);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM registration_attempts WHERE attempted_at <= ?")
      .run(now - WINDOW_MS);
    const total = db.prepare(`SELECT COUNT(*) AS count, MIN(attempted_at) AS oldest
      FROM registration_attempts`).get() as { count: number; oldest: number | null };
    const local = db.prepare(`SELECT COUNT(*) AS count, MIN(attempted_at) AS oldest
      FROM registration_attempts WHERE source_key = ?`).get(source) as typeof total;
    let retryAfter = 0;
    for (const [usage, limit] of [[total, TOTAL_LIMIT], [local, SOURCE_LIMIT]] as const) {
      if (usage.count >= limit && usage.oldest !== null) {
        retryAfter = Math.max(retryAfter, Math.ceil((usage.oldest + WINDOW_MS - now) / 1000), 1);
      }
    }
    if (!retryAfter) {
      db.prepare("INSERT INTO registration_attempts (source_key, attempted_at) VALUES (?, ?)")
        .run(source, now);
    }
    db.exec("COMMIT");
    return retryAfter ? { allowed: false, retryAfter } : { allowed: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
