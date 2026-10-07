import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EMAIL_UNSET, EmailTakenError, normalizeEmailKey } from "./registration";
import { sessionSecret } from "./secret";
import type { Job, LogEntry } from "./types";


export type Role = "user" | "admin";

/**
 * Where a self-service registration stands.
 *
 * Accounts created by an administrator default to `approved`, so the flag only
 * ever means something for people who registered themselves.
 */
export type BetaStatus = "pending" | "approved" | "rejected";

export interface User {
  id: number;
  username: string;
  role: Role;
  quota: number;
  used: number;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  /**
   * Contact address. Accounts that predate the field, and ones created without
   * one, hold the literal sentinel `'null'` rather than SQL NULL — see
   * `isEmailSet` in ./registration. Such a user must supply one at next login.
   */
  email: string;
  /** Beta application fields. Null on accounts that never applied. */
  occupation: string | null;
  region: string | null;
  betaStatus: BetaStatus;
  betaAppliedAt: number | null;
  betaReviewedAt: number | null;
  betaReviewedBy: number | null;
}


export interface JobRow {
  id: string;

  user_id: number | null;
  status: string;
  created_at: number;
  image_count: number;
  result_path: string | null;
  result_size: number | null;
  error: string | null;
  note: string | null;
  logs: string;
}

interface DbHandles {
  db: DatabaseSync;
}

const globalForDb = globalThis as typeof globalThis & {
  __paperforgeDb?: DbHandles;
};


