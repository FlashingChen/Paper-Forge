import { NextResponse } from "next/server";
import { endSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/auth/logout -- clears the session cookie. Idempotent. */
export async function POST(): Promise<Response> {
  await endSession();
  return NextResponse.json({ ok: true });
}
