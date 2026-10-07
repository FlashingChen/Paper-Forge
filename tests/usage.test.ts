import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateCost, parsePrice, parseUsage } from "../src/lib/usage-types";

test("pi token buckets include cache and do not double count reasoning", () => {
  const usage = parseUsage({ input: 100, output: 40, cacheRead: 200, cacheWrite: 10, reasoning: 30, totalTokens: 350 });
  assert.deepEqual(usage, { input: 100, output: 40, cacheRead: 200, cacheWrite: 10, total: 350 });
  assert.equal(estimateCost(usage!, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 3 }), 0.00067);
});
test("missing and invalid usage is unknown, explicit zero is valid", () => {
  for (const value of [null, {}, { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: NaN, output: 0, cacheRead: 0, cacheWrite: 0 }]) assert.equal(parseUsage(value), null);
  assert.equal(parseUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })?.total, 0);
});
test("price requires all four finite nonnegative buckets", () => {
  assert.equal(parsePrice({ input: 1, output: 2 }), null);
  assert.equal(parsePrice({ input: 1, output: Infinity, cacheRead: 0, cacheWrite: 0 }), null);
  assert.deepEqual(parsePrice({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }), { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
});
