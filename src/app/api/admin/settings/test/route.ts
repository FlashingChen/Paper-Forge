import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { parseCapabilityInput, readModelSettings } from "@/lib/auth";
import { ProviderConfigError, probeEndpoint, resolveProviderConfig } from "@/lib/pi-provider";
import { executor } from "@/lib/execution/store";

/**
 * POST /api/admin/settings/test
 *
 * Answers "does this provider configuration actually work?" with a real call.
 *
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * A provider name, base URL, model id and key only fail together, at request
 * time, with whatever the upstream decides to say:
 *
 *   503 {"code":"model_not_found","message":"No available channel for model
 *        opencodego/deepseek-v4-flash under group default (distributor)"}
 *
 * That is unreadable, and finding it costs a whole generation (minutes) because
 * it only shows up once a job runs. This endpoint runs one trivial completion
 * through the very same path a job uses — same generated models.json, same args,
 * same key plumbing — and hands back what came out.
 *
 * The form's unsaved values are used when present, so an operator can test
 * before saving. A blank API KEY means "use the stored one", matching the rest
 * of the admin console (the key is never sent back to the browser).
 *
 * Admin-only, and it makes exactly one small request.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // An empty body is fine: fall back to what is stored.
    body = {};
  }
  const field = (key: string): string =>
    typeof body[key] === "string" ? (body[key] as string).trim() : "";

  const stored = readModelSettings();

  // The form sends its capability fields along (null = 自动/清除). When a caller
  // omits them entirely — a plain "test what is saved" — the stored values are
  // the ones that will actually govern the run, so use those.
  let capabilities = stored.capabilities;
  if (body.capabilities !== undefined) {
    const parsed = parseCapabilityInput(body.capabilities);
    if (!parsed.ok) {
      return NextResponse.json({ ok: false, error: parsed.error, kind: "config" as const });
    }
    // Carry over anything the form left as null but the DB still has? No:
    // null in the form means "自动" — don't declare it — which is exactly what
    // the operator just chose, and what resolveProviderConfig handles.
    capabilities = parsed.value;
  }

  const settings = {
    provider: field("provider") || stored.provider,
    baseUrl: field("baseUrl") || stored.baseUrl,
    model: field("model") || stored.model,
    apiKey: field("apiKey") || stored.apiKey,
    capabilities,
  };

  let resolved;
  try {
    resolved = resolveProviderConfig(settings);
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      // A configuration only a human can fix: say which field, not just "failed".
      return NextResponse.json({
        ok: false,
        error: error.message,
        hint: error.hint,
        kind: "config" as const,
      });
    }
    return NextResponse.json({
      ok: false,
      error: (error as Error).message,
      kind: "config" as const,
    });
  }

  if (executor() !== "local") {
    return NextResponse.json({ ok: false, kind: "endpoint", provider: resolved.provider,
      model: resolved.model, output: "", error: "模型配置校验通过。控制面不运行 pi；请在测试环境提交任务验证 独立 Agent 执行面的模型连接。" });
  }
  const probe = await probeEndpoint(resolved);

  return NextResponse.json({
    ok: probe.ok,
    kind: probe.ok ? ("ok" as const) : ("endpoint" as const),
    provider: resolved.provider,
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    modelSource: resolved.source,
    // What will actually govern the run: the operator's models.json declaration
    // merged with whatever they typed in the console (the console wins). These
    // are the numbers the run is limited by, so they are what the panel shows.
    vision: resolved.effective.input
      ? resolved.effective.input.includes("image")
      : null,
    reasoning: resolved.effective.reasoning ?? null,
    contextWindow: resolved.effective.contextWindow ?? null,
    maxTokens: resolved.effective.maxTokens ?? null,
    assumedCapabilities: resolved.assumedCapabilities,
    /** Capabilities nobody stated, so PaperForge had to guess them. */
    assumedFields: resolved.assumedFields,
    // What pi will send for this model: 上下文 / 输出上限 / thinking / images.
    piModel: probe.piModel,
    output: probe.output,
    error: probe.error,
    timedOut: probe.timedOut ?? false,
    elapsedMs: probe.elapsedMs,
  });
}
