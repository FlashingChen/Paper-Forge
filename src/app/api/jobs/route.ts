import { NextResponse } from "next/server";
import { loadEnv, loadRunEnv } from "@/lib/config";
import { consumeQuota, initDb, refundQuota } from "@/lib/db";
import { requireEmailSet } from "@/lib/email-guard";
import {
  activeJobCount,
  createJob,
  jobSnapshot,
  prepareJobDir,
  updateJob,
} from "@/lib/jobs";
import { runAgent } from "@/lib/pi-runner";
import { ProviderConfigError, resolveProviderConfig } from "@/lib/pi-provider";
import type { RunOptions } from "@/lib/types";
import { enqueueRun, executor } from "@/lib/execution/store";
import { nodeRegistry, reconcileNodeRuns } from "@/lib/execution/nodes";
import { cloudRunConfig } from "@/lib/execution/cloud-run";
import { readUsagePrice } from "@/lib/usage";

/**
 * POST /api/jobs
 *
 * multipart/form-data with one or more `images` fields (JPEG or PNG).
 * Creates a job, materialises the job directory (in/, out/, reference/),
 * kicks off the pi agent run without awaiting it, and returns `{ id }` with
 * HTTP 202 so the browser can navigate straight to the progress page.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only these two content types are accepted, as required by the spec. */
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

