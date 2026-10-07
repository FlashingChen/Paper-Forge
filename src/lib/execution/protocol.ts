import type { ModelCapabilities } from "../auth";
import type { Job, LogEntry } from "../types";
import type { UsagePrice } from "../usage-types";

export interface RunManifest {
  version: 1;
  jobId: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  capabilities: ModelCapabilities;
  declared?: Record<string, unknown>;
  timeoutMs: number;
  imageEnv: Record<string, string>;
  images: { index: number; filename: string }[];
  price: UsagePrice | null;
}

export interface UsageRow {
  sequence: number;
  created_at: number;
  provider: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cost_source: string | null;
  price_json: string | null;
}

export interface RunSnapshot {
  execution: string;
  sequence: number;
  status: "running" | "done" | "error";
  logs: LogEntry[];
  note?: string;
  error?: string;
  usage: UsageRow[];
}

export function snapshotFor(job: Job, execution: string, sequence: number, usage: UsageRow[]): RunSnapshot {
  return { execution, sequence, status: job.status === "queued" ? "running" : job.status,
    logs: job.logs, note: job.note, error: job.error, usage };
}

export function parseSnapshot(value: unknown): RunSnapshot {
  if (!value || typeof value !== "object") throw new Error("Invalid snapshot");
  const s = value as RunSnapshot;
  if (typeof s.execution !== "string" || !s.execution || s.execution.length > 256 ||
      !Number.isSafeInteger(s.sequence) || s.sequence < 1 ||
      !["running", "done", "error"].includes(s.status) ||
      !Array.isArray(s.logs) || s.logs.length > 2000 ||
      !Array.isArray(s.usage) || s.usage.length > 10000 ||
      (s.note !== undefined && typeof s.note !== "string") ||
      (s.error !== undefined && typeof s.error !== "string")) throw new Error("Invalid snapshot");
  for (const log of s.logs) {
    if (!log || !Number.isFinite(log.ts) || typeof log.text !== "string" ||
      log.text.length > 100000 || !["info", "warn", "error", "success"].includes(log.level)) {
      throw new Error("Invalid log");
    }
  }
  for (const u of s.usage) {
    if (!u || !Number.isSafeInteger(u.sequence) || u.sequence < 1 ||
        !Number.isFinite(u.created_at) || typeof u.provider !== "string" || typeof u.model !== "string" ||
        ![u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.total_tokens, u.cost_usd]
          .every(n => n === null || (Number.isFinite(n) && n! >= 0)) ||
        ![null, "catalog", "configured"].includes(u.cost_source) ||
        !(u.price_json === null || typeof u.price_json === "string")) throw new Error("Invalid usage");
  }
  return s;
}
