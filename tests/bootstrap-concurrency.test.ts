import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

test("Web and dispatcher can initialize a fresh WAL database and seed one admin concurrently", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-bootstrap-test-"));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const env = { ...process.env, PAPERFORGE_DB_PATH: path.join(root, `${attempt}.db`),
        ADMIN_USERNAME: "bootstrap-test", ADMIN_PASSWORD: "test-only-password", SESSION_SECRET: "test-only-session-secret" };
      const run = () => new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "-e",
          `const db=require('./src/lib/db');db.initDb();
           const users=db.rawDb().prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'bootstrap-test' AND role = 'admin'").get();
           if(users.n!==1)process.exit(2);`], { env, stdio: ["ignore", "ignore", "pipe"] });
        let output = "";
        child.stderr.on("data", data => { output += data; });
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve() : reject(new Error(output || `exit ${code}`)));
      });
      const results = await Promise.allSettled([run(), run()]);
      for (const result of results) assert.equal(result.status, "fulfilled", result.status === "rejected" ? String(result.reason) : undefined);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
