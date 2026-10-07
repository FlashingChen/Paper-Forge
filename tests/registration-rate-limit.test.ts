import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("registration throttles before parsing or creating accounts and persists its limits", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-registration-limit-"));
  process.env.PAPERFORGE_DB_PATH = path.join(dir, "test.db");
  process.env.SESSION_SECRET = "registration-rate-limit-test-secret";
  delete process.env.PAPERFORGE_CLIENT_IP_HEADER;
  delete process.env.PAPERFORGE_CLIENT_IP_PEER_HEADER;
  delete process.env.PAPERFORGE_CLIENT_IP_TRUSTED_PEERS;
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  const db = await import("../src/lib/db");
  const { consumeRegistrationAttempt } = await import("../src/lib/registration-rate-limit");
  const route = await import("../src/app/api/auth/register/route");
  db.initDb();
  const request = (ip = "192.0.2.1", body = "{") => new Request("http://localhost/api/auth/register", {
    method: "POST",
    headers: { Origin: "http://localhost", "Content-Type": "application/json", "x-real-ip": ip },
    body,
  });
  try {
    await t.test("untrusted IP headers cannot bypass the shared fallback", async () => {
      for (let i = 1; i <= 5; i++) assert.equal((await route.POST(request(`192.0.2.${i}`))).status, 400);
      const response = await route.POST(request("192.0.2.99"));
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get("Retry-After")) > 0);
      assert.equal(db.rawDb().prepare("SELECT COUNT(*) AS n FROM users").get()?.n, 0);
    });
    await t.test("expired attempts allow registration again without changing existing accounts", async () => {
      db.rawDb().prepare("UPDATE registration_attempts SET attempted_at = ?").run(Date.now() - 600_001);
      const response = await route.POST(request("192.0.2.1", JSON.stringify({
        username: "applicant", password: "test-password", email: "applicant@example.com",
        occupation: "中小学老师", region: "浙江",
      })));
      assert.equal(response.status, 201);
      assert.equal(db.getUserByUsername("applicant")?.betaStatus, "pending");
    });
    process.env.PAPERFORGE_CLIENT_IP_HEADER = "x-real-ip";
    await t.test("trusted sources have separate rolling limits shared across database connections", () => {
      db.rawDb().exec("DELETE FROM registration_attempts");
      const now = 1_000_000;
      for (let i = 0; i < 5; i++) assert.equal(consumeRegistrationAttempt(db.rawDb(), request(), now + i * 1000).allowed, true);
      const second = new DatabaseSync(process.env.PAPERFORGE_DB_PATH!);
      try {
        assert.deepEqual(consumeRegistrationAttempt(second, request(), now + 5000), { allowed: false, retryAfter: 595 });
        assert.equal(consumeRegistrationAttempt(second, request("192.0.2.2"), now + 5000).allowed, true);
        assert.equal(consumeRegistrationAttempt(second, request(), now + 600_000).allowed, true);
        assert.equal(consumeRegistrationAttempt(second, request(), now + 600_000).allowed, false);
      } finally { second.close(); }
      const keys = db.rawDb().prepare("SELECT source_key FROM registration_attempts").all();
      assert.ok(keys.every(row => /^[a-f0-9]{64}$/.test(String(row.source_key))));
    });
    await t.test("address normalization and invalid headers do not create bypasses", () => {
      db.rawDb().exec("DELETE FROM registration_attempts");
      const now = 2_000_000;
      for (let i = 0; i < 5; i++) consumeRegistrationAttempt(db.rawDb(), request("192.0.2.1"), now);
      assert.equal(consumeRegistrationAttempt(db.rawDb(), request("::ffff:192.0.2.1"), now).allowed, false);
      for (let i = 0; i < 5; i++) consumeRegistrationAttempt(db.rawDb(), request(`2001:db8::${i + 1}`), now);
      assert.equal(consumeRegistrationAttempt(db.rawDb(), request("2001:0db8:0000:0000::99"), now).allowed, false);
      assert.equal(consumeRegistrationAttempt(db.rawDb(), request("2001:db8:0:1::1"), now).allowed, true);
      for (let i = 0; i < 5; i++) consumeRegistrationAttempt(db.rawDb(), request("invalid"), now);
      assert.equal(consumeRegistrationAttempt(db.rawDb(), request("192.0.2.2, 192.0.2.3"), now).allowed, false);
    });
    await t.test("CDN client headers are trusted only from verified origin peers", () => {
      db.rawDb().exec("DELETE FROM registration_attempts");
      process.env.PAPERFORGE_CLIENT_IP_HEADER = "cdn-client-ip";
      process.env.PAPERFORGE_CLIENT_IP_PEER_HEADER = "x-real-ip";
      process.env.PAPERFORGE_CLIENT_IP_TRUSTED_PEERS = "192.0.2.7";
      const via = (peer: string, client: string) => new Request("http://localhost/api/auth/register", {
        headers: { "x-real-ip": peer, "cdn-client-ip": client },
      });
      const now = 2_500_000;
      for (let i = 0; i < 5; i++) consumeRegistrationAttempt(db.rawDb(), via("192.0.2.7", "198.51.100.1"), now);
      assert.equal(consumeRegistrationAttempt(db.rawDb(), via("192.0.2.7", "198.51.100.1"), now).allowed, false);
      assert.equal(consumeRegistrationAttempt(db.rawDb(), via("192.0.2.7", "198.51.100.2"), now).allowed, true);
      for (let i = 1; i <= 5; i++) consumeRegistrationAttempt(db.rawDb(), via("192.0.2.8", `198.51.100.${i}`), now);
      assert.equal(consumeRegistrationAttempt(db.rawDb(), via("192.0.2.8", "198.51.100.99"), now).allowed, false);
      process.env.PAPERFORGE_CLIENT_IP_HEADER = "x-real-ip";
      delete process.env.PAPERFORGE_CLIENT_IP_PEER_HEADER;
      delete process.env.PAPERFORGE_CLIENT_IP_TRUSTED_PEERS;
    });
    await t.test("the aggregate limit bounds rotating-source traffic and storage", () => {
      db.rawDb().exec("DELETE FROM registration_attempts");
      const now = 3_000_000;
      for (let i = 1; i <= 60; i++) assert.equal(consumeRegistrationAttempt(db.rawDb(), request(`192.0.2.${i}`), now).allowed, true);
      assert.deepEqual(consumeRegistrationAttempt(db.rawDb(), request("192.0.2.61"), now), { allowed: false, retryAfter: 600 });
      assert.equal(db.rawDb().prepare("SELECT COUNT(*) AS n FROM registration_attempts").get()?.n, 60);
      assert.equal(consumeRegistrationAttempt(db.rawDb(), request("192.0.2.61"), now + 600_000).allowed, true);
    });
  } finally {
    delete process.env.PAPERFORGE_CLIENT_IP_HEADER;
    delete process.env.PAPERFORGE_CLIENT_IP_PEER_HEADER;
    delete process.env.PAPERFORGE_CLIENT_IP_TRUSTED_PEERS;
    db.rawDb().close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