export async function POST(request: Request): Promise<Response> {
  initDb();

  // 1. Authentication. Middleware already gated this, but the route re-checks
  //    against the database so a disabled or deleted account is rejected even
  //    if it still holds a valid cookie. The email gate rides along: an account
  //    with no contact address cannot start work, whatever the UI did.
  const gate = await requireEmailSet();
  if (!gate.ok) return gate.response;
  const user = { id: gate.user.userId, quota: gate.user.quota, used: gate.user.used };

  if (process.env.PAPERFORGE_DISPATCH_ENABLED === "0" && executor() !== "local") {
    return NextResponse.json({ error: "云端执行面尚未配置，暂时无法生成。请等待管理员启用执行节点。" }, { status: 503 });
  }

  // 2. One run at a time per account. A generation takes minutes; letting one
  //    teacher open ten tabs would starve everyone else and burn quota fast.
  if (executor() === "node") reconcileNodeRuns();
  if (activeJobCount(user.id) > 0) {
    return NextResponse.json(
      { error: "你还有一个任务正在生成中，请等它完成再上传。" },
      { status: 409 },
    );
  }

  let env: ReturnType<typeof loadEnv>;
  try {
    env = loadEnv();
  } catch (error) {
    return NextResponse.json(
      { error: `服务端配置有误：${(error as Error).message}` },
      { status: 500 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "请求格式不对，必须是 multipart/form-data 的上传请求。" },
      { status: 400 },
    );
  }

  const raw = form.getAll("images");
  const files: File[] = [];
  for (const entry of raw) {
    if (entry instanceof File) {
      files.push(entry);
    }
  }

  if (files.length === 0) {
    return NextResponse.json(
      { error: "没有收到任何图片，请至少上传一张试卷照片。" },
      { status: 400 },
    );
  }

  if (files.length > env.maxImages) {
    return NextResponse.json(
      { error: `一次最多上传 ${env.maxImages} 张照片，这次收到 ${files.length} 张。` },
      { status: 400 },
    );
  }

  for (const file of files) {
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      const label = file.name ? `「${file.name}」` : "其中一个文件";
      return NextResponse.json(
        {
          error: `${label}的类型是 ${file.type || "未知"}，只支持 JPG 和 PNG 图片。`,
        },
        { status: 415 },
      );
    }
  }

  // 3. Refuse a provider configuration that cannot run, BEFORE spending a
  //    generation. Without this, a blank or stale MODEL only surfaces as an
  //    upstream error minutes into the run — and costs the teacher one of their
  //    limited generations. See resolveProviderConfig for the rules.
  //
  //    Note loadRunEnv(), not loadEnv(): the run is what has to be valid, and
  //    the admin console's saved settings live on top of the environment.
  try {
    resolveProviderConfig(loadRunEnv());
    if (executor() === "cloud-run") cloudRunConfig();
    if (executor() === "node") nodeRegistry();
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      return NextResponse.json(
        { error: `模型配置有问题：${error.toString()}` },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: `执行面配置有问题：${(error as Error).message}` }, { status: 500 });
  }

  // 4. Spend one generation. Done only after the upload passed validation, so
  //    a malformed request does not cost the teacher a run. consumeQuota does
  //    the check-and-increment inside one SQL statement, so two simultaneous
  //    uploads cannot both slip past the limit.
  const quota = consumeQuota(user.id);
  if (!quota.ok) {
    return NextResponse.json(
      {
        error:
          `你的 ${user.quota} 次生成机会已经用完了，请联系管理员增加额度。`,
        quota: user.quota,
        used: user.used,
        remaining: 0,
      },
      { status: 402 },
    );
  }

  const job = createJob({ imageCount: files.length, userId: user.id });
  const jobId = job.id;

  let jobDir = "";
  try {
    if (executor() === "local") jobDir = prepareJobDir(jobId);
  } catch (error) {
    updateJob(jobId, {
      status: "error",
      error: `无法创建任务目录：${(error as Error).message}`,
    });
    refundQuota(user.id);
    return NextResponse.json(
      { error: `无法创建任务目录：${(error as Error).message}` },
      { status: 500 },
    );
  }

  // Read the uploads into buffers up front. runAgent writes them into in/ so
  // the pi agent never needs the original request object.
  let images: RunOptions["images"];
  try {
    images = await Promise.all(
      files.map(async (file, index) => ({
        index,
        filename: file.name || `photo-${index + 1}`,
        buffer: Buffer.from(await file.arrayBuffer()),
      })),
    );
    const empty = images.find((image) => image.buffer.length === 0);
    if (empty) {
      throw new Error(`「${empty.filename}」是空文件。`);
    }
  } catch (error) {
    updateJob(jobId, {
      status: "error",
      error: `读取上传内容失败：${(error as Error).message}`,
    });
    refundQuota(user.id);
    return NextResponse.json(
      { error: `读取上传内容失败：${(error as Error).message}` },
      { status: 400 },
    );
  }

  updateJob(jobId, { status: "queued", imageCount: images.length });

  if (executor() !== "local") {
    try {
      const settings = loadRunEnv();
      const resolved = resolveProviderConfig(settings);
      const imageEnv: Record<string, string> = {};
      for (const name of ["PAPERFORGE_IMAGE_MAX_EDGE", "PAPERFORGE_IMAGE_MAX_BYTES", "PAPERFORGE_IMAGE_JPEG_QUALITY"]) {
        if (process.env[name]) imageEnv[name] = process.env[name]!;
      }
      enqueueRun({ version: 1, jobId, provider: resolved.provider, model: resolved.model,
        baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, capabilities: settings.capabilities,
        declared: resolved.declared, timeoutMs: settings.timeoutMs, imageEnv,
        images: images.map(({ index, filename }) => ({ index, filename })),
        price: readUsagePrice(resolved.provider, resolved.model),
      }, images.map(image => image.buffer));
    } catch {
      updateJob(jobId, { status: "error", error: "无法持久化远程任务，请重试。" });
      refundQuota(user.id);
      return NextResponse.json({ error: "无法持久化远程任务，请重试。" }, { status: 500 });
    }
    return NextResponse.json({ id: jobId, status: "queued", imageCount: images.length }, { status: 202 });
  }

  // Fire and forget. The job keeps its progress in the in-memory registry, the
  // SSE route streams it, and a rejection here must mark the job errored rather
  // than take down the Node process with an unhandled rejection.
  void runAgent({
    jobId,
    jobDir,
    images,
    onLog: () => {
      // Logs are recorded by pi-runner via appendLog; nothing extra to do.
    },
  }).catch((error: unknown) => {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "生成过程中出现未知错误。";
    updateJob(jobId, { status: "error", error: message });
  });

  const snapshot = jobSnapshot(jobId);

  // Do not expose the server-side job directory in the response: it is not part
  // of the client contract and would leak filesystem layout.
  return NextResponse.json(
    {
      id: jobId,
      status: snapshot?.status ?? "queued",
      imageCount: images.length,
    },
    { status: 202 },
  );
}
