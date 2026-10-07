import { execFile } from "node:child_process";
import { previewScriptPath, resolvePythonBin } from "./config";
import type { ResultFile } from "./jobs";
import type { PreviewDoc, PreviewResponse } from "./preview-types";

/**
 * Server-side bridge to scripts/docx_preview.py.
 *
 * The extractor is a stdlib-only Python script, for two reasons: it keeps the
 * preview working even when the Python venv is broken, and it reuses the exact
 * XML-walking approach scripts/verify.py already relies on.
 *
 * The trade-off this file manages is cost: spawning a process per request is
 * fine (tens of milliseconds on a document this size) but wasteful when a
 * teacher reopens a finished job, so results are memoised in-process and keyed
 * on the file's mtime + size. Nothing is written to disk, so there is no cache
 * to invalidate or clean up, and a fresh server just re-parses.
 */

/** Hard cap on one parse. A document we cannot read in 15s is not previewable. */
const PARSE_TIMEOUT_MS = 15_000;

/** stdout budget: the JSON payload for a capped document stays well under this. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** How many parsed documents to keep around, newest first. */
const CACHE_LIMIT = 16;

/**
 * Message shown whenever the extractor fails for any reason. The concrete
 * cause is logged server-side; the browser gets one sentence plus the download
 * button, because a teacher can act on "download it" and not on a traceback.
 */
const FAILED: PreviewResponse = {
  ok: false,
  error: "预览解析失败，请直接下载查看。",
};

const cache = new Map<string, Promise<PreviewResponse>>();

/**
 * Environment handed to the extractor.
 *
 * Deliberately minimal: the script reads a local file and prints JSON, so it
 * must never inherit DEEPSEEK_API_KEY, PAPERFORGE_API_KEY or SESSION_SECRET.
 * `NODE_ENV` is absent on purpose, which is why this needs the cast — a full
 * ProcessEnv is exactly what we are avoiding. LANG/LC_ALL keep Python's stdout
 * on UTF-8 (the container may otherwise run with LANG=C).
 */
const CHILD_ENV = {
  PATH: process.env.PATH ?? "",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
} as unknown as NodeJS.ProcessEnv;

function cacheKey(file: ResultFile): string {
  return `${file.path}:${file.mtimeMs}:${file.size}`;
}

function parseStdout(stdout: string): PreviewResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    console.error("[preview] extractor produced invalid JSON");
    return FAILED;
  }

  if (!parsed || typeof parsed !== "object") {
    console.error("[preview] extractor produced a non-object payload");
    return FAILED;
  }

  const candidate = parsed as { ok?: unknown; error?: unknown };
  if (candidate.ok !== true) {
    const reason =
      typeof candidate.error === "string" && candidate.error.length > 0
        ? candidate.error
        : "unknown error";
    console.error(`[preview] extractor reported: ${reason}`);
    return FAILED;
  }

  return parsed as PreviewDoc;
}

function runExtractor(file: ResultFile): Promise<PreviewResponse> {
  return new Promise((resolve) => {
    execFile(
      resolvePythonBin(),
      [previewScriptPath(), file.path],
      {
        timeout: PARSE_TIMEOUT_MS,
        maxBuffer: MAX_STDOUT_BYTES,
        encoding: "utf8",
        env: CHILD_ENV,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message || "").toString().slice(0, 2000);
          console.error("[preview] extractor failed:", detail);
          resolve(FAILED);
          return;
        }
        resolve(parseStdout(stdout ?? ""));
      },
    );
  });
}

/**
 * Parsed preview for a job's document, memoised per file version.
 *
 * The cached value is the *promise*, so two requests that arrive while the
 * first parse is still running share one child process instead of racing.
 * Failures are evicted rather than cached: a transient problem (a missing
 * interpreter, a file mid-write) must not poison the entry until restart.
 */
export function previewForFile(file: ResultFile): Promise<PreviewResponse> {
  const key = cacheKey(file);

  const cached = cache.get(key);
  if (cached) {
    // Refresh recency so the LRU eviction below drops colder entries.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const pending = runExtractor(file);
  cache.set(key, pending);

  void pending.then((result) => {
    if (!result.ok) cache.delete(key);
  });

  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }

  return pending;
}
