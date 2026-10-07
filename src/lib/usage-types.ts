export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}
export interface UsagePrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function parseUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
  if (!keys.every((key) => typeof record[key] === "number" && Number.isSafeInteger(record[key]) && (record[key] as number) >= 0)) return null;
  const usage = Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as Omit<TokenUsage, "total">;
  return { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite };
}

export function parsePrice(value: unknown): UsagePrice | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
  if (!keys.every((key) => typeof record[key] === "number" && Number.isFinite(record[key]) && (record[key] as number) >= 0 && (record[key] as number) <= 1_000_000)) return null;
  return Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as UsagePrice;
}

export function estimateCost(usage: TokenUsage, price: UsagePrice): number {
  return (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1_000_000;
}
