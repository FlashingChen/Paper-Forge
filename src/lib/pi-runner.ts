import { AgentProgressReporter } from "./agent-progress";
import fs from "node:fs";
import { readUsagePrice, recordMessageUsage } from "./usage";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { loadRunEnv, resolvePiBin, resolvePythonBin, taskBriefPath } from "./config";
import {
  PI_API_KEY_ENV,
  ProviderConfigError,
  discardPiAgentDir,
  imageResizeLimits,
  preparePiAgentDir,
  resolveProviderConfig,
} from "./pi-provider";
import type { ModelSource, ResolvedProviderConfig } from "./pi-provider";
import { appendLog, updateJob } from "./jobs";
import type { Job, LogLevel, RunOptions } from "./types";

/**
 * Runs the pi coding agent in RPC mode against a prepared job directory and
 * returns the finished Job record.
 *
 * Protocol reference: docs/rpc.md and docs/rpc-commands.md in the pi package.
 *   stdin  <- one JSON command record per line
 *   stdout -> one JSON record per line (responses + session events)
 *   stderr  -> diagnostics only, never protocol data
 */

const MAX_TOOL_RESULT_CHARS = 400;
const STDERR_KEEP_CHARS = 8000;

/** Extension applied to images when the uploaded filename has none. */
const DEFAULT_IMAGE_EXT = ".jpg";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

function extForFilename(filename: string): string {
  const ext = path.extname(filename || "").toLowerCase();
  if (ext && /^\.[a-z0-9]{1,5}$/.test(ext) && MIME_BY_EXT[ext]) return ext;
  return DEFAULT_IMAGE_EXT;
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return normalized.slice(0, max) + "…";
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Flatten a tool result / content-block value into plain text. */
function contentToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => contentToText(item))
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) return contentToText(record.content);
    if (record.type === "image") return "[image]";
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

/** Short human-readable summary of tool call arguments for the log. */
function summarizeArgs(toolName: string, args: unknown): string {
  if (args == null) return "";
  if (typeof args !== "object") return truncate(String(args), 120);
  const record = args as Record<string, unknown>;

  const preferred = ["command", "file_path", "path", "filePath", "pattern", "query", "filename"];
  for (const key of preferred) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      return truncate(value, 160);
    }
  }

  const keys = Object.keys(record);
  if (keys.length === 0) return "";
  try {
    return truncate(JSON.stringify(record), 160);
  } catch {
    return `[${keys.join(", ")}]`;
  }
}

/**
 * How many image reads the agent may spend per uploaded page.
 *
 * 1 page = 1 full-page read + 3 chances to zoom into something illegible. The
 * budget is deliberately proportional to the upload rather than a fixed number:
 * a 16-page booklet and a single photo should not get the same allowance.
 *
 * It is a prompt-level budget, not an enforced one — pi cannot rewrite or reject
 * history, so nothing stops the agent from exceeding it. The backstop is the
 * encoded size cap in pi-provider.ts (`imageResizeLimits`), which is what
 * actually bounds the per-turn payload. Keep both.
 */
const IMAGE_READS_PER_PAGE = 4;

/**
 * Read the task brief and substitute the {{PYTHON}} / {{IMAGE_COUNT}} /
 * {{IMAGE_BUDGET}} placeholders.
 *
 * The image count has to reach the brief because the "how many pictures may you
 * look at" rule is scaled to the number of uploaded pages.
 */
export function buildSystemPrompt(python: string, imageCount: number): string {
  const brief = taskBriefPath();
  let text: string;
  try {
    text = fs.readFileSync(brief, "utf8");
  } catch {
    throw new Error(
      `Agent task brief not found at ${brief}. The pi agent cannot run without it.`,
    );
  }
  const pages = Math.max(1, imageCount);
  const budget = pages * IMAGE_READS_PER_PAGE;
  const substituted = text
    .split("{{PYTHON}}")
    .join(python)
    .split("{{IMAGE_COUNT}}")
    .join(String(pages))
    .split("{{IMAGE_BUDGET}}")
    .join(String(budget));
  return (
    substituted +
    `\n\n---\nRUNTIME FACTS (authoritative, do not re-probe):\n` +
    `- Python interpreter for running your script: ${python}\n` +
    `- You are running inside the job directory. Inputs are in ./in/, ` +
    `write your script to ./out/ and the final document to ./out/result.docx.\n` +
    `- Image budget for this job: ${budget} reads total for ${pages} uploaded ` +
    `page(s). Every image you read is re-sent to the model on every later turn, ` +
    `so this is a hard performance budget, not a suggestion.\n`
  );
}

