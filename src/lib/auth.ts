import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { cookies } from "next/headers";
import { deleteSetting, getSetting, setSetting, getUserById, getUserSessionVersion } from "./db";
import { sessionSecret } from "./secret";
import type { Role } from "./db";


const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEYLEN = 64;


export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString("hex"),
    hash.toString("hex"),
  ].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const expected = Buffer.from(hashHex, "hex");
  let actual: Buffer;
  try {
    actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length, {
      N,
      r,
      p,
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/* --------------------------------------------------------- session cookie */

const COOKIE_NAME = "pf_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface Session {
  uid: number;
  username: string;
  role: Role;

  iat: number;
  version?: number;
}


function sign(payload: Session): string {
  const secret = sessionSecret();
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifySessionCookie(value: string | undefined): Session | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const mac = value.slice(dot + 1);

  const expected = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: Session;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
  } catch {
    return null;
  }
  if (typeof payload.uid !== "number" || typeof payload.iat !== "number") return null;
  if (Date.now() - payload.iat > SESSION_TTL_MS) return null;
  return payload;
}


function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

export async function startSession(
  user: { id: number; username: string; role: Role },
  version: number,
): Promise<void> {
  // Use the version read with the verified hash, even if another process has
  // reset the password during verification or while awaiting the cookie jar.
  const jar = await cookies();
  jar.set(
    COOKIE_NAME,
    sign({ uid: user.id, username: user.username, role: user.role, iat: Date.now(), version }),
    cookieOptions(),
  );
}

export async function endSession(): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, "", { ...cookieOptions(), maxAge: 0 });
}


export async function currentUser(): Promise<
  {
    id: number;
    username: string;
    role: Role;
    quota: number;
    used: number;
    email: string;
    occupation: string | null;
    region: string | null;
  } | null
> {
  const jar = await cookies();
  const session = verifySessionCookie(jar.get(COOKIE_NAME)?.value);
  if (!session) return null;
  const user = getUserById(session.uid);
  if (!user || user.disabled) return null;
  // Approval can be revoked after a session was issued; re-reading the row here
  // is what makes that take effect on the very next request.
  if (user.betaStatus !== "approved") return null;
  if ((session.version ?? 0) !== getUserSessionVersion(user.id)) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    quota: user.quota,
    used: user.used,
    // The sentinel means "never provided"; deciding what to do about that is
    // the caller's job — requireEmailSet() is the gate.
    email: user.email,
    occupation: user.occupation,
    region: user.region,
  };
}

export function requireAdminRole(role: Role): boolean {
  return role === "admin";
}

/* --------------------------------------------------- encrypted API key at rest */

const SETTING_API_KEY = "model.api_key";
const SETTING_PROVIDER = "model.provider";
const SETTING_BASE_URL = "model.base_url";
const SETTING_MODEL = "model.model";
const SETTING_CAP_VISION = "model.cap.vision";
const SETTING_CAP_REASONING = "model.cap.reasoning";
const SETTING_CAP_CONTEXT = "model.cap.context_window";
const SETTING_CAP_MAX_TOKENS = "model.cap.max_tokens";
const SETTING_CAP_COMPAT = "model.cap.compat";


function encryptionKey(): Buffer {
  return createHmac("sha256", sessionSecret()).update("paperforge:api-key").digest();
}

