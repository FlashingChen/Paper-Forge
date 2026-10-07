import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("usage persists, deduplicates and includes failed and unpriced tasks without rewriting history", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-usage-test-"));
  process.env.PAPERFORGE_DB_PATH = path.join(dir, "test.db");
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  const db = await import("../src/lib/db");
  const usage = await import("../src/lib/usage");
  try {
    db.migrate();
    db.migrate();
    for (const id of ["failed", "unknown", "legacy", "catalog"]) db.insertJob({ id, userId: 0, status: "error", createdAt: 1, imageCount: 1 });
    const price = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 3 };
    const message = { usage: { input: 100, output: 40, cacheRead: 200, cacheWrite: 10, cost: { total: 0 } } };
    usage.saveUsagePrice("example", "model", price);
    assert.deepEqual(usage.readUsagePrice("example", "model"), price);
    usage.recordMessageUsage("failed", 1, message, "example", "model", price);
    usage.recordMessageUsage("failed", 1, message, "example", "model", price);
    usage.recordMessageUsage("unknown", 1, { usage: {} }, "example", "model", null);
    usage.recordMessageUsage("catalog", 1, { usage: { ...message.usage, cost: { total: 0.01 } } }, "example", "model", null);
    usage.saveUsagePrice("example", "model", { ...price, input: 20 });
    const report = usage.usageReport() as { summary: { calls: number; tokens: number; costUsd: number; unknownCalls: number; unpricedCalls: number }; jobs: { id: string; calls: number; tokens: number | null; costUsd: number | null }[] };
    assert.equal(report.summary.calls, 3);
    assert.equal(report.summary.tokens, 700);
    assert.equal(report.summary.unknownCalls, 1);
    assert.equal(report.summary.unpricedCalls, 1);
    assert.equal(report.jobs.find(job => job.id === "failed")?.costUsd, 0.00067);
    assert.equal(report.jobs.find(job => job.id === "legacy")?.tokens, null);
    assert.equal(report.jobs.find(job => job.id === "legacy")?.calls, 0);
    assert.equal(report.jobs.find(job => job.id === "catalog")?.costUsd, 0.01);
    db.rawDb().close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