/** Write image buffers into jobDir/in as 1.ext, 2.ext, ... preserving order. */
function writeImages(jobDir: string, images: RunOptions["images"]): string[] {
  const inDir = path.join(jobDir, "in");
  fs.mkdirSync(inDir, { recursive: true });

  const ordered = [...images].sort((a, b) => a.index - b.index);
  const written: string[] = [];

  ordered.forEach((image, position) => {
    const ext = extForFilename(image.filename);
    const name = `${position + 1}${ext}`;
    fs.writeFileSync(path.join(inDir, name), image.buffer);
    written.push(name);
  });

  return written;
}

/** Build the user prompt handed to pi. */
function buildPrompt(imageFiles: string[]): string {
  const listing = imageFiles.map((name, i) => `  ${i + 1}. in/${name}`).join("\n");
  return (
    `Convert the photographed exercise sheet into a Word document.\n\n` +
    `The photos are (in order):\n${listing}\n\n` +
    `Read the images with the read tool, then follow the system instructions ` +
    `exactly: write a Python script using python-docx to out/build.py, run it ` +
    `with the provided interpreter, and produce out/result.docx. ` +
    `The working directory is the job directory; use relative paths.`
  );
}

/**
 * Parse one JSONL record emitted by pi RPC mode and translate it into log lines.
 * Returns the assistant text when the record is a completed assistant message.
 */
interface TranslateResult {
  finalAssistantText?: string;
  /**
   * Why the assistant message ended, straight from the provider
   * ("stop" | "toolUse" | "length" | "max_tokens" | "error" | "aborted").
   */
  assistantStopReason?: string;
  /** The assistant said nothing and called no tool: the agent stops here. */
  emptyAssistantTurn?: boolean;
}

