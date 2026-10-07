import { publicJob, publicLog } from "./security/public-job";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadEnv, referenceSourceDir, snippetsSourceDir } from "./config";
import {
  countActiveJobs,
  deleteJobRow,
  getJobRow,
  insertJob,
  listAllJobRows,
  listJobRowsForUser,
  rowToJob,
  saveJobLogs,
  updateJobRow,
} from "./db";
import type { Job, LogEntry, LogLevel } from "./types";

/**
 * Job registry (SQLite-backed) plus on-disk job directory helpers.
 *
 * Jobs used to live in a module-level Map, which meant a server restart lost
 * every in-flight job and the teacher's progress page 404'd. They are now rows
 * in the `jobs` table, so state survives restarts and every job has an owner,
 * which is what lets us enforce "you may only see your own jobs".
 */

/** Directory names that must be usable: [A-Za-z0-9._-], no traversal. */
export function sanitizeJobId(id: string): string {
  const cleaned = String(id).replace(/[^A-Za-z0-9._-]/g, "");
  const trimmed = cleaned.replace(/^\.+/, "");
  if (trimmed.length === 0) {
    throw new Error("Invalid job id");
  }
  return trimmed.slice(0, 128);
}

export function jobsDir(): string {
  return loadEnv().jobsDir;
}

/** Absolute job directory for an id, guaranteed to stay inside the jobs dir. */
export function jobDirFor(id: string): string {
  const safe = sanitizeJobId(id);
  const root = path.resolve(jobsDir());
  const dir = path.resolve(root, safe);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error("Invalid job id");
  }
  return dir;
}

export function getJob(id: string): Job | undefined {
  const row = getJobRow(sanitizeJobId(id));
  return row ? rowToJob(row) : undefined;
}

/** All jobs, newest first. Used by the admin view. */
export function listJobs(): Job[] {
  return listAllJobRows().map(rowToJob);
}

/** Jobs belonging to one user, newest first. */
export function listJobsForUser(userId: number): Job[] {
  return listJobRowsForUser(userId).map(rowToJob);
}

/** A generated document on disk, with the stat the preview cache keys on. */
export interface ResultFile {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Locate a job's generated document.
 *
 * `resultPath` is authoritative once pi-runner recorded it; otherwise the
 * conventional location inside the (sanitised) job directory is checked. Both
 * the download route and the preview route go through here, which is what
 * makes "the preview shows the file you download" true by construction
 * instead of by convention.
 */
export function resolveResultFile(job: Job): ResultFile | undefined {
  const candidates: string[] = [];
  if (job.resultPath) candidates.push(job.resultPath);
  try {
    candidates.push(path.join(jobDirFor(job.id), "out", "result.docx"));
  } catch {
    // Unreachable id: the caller's 404 covers it.
  }

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size > 0) {
        return { path: candidate, size: stat.size, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

export function createJob(options?: {
  id?: string;
  imageCount?: number;
  userId?: number;
}): Job {
  const id = sanitizeJobId(options?.id ?? randomUUID());
  const createdAt = Date.now();
  // userId 0 is the "unowned" bucket used only by tests and by the seed path;
  // real requests always pass the authenticated user id.
  insertJob({
    id,
    userId: options?.userId ?? 0,
    status: "queued",
    createdAt,
    imageCount: options?.imageCount ?? 0,
  });
  return {
    id,
    userId: options?.userId ?? 0,
    status: "queued",
    createdAt,
    imageCount: options?.imageCount ?? 0,
    logs: [],
  };
}

/** Shallow-merge a patch into a job. Logs are never overwritten by a patch. */
export function updateJob(id: string, patch: Partial<Job>): Job | undefined {
  const key = sanitizeJobId(id);
  const current = getJob(key);
  if (!current) return undefined;
  updateJobRow(key, {
    status: patch.status,
    resultPath: patch.resultPath,
    resultSize: patch.resultSize,
    error: patch.error,
    note: patch.note,
  });
  return getJob(key);
}

/**
 * Append one log line and persist the whole list.
 *
 * Persisting on every line keeps the SSE replay-after-reconnect honest: a
 * teacher who reloads the page sees the full history instead of an empty box.
 */
export function appendLog(id: string, level: LogLevel, text: string): LogEntry | undefined {
  const key = sanitizeJobId(id);
  const current = getJob(key);
  if (!current) return undefined;
  const entry = publicLog({ ts: Date.now(), level, text });
  if (!entry) return undefined;
  current.logs.push(entry);
  // Cap the persisted log so a pathological run cannot grow the row forever.
  const trimmed = current.logs.slice(-2000);
  saveJobLogs(key, JSON.stringify(trimmed));
  return entry;
}

function safeMkdir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function copyReferenceDocs(targetDir: string): string[] {
  const copied: string[] = [];
  const source = referenceSourceDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(source);
  } catch {
    return copied;
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".docx")) continue;
    if (entry.startsWith("~$")) continue;
    const from = path.join(source, entry);
    try {
      const stat = fs.statSync(from);
      if (!stat.isFile()) continue;
      fs.copyFileSync(from, path.join(targetDir, entry));
      copied.push(entry);
    } catch {
      // A single unreadable reference file must not fail job creation.
    }
  }
  return copied;
}

