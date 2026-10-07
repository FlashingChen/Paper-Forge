import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("dispatcher resumes durable leases, handles a lost launch response, and reconciles the claimed execution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-dispatch-test-"));
  process.env.PAPERFORGE_DB_PATH = path.join(root, "control.db");
  process.env.PAPERFORGE_JOBS_DIR = path.join(root, "jobs");
  process.env.PAPERFORGE_EXECUTION_SECRET = "test-only-execution-secret-32-characters";
  process.env.PAPERFORGE_EXECUTOR = "local";
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  const db = await import("../src/lib/db");
  const jobs = await import("../src/lib/jobs");
  const store = await import("../src/lib/execution/store");
  const { tick } = await import("../scripts/execution/dispatcher");
  db.initDb();
  try {
    jobs.createJob({ id: "dispatch-test" });
    store.enqueueRun({ version: 1, jobId: "dispatch-test", provider: "example", model: "vision",
      baseUrl: "https://example.invalid/v1", capabilities: {}, timeoutMs: 3000,
      imageEnv: {}, images: [], price: null }, []);
    let dispatched = 0;
    let observed = "";
    let completed = false;
    const resource = "projects/test/locations/region/jobs/agent";
    const api = {
      resource: () => resource,
      dispatch: async () => { dispatched++; throw new Error("Response lost after Google accepted the execution"); },
      operation: async () => ({ name: "operation", metadata: { name: `${resource}/executions/duplicate` } }),
      execution: async (name: string) => { observed = name; return completed ? { completionTime: new Date().toISOString() } : {}; },
    };
    await tick(api);
    assert.equal(dispatched, 1);
    assert.equal(store.remoteRun("dispatch-test")?.dispatch_attempts, 1);
    db.migrate(); // A control restart keeps both task and dispatch lease.
    await tick(api);
    assert.equal(dispatched, 1);
    assert.equal(store.claimRun("dispatch-test", "original-execution"), "claimed");
    await tick(api); // A worker that claimed despite a lost API response is not dispatched again.
    assert.equal(dispatched, 1);
    assert.equal(observed, `${resource}/executions/original-execution`);
    // Even if a later duplicate's operation is stored, reconcile the owner, not the duplicate.
    db.rawDb().prepare("UPDATE remote_runs SET operation = ? WHERE job_id = ?").run("operation", "dispatch-test");
    await tick(api);
    assert.equal(observed, `${resource}/executions/original-execution`);
    assert.equal(jobs.getJob("dispatch-test")?.status, "queued");
    completed = true;
    await tick(api);
    assert.equal(jobs.getJob("dispatch-test")?.status, "error");
    assert.match(jobs.getJob("dispatch-test")!.error!, /未收到最终结果/);
  } finally {
    db.rawDb().close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
