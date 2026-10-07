"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { accountReturnTarget } from "@/lib/account-navigation";
import { Hud, type HudAction, type HudUser } from "./Hud";

/**
 * Login-aware HUD bar for the teacher-facing pages: who is signed in, how many
 * generations are left, and a way out.
 *
 * Quota is fetched rather than passed down so it stays correct after a run
 * spends one — the teacher sees the count drop without a page reload.
 */

export interface MeResponse {
  user: {
    id: number;
    username: string;
    role: "user" | "admin";
    quota: number;
    used: number;
    remaining: number;
    email?: string | null;
    needEmail?: boolean;
    occupation?: string | null;
    region?: string | null;
  };
}

export default function UserBar({
  refreshKey = 0,
  level = 1,
  extraActions = [],
  onUser,
}: {
  /** Bump this to re-fetch the quota after a job consumes one. */
  refreshKey?: number;
  /** Which level colour tints the logo mark; matches the current level. */
  level?: 1 | 2 | 3 | 4;
  /** Extra HUD entries rendered on the right (e.g. "return to upload"). */
  extraActions?: HudAction[];
  /**
   * Fired whenever the signed-in user is (re)loaded. The upload page needs the
   * same quota for its sidebar strip and for disabling the submit button, and
   * two independent fetches would drift apart after a run spends one.
   */
  onUser?: (user: HudUser | null) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<HudUser | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      if (!response.ok) {
        setMe(null);
        onUser?.(null);
        return;
      }
      const data = (await response.json()) as MeResponse;
      if (data.user.needEmail && pathname !== "/account" && !pathname.startsWith("/account/")) {
        const target = accountReturnTarget(window.location.pathname + window.location.search);
        router.replace(`/account?next=${encodeURIComponent(target)}#email`);
      }
      setMe(data.user);
      onUser?.(data.user);
    } catch {
      // Offline or server restarting: keep whatever we last knew.
    }
  }, [onUser, pathname, router]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // Even if this fails the cookie is cleared on the next load attempt.
    }
    router.replace("/login");
    router.refresh();
  }

  const toneByLevel = ["green", "blue", "purple", "orange"] as const;

  const actions: HudAction[] = [];
  if (me?.role === "admin") {
    actions.push({ key: "ADMIN", label: "后台管理", href: "/admin" });
  }
  if (me) {
    actions.push({ key: "ACCOUNT", label: me.needEmail ? "账号设置 · 待填邮箱" : "账号设置", href: "/account" });
  }
  actions.push({ key: "EXIT", label: "退出登录", onClick: () => void logout() });
  actions.push(...extraActions);

  return (
    <Hud
      user={me}
      actions={actions}
      markTone={toneByLevel[level - 1] ?? "green"}
    />
  );
}
