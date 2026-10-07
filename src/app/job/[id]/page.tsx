"use client";

import { BETA_CONTACT } from "@/lib/beta-contact";
import JobCoffeeSupport from "@/components/JobCoffeeSupport";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import LogView from "@/components/LogView";
import UserBar from "@/components/UserBar";
import { DocxPreview, PreviewFacts } from "@/components/DocxPreview";
import PreviewOverlay from "@/components/PreviewOverlay";
import { LevelBar } from "@/components/Hud";
import type { Job, LogEntry, LogLevel } from "@/lib/types";
import type { PreviewDoc, PreviewResponse } from "@/lib/preview-types";

/** Wire shape of the SSE `log` event (see GET /api/jobs/:id/events). */
interface LogPayload {
  level: LogLevel;
  text: string;
  ts: number;
}

/** Wire shape of the SSE `status` event. */
interface StatusPayload {
  status: Job["status"];
  note?: string;
  error?: string;
  resultSize?: number;
}

/**
 * How long we wait before offering the user a manual "stop waiting" affordance.
 *
 * This is deliberately NOT a hard give-up. The earlier version closed the
 * EventSource and stopped polling after 15 minutes, which killed the page even
 * though the server-side run was still going (and had a 30 minute budget). The
 * user was told "it is stuck" while it was actually still working.
 *
 * Now we keep listening well past the server budget and only show a hint that
 * lets the user leave on their own terms.
 */
const CLIENT_SOFT_TIMEOUT_MS = 25 * 60 * 1000;

/** Reconnect attempts for the EventSource before falling back to polling. */
const MAX_RETRIES = 5;

/** First retry delay; doubles up to RETRY_CAP_MS. */
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 16_000;

/** Fallback poll cadence while the event stream is unavailable. */
const POLL_MS = 4000;

function isLogLevel(value: unknown): value is LogLevel {
  return (
    value === "info" || value === "warn" || value === "error" || value === "success"
  );
}

function parsePayload<T>(event: MessageEvent): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

