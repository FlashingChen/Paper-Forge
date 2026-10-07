import { redirect } from "next/navigation";
import { accountReturnTarget } from "@/lib/account-navigation";

export default async function EmailPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  redirect(`/account${next ? `?next=${encodeURIComponent(accountReturnTarget(next))}` : ""}#email`);
}
