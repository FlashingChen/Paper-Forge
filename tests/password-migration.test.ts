import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("session migration preserves populated legacy data and supports concurrent startup", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-password-migration-"));
  const file = path.join(dir, "legacy.db");
  process.env.PAPERFORGE_DB_PATH = file;
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  const db = await import("../src/lib/db");
  const { hashPassword } = await import("../src/lib/auth");
  let connection: DatabaseSync | undefined;
  try {
    db.migrate();
    const user = db.createUser({ username: "existing-user", passwordHash: hashPassword("existing password"), quota: 47 });
    db.consumeQuota(user.id);
    db.touchLogin(user.id);
    db.setSetting("model.api_key", "existing-encrypted-value");
    db.insertJob({ id: "existing-job", userId: user.id, status: "done", createdAt: 123, imageCount: 3 });
    db.updateJobRow("existing-job", { resultPath: "/data/jobs/existing-job/out/result.docx", resultSize: 2048 });
    db.saveJobLogs("existing-job", '[{"ts":123,"level":"info","text":"完成"}]');
    db.rawDb().prepare(`INSERT INTO model_usage
      (job_id, sequence, created_at, provider, model, input_tokens, output_tokens, total_tokens, cost_usd)
      VALUES (?, 1, 123, 'provider', 'model', 100, 50, 150, 0.001)`).run("existing-job");
    // Recreate the prior schema with populated records; only this disposable fixture is changed.
    // `session_version` came with the session upgrade, the beta columns with self-service
    // registration and `email` with the contact-address requirement: dropping all of
    // them leaves the exact shape of a pre-feature database, like the one in production.
    for (const column of [
      "session_version",
      "occupation",
      "region",
      "beta_status",
      "beta_applied_at",
      "beta_reviewed_at",
      "beta_reviewed_by",
      "email",
    ]) {
      db.rawDb().exec(`ALTER TABLE users DROP COLUMN ${column}`);
    }
    const tables = ["users", "settings", "jobs", "model_usage", "sqlite_sequence"];
    const before = Object.fromEntries(tables.map(table => [table, db.rawDb().prepare(`SELECT * FROM ${table}`).all()]));
    const otherSchema = db.rawDb().prepare("SELECT type, name, sql FROM sqlite_master WHERE name != 'users' ORDER BY name").all();
    db.rawDb().close();

    // Real independent processes contend for the same SQLite file.
    await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--eval", "require('./src/lib/db.ts').migrate()"], {
        cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve() : reject(new Error(output || `Migration exited ${code}`)));
    })));
    connection = new DatabaseSync(file);
    for (const table of tables) {
      const columns = table === "users" ? "id, username, password_hash, role, quota, used, disabled, created_at, last_login_at" : "*";
      assert.deepEqual(connection.prepare(`SELECT ${columns} FROM ${table}`).all(), before[table], `${table} rows preserved`);
    }
    assert.deepEqual(connection.prepare("SELECT type, name, sql FROM sqlite_master WHERE name != 'users' ORDER BY name").all(), otherSchema);
    assert.equal((connection.prepare("SELECT session_version FROM users").get() as { session_version: number }).session_version, 0);
    // The additive columns land with defaults that keep existing accounts working.
    // `email` specifically must come out as the literal sentinel, which is what
    // forces a pre-feature account to supply an address at its next sign-in.
    const migrated = connection
      .prepare("SELECT email, occupation, region, beta_status, beta_applied_at FROM users WHERE id = ?")
      .get(user.id) as {
      email: string;
      occupation: string | null;
      region: string | null;
      beta_status: string;
      beta_applied_at: number | null;
    };
    assert.deepEqual(migrated, Object.assign(Object.create(null), {
      email: "null",
      occupation: null,
      region: null,
      beta_status: "approved",
      beta_applied_at: null,
    }));
    assert.deepEqual(connection.prepare("PRAGMA integrity_check").all(), [Object.assign(Object.create(null), { integrity_check: "ok" })]);
    assert.deepEqual(connection.prepare("PRAGMA foreign_key_check").all(), []);
    // Old application queries remain compatible with the additive schema.
    assert.equal((connection.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as { used: number }).used, 1);
  } finally {
    connection?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
