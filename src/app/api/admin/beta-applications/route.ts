import { NextResponse } from "next/server";
import { listBetaApplications } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/beta-applications
 *
 * Every self-registered account with its application, pending first. Accounts
 * created from the console never appear here — they never applied.
 */
export async function GET(): Promise<Response> {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  return NextResponse.json({ applications: listBetaApplications() });
}
