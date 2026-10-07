import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-guard";
import { readUsagePrice, saveUsagePrice, usageReport } from "@/lib/usage";
import { parsePrice } from "@/lib/usage-types";
import { loadRunEnv } from "@/lib/config";
import { resolveProviderConfig } from "@/lib/pi-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  let current: { provider: string; model: string } | null = null;
  try {
    const run = resolveProviderConfig(loadRunEnv());
    current = { provider: run.provider, model: run.model };
  } catch { /* Reports remain available when the model config is invalid. */ }
  return NextResponse.json({ ...usageReport(), current, price: current ? readUsagePrice(current.provider, current.model) : null });
}

export async function PUT(request: Request): Promise<Response> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "请求格式不对" }, { status: 400 }); }
  const price = parsePrice(body?.price);
  if (!price || typeof body?.provider !== "string" || typeof body?.model !== "string") {
    return NextResponse.json({ error: "请填写有效的非负单价" }, { status: 400 });
  }
  try {
    const run = resolveProviderConfig(loadRunEnv());
    if (body.provider !== run.provider || body.model !== run.model) {
      return NextResponse.json({ error: "当前模型已改变，请刷新后重试" }, { status: 409 });
    }
  } catch { return NextResponse.json({ error: "请先配置有效模型" }, { status: 400 }); }
  saveUsagePrice(body.provider, body.model, price);
  return NextResponse.json({ ok: true });
}
