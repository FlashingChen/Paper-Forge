import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { RunManifest } from "../src/lib/execution/protocol";

test("node reservations enforce capacity, fence stale launches, survive restart and never fail over an Agent that started", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pf-node-test-"));
  process.env.PAPERFORGE_DB_PATH = path.join(root, "db.sqlite");
  process.env.PAPERFORGE_JOBS_DIR = path.join(root, "jobs");
  process.env.PAPERFORGE_EXECUTOR = "node";
  process.env.PAPERFORGE_EXECUTION_SECRET = "test-only-node-execution-secret-long-enough";
  const token = "test-node-token-at-least-32-characters";
  const node = { id: "test-a", tokenHash: createHash("sha256").update(token).digest("hex"), concurrency: 1 };
  const other = { ...node, id: "test-b", tokenHash: createHash("sha256").update("other-node-token-32-characters-long").digest("hex") };
  process.env.PAPERFORGE_NODES = JSON.stringify([node, other]);
  delete process.env.ADMIN_USERNAME; delete process.env.ADMIN_PASSWORD;
  const db = await import("../src/lib/db");
  const jobs = await import("../src/lib/jobs");
  const store = await import("../src/lib/execution/store");
  const nodes = await import("../src/lib/execution/nodes");
  db.initDb();
  try {
    assert.equal(nodes.authorizeNode("Bearer incorrect"), undefined);
    assert.equal(nodes.authorizeNode(`Bearer ${token}`)?.id, node.id);
    const manifest: RunManifest = { version: 1, jobId: "node-a", provider: "example", model: "vision", baseUrl: "https://example.invalid",
      timeoutMs: 1000, capabilities: { vision: true }, images: [{ index: 0, filename: "a.png" }], imageEnv: {}, price: null };
    for (const id of ["node-a", "node-b", "node-c"]) {
      jobs.createJob({ id, imageCount: 1 }); store.enqueueRun({ ...manifest, jobId: id }, [Buffer.from("image")]);
    }
    assert.equal(nodes.pollNode(node, false).length, 0);
    const first = nodes.pollNode(node, true)[0];
    assert(first && !first.claimed);
    assert.equal(nodes.pollNode(node, true).length, 1);
    assert.equal(nodes.pollNode(node, true)[0].execution, first.execution);
    assert.equal(store.claimRun(first.jobId, "wrong-execution"), "conflict");
    // A reservation that never began an Agent can be safely reallocated.
    nodes.reconcileNodeRuns(Date.now() + 91_000);
    const replacement = nodes.pollNode(other, true)[0];
    assert.equal(replacement.jobId, first.jobId);
    assert.notEqual(replacement.execution, first.execution);
    assert.equal(store.claimRun(first.jobId, first.execution), "conflict");
    assert.equal(store.claimRun(replacement.jobId, replacement.execution), "claimed");
    const deadline = store.remoteRun(first.jobId)!.deadline;
    assert.equal(store.claimRun(replacement.jobId, replacement.execution), "claimed");
    assert.equal(store.remoteRun(first.jobId)!.deadline, deadline, "claim retries do not reset task deadline");
    db.migrate();
    assert.equal(nodes.pollNode(other, true)[0].execution, replacement.execution);
    nodes.reconcileNodeRuns(Date.now() + 91_000);
    assert.equal(store.remoteRun(first.jobId)!.node_id, other.id, "started tasks never change owner on reservation expiry");
    assert.equal(nodes.reportNodeFailure(node, first.jobId, replacement.execution, "missing"), false);
    store.acceptSnapshot(first.jobId, { execution: replacement.execution, sequence: 1, status: "done", logs: [], usage: [] }, Buffer.from("PKdocument"));
    nodes.reportNodeFailure(other, first.jobId, replacement.execution, "exited");
    assert.equal(jobs.getJob(first.jobId)?.status, "done", "late node reconciliation does not overwrite success");
    assert(nodes.pollNode(other, true)[0]);
    const expiredId = "node-expired";
    jobs.createJob({ id: expiredId }); store.enqueueRun({ ...manifest, jobId: expiredId }, [Buffer.from("image")]);
    db.rawDb().prepare("UPDATE remote_runs SET deadline = 0 WHERE job_id = ?").run(expiredId);
    nodes.reconcileNodeRuns();
    assert.equal(jobs.getJob(expiredId)?.status, "error");
    const hashes = JSON.stringify(nodes.nodeRegistry());
    assert(!hashes.includes(token));
  } finally { db.rawDb().close(); fs.rmSync(root, { recursive: true, force: true }); }
});
