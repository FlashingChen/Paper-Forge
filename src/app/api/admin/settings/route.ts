import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import {
  maskSecret,
  parseCapabilityInput,
  readModelSettings,
  writeModelSettings,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/settings
 *
 * Returns the provider config with the API key masked. The full key is never
 * sent to the browser: once it is stored, the admin form shows "已保存" and only
 * accepts a replacement, so a stray shoulder-surfer or a screenshot cannot leak
 * it.
 */
export async function GET(): Promise<Response> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const settings = readModelSettings();
  return NextResponse.json({
    settings: {
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      model: settings.model,
      hasApiKey: settings.apiKey.length > 0,
      apiKeyMask: maskSecret(settings.apiKey),
      capabilities: settings.capabilities,
    },
  });
}

/** PUT /api/admin/settings -- save provider config. */
export async function PUT(request: Request): Promise<Response> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "请求格式不对" }, { status: 400 });
  }

  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";

  if (!provider || !model) {
    return NextResponse.json(
      { error: "provider 和 model 都要填。" },
      { status: 400 },
    );
  }

  // apiKey: undefined -> keep the stored one; "" -> keep; null -> delete.
  let apiKey: string | null | undefined;
  if (body.clearApiKey === true) apiKey = null;
  else if (typeof body.apiKey === "string" && body.apiKey.trim().length > 0) {
    apiKey = body.apiKey.trim();
  }

  // Capability overrides. Every field is optional; `null` clears it, which is
  // how an operator goes back to "let PaperForge decide".
  const parsed = parseCapabilityInput(body.capabilities);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const capabilities = parsed.value;

  writeModelSettings({ provider, baseUrl, model, apiKey, capabilities });

  const after = readModelSettings();
  return NextResponse.json({
    settings: {
      provider: after.provider,
      baseUrl: after.baseUrl,
      model: after.model,
      hasApiKey: after.apiKey.length > 0,
      apiKeyMask: maskSecret(after.apiKey),
      capabilities: after.capabilities,
    },
  });
}