function formatBytes(size: number | undefined): string {
  if (!size || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes} 分 ${seconds < 10 ? "0" : ""}${seconds} 秒`;
}

type Level = 1 | 2 | 3 | 4;

/**
 * Load state of the sheet preview.
 *
 * Kept as one discriminated union rather than four booleans so the sidebar
 * cannot show "正在解析" and an error at the same time.
 */
type PreviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; doc: PreviewDoc }
  | { status: "error"; message: string };

const STAGE_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "正在识别",
  done: "已完成",
  error: "出错了",
};

/**
 * Map the human stage label onto the level axis (1–4).
 *
 * The four levels are the product's real pipeline: upload → recognise →
 * typeset → produce. The agent emits its own wording, so `stageText` (which
 * sniffs the log for Chinese keywords) is the single source of truth here.
 */
function levelForStage(stage: string): Level {
  if (/已完成|生成成功|做好了/.test(stage)) return 4;
  if (/生成 Word|保存/.test(stage)) return 4;
  if (/排版|表格|脚本|裁切|核对|修正/.test(stage)) return 3;
  return 2;
}

const LEVEL_NAMES: Record<Level, string> = {
  1: "拍照上传",
  2: "识别题目",
  3: "整理版面",
  4: "生成 Word",
};

const NEXT_STEPS: Record<Level, string[]> = {
  1: ["接收试卷照片", "开始逐字识别"],
  2: ["逐字识别题目与选项", "判断题型并核对文字"],
  3: ["按题型排成宋体卷面", "生成答题横线与题号"],
  4: ["生成可编辑的 Word", "核对后修改或打印"],
};

function logKey(entry: { ts: number; level: string; text: string }): string {
  return `${entry.ts}|${entry.level}|${entry.text}`;
}

function isRenderableLog(entry: unknown): entry is LogEntry {
  if (!entry || typeof entry !== "object") return false;
  const candidate = entry as Partial<LogEntry>;
  return (
    typeof candidate.text === "string" &&
    typeof candidate.ts === "number" &&
    isLogLevel(candidate.level)
  );
}

/**
 * Merge the authoritative log list from a GET snapshot with whatever the SSE
 * stream has already delivered.
 *
 * Snapshot entries are canonical (the server keeps the full list), and any
 * stream-only entries that the snapshot does not know about yet are appended in
 * order. Duplicates are removed by (ts, level, text), so reconnecting the event
 * stream or polling never grows the list twice.
 */
function mergeLogs(prev: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  if (incoming.length === 0) return prev;

  const merged: LogEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: LogEntry) => {
    const key = logKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(entry);
  };

  // Entries already on screen keep their position and order. A snapshot can be
  // newer while still containing older lines, so appending the whole snapshot
  // first would visibly shuffle history. Stream-only entries the snapshot does
  // not know about yet are appended after the known ones.
  prev.forEach(push);
  incoming.forEach(push);

  if (merged.length === prev.length) {
    // Nothing new — keep the previous array identity so React skips a needless
    // re-render and the autoscroll effect stays put.
    let identical = true;
    for (let i = 0; i < merged.length; i += 1) {
      if (merged[i] !== prev[i]) {
        identical = false;
        break;
      }
    }
    if (identical) return prev;
  }

  // Only reorder when timestamps actually disagree; equal timestamps must not
  // be reshuffled, or repeated snapshots would flip lines around on screen.
  merged.sort((a, b) => a.ts - b.ts);
  return merged.slice(-2000);
}

export default function JobPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === "string" ? params.id : "";

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<Job["status"]>("queued");
  const [note, setNote] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [resultSize, setResultSize] = useState<number | undefined>(undefined);
  const [connectionNote, setConnectionNote] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [linkMessage, setLinkMessage] = useState("");

  async function copyResultLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setLinkMessage("链接已复制，保存后就能回来查看进度和下载。");
    } catch {
      setLinkMessage("暂时无法复制，请复制浏览器地址栏里的链接并保存。");
    }
  }

  const slowNoticedRef = useRef(false);
  const previewRequestedRef = useRef(false);


  const startedAtRef = useRef<number>(Date.now());
  const terminalRef = useRef(false);
  const retriesRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const finished = status === "done" || status === "error";

  const stageText = useMemo(() => {
    if (status === "done") return "已完成";
    if (status === "error") return "生成失败";
    if (timedOut) return "仍在处理（比平时慢）";
    if (status === "running") {
      const last = logs.length > 0 ? logs[logs.length - 1].text : "";
      if (last.startsWith("正在")) return last;
      if (/docx|Word|生成文档|保存/.test(last)) return "正在生成 Word";
      if (/排版|table|python|脚本/.test(last)) return "正在排版";
      return "正在识别";
    }
    return STAGE_LABELS[status] ?? "正在识别";
  }, [logs, status, timedOut]);

  const applyJob = useCallback((job: Partial<Job> & { id?: string }) => {
    if (typeof job.createdAt === "number" && job.createdAt > 0) {
      // Measure the client budget from server-side job creation, not page load:
      // a refresh must not hand the user a fresh 15 minutes.
      startedAtRef.current = Math.min(startedAtRef.current, job.createdAt);
    }
    if (Array.isArray(job.logs)) {
      const incoming = job.logs.filter(isRenderableLog);
      setLogs((prev) => mergeLogs(prev, incoming));
    }
    if (typeof job.status === "string") {
      const nextStatus = job.status;
      setStatus(nextStatus);
      if (nextStatus === "done" || nextStatus === "error") {
        terminalRef.current = true;
        // Freeze the clock the moment the run reaches a terminal state. The
        // interval below is torn down as soon as `finished` flips, so without
        // this a job that was already done when the page loaded would report
        // "0 分 00 秒" — the teacher reading the finished screen wants to know
        // how long the run actually took, not what time it is now.
        setElapsed(Date.now() - startedAtRef.current);
      }
    }
    if (typeof job.note === "string") setNote(job.note);
    if (typeof job.error === "string") setError(job.error);
    if (typeof job.resultSize === "number") setResultSize(job.resultSize);
  }, []);

  const appendLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => {
      if (prev.some((existing) => logKey(existing) === logKey(entry))) {
        return prev;
      }
      return [...prev, entry].slice(-2000);
    });
  }, []);

  const fetchJob = useCallback(async (): Promise<Job | null> => {
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      if (!response.ok) return null;
      const job = (await response.json()) as Job;
      if (!job || typeof job.id !== "string") return null;
      applyJob(job);
      return job;
    } catch {
      return null;
    }
  }, [applyJob, id]);

  /* ---------------- event stream with backoff ---------------- */

  useEffect(() => {
    if (!id) return undefined;

    let disposed = false;

    const clearRetry = () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const stopPolling = () => {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };

    const startPolling = () => {
      if (pollTimerRef.current !== null || disposed || terminalRef.current) return;
      pollTimerRef.current = setInterval(() => {
        if (disposed || terminalRef.current) {
          stopPolling();
          return;
        }
        void fetchJob().then((job) => {
          if (job && (job.status === "done" || job.status === "error")) {
            stopPolling();
          }
        });
      }, POLL_MS);
    };

    const closeSource = () => {
      sourceRef.current?.close();
      sourceRef.current = null;
    };

    const connect = () => {
      if (disposed || terminalRef.current) return;
      closeSource();

      const source = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
      sourceRef.current = source;

      source.addEventListener("open", () => {
        retriesRef.current = 0;
        setConnectionNote(null);
        stopPolling();
      });

      source.addEventListener("log", (event) => {
        const payload = parsePayload<LogPayload>(event as MessageEvent);
        if (!payload || typeof payload.text !== "string") return;
        appendLog({
          ts: typeof payload.ts === "number" ? payload.ts : Date.now(),
          level: isLogLevel(payload.level) ? payload.level : "info",
          text: payload.text,
        });
      });

      source.addEventListener("status", (event) => {
        const payload = parsePayload<StatusPayload>(event as MessageEvent);
        if (!payload) return;
        if (typeof payload.note === "string") setNote(payload.note);
        if (typeof payload.error === "string") setError(payload.error);
        if (typeof payload.resultSize === "number") setResultSize(payload.resultSize);
        if (typeof payload.status === "string") {
          setStatus(payload.status);
          if (payload.status === "done" || payload.status === "error") {
            terminalRef.current = true;
            closeSource();
            stopPolling();
          }
        }
      });

      source.addEventListener("error", () => {
        if (disposed || terminalRef.current) {
          closeSource();
          return;
        }
        closeSource();
        void fetchJob();

        if (retriesRef.current >= MAX_RETRIES) {
          setConnectionNote("连接暂时不稳定，正在继续为你更新进度。");
          startPolling();
          return;
        }

        const delay = Math.min(
          RETRY_BASE_MS * 2 ** retriesRef.current,
          RETRY_CAP_MS,
        );
        retriesRef.current += 1;
        setConnectionNote(
          `连接暂时中断，${Math.round(delay / 1000)} 秒后自动重连，你无需重新上传。`,
        );
        clearRetry();
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null;
          void fetchJob().then(() => connect());
        }, delay);
      });
    };

    void fetchJob().then(() => {
      if (disposed || terminalRef.current) return;
      connect();
    });

    return () => {
      disposed = true;
      clearRetry();
      stopPolling();
      closeSource();
    };
  }, [appendLog, fetchJob, id]);

  /* ---------------- elapsed clock + hard timeout ---------------- */

  useEffect(() => {
    if (!id) return undefined;
    if (finished && !timedOut) return undefined;

    const tick = setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsed(ms);
      // Soft threshold only: show the hint, but KEEP the stream and the
      // poller alive. The server owns the real deadline and will report
      // done or error on its own.
      if (!terminalRef.current && ms >= CLIENT_SOFT_TIMEOUT_MS && !slowNoticedRef.current) {
        slowNoticedRef.current = true;
        setTimedOut(true);
        setConnectionNote(
          "这份卷子整理得比较久，还在处理中。保存结果链接后，你可以关掉页面，" +
            "照片会继续整理，稍后可以回来查看。",
        );
      }
    }, 1000);

    return () => clearInterval(tick);
  }, [finished, id, timedOut]);

  /* ---------------- preview: fetched once the run is done ---------------- */

  useEffect(() => {
    // Not before "done": the agent rewrites out/result.docx while it works, so
    // an earlier fetch would paint a half-written document and never refresh.
    // The ref keeps this to one request per page load (no refetch loop when the
    // state below changes).
    if (!id || status !== "done" || previewRequestedRef.current) return undefined;
    previewRequestedRef.current = true;

    let disposed = false;
    setPreview({ status: "loading" });

    void (async () => {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(id)}/preview`, {
          cache: "no-store",
        });
        const payload = (await response.json()) as PreviewResponse;
        if (disposed) return;

        if (!response.ok || !payload || payload.ok !== true) {
          const message =
            payload && payload.ok === false && typeof payload.error === "string"
              ? payload.error
              : "预览暂时不可用，可以先下载查看。";
          setPreview({ status: "error", message });
          return;
        }
        setPreview({ status: "ready", doc: payload });
      } catch {
        if (disposed) return;
        setPreview({ status: "error", message: "预览加载失败，可以先下载查看。" });
      }
    })();

    return () => {
      disposed = true;
    };
  }, [id, status]);

  /* ---------------- render ---------------- */

  const downloadHref = `/api/jobs/${encodeURIComponent(id)}/download`;

  const level = useMemo(() => {
    if (status === "done") return 4 as const;
    if (status === "error") return 2 as const;
    return levelForStage(stageText);
  }, [stageText, status]);

  const bossState = status === "done" ? "done" : status === "error" ? "fail" : "work";

  // A finished run keeps showing how long it took: the teacher's first
  // question on this screen is "how long was that", not "what time is it".
  const bossLine =
    status === "done"
      ? `文档已做好，可以下载了（共 ${formatElapsed(elapsed)}）。`
      : status === "error"
        ? "这次没能生成，请回到上传页重试。"
        : stageText;

  return (
    <div>
      <UserBar
        level={level}
        extraActions={[{ key: "MAP", label: "上传新卷子", href: "/app" }]}
      />
      <LevelBar current={level} />

      <main className="stage">
        <div className="job-main">
        <section className="panel" aria-labelledby="stage-heading">
          <div className="panel-h">
            <h2 id="stage-heading">
              <span
                className="px"
                style={{ color: level === 4 ? "var(--l1-c)" : "var(--l4-c)" }}
                aria-hidden="true"
              >
                {status === "done" ? "★" : status === "error" ? "■" : "◈"}
              </span>
              {status === "done" ? "你的 Word 已做好" : status === "error" ? "这次没有生成成功" : "正在帮你整理练习卷"}
            </h2>
            <span className="aside">{status === "done" ? "可以下载" : status === "error" ? "请重试" : "请稍等"}</span>
          </div>

          <div className="panel-b">
            {/* Activity indicator; no numeric completion estimate. */}
            <div className="bossbar">
              <div className="bosshead">
                <span>

                  <span className="stage-name">{LEVEL_NAMES[level]}</span>
                </span>
                {status === "done" ? (
                  <span className="clock" style={{ color: "var(--l1-c)" }}>已完成</span>
                ) : status === "error" ? (
                  <span className="clock" style={{ color: "#ff8b7d" }}>未完成</span>
                ) : (
                  <span className="clock">{formatElapsed(elapsed)}</span>
                )}
              </div>
              <div className={`hp ${bossState}`}>
                <i />
              </div>
              <div className="stage-say">
                <span className="blink" aria-hidden="true">
                  {status === "done" ? "★" : status === "error" ? "■" : "▮"}
                </span>
                <span className="cn">{bossLine}</span>
              </div>
            </div>

            {/* 对话框：用老师的口吻解释为什么慢、为什么可以走开 */}
            {status === "done" ? (
              <div className="dlg">
                做好了。用 Word 或 WPS 打开，<em>就能修改题目和版面</em>。
                打印前请核对文字、公式和分页，也别忘了查看识别备注。
              </div>
            ) : status === "error" ? (
              <div className="alert alert-error" role="alert">
                {error ?? "生成失败，请回到上传页重试。"}
              </div>
            ) : (
              <div className="dlg">
                照片已收到，接下来会识别题目、整理版面并生成 Word。
                <em>生成需要一些时间，你不用一直守在这里</em>。
                先保存结果链接，关掉页面后也会继续整理，稍后用同一个链接回来查看。
              </div>
            )}

            {timedOut && !finished ? (
              <div className="alert alert-warn" role="status">
                这份卷子整理得比平时久，还在处理中。保存结果链接后可以先离开，
                稍后回来查看，不用重复上传。
              </div>
            ) : null}

            {connectionNote ? (
              <div className="alert alert-info" role="status">
                {connectionNote}
              </div>
            ) : null}

            {status === "done" ? (
              <>
                <a className="act go" href={downloadHref} download>
                  <span className="px" aria-hidden="true">▼</span>
                  下载 Word 文档
                  {resultSize ? (
                    <span style={{ fontSize: 13, fontWeight: 500, opacity: 0.75 }}>
                      （{formatBytes(resultSize)}）
                    </span>
                  ) : null}
                </a>
                {note ? (
                  <details className="note-wrap">
                    <summary>识别备注</summary>
                    <p className="note">{note}</p>
                  </details>
                ) : null}
                <Link className="act quiet" href="/app">
                  <span className="px" aria-hidden="true">◀</span>
                  整理另一份练习卷
                </Link>
              </>
            ) : null}

            {status === "error" || (timedOut && !finished) ? (
              <Link className="act quiet" href="/app">
                <span className="px" aria-hidden="true">◀</span>
                {status === "error" ? "返回上传页重试" : "先去整理另一份"}
              </Link>
            ) : null}
          </div>
        </section>
        <JobCoffeeSupport />
        </div>

        <aside className="side">
          {/* 预览放在侧栏最前面：做完之后老师第一眼要看的就是它 */}
          {status === "done" ? (
            <div className="hudbox">
              <div className="strip green">
                <span>排版预览</span>
              </div>
              <div className="b">
                {preview.status === "loading" ? (
                  <p className="hintline">正在准备预览 …</p>
                ) : preview.status === "ready" ? (
                  <>
                    <div className="pf-card-sheet">
                      <DocxPreview doc={preview.doc} variant="fit" />
                    </div>
                    <button
                      type="button"
                      className="pf-open"
                      onClick={() => setPreviewOpen(true)}
                    >
                      <span className="px" aria-hidden="true">▣</span>
                      放大预览
                    </button>
                    <PreviewFacts doc={preview.doc} className="pf-facts-card" />
                  </>
                ) : (
                  <>
                    <p className="hintline">
                      {preview.status === "error"
                        ? preview.message
                        : "预览暂时不可用，可以先下载查看。"}
                    </p>
                    <a className="act quiet" href={downloadHref} download>
                      <span className="px" aria-hidden="true">▼</span>
                      下载 Word 文档
                    </a>
                  </>
                )}
              </div>
            </div>
          ) : null}

          <div className="hudbox">
            <div className="strip green">
              <span>{status === "done" ? "本次用时" : "已等待"}</span>
              <b>{formatElapsed(elapsed)}</b>
            </div>
            <div className="b">
              <h3>稍后回来，怎么找这份卷子？</h3>
              <p className="hintline">保存本页链接，登录同一账号后，就能查看进度和下载结果。</p>
              <button type="button" className="btn" onClick={() => void copyResultLink()}>复制结果链接</button>
              <p className="hintline" role="status">{linkMessage}</p>
            </div>
          </div>

          <div className="hudbox">
            <div className="strip blue">
              <span>{status === "done" ? "下载之后" : status === "error" ? "重试之前" : "接下来"}</span>
              <b className="cn-name">{status === "done" ? "核对与使用" : status === "error" ? "检查照片" : LEVEL_NAMES[level]}</b>
            </div>
            <div className="b">
              {(status === "done" ? ["用 Word 或 WPS 打开", "核对文字、公式和分页", "修改后保存或打印"] : status === "error" ? ["确认照片清楚、光线均匀", `重新上传，或私信${BETA_CONTACT}反馈`] : NEXT_STEPS[level]).map((step) => (
                <div className="tip" key={step}>
                  {step}
                </div>
              ))}
            </div>
          </div>
        </aside>

        <details className="note-wrap processing-details" style={{ gridColumn: "1 / -1" }}>
          <summary>查看处理详情（遇到问题时可展开）</summary>
          <LogView entries={logs} emptyText="正在准备处理照片 …" />
        </details>
      </main>

      {previewOpen && preview.status === "ready" ? (
        <PreviewOverlay
          doc={preview.doc}
          downloadHref={downloadHref}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </div>
  );
}
