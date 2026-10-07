import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionSecret } from "./secret";
import type { ModelCapabilities } from "./auth";


export interface PaperForgeEnv {

  apiKey?: string;

  provider: string;
  baseUrl: string;
  model: string;
  jobsDir: string;

  timeoutMs: number;

  maxImages: number;

  python: string;

  sessionSecret: string;

  capabilities: ModelCapabilities;
}

const DEFAULT_PROVIDER = "deepseek";


export const DEEPSEEK_CATALOG_MODEL = "deepseek-flash";
const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_MAX_IMAGES = 20;


export function resolvePiBin(): string {
  return str(process.env.PAPERFORGE_PI_BIN) ?? "pi";
}

function str(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function int(value: string | undefined, fallback: number): number {
  const raw = str(value);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}


export function piAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

export function authJsonPath(): string {
  return path.join(piAgentDir(), "auth.json");
}


function readAuthJsonKey(): string | undefined {
  try {
    const raw = fs.readFileSync(authJsonPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const entry = (parsed as Record<string, unknown>)["deepseek"];
    if (!entry || typeof entry !== "object") return undefined;
    const key = (entry as Record<string, unknown>)["key"];
    return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}


export function modelsJsonPath(): string {
  return path.join(piAgentDir(), "models.json");
}


export interface ModelsJsonModel {
  id: string;
  name?: string;

  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;

  [key: string]: unknown;
}


export interface ModelsJsonProvider {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  compat?: Record<string, unknown>;
  models?: ModelsJsonModel[];
  [key: string]: unknown;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}


function normalizeModels(value: unknown): ModelsJsonModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models: ModelsJsonModel[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      models.push({ id: entry.trim() });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = str(record["id"] as string | undefined);
    if (!id) continue;
    models.push({
      ...record,
      id,
      input: Array.isArray(record["input"])
        ? record["input"].filter((v): v is string => typeof v === "string")
        : undefined,
      contextWindow: numeric(record["contextWindow"]),
      maxTokens: numeric(record["maxTokens"]),
      reasoning:
        typeof record["reasoning"] === "boolean" ? record["reasoning"] : undefined,
    });
  }
  return models.length > 0 ? models : undefined;
}


export function readModelsJsonProvider(provider: string): ModelsJsonProvider | undefined {
  try {
    const raw = fs.readFileSync(modelsJsonPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const providers = (parsed as Record<string, unknown>)?.["providers"];
    if (!providers || typeof providers !== "object") return undefined;
    const byKey = providers as Record<string, unknown>;

    // Exact key first, then case-insensitively. pi itself matches provider names
    // case-insensitively, so `CommandCode` and `commandcode` are the same
    // provider to it; looking up only the exact key would silently throw away
    // the operator's declaration (and with it, e.g. `reasoning: true`).
    const key = provider in byKey
      ? provider
      : Object.keys(byKey).find((name) => name.toLowerCase() === provider.toLowerCase());
    if (!key) return undefined;
    const entry = byKey[key];
    if (!entry || typeof entry !== "object") return undefined;

    const record = entry as Record<string, unknown>;
    return {
      ...record,
      name: str(record["name"] as string | undefined),
      baseUrl: str(record["baseUrl"] as string | undefined),
      api: str(record["api"] as string | undefined),
      apiKey: str(record["apiKey"] as string | undefined),
      models: normalizeModels(record["models"]),
    };
  } catch {
    return undefined;
  }
}


export function resolveApiKey(provider = resolveProvider()): string {
  const fromEnv = str(process.env.PAPERFORGE_API_KEY) ?? str(process.env.DEEPSEEK_API_KEY);
  if (fromEnv) return fromEnv;

  const fromModels = readModelsJsonProvider(provider);
  if (fromModels?.apiKey) return fromModels.apiKey;

  const fromAuth = readAuthJsonKey();
  if (fromAuth) return fromAuth;

  throw new Error(
    `No API key found for provider "${provider}". Set PAPERFORGE_API_KEY in the ` +
      `server environment, or add an apiKey for "${provider}" to ` +
      `${modelsJsonPath()}, or add a "deepseek" entry to ${authJsonPath()}.`,
  );
}


export function resolveProvider(): string {
  return str(process.env.PAPERFORGE_PROVIDER) ?? DEFAULT_PROVIDER;
}


export function tryResolveApiKey(provider?: string): string | undefined {
  try {
    return resolveApiKey(provider);
  } catch {
    return undefined;
  }
}


export function resolvePythonBin(): string {
  const fromEnv = str(process.env.PAPERFORGE_PYTHON);
  if (fromEnv) return fromEnv;

  const venvPython = "/opt/venv/bin/python";
  try {
    fs.accessSync(venvPython, fs.constants.X_OK);
    return venvPython;
  } catch {
    return "python3";
  }
}


export function defaultJobsDir(): string {
  return path.join(process.cwd(), ".jobs");
}


export function referenceSourceDir(): string {
  return path.join(process.cwd(), "reference");
}


export function taskBriefPath(): string {
  return path.join(process.cwd(), "agent", "TASK_BRIEF.md");
}


export function previewScriptPath(): string {
  return path.join(process.cwd(), "scripts", "docx_preview.py");
}


export function snippetsSourceDir(): string {
  return path.join(process.cwd(), "agent", "snippets");
}


export function loadEnv(): PaperForgeEnv {
  const provider = resolveProvider();
  const fromModels = readModelsJsonProvider(provider);
  return {
    provider,
    apiKey: tryResolveApiKey(provider),
    baseUrl:
      str(process.env.PAPERFORGE_BASE_URL) ??
      str(process.env.DEEPSEEK_BASE_URL) ??
      fromModels?.baseUrl ??
      "",
    model: str(process.env.PAPERFORGE_MODEL) ?? str(process.env.DEEPSEEK_MODEL) ?? "",
    jobsDir: str(process.env.PAPERFORGE_JOBS_DIR) ?? defaultJobsDir(),
    timeoutMs: int(process.env.PAPERFORGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxImages: int(process.env.PAPERFORGE_MAX_IMAGES, DEFAULT_MAX_IMAGES),
    python: resolvePythonBin(),
    sessionSecret: sessionSecret(),
    capabilities: {},
  };
}


export function loadRunEnv(): PaperForgeEnv {
  const base = loadEnv();
  let stored: {
    provider: string;
    baseUrl: string;
    model: string;
    apiKey: string;
    capabilities: ModelCapabilities;
  };
  try {
    const { readModelSettings } = requireAuthModule();
    stored = readModelSettings();
  } catch {
    return base;
  }

  const provider = str(stored.provider) ?? base.provider;
  return {
    ...base,
    provider,
    capabilities: stored.capabilities ?? base.capabilities,
    apiKey: str(stored.apiKey) ?? base.apiKey,
    baseUrl: str(stored.baseUrl) ?? base.baseUrl,
    model: str(stored.model) ?? base.model,
  };
}


function requireAuthModule(): typeof import("./auth") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./auth") as typeof import("./auth");
}