export function encryptSecret(plain: string): string {
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptSecret(stored: string): string {
  if (!stored) return "";
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return "";
  try {
    const [, ivB64, tagB64, dataB64] = parts;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(ivB64, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return "";
  }
}


export interface ModelCapabilities {

  vision?: boolean | null;

  reasoning?: boolean | null;
  contextWindow?: number | null;
  maxTokens?: number | null;

  /** Field names are nullable on purpose: the console sends an explicit null for
   *  every capability left on 自动, and that null has to be handled, not cast
   *  away. See resolveProviderConfig — a null written into the generated
   *  models.json makes pi reject the whole provider. */
  compat?: Record<string, unknown> | null;
}

export interface ModelSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  capabilities: ModelCapabilities;
}

function readBoolSetting(key: string): boolean | undefined {
  const raw = getSetting(key);
  if (raw === undefined || raw === "") return undefined;
  return raw === "1" || raw.toLowerCase() === "true";
}

function readIntSetting(key: string): number | undefined {
  const raw = getSetting(key);
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}


export function readModelCapabilities(): ModelCapabilities {
  const capabilities: ModelCapabilities = {
    vision: readBoolSetting(SETTING_CAP_VISION),
    reasoning: readBoolSetting(SETTING_CAP_REASONING),
    contextWindow: readIntSetting(SETTING_CAP_CONTEXT),
    maxTokens: readIntSetting(SETTING_CAP_MAX_TOKENS),
  };
  const compatRaw = getSetting(SETTING_CAP_COMPAT);
  if (compatRaw) {
    try {
      const parsed: unknown = JSON.parse(compatRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        capabilities.compat = parsed as Record<string, unknown>;
      }
    } catch {
    }
  }
  return capabilities;
}


export interface CapabilityInput {
  vision?: boolean | null;
  reasoning?: boolean | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  compat?: Record<string, unknown> | null;
}

export type CapabilityParse =
  | { ok: true; value: CapabilityInput }
  | { ok: false; error: string };

export function parseCapabilityInput(raw: unknown): CapabilityParse {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "capabilities 必须是一个对象。" };
  }
  const input = raw as Record<string, unknown>;

  const tri = (value: unknown): boolean | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    if (value === true || value === "true" || value === 1 || value === "1") return true;
    if (value === false || value === "false" || value === 0 || value === "0") return false;
    return undefined;
  };

  const count = (value: unknown, label: string): number | null | undefined | Error => {
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return new Error(`${label}要填一个正整数。`);
    return Math.floor(parsed);
  };

  let compat: Record<string, unknown> | null | undefined;
  const compatRaw = input.compat;
  if (compatRaw === null || compatRaw === "") compat = null;
  else if (typeof compatRaw === "string") {
    try {
      const parsed: unknown = JSON.parse(compatRaw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: "端点兼容（compat）要是一个 JSON 对象。" };
      }
      compat = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, error: "端点兼容（compat）不是合法 JSON。" };
    }
  } else if (compatRaw && typeof compatRaw === "object") {
    compat = compatRaw as Record<string, unknown>;
  }

  const contextWindow = count(input.contextWindow, "上下文窗口");
  if (contextWindow instanceof Error) return { ok: false, error: contextWindow.message };
  const maxTokens = count(input.maxTokens, "输出上限");
  if (maxTokens instanceof Error) return { ok: false, error: maxTokens.message };

  return {
    ok: true,
    value: {
      vision: tri(input.vision),
      reasoning: tri(input.reasoning),
      contextWindow,
      maxTokens,
      compat,
    },
  };
}


export function readModelSettings(): ModelSettings {
  const provider = getSetting(SETTING_PROVIDER) ?? process.env.PAPERFORGE_PROVIDER ?? "";
  const baseUrl = getSetting(SETTING_BASE_URL) ?? process.env.PAPERFORGE_BASE_URL ?? "";
  const model = getSetting(SETTING_MODEL) ?? process.env.PAPERFORGE_MODEL ?? "";
  const encrypted = getSetting(SETTING_API_KEY);
  const apiKey = encrypted ? decryptSecret(encrypted) : "";
  return { provider, baseUrl, model, apiKey, capabilities: readModelCapabilities() };
}

export function writeModelSettings(input: {
  provider: string;
  baseUrl: string;
  model: string;

  apiKey?: string | null;

  capabilities?: {
    vision?: boolean | null;
    reasoning?: boolean | null;
    contextWindow?: number | null;
    maxTokens?: number | null;
    compat?: Record<string, unknown> | null;
  };
}): void {
  if (input.provider.trim()) setSetting(SETTING_PROVIDER, input.provider.trim());
  if (input.baseUrl.trim()) setSetting(SETTING_BASE_URL, input.baseUrl.trim());
  if (input.model.trim()) setSetting(SETTING_MODEL, input.model.trim());

  const capabilities = input.capabilities;
  if (capabilities) {
    const bool = (key: string, value: boolean | null | undefined) => {
      if (value === undefined) return;
      if (value === null) deleteSetting(key);
      else setSetting(key, value ? "1" : "0");
    };
    const int = (key: string, value: number | null | undefined) => {
      if (value === undefined) return;
      if (value === null) deleteSetting(key);
      else setSetting(key, String(value));
    };
    bool(SETTING_CAP_VISION, capabilities.vision);
    bool(SETTING_CAP_REASONING, capabilities.reasoning);
    int(SETTING_CAP_CONTEXT, capabilities.contextWindow);
    int(SETTING_CAP_MAX_TOKENS, capabilities.maxTokens);
    if (capabilities.compat !== undefined) {
      if (capabilities.compat === null) deleteSetting(SETTING_CAP_COMPAT);
      else setSetting(SETTING_CAP_COMPAT, JSON.stringify(capabilities.compat));
    }
  }
  if (input.apiKey === undefined) return;
  if (input.apiKey === null) {
    deleteSetting(SETTING_API_KEY);
    return;
  }
  if (input.apiKey) setSetting(SETTING_API_KEY, encryptSecret(input.apiKey));
}


export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
