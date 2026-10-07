import { getSetting, rawDb, setSetting } from "./db";
import { estimateCost, parsePrice, parseUsage } from "./usage-types";
import type { UsagePrice } from "./usage-types";

function priceKey(provider: string, model: string): string {
  return `usage.price.${JSON.stringify([provider, model])}`;
}
export function readUsagePrice(provider: string, model: string): UsagePrice | null {
  try { return parsePrice(JSON.parse(getSetting(priceKey(provider, model)) ?? "null")); }
  catch { return null; }
}
export function saveUsagePrice(provider: string, model: string, price: UsagePrice): void {
  setSetting(priceKey(provider, model), JSON.stringify(price));
}

export function recordMessageUsage(jobId: string, sequence: number, message: Record<string, unknown>, provider: string, model: string, price: UsagePrice | null): void {
  const usage = parseUsage(message.usage);
  const raw = message.usage as { cost?: { total?: unknown } } | undefined;
  const reported = raw?.cost?.total;
  // Catalog costs are estimates, and zero often means no catalog price exists.
  const catalogCost = typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? reported : null;
  const cost = usage && price ? estimateCost(usage, price) : usage ? catalogCost : null;
  rawDb().prepare(`INSERT OR IGNORE INTO model_usage
    (job_id, sequence, created_at, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_usd, cost_source, price_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      jobId, sequence, Date.now(), provider, model,
      usage?.input ?? null, usage?.output ?? null, usage?.cacheRead ?? null,
      usage?.cacheWrite ?? null, usage?.total ?? null, cost,
      cost === null ? null : price ? "configured" : "catalog",
      price ? JSON.stringify(price) : null,
    );
}

export function usageReport() {
  const db = rawDb();
  const summary = db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens,
    COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
    COALESCE(SUM(cache_read_tokens), 0) AS cacheRead, COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
    SUM(cost_usd) AS costUsd, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedCalls,
    SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END) AS unknownCalls FROM model_usage`).get();
  const jobs = db.prepare(`SELECT j.id, j.status, j.created_at AS createdAt, j.image_count AS imageCount,
    COUNT(u.sequence) AS calls, SUM(u.total_tokens) AS tokens, SUM(u.input_tokens) AS input,
    SUM(u.output_tokens) AS output, SUM(u.cache_read_tokens) AS cacheRead, SUM(u.cache_write_tokens) AS cacheWrite,
    SUM(u.cost_usd) AS costUsd, COUNT(u.sequence) - COUNT(u.cost_usd) AS unpricedCalls,
    COUNT(u.sequence) - COUNT(u.total_tokens) AS unknownCalls,
    GROUP_CONCAT(DISTINCT u.provider || '/' || u.model) AS models,
    GROUP_CONCAT(DISTINCT u.cost_source) AS sources
    FROM jobs j LEFT JOIN model_usage u ON u.job_id = j.id
    GROUP BY j.id ORDER BY j.created_at DESC LIMIT 200`).all();
  return { summary, jobs };
}