/**
 * Recursively copy the project's agent/snippets into <jobDir>/snippets.
 *
 * agent/TASK_BRIEF.md instructs the agent to `sys.path.insert(0, "snippets")`,
 * so the helpers must live at the job root, not under agent/. Missing source
 * directory is not an error: the brief still works without the helpers.
 */
function copySnippets(targetDir: string): string[] {
  const copied: string[] = [];
  const source = snippetsSourceDir();

  let sourceStat: fs.Stats;
  try {
    sourceStat = fs.statSync(source);
  } catch {
    return copied;
  }
  if (!sourceStat.isDirectory()) return copied;

  safeMkdir(targetDir);

  const walk = (from: string, to: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        safeMkdir(dst);
        walk(src, dst, rel);
      } else if (entry.isFile()) {
        try {
          fs.copyFileSync(src, dst);
          copied.push(rel);
        } catch {
          // A single unreadable helper must not fail job creation.
        }
      }
    }
  };

  walk(source, targetDir, "");
  return copied;
}

/**
 * Create in/, out/, reference/ and snippets/ inside the job directory.
 * Reference .docx files and the helper snippets are copied from the project so
 * the agent can read them without escaping its working directory.
 */
export function prepareJobDir(id: string): string {
  const dir = jobDirFor(id);
  const inDir = path.join(dir, "in");
  const outDir = path.join(dir, "out");
  const refDir = path.join(dir, "reference");
  const snippetsDir = path.join(dir, "snippets");

  safeMkdir(dir);
  safeMkdir(inDir);
  safeMkdir(outDir);
  safeMkdir(refDir);

  copyReferenceDocs(refDir);
  copySnippets(snippetsDir);

  return dir;
}

/** Remove job directories older than maxAgeMs. Returns the ids removed. */
export function cleanupJobs(maxAgeMs: number): string[] {
  const removed: string[] = [];
  const root = path.resolve(jobsDir());
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return removed;
  }

  const cutoff = Date.now() - maxAgeMs;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs >= cutoff) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      deleteJobRow(entry.name);
      removed.push(entry.name);
    } catch {
      // Best effort sweep; try again on the next tick.
    }
  }

  return removed;
}

/** Convenience used by the SSE route: snapshot of a job including its logs. */
export function jobSnapshot(id: string): Job | undefined {
  const job = getJob(id);
  if (!job) return undefined;
  return publicJob(job);
}

/** Concurrent runs a single account may have open. */
export function activeJobCount(userId: number): number {
  return countActiveJobs(userId);
}

/** True when `userId` may read/act on `jobId`. Admins may read anything. */
export function jobBelongsTo(job: Job, userId: number, role: string): boolean {
  if (role === "admin") return true;
  return job.userId === userId;
}