function dbPath(): string {
  const explicit = process.env.PAPERFORGE_DB_PATH?.trim();
  const file = explicit
    ? path.resolve(explicit)
    : path.resolve(process.cwd(), "data", "paperforge.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

const handles: DbHandles =
  globalForDb.__paperforgeDb ?? { db: new DatabaseSync(dbPath()) };
globalForDb.__paperforgeDb = handles;


export function rawDb(): DatabaseSync {
  return handles.db;
}


export function migrate(): void {
  const db = handles.db;
  db.exec("PRAGMA busy_timeout = 5000");
  // Enabling WAL can fail immediately on a fresh DB when two processes race;
  // SQLite does not always invoke busy_timeout for this lock upgrade.
  const walDeadline = Date.now() + 5000;
  for (;;) {
    try { db.exec("PRAGMA journal_mode = WAL"); break; }
    catch (error) {
      const code = (error as { errcode?: number }).errcode;
      if ((code !== 5 && code !== 6) || Date.now() >= walDeadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'user',
      quota         INTEGER NOT NULL DEFAULT 20,
      used          INTEGER NOT NULL DEFAULT 0,
      disabled      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER,
      email         TEXT    NOT NULL DEFAULT '${EMAIL_UNSET}',
      occupation    TEXT,
      region        TEXT,
      beta_status   TEXT    NOT NULL DEFAULT 'approved',
      beta_applied_at  INTEGER,
      beta_reviewed_at INTEGER,
      beta_reviewed_by INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS registration_attempts (
      source_key TEXT NOT NULL,
      attempted_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS registration_attempts_time
      ON registration_attempts(attempted_at);
    CREATE INDEX IF NOT EXISTS registration_attempts_source
      ON registration_attempts(source_key, attempted_at);
  `);

  // Serialize the schema check and ALTER across processes sharing this file.
  db.exec("BEGIN IMMEDIATE");
  try {
    const userColumns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    const hasColumn = (name: string) => userColumns.some((column) => column.name === name);
    // Added with the session upgrade; kept so a pre-auth database still migrates.
    if (!hasColumn("session_version")) {
      db.exec("ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0");
    }
    // Added with self-service registration. `beta_status` defaults to 'approved'
    // so every account that existed before the feature keeps working.
    for (const column of [
      // Accounts that predate this field keep the sentinel and are asked for a
      // real address at their next sign-in.
      `email TEXT NOT NULL DEFAULT '${EMAIL_UNSET}'`,
      "occupation TEXT",
      "region TEXT",
      "beta_status TEXT NOT NULL DEFAULT 'approved'",
      "beta_applied_at INTEGER",
      "beta_reviewed_at INTEGER",
      "beta_reviewed_by INTEGER",
    ]) {
      if (!hasColumn(column.split(" ")[0])) {
        db.exec(`ALTER TABLE users ADD COLUMN ${column}`);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT    PRIMARY KEY,
      user_id     INTEGER          REFERENCES users(id) ON DELETE CASCADE,
      status      TEXT    NOT NULL,
      created_at  INTEGER NOT NULL,
      image_count INTEGER NOT NULL DEFAULT 0,
      result_path TEXT,
      result_size INTEGER,
      error       TEXT,
      note        TEXT,
      logs        TEXT    NOT NULL DEFAULT '[]'
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs(user_id, created_at DESC)");

  // Durable execution outbox. Only the control plane owns this database.
  db.exec(`CREATE TABLE IF NOT EXISTS remote_runs (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    operation TEXT,
    execution TEXT,
    claimed_by TEXT,
    sequence INTEGER NOT NULL DEFAULT 0,
    next_dispatch_at INTEGER NOT NULL DEFAULT 0,
    dispatch_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    heartbeat_at INTEGER,
    deadline INTEGER NOT NULL,
    backend TEXT NOT NULL DEFAULT 'cloud-run',
    node_id TEXT, reserved_by TEXT, reserved_until INTEGER, started_at INTEGER,
    timeout_ms INTEGER NOT NULL DEFAULT 1800000
  )`);

  const remoteColumns = new Set((db.prepare("PRAGMA table_info(remote_runs)").all() as { name: string }[]).map(c => c.name));
  for (const [name, declaration] of Object.entries({
    backend: "TEXT NOT NULL DEFAULT 'cloud-run'", node_id: "TEXT", reserved_by: "TEXT",
    reserved_until: "INTEGER", started_at: "INTEGER", timeout_ms: "INTEGER NOT NULL DEFAULT 1800000",
  })) {
    if (!remoteColumns.has(name)) {
      try { db.exec(`ALTER TABLE remote_runs ADD COLUMN ${name} ${declaration}`); }
      catch (error) {
        // Web and monitor can migrate a legacy database concurrently.
        const migrated = (db.prepare("PRAGMA table_info(remote_runs)").all() as { name: string }[]).some(c => c.name === name);
        if (!migrated) throw error;
      }
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS execution_nodes (
    id TEXT PRIMARY KEY, heartbeat_at INTEGER NOT NULL
  )`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS model_usage (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      total_tokens INTEGER,
      cost_usd REAL,
      cost_source TEXT,
      price_json TEXT,
      PRIMARY KEY (job_id, sequence)
    )
  `);

  seedAdmin();
  failOrphanedJobs();
}


function failOrphanedJobs(): void {
  const db = rawDb();
  const now = Date.now();
  const orphans = db
    .prepare(`SELECT id, status FROM jobs WHERE status IN ('queued','running')
      AND id NOT IN (SELECT job_id FROM remote_runs)`)
    .all() as { id: string; status: string }[];
  if (orphans.length === 0) return;

  const stmt = db.prepare(
    "UPDATE jobs SET status = 'error', error = ?, note = COALESCE(note, ?) WHERE id = ?",
  );
  for (const job of orphans) {
    stmt.run(
      "服务重启，这个任务被中断了，请重新上传。",
      `中断于 ${new Date(now).toISOString()}`,
      job.id,
    );
  }
  for (const job of orphans) {
    try {
      const row = db.prepare("SELECT logs FROM jobs WHERE id = ?").get(job.id) as
        | { logs: string }
        | undefined;
      const logs = row ? (JSON.parse(row.logs) as unknown[]) : [];
      logs.push({
        ts: now,
        level: "error",
        text: "服务重启，任务被中断（进程已不存在，无法继续）。",
      });
      db.prepare("UPDATE jobs SET logs = ? WHERE id = ?").run(
        JSON.stringify(logs),
        job.id,
      );
    } catch {
      /* the status/error update above is the part that matters */
    }
  }
}

/* ------------------------------------------------------------------ users */

interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  quota: number;
  used: number;
  disabled: number;
  created_at: number;
  last_login_at: number | null;
  email: string;
  occupation: string | null;
  region: string | null;
  beta_status: string;
  beta_applied_at: number | null;
  beta_reviewed_at: number | null;
  beta_reviewed_by: number | null;
}

function toBetaStatus(raw: string): BetaStatus {
  return raw === "pending" || raw === "rejected" ? raw : "approved";
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    role: row.role === "admin" ? "admin" : "user",
    quota: row.quota,
    used: row.used,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    email: row.email ?? EMAIL_UNSET,
    occupation: row.occupation ?? null,
    region: row.region ?? null,
    betaStatus: toBetaStatus(row.beta_status),
    betaAppliedAt: row.beta_applied_at ?? null,
    betaReviewedAt: row.beta_reviewed_at ?? null,
    betaReviewedBy: row.beta_reviewed_by ?? null,
  };
}

export function getUserById(id: number): User | undefined {
  const row = handles.db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(id) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}


export function getPasswordHashByUsername(username: string): string | undefined {
  const row = handles.db
    .prepare("SELECT password_hash FROM users WHERE username = ?")
    .get(username) as { password_hash: string } | undefined;
  return row?.password_hash;
}

/** Read the hash and its session version together, before password verification. */
export function getLoginCredentialsByUsername(username: string):
  { passwordHash: string; sessionVersion: number } | undefined {
  const row = handles.db.prepare("SELECT password_hash, session_version FROM users WHERE username = ?")
    .get(username) as { password_hash: string; session_version: number } | undefined;
  return row ? { passwordHash: row.password_hash, sessionVersion: row.session_version } : undefined;
}

export function getUserByUsername(username: string): User | undefined {
  const row = handles.db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

export function listUsers(): User[] {
  const rows = handles.db
    .prepare("SELECT * FROM users ORDER BY id ASC")
    .all() as unknown as UserRow[];
  return rows.map(toUser);
}

/* -------------------------------------------------------- email uniqueness */

/**
 * One address belongs to one account.
 *
 * The rule lives in the write path rather than in a UNIQUE index on purpose.
 * An index over `lower(trim(email))`, partial on "not the sentinel", is the
 * obvious database-level answer, but it cannot be created on a database that
 * already contains two accounts sharing an address — which is exactly the case
 * this feature has to survive. Creating it would either fail the migration or
 * force us to rewrite, merge or disable those rows, and every one of those
 * outcomes is a real change to accounts that are already in production.
 *
 * So the check runs inside the same transaction as the write it guards, which
 * makes it atomic against other processes sharing the file without touching a
 * single existing row. Duplicate rows that predate the rule stay exactly as
 * they are: they keep their address, and only a *new* claim can be refused.
 *
 * Comparison folds case and trims, and the sentinel is never a value — see
 * normalizeEmailKey.
 */
function inWriteTransaction<T>(work: () => T): T {
  const db = handles.db;
  // Take the write lock before reading, so a concurrent process cannot slip the
  // same address in between the check and the statement that follows.
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the original failure is the one worth reporting */
    }
    throw error;
  }
}

function findUserByEmailKey(key: string, exceptUserId?: number): User | undefined {
  const row = (exceptUserId === undefined
    ? handles.db
        .prepare("SELECT * FROM users WHERE lower(trim(email)) = ? LIMIT 1")
        .get(key)
    : handles.db
        .prepare("SELECT * FROM users WHERE lower(trim(email)) = ? AND id <> ? LIMIT 1")
        .get(key, exceptUserId)) as UserRow | undefined;
  return row ? toUser(row) : undefined;
}

/**
 * The account holding this address, if any. Pass `exceptUserId` when the caller
 * is the account itself so it can re-save the address it already owns.
 */
export function findUserByEmail(email: string, exceptUserId?: number): User | undefined {
  const key = normalizeEmailKey(email);
  if (!key) return undefined;
  return findUserByEmailKey(key, exceptUserId);
}

/* ---------------------------------------------------- beta applications */

/**
 * Every account that registered itself, pending ones first.
 *
 * `beta_applied_at` is the discriminator: administrator-created accounts have
 * never applied, so they never show up here.
 */
export function listBetaApplications(): User[] {
  const rows = handles.db
    .prepare(
      `SELECT * FROM users
        WHERE beta_applied_at IS NOT NULL
        ORDER BY CASE beta_status WHEN 'pending' THEN 0 ELSE 1 END,
                 beta_applied_at DESC`,
    )
    .all() as unknown as UserRow[];
  return rows.map(toUser);
}

export function countPendingBetaApplications(): number {
  const row = handles.db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE beta_applied_at IS NOT NULL AND beta_status = 'pending'")
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Approve or reject one application.
 *
 * Only accounts that actually applied can be reviewed. A quota is only ever
 * granted on approval — rejecting leaves the balance alone so a later change of
 * mind does not silently hand out credits.
 */
export function reviewBetaApplication(
  id: number,
  decision: { status: "approved" | "rejected"; quota?: number; reviewerId: number },
): User | undefined {
  const current = getUserById(id);
  if (!current || current.betaAppliedAt === null) return undefined;

  const quota =
    decision.status === "approved" && decision.quota !== undefined
      ? Math.max(0, Math.floor(decision.quota))
      : current.quota;

  handles.db
    .prepare(
      `UPDATE users
          SET beta_status = ?, quota = ?, beta_reviewed_at = ?, beta_reviewed_by = ?
        WHERE id = ? AND beta_applied_at IS NOT NULL`,
    )
    .run(decision.status, quota, Date.now(), decision.reviewerId, id);
  return getUserById(id);
}


/**
 * Create one account.
 *
 * Throws EmailTakenError when another account already holds the address. The
 * check and the insert share a transaction, so two processes racing for the
 * same address cannot both win.
 */
export function createUser(input: {
  username: string;
  passwordHash: string;
  role?: Role;
  quota?: number;
  /** Contact address; omitted means the sentinel, i.e. "ask at next login". */
  email?: string;
  /** Self-registered accounts carry their application with the account. */
  application?: { occupation: string; region: string };
}): User {
  const now = Date.now();
  const email = input.email?.trim() || EMAIL_UNSET;
  const emailKey = normalizeEmailKey(email);

  const info = inWriteTransaction(() => {
    if (emailKey && findUserByEmailKey(emailKey)) throw new EmailTakenError();
    return handles.db
      .prepare(
        `INSERT INTO users
           (username, password_hash, role, quota, used, disabled, created_at,
            email, occupation, region, beta_status, beta_applied_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.username,
        input.passwordHash,
        input.role ?? "user",
        input.quota ?? 20,
        now,
        email,
        input.application?.occupation ?? null,
        input.application?.region ?? null,
        input.application ? "pending" : "approved",
        input.application ? now : null,
      );
  });

  const user = getUserById(Number(info.lastInsertRowid));
  if (!user) throw new Error("failed to create user");
  return user;
}

/**
 * Set the contact address.
 *
 * Returns false when the account does not exist, and throws EmailTakenError
 * when another account holds the address. Re-saving the address the account
 * already owns is always allowed — the caller's own row is excluded.
 */
export function setUserEmail(id: number, email: string): boolean {
  const value = email.trim() || EMAIL_UNSET;
  const key = normalizeEmailKey(value);
  return inWriteTransaction(() => {
    if (key && findUserByEmailKey(key, id)) throw new EmailTakenError();
    const info = handles.db
      .prepare("UPDATE users SET email = ? WHERE id = ?")
      .run(value, id);
    return info.changes > 0;
  });
}

export function setUserPassword(id: number, passwordHash: string): void {
  handles.db
    .prepare("UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?")
    .run(passwordHash, id);
}

export function getUserSessionVersion(id: number): number | undefined {
  const row = handles.db.prepare("SELECT session_version FROM users WHERE id = ?")
    .get(id) as { session_version: number } | undefined;
  return row?.session_version;
}

/** Compare-and-swap prevents a concurrent password reset from being overwritten. */
export function replaceUserPassword(id: number, previousHash: string, passwordHash: string): boolean {
  const result = handles.db.prepare(
    "UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ? AND password_hash = ? AND disabled = 0",
  ).run(passwordHash, id, previousHash);
  return result.changes > 0;
}

export function updateUser(
  id: number,
  patch: { quota?: number; disabled?: boolean; role?: Role },
): User | undefined {
  const current = getUserById(id);
  if (!current) return undefined;
  handles.db
    .prepare("UPDATE users SET quota = ?, disabled = ?, role = ? WHERE id = ?")
    .run(
      patch.quota ?? current.quota,
      patch.disabled === undefined ? (current.disabled ? 1 : 0) : patch.disabled ? 1 : 0,
      patch.role ?? current.role,
      id,
    );
  return getUserById(id);
}

export function touchLogin(id: number): void {
  handles.db
    .prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

export function deleteUser(id: number): boolean {
  const info = handles.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  return info.changes > 0;
}


export function consumeQuota(userId: number): { ok: boolean; remaining: number } {
  const info = handles.db
    .prepare(
      `UPDATE users SET used = used + 1
        WHERE id = ? AND disabled = 0 AND used < quota`,
    )
    .run(userId);
  const user = getUserById(userId);
  if (!user) return { ok: false, remaining: 0 };
  return { ok: info.changes > 0, remaining: Math.max(0, user.quota - user.used) };
}

export function resetUsage(id: number): void {
  handles.db.prepare("UPDATE users SET used = 0 WHERE id = ?").run(id);
}


export function refundQuota(userId: number): void {
  handles.db
    .prepare("UPDATE users SET used = MAX(0, used - 1) WHERE id = ?")
    .run(userId);
}

/* --------------------------------------------------------------- settings */

export function getSetting(key: string): string | undefined {
  const row = handles.db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  handles.db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, Date.now());
}

export function deleteSetting(key: string): void {
  handles.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/* ------------------------------------------------------------------- jobs */

export function insertJob(row: {
  id: string;

  userId: number;
  status: string;
  createdAt: number;
  imageCount: number;
}): void {
  handles.db
    .prepare(
      `INSERT INTO jobs (id, user_id, status, created_at, image_count, logs)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    )
    .run(row.id, row.userId === 0 ? null : row.userId, row.status, row.createdAt, row.imageCount);
}

export function rowToJob(row: JobRow): Job {
  let logs: LogEntry[] = [];
  try {
    const parsed: unknown = JSON.parse(row.logs);
    if (Array.isArray(parsed)) logs = parsed as LogEntry[];
  } catch {
  }
  return {
    id: row.id,
    userId: row.user_id ?? 0,
    status: row.status as Job["status"],
    createdAt: row.created_at,
    imageCount: row.image_count,
    logs,
    resultPath: row.result_path ?? undefined,
    resultSize: row.result_size ?? undefined,
    error: row.error ?? undefined,
    note: row.note ?? undefined,
  };
}

export function getJobRow(id: string): JobRow | undefined {
  return handles.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
    | JobRow
    | undefined;
}

export function listJobRowsForUser(userId: number, limit = 50): JobRow[] {
  return handles.db
    .prepare("SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as unknown as JobRow[];
}


export function countActiveJobs(userId: number): number {
  const row = handles.db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
        WHERE user_id = ? AND status IN ('queued','running')`,
    )
    .get(userId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function listAllJobRows(limit = 200): JobRow[] {
  return handles.db
    .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
    .all(limit) as unknown as JobRow[];
}

export function updateJobRow(
  id: string,
  patch: {
    status?: string;
    resultPath?: string | null;
    resultSize?: number | null;
    error?: string | null;
    note?: string | null;
  },
): void {
  const current = getJobRow(id);
  if (!current) return;
  handles.db
    .prepare(
      `UPDATE jobs SET status = ?, result_path = ?, result_size = ?, error = ?, note = ?
        WHERE id = ?`,
    )
    .run(
      patch.status ?? current.status,
      patch.resultPath === undefined ? current.result_path : patch.resultPath,
      patch.resultSize === undefined ? current.result_size : patch.resultSize,
      patch.error === undefined ? current.error : patch.error,
      patch.note === undefined ? current.note : patch.note,
      id,
    );
}

export function saveJobLogs(id: string, logsJson: string): void {
  handles.db.prepare("UPDATE jobs SET logs = ? WHERE id = ?").run(logsJson, id);
}

export function deleteJobRow(id: string): void {
  handles.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
}

/* ------------------------------------------------------------------- seed */


function seedAdmin(): void {
  const username = (process.env.ADMIN_USERNAME ?? "").trim();
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (!username || !password) return;
  if (getUserByUsername(username)) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hashPassword } = require("./auth") as typeof import("./auth");
  // Web and dispatcher can initialize the same fresh database simultaneously.
  handles.db.prepare(`INSERT OR IGNORE INTO users
    (username, password_hash, role, quota, used, disabled, created_at)
    VALUES (?, ?, 'admin', ?, 0, 0, ?)`).run(
      username, hashPassword(password), Number(process.env.ADMIN_QUOTA ?? 100000), Date.now(),
    );
}

let seeded = false;


export function initDb(): void {
  if (seeded) return;
  migrate();
  seeded = true;
  void sessionSecret();
}