function translateRecord(
  record: Record<string, unknown>,
  onLog: (level: LogLevel, text: string) => void,
): TranslateResult {
  const type = str(record.type);
  if (!type) return {};

  switch (type) {
    case "response": {
      const success = record.success !== false;
      const command = str(record.command) ?? "unknown";
      if (!success) {
        const error = str(record.error) ?? "unknown error";
        onLog("error", `pi command "${command}" failed: ${error}`);
      } else if (command !== "prompt") {
        onLog("info", `pi command "${command}" accepted`);
      }
      return {};
    }

    case "agent_start":
      onLog("info", "Agent run started");
      return {};

    case "agent_end":
      onLog("info", "Agent run finished");
      return {};

    case "agent_settled":
      onLog("success", "Agent settled");
      return {};

    case "turn_start":
      onLog("info", "Turn started");
      return {};

    case "turn_end": {
      const toolResults = record.toolResults;
      const count = Array.isArray(toolResults) ? toolResults.length : 0;
      onLog("info", `Turn finished (${count} tool result${count === 1 ? "" : "s"})`);
      return {};
    }

    case "message_end": {
      const message = record.message as Record<string, unknown> | undefined;
      if (!message) return {};
      const role = str(message.role);
      if (role !== "assistant") return {};

      const content = message.content;
      const text = Array.isArray(content)
        ? content
            .filter(
              (block): block is Record<string, unknown> =>
                !!block && typeof block === "object" && (block as Record<string, unknown>).type === "text",
            )
            .map((block) => contentToText(block.text))
            .join("\n")
        : typeof content === "string"
          ? content
          : "";

      const stopReason = str(message.stopReason);
      if (text.trim().length > 0) {
        for (const line of text.split("\n")) {
          if (line.trim().length > 0) onLog("info", line);
        }
      }
      if (stopReason === "error") {
        const errorMessage = str(message.errorMessage) ?? "provider error";
        onLog("error", `Assistant message ended with error: ${errorMessage}`);
      } else if (stopReason === "length" || stopReason === "max_tokens") {
        // The output budget ran out. On a reasoning model this is often ALL
        // thinking and no visible text, which looks like the agent silently
        // giving up: the next turn has no tool call, so the run just ends.
        onLog(
          "warn",
          `模型输出到达上限就断了（stopReason=${stopReason}）：这一轮的正文可能被截断或为空。` +
            `如果反复出现，多半是推理内容吃光了输出预算——检查 models.json 里该模型的 ` +
            `maxTokens / reasoning 声明，或换一个输出上限更大的模型。`,
        );
      }

      const content_blocks = Array.isArray(content)
        ? content.filter(
            (block): block is Record<string, unknown> =>
              !!block && typeof block === "object",
          )
        : [];
      const calledTool = content_blocks.some(
        (block) => str(block.type) === "toolCall" || str(block.type) === "tool_use",
      );
      const emptyAssistantTurn = text.trim().length === 0 && !calledTool;
      if (emptyAssistantTurn) {
        onLog(
          "warn",
          `这一轮模型没有输出任何文字，也没有调用工具（stopReason=${stopReason ?? "?"}）；` +
            `agent 会就此结束。常见原因：输出预算被推理内容吃光、模型不支持工具调用、` +
            `或 provider 能力声明不对（用后台的「测试连接」可以先把端点和模型确认一遍）。`,
        );
      }

      return {
        finalAssistantText: text.trim().length > 0 ? text : undefined,
        assistantStopReason: stopReason,
        emptyAssistantTurn,
      };
    }

    case "message_update": {
      const event = record.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!event) return {};
      const eventType = str(event.type);
      if (eventType === "error") {
        const reason = str(event.reason) ?? str(event.error) ?? "stream error";
        onLog("error", `Stream error: ${truncate(reason, MAX_TOOL_RESULT_CHARS)}`);
      } else if (eventType === "toolcall_start") {
        const toolName = str(event.toolName) ?? "tool";
        onLog("info", `Calling tool: ${toolName}`);
      }
      return {};
    }

    case "tool_execution_start": {
      const toolName = str(record.toolName) ?? "tool";
      const summary = summarizeArgs(toolName, record.args);
      onLog("info", summary ? `${toolName}: ${summary}` : `${toolName}`);
      return {};
    }

    case "tool_execution_end": {
      const toolName = str(record.toolName) ?? "tool";
      const result = record.result as Record<string, unknown> | undefined;
      const text = truncate(contentToText(result?.content ?? result), MAX_TOOL_RESULT_CHARS);
      const isError = record.isError === true;
      if (isError) {
        onLog("error", `${toolName} failed: ${text || "unknown error"}`);
      } else if (text.length > 0) {
        onLog("info", `${toolName} -> ${text}`);
      }
      return {};
    }

    case "auto_retry_start": {
      const attempt = record.attempt ?? "?";
      const maxAttempts = record.maxAttempts ?? "?";
      const errorMessage = str(record.errorMessage) ?? "transient error";
      onLog("warn", `Retry ${attempt}/${maxAttempts}: ${truncate(errorMessage, 200)}`);
      return {};
    }

    case "auto_retry_end": {
      if (record.success === false) {
        onLog("error", `Retries exhausted: ${truncate(str(record.finalError) ?? "", 200)}`);
      } else {
        onLog("info", "Retry succeeded");
      }
      return {};
    }

    case "compaction_start":
      onLog("warn", `Compacting context (${str(record.reason) ?? "threshold"})`);
      return {};

    case "compaction_end":
      onLog("info", "Compaction finished");
      return {};

    case "extension_error": {
      const extError = str(record.error) ?? "unknown";
      onLog("error", `Extension error: ${truncate(extError, 200)}`);
      return {};
    }

    default:
      return {};
  }
}

