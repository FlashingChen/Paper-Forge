"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { BETA_STATUS_LABELS, isEmailSet } from "@/lib/registration";

/**
 * /admin/applications
 *
 * The review desk for self-service registrations. Two separate decisions live
 * here and the UI keeps them separate: whether to let someone in, and how many
 * generations to hand them. Approving with a quota of 0 means "you're in, but
 * ask me before you burn credits".
 */

interface Application {
  id: number;
  username: string;
  email: string;
  occupation: string | null;
  region: string | null;
  betaStatus: "pending" | "approved" | "rejected";
  betaAppliedAt: number | null;
  betaReviewedAt: number | null;
  quota: number;
  used: number;
  disabled: boolean;
}

const DEFAULT_GRANT = 20;

const STATUS_BADGE: Record<Application["betaStatus"], string> = {
  pending: "badge badge-key",
  approved: "badge badge-ok",
  rejected: "badge badge-off",
};

function when(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function BetaApplicationsPage() {
  const [apps, setApps] = useState<Application[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Draft quota per application id; nothing is saved until a button is pressed. */
  const [quotas, setQuotas] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/admin/beta-applications", { cache: "no-store" });
      if (response.status === 403) {
        setError("你不是管理员。");
        return;
      }
      if (response.status === 401) {
        setError("登录已过期，请重新登录。");
        return;
      }
      if (!response.ok) {
        setError("读取内测申请失败。");
        return;
      }
      const data = (await response.json()) as { applications: Application[] };
      setApps(data.applications);
      setQuotas((current) => {
        const next = { ...current };
        for (const app of data.applications) {
          if (next[app.id] === undefined) {
            next[app.id] =
              app.betaStatus === "pending" ? String(DEFAULT_GRANT) : String(app.quota);
          }
        }
        return next;
      });
    } catch {
      setError("网络错误，请刷新重试。");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function flash(message: string) {
    setNotice(message);
    setError(null);
    window.setTimeout(() => setNotice(null), 4000);
  }

  function fail(message: string) {
    setError(message);
    setNotice(null);
  }

  async function review(app: Application, status: "approved" | "rejected") {
    if (busyId !== null) return;

    // Validate before spending a request: an empty or garbled quota field must
    // not silently turn into "approve with no credits".
    let quota: number | undefined;
    if (status === "approved") {
      const parsed = Number(quotas[app.id] ?? DEFAULT_GRANT);
      if (!Number.isFinite(parsed) || parsed < 0) {
        fail("配额要填 0 或正整数。");
        return;
      }
      quota = Math.floor(parsed);
    }

    setBusyId(app.id);
    try {
      const response = await fetch(`/api/admin/beta-applications/${app.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, quota }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        fail(data.error ?? "操作失败。");
        return;
      }
      if (status === "approved") {
        flash(
          quota && quota > 0
            ? `已通过「${app.username}」，发放 ${quota} 次配额。`
            : `已通过「${app.username}」，暂不发放配额。`,
        );
      } else {
        flash(`已拒绝「${app.username}」的内测申请。`);
      }
      setQuotas((current) => {
        const next = { ...current };
        delete next[app.id];
        return next;
      });
      void load();
    } catch {
      fail("网络错误。");
    } finally {
      setBusyId(null);
    }
  }

  async function saveQuota(app: Application) {
    const raw = quotas[app.id];
    // An empty field means "the admin is mid-edit", not "revoke every credit".
    if (raw === undefined || raw.trim() === "") return;
    const quota = Number(raw);
    if (!Number.isFinite(quota) || quota < 0 || quota === app.quota) return;
    setBusyId(app.id);
    try {
      const response = await fetch(`/api/admin/beta-applications/${app.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: app.betaStatus, quota }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        fail(data.error ?? "保存配额失败。");
        return;
      }
      flash(`「${app.username}」的配额已改为 ${quota}。`);
      void load();
    } catch {
      fail("网络错误。");
    } finally {
      setBusyId(null);
    }
  }

  const pending = apps?.filter((app) => app.betaStatus === "pending") ?? [];
  const handled = apps?.filter((app) => app.betaStatus !== "pending") ?? [];

  function renderRow(app: Application) {
    const draft = quotas[app.id] ?? String(app.quota);
    const grant = Number(draft);
    const willGrant = Number.isFinite(grant) && grant > 0;
    const approveLabel = willGrant ? `通过并发 ${Math.floor(grant)} 次` : "通过（不发配额）";

    return (
      <tr key={app.id}>
        <td>
          {app.username}{" "}
          <span className={STATUS_BADGE[app.betaStatus]}>
            {BETA_STATUS_LABELS[app.betaStatus]}
          </span>
          {app.disabled ? <span className="badge badge-off">已停用</span> : null}
        </td>
        <td>
          {isEmailSet(app.email) ? (
            <span className="admin-email">{app.email}</span>
          ) : (
            <span className="badge badge-key">未填写</span>
          )}
        </td>
        <td>{app.occupation ?? "—"}</td>
        <td>{app.region ?? "—"}</td>
        <td className="num">{when(app.betaAppliedAt)}</td>
        <td className="num">
          {app.betaStatus === "pending"
            ? "—"
            : `${app.used}/${app.quota}`}
        </td>
        <td>
          <input
            className="input"
            type="number"
            min={0}
            inputMode="numeric"
            value={draft}
            disabled={busyId === app.id || app.betaStatus === "rejected"}
            style={{ width: 96, minHeight: 40 }}
            aria-label={`${app.username} 的配额`}
            onChange={(e) => setQuotas({ ...quotas, [app.id]: e.target.value })}
            onBlur={() => {
              if (app.betaStatus === "approved") void saveQuota(app);
            }}
          />
        </td>
        <td className="num">{when(app.betaReviewedAt)}</td>
        <td>
          <div className="admin-actions">
            {app.betaStatus !== "approved" ? (
              <button
                className="btn btn-sm"
                type="button"
                disabled={busyId === app.id}
                onClick={() => void review(app, "approved")}
              >
                {approveLabel}
              </button>
            ) : (
              <button
                className="btn btn-sm"
                type="button"
                disabled={busyId === app.id}
                onClick={() => void saveQuota(app)}
              >
                保存配额
              </button>
            )}
            {app.betaStatus !== "rejected" ? (
              <button
                className="btn btn-sm btn-danger-ghost"
                type="button"
                disabled={busyId === app.id}
                onClick={() => {
                  if (window.confirm(`确定拒绝「${app.username}」的内测申请？对方将无法登录。`)) {
                    void review(app, "rejected");
                  }
                }}
              >
                拒绝
              </button>
            ) : null}
          </div>
        </td>
      </tr>
    );
  }

  const table = (rows: Application[]) => (
    <div className="table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>用户名</th>
            <th>邮箱</th>
            <th>职业</th>
            <th>地区</th>
            <th>申请时间</th>
            <th>用量</th>
            <th>配额</th>
            <th>审核时间</th>
            <th style={{ textAlign: "right" }}>操作</th>
          </tr>
        </thead>
        <tbody>{rows.map(renderRow)}</tbody>
      </table>
    </div>
  );

  return (
    <>
      <header className="hud">
        <div className="hud-l">
          <Link className="hud-logo" href="/admin">
            <span
              className="mark"
              style={{ background: "var(--l1-c)", boxShadow: "inset 0 0 0 4px var(--l1-a)" }}
              aria-hidden="true"
            >
              P
            </span>
            BETA
            <span className="cn-name">内测申请</span>
          </Link>
          <div className="hud-stats">
            <div className="stat">
              <span>PENDING</span>
              <b>{apps ? `${pending.length} 条待审核` : "…"}</b>
            </div>
          </div>
        </div>
        <div className="hud-stats">
          <button className="stat" type="button" onClick={() => void load()}>
            <span>RELOAD</span>
            <b>刷新</b>
          </button>
          <Link className="stat" href="/admin">
            <span>ADMIN</span>
            <b>返回后台</b>
          </Link>
          <Link className="stat" href="/admin/usage">
            <span>USAGE</span>
            <b>用量与费用</b>
          </Link>
        </div>
      </header>

      <main className="page wide" style={{ paddingTop: 24 }}>
        {error ? (
          <div className="alert alert-warn" role="alert">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="alert alert-info" role="status">
            {notice}
          </div>
        ) : null}

        <section className="panel" aria-labelledby="pending-heading">
          <div className="panel-h">
            <h2 id="pending-heading">
              <span className="px" style={{ color: "var(--l2-c)" }} aria-hidden="true">✦</span>
              待审核
            </h2>
            <span className="aside">{apps ? `${pending.length} PENDING` : "…"}</span>
          </div>
          <div className="panel-b flush">
            {!apps ? (
              <div className="b">
                <p className="hintline">正在读取 …</p>
              </div>
            ) : pending.length === 0 ? (
              <div className="b">
                <p className="hintline">没有待审核的申请。新的注册会出现在这里。</p>
              </div>
            ) : (
              table(pending)
            )}
          </div>
        </section>

        <section className="panel" aria-labelledby="handled-heading" style={{ marginTop: 24 }}>
          <div className="panel-h">
            <h2 id="handled-heading">
              <span className="px" style={{ color: "var(--l1-c)" }} aria-hidden="true">■</span>
              已审核
            </h2>
            <span className="aside">{apps ? `${handled.length} REVIEWED` : "…"}</span>
          </div>
          <div className="panel-b flush">
            {!apps ? (
              <div className="b">
                <p className="hintline">正在读取 …</p>
              </div>
            ) : handled.length === 0 ? (
              <div className="b">
                <p className="hintline">还没有审核过的申请。</p>
              </div>
            ) : (
              table(handled)
            )}
          </div>
        </section>

        <p className="hintline" style={{ marginTop: 16 }}>
          通过 = 放行登录；配额 = 能生成多少次。配额填 0 表示「通过但不发配额」，
          之后随时可以在这里改。已通过或已拒绝的申请也能重新处理。
        </p>
      </main>
    </>
  );
}
