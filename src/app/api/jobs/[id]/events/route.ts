import { jobSnapshot } from "@/lib/jobs";
import { requireJobAccess } from "@/lib/job-guard";
import type { Job, LogEntry } from "@/lib/types";

/**
 * GET /api/jobs/:id/events
 *
 * Server-Sent Events stream of a job's progress.
 *
 *   event: log     { level, text, ts }
 *   event: status  { status, note?, error?, resultSize? }
 *
 * The job registry keeps the authoritative append-only log list in memory, so
 * this route tails it by index instead of wiring a per-job emitter. That keeps
 * reconnecting cheap: a browser that drops the stream resumes from the current
 * cursor and gets the backlog it missed.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How often the tail loop checks for new log lines. */
const POLL_INTERVAL_MS = 250;

/** Comment frame cadence, to keep proxies from closing an idle connection. */
const HEARTBEAT_MS = 15_000;

/** Stop streaming jobs that were never registered, after this long. */
const UNKNOWN_JOB_GRACE_MS = 30_000;

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

function statusPayload(job: Job): Record<string, unknown> {
  return {
    status: job.status,
    note: job.note,
    error: job.error,
    resultSize: job.resultSize,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;

  // Same ownership rule as the other per-job routes: this stream carries the
  // full log, which would otherwise let one teacher watch another's run.
  const guard = await requireJobAccess(id);
  if (!guard.ok) return guard.response;

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let cursor = 0;
      let lastHeartbeat = Date.now();
      let timer: ReturnType<typeof setInterval> | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      const write = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          close();
        }
      };

      // Initial retry hint for the browser, and an immediate flush so the
      // client's `open` handler fires without waiting for the first log line.
      write(encoder.encode("retry: 2000\n\n"));

      const tick = () => {
        if (closed) return;

        let job: Job | undefined;
        try {
          job = jobSnapshot(id);
        } catch {
          write(sse("status", { status: "error", error: "任务编号不合法。" }));
          close();
          return;
        }

        if (!job) {
          if (Date.now() - startedAt > UNKNOWN_JOB_GRACE_MS) {
            write(sse("status", { status: "error", error: "找不到这个任务。" }));
            close();
          }
          return;
        }

        // A restarted or shrunk log list means this cursor is meaningless.
        if (cursor > job.logs.length) cursor = 0;

        for (let i = cursor; i < job.logs.length; i += 1) {
          const entry: LogEntry = job.logs[i];
          write(sse("log", entry));
        }
        cursor = job.logs.length;

        if (job.status === "done" || job.status === "error") {
          write(sse("status", statusPayload(job)));
          close();
          return;
        }

        if (Date.now() - lastHeartbeat >= HEARTBEAT_MS) {
          lastHeartbeat = Date.now();
          write(encoder.encode(": keep-alive\n\n"));
        }
      };

      timer = setInterval(tick, POLL_INTERVAL_MS);

      // Emit whatever already exists synchronously.
      tick();

      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Prevent reverse proxies (nginx/Coolify) from buffering the stream.
      "X-Accel-Buffering": "no",
    },
  });
}