/** Wait until one of the given files exists on disk. */
async function waitForFile(
  candidates: string[],
  deadline: number,
  pollMs = 100,
): Promise<string | undefined> {
  for (;;) {
    for (const candidate of candidates) {
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && stat.size > 0) return candidate;
      } catch {
        // not there yet
      }
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function findAnyDocx(outDir: string): string | undefined {
  let entries: string[];
  try {
    entries = fs.readdirSync(outDir);
  } catch {
    return undefined;
  }
  const docx = entries
    .filter((name) => name.toLowerCase().endsWith(".docx") && !name.startsWith("~$"))
    .map((name) => path.join(outDir, name))
    .filter((full) => {
      try {
        return fs.statSync(full).isFile() && fs.statSync(full).size > 0;
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      const aTime = fs.statSync(a).mtimeMs;
      const bTime = fs.statSync(b).mtimeMs;
      return bTime - aTime;
    });
  return docx[0];
}

export async function runAgent(opts: RunOptions): Promise<Job> {
  const log = (level: LogLevel, text: string) => {
    appendLog(opts.jobId, level, text);
    try {
      opts.onLog(level, text);
    } catch {
      // A failing listener must never break the run.
    }
  };

  const env = loadRunEnv();
  const jobDir = path.resolve(opts.jobDir);
  const outDir = path.join(jobDir, "out");
  const resultPath = path.join(outDir, "result.docx");

  const job = updateJob(opts.jobId, { status: "running", imageCount: opts.images.length });
  if (!job) {
    throw new Error(`Unknown job: ${opts.jobId}`);
  }

  const fail = (message: string): Job => {
    log("error", message);
    return (
      updateJob(opts.jobId, { status: "error", error: message }) ?? {
        ...job,
        status: "error" as const,
        error: message,
      }
    );
  };

  // Which endpoint/model/key this run uses — or a message naming the field to
  // fix. Resolved before anything is written or spawned, so a misconfigured
  // provider reads as "fix your config" instead of an unexplainable upstream
  // failure many minutes in. It is also what stops PaperForge from inventing a
  // DeepSeek model id for somebody else's endpoint.
  let run: ResolvedProviderConfig;
  try {
    run = resolveProviderConfig(env);
  } catch (error) {
    return fail(
      error instanceof ProviderConfigError
        ? error.toString()
        : `模型配置有问题：${(error as Error).message}`,
    );
  }

  fs.mkdirSync(outDir, { recursive: true });

  let imageFiles: string[];
  try {
    imageFiles = writeImages(jobDir, opts.images);
    log("info", `Wrote ${imageFiles.length} image(s) to in/`);
  } catch (error) {
    return fail(`Could not write input images: ${(error as Error).message}`);
  }

  let systemPrompt: string;
  try {
    systemPrompt = buildSystemPrompt(resolvePythonBin(), imageFiles.length);
  } catch (error) {
    return fail((error as Error).message);
  }

  const args = [
    "--mode",
    "rpc",
    "--no-session",
    "--tools",
    "read,bash,edit,write",
    "--provider",
    run.provider,
    "--model",
    run.model,
    "--append-system-prompt",
    systemPrompt,
  ];
  // No --api-key here on purpose: the key reaches pi through the environment
  // (see the generated models.json), so it never shows up in `ps` output.

  const modelOrigin: Record<ModelSource, string> = {
    settings: "来自后台/环境变量",
    declared: "来自你 models.json 里该 provider 唯一声明的模型",
    "catalog-default": "pi 自带 catalog 的默认模型",
  };
  log("info", `Starting pi (provider ${run.provider}, model ${run.model})`);
  log("info", `模型来源：${modelOrigin[run.source]}`);
  log("info", `Endpoint ${run.baseUrl || "(provider 自带)"}`);
  log("info", `Timeout ${Math.round(env.timeoutMs / 1000)}s`);

  // pi only accepts a provider *name* on the command line — there is no
  // --base-url — so the endpoint the admin configured has to reach pi through
  // models.json. Without this, any provider pi does not ship in its own catalog
  // fails with `Unknown provider`. See src/lib/pi-provider.ts.
  const prepared = preparePiAgentDir(jobDir, run);
  const agentDir = prepared?.dir;
  if (prepared) {
    const limits = imageResizeLimits();
    log(
      "info",
      `Per-run pi config written for "${run.provider}/${run.model}" ` +
        `(images stored at <= ${limits.maxWidth}px / ${Math.round(limits.maxBytes / 1024)}KiB ` +
        `base64 / q${limits.jpegQuality})`,
    );
    for (const warning of prepared.warnings) {
      log("warn", warning);
    }
  } else {
    // Worth a warning rather than a note: with pi's own defaults an image is
    // only re-encoded above 4.5 MiB of base64, so every PNG the agent reads
    // stays full size in context and every later turn re-uploads it.
    log(
      "warn",
      `Could not write a per-run pi config for "${run.provider}"; using pi's ` +
        `defaults (images up to 4.5MiB base64). The agent will be slow if it ` +
        `reads many images.`,
    );
  }

  let child: ChildProcessWithoutNullStreams;
  const piBin = resolvePiBin();
  try {
    child = spawn(piBin, args, {
      cwd: jobDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
        // The generated models.json refers to the key by name so the secret is
        // never written to disk (see pi-provider.ts).
        ...(run.apiKey ? { [PI_API_KEY_ENV]: run.apiKey } : {}),
      },
    });
  } catch (error) {
    discardPiAgentDir(agentDir);
    return fail(`Failed to spawn pi: ${(error as Error).message}`);
  }

  const usagePrice = readUsagePrice(run.provider, run.model);
  let usageSequence = 0;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  let lastAssistantText: string | undefined;
  // Run diagnostics: "the agent stopped without writing anything" is otherwise
  // impossible to explain from the log, because the failing turn logged nothing.
  let lastStopReason: string | undefined;
  let emptyAssistantTurns = 0;
  let settled = false;
  let exitCode: number | null = null;
  let spawnError: string | undefined;
  // Resolved when pi reports agent_settled. pi RPC is a long-lived protocol and
  // does NOT exit on its own after a run completes, so waiting on process exit
  // alone would burn the full timeout on every successful job.
  let notifySettled: () => void = () => {};
  const settledPromise = new Promise<"settled">((resolve) => {
    notifySettled = () => resolve("settled");
  });

  const progressReporter = new AgentProgressReporter();
  const handleRecord = (line: string) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (trimmed.length === 0) return;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      record = parsed as Record<string, unknown>;
    } catch {
      log("warn", `Unparseable pi output: ${truncate(trimmed, 200)}`);
      return;
    }
    if (record.type === "message_end") {
      const message = record.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        recordMessageUsage(opts.jobId, ++usageSequence, message, run.provider, run.model, usagePrice);
      }
    }
    if (record.type === "compaction_end") {
      const result = record.result as Record<string, unknown> | undefined;
      if (result) {
        recordMessageUsage(opts.jobId, ++usageSequence, { usage: result.usage }, run.provider, run.model, usagePrice);
      }
    }
    progressReporter.consume(record, tag => log("info", tag));
    const result = translateRecord(record, log);
    if (result.finalAssistantText) {
      lastAssistantText = result.finalAssistantText;
    }
    if (result.assistantStopReason) {
      lastStopReason = result.assistantStopReason;
    }
    if (result.emptyAssistantTurn) {
      emptyAssistantTurns += 1;
    }
    if (record.type === "agent_settled") {
      settled = true;
      notifySettled();
    }
  };

  // Read stdout as a UTF-8 byte stream and split on LF only. Node's readline
  // also splits on U+2028/U+2029, which are legal inside JSON strings.
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      handleRecord(stdoutBuffer.slice(0, newlineIndex));
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });
  child.stdout.on("end", () => {
    if (stdoutBuffer.trim().length > 0) {
      handleRecord(stdoutBuffer);
      stdoutBuffer = "";
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBuffer = (stderrBuffer + chunk).slice(-STDERR_KEEP_CHARS);
  });

  const exitPromise = new Promise<void>((resolve) => {
    child.on("error", (error) => {
      spawnError = error.message;
      resolve();
    });
    child.on("close", (code) => {
      exitCode = code;
      resolve();
    });
  });

  // Send the prompt once the child is alive. Writing before the process has
  // wired up stdin is fine because the pipe buffers, but a spawn failure must
  // not leave the write hanging.
  const promptId = `prompt-${opts.jobId}`;
  const promptCommand =
    JSON.stringify({
      id: promptId,
      type: "prompt",
      message: buildPrompt(imageFiles),
    }) + "\n";

  try {
    child.stdin.write(promptCommand);
  } catch (error) {
    child.kill("SIGKILL");
    return fail(`Failed to send prompt to pi: ${(error as Error).message}`);
  }

  const deadline = Date.now() + env.timeoutMs;
  let timedOut = false;

  const timeoutPromise = new Promise<"timeout">((resolve) => {
    const remaining = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => resolve("timeout"), remaining);
    // Do not keep the Node process alive just for the watchdog.
    if (typeof timer.unref === "function") timer.unref();
  });

  // Race three outcomes: the process exits on its own, the agent settles (then
  // we shut it down ourselves), or the hard timeout fires.
  const outcome = await Promise.race([
    exitPromise.then(() => "exit" as const),
    settledPromise,
    timeoutPromise,
  ]);

  if (outcome === "settled") {
    log("info", "Agent finished its run");
  }

  if (outcome === "timeout") {
    timedOut = true;
    log("error", `Timed out after ${Math.round(env.timeoutMs / 1000)}s — killing pi`);
    child.kill("SIGKILL");
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  }

  // Drain any final stdout records before deciding the outcome.
  await new Promise<void>((resolve) => {
    if (child.stdout.readableEnded) {
      resolve();
      return;
    }
    const done = () => resolve();
    child.stdout.once("end", done);
    child.stdout.once("close", done);
    setTimeout(() => {
      child.stdout.removeListener("end", done);
      child.stdout.removeListener("close", done);
      resolve();
    }, 2000);
  });
  if (stdoutBuffer.trim().length > 0) {
    handleRecord(stdoutBuffer);
    stdoutBuffer = "";
  }

  if (stderrBuffer.trim().length > 0) {
    const tail = truncate(stderrBuffer, 600);
    log(spawnError || timedOut ? "error" : "info", `pi stderr: ${tail}`);
  }

  if (settled) {
    log("info", "pi session settled");
  }

  // Close stdin so pi shuts down cleanly if it is still alive, then wait
  // briefly for it to exit. Killing is the fallback; the docx is what matters.
  if (outcome !== "exit") {
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    await Promise.race([
      exitPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (exitCode === null && child.exitCode === null) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
  }

  if (spawnError) {
    return fail(`Failed to run pi: ${spawnError}`);
  }

  if (timedOut) {
    return fail(
      `Agent timed out after ${Math.round(env.timeoutMs / 1000)}s without producing out/result.docx.`,
    );
  }

  if (exitCode !== 0 && exitCode !== null) {
    log("warn", `pi exited with code ${exitCode}`);
  }

  // Resolve only once the result document exists on disk.
  let produced = await waitForFile([resultPath], Date.now() + 3000);
  if (!produced) {
    produced = findAnyDocx(outDir);
    if (produced) {
      log("warn", `out/result.docx missing; falling back to ${path.basename(produced)}`);
      try {
        fs.copyFileSync(produced, resultPath);
        produced = resultPath;
      } catch (error) {
        log("warn", `Could not normalise result name: ${(error as Error).message}`);
      }
    }
  }

  if (!produced) {
    const suffix =
      exitCode !== null && exitCode !== 0 ? ` (pi exit code ${exitCode})` : "";
    // Say WHY, instead of pointing at a log that contains no error: the usual
    // cause is a turn that produced neither text nor a tool call.
    const clues: string[] = [];
    if (emptyAssistantTurns > 0) {
      clues.push(`有 ${emptyAssistantTurns} 轮模型既没输出文字也没调用工具`);
    }
    if (lastStopReason === "length" || lastStopReason === "max_tokens") {
      clues.push(`最后一轮因为输出到达上限而中断（${lastStopReason}）`);
    } else if (lastStopReason) {
      clues.push(`最后一轮 stopReason=${lastStopReason}`);
    }
    const why = clues.length > 0 ? `原因线索：${clues.join("；")}。` : "";
    return fail(
      `Agent finished without producing a .docx in out/${suffix}. ${why}` +
        `日志里有对应告警；也建议用后台的「测试连接」确认 provider / model 是否真的可用。`,
    );
  }

  let size = 0;
  try {
    size = fs.statSync(produced).size;
  } catch {
    size = 0;
  }

  if (size <= 0) {
    return fail("Agent produced an empty .docx file.");
  }

  log("success", `Result ready: ${path.basename(produced)} (${size} bytes)`);

  const finished =
    updateJob(opts.jobId, {
      status: "done",
      resultPath: produced,
      resultSize: size,
      note: lastAssistantText,
      error: undefined,
    }) ?? job;

  return finished;
}
