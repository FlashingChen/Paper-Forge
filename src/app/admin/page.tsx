"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { isEmailSet } from "@/lib/registration";

interface AdminUser {
  id: number;
  username: string;
  role: "user" | "admin";
  quota: number;
  used: number;
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  email: string;
  occupation: string | null;
  region: string | null;
  betaStatus: "pending" | "approved" | "rejected";
  betaAppliedAt: number | null;
}

interface Capabilities {
  vision?: boolean;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
}

interface Settings {
  provider: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKeyMask: string;
  capabilities?: Capabilities;
}

/** Form state for the advanced capability panel; "" means "自动/不声明". */
interface CapabilityForm {
  vision: "" | "yes" | "no";
  reasoning: "" | "yes" | "no";
  contextWindow: string;
  maxTokens: string;
  compat: string;
}

/** Result of the 「测试连接」 self-test (see POST /api/admin/settings/test). */
interface TestResult {
  ok: boolean;
  kind?: "ok" | "config" | "endpoint";
  provider?: string;
  baseUrl?: string;
  model?: string;
  modelSource?: string;
  /** Whether the operator's own models.json says this model reads images. */
  vision?: boolean | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  assumedCapabilities?: boolean;
  assumedFields?: string[];
  reasoning?: boolean | null;
  piModel?: { contextWindow: string; maxOut: string; thinking: string; images: string } | null;
  output?: string;
  error?: string;
  hint?: string;
  timedOut?: boolean;
  elapsedMs?: number;
}

const MODEL_SOURCE_LABEL: Record<string, string> = {
  settings: "后台/环境变量指定",
  declared: "models.json 里唯一声明的模型",
  "catalog-default": "pi 自带 catalog 的默认模型",
};

function compactNumber(value: number | null | undefined): string {
  if (typeof value !== "number") return "—";
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

function when(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function AdminPage() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  // Registrations waiting for a decision; drives the header badge and link.
  const pendingApplications =
    users?.filter((u) => u.betaAppliedAt !== null && u.betaStatus === "pending").length ?? 0;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // create-user form
  const [newUser, setNewUser] = useState({ username: "", password: "", email: "", quota: 20 });

  // settings form
  const [form, setForm] = useState({ provider: "", baseUrl: "", model: "", apiKey: "" });
  const [caps, setCaps] = useState<CapabilityForm>({
    vision: "",
    reasoning: "",
    contextWindow: "",
    maxTokens: "",
    compat: "",
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [usersRes, settingsRes] = await Promise.all([
        fetch("/api/admin/users", { cache: "no-store" }),
        fetch("/api/admin/settings", { cache: "no-store" }),
      ]);

      if (usersRes.status === 403 || settingsRes.status === 403) {
        setError("你不是管理员。");
        return;
      }
      if (!usersRes.ok) {
        setError("读取用户列表失败。");
        return;
      }

      const usersData = (await usersRes.json()) as { users: AdminUser[] };
      setUsers(usersData.users);

      if (settingsRes.ok) {
        const settingsData = (await settingsRes.json()) as { settings: Settings };
        setSettings(settingsData.settings);
        if (!settingsLoaded) {
          setForm({
            provider: settingsData.settings.provider,
            baseUrl: settingsData.settings.baseUrl,
            model: settingsData.settings.model,
            apiKey: "",
          });
          const loaded: Capabilities = settingsData.settings.capabilities ?? {};
          setCaps({
            vision: loaded.vision === undefined ? "" : loaded.vision ? "yes" : "no",
            reasoning: loaded.reasoning === undefined ? "" : loaded.reasoning ? "yes" : "no",
            contextWindow:
              loaded.contextWindow === undefined ? "" : String(loaded.contextWindow),
            maxTokens: loaded.maxTokens === undefined ? "" : String(loaded.maxTokens),
            compat: loaded.compat ? JSON.stringify(loaded.compat, null, 2) : "",
          });
          setSettingsLoaded(true);
        }
      }
    } catch {
      setError("网络错误，请刷新重试。");
    }
  }, [settingsLoaded]);

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

  async function createUser(event: React.FormEvent) {
    event.preventDefault();
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newUser),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        fail(data.error ?? "创建失败。");
        return;
      }
      setNewUser({ username: "", password: "", email: "", quota: 20 });
      flash("用户已创建。");
      void load();
    } catch {
      fail("网络错误。");
    }
  }

  async function patchUser(id: number, body: Record<string, unknown>) {
    try {
      const response = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        fail(data.error ?? "操作失败。");
        return;
      }
      flash("已保存。");
      void load();
    } catch {
      fail("网络错误。");
    }
  }

  async function removeUser(id: number, username: string) {
    if (!window.confirm(`确定删除用户「${username}」？他的任务记录也会一并删除。`)) {
      return;
    }
    try {
      const response = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        fail(data.error ?? "删除失败。");
        return;
      }
      flash("用户已删除。");
      void load();
    } catch {
      fail("网络错误。");
    }
  }

  async function saveSettings(event: React.FormEvent) {
    event.preventDefault();
    try {
      const response = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          capabilities: {
            vision: caps.vision === "" ? null : caps.vision === "yes",
            reasoning: caps.reasoning === "" ? null : caps.reasoning === "yes",
            contextWindow: caps.contextWindow.trim() === "" ? null : caps.contextWindow.trim(),
            maxTokens: caps.maxTokens.trim() === "" ? null : caps.maxTokens.trim(),
            compat: caps.compat.trim() === "" ? null : caps.compat,
          },
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        fail(data.error ?? "保存失败。");
        return;
      }
      setForm((f) => ({ ...f, apiKey: "" }));
      flash("配置已保存，下一次生成立即生效。");
      void load();
    } catch {
      fail("网络错误。");
    }
  }

  async function testSettings() {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const response = await fetch("/api/admin/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The form as typed, including an unsaved key and unsaved capabilities;
        // blank key = use the stored one.
        body: JSON.stringify({
          ...form,
          capabilities: {
            vision: caps.vision === "" ? null : caps.vision === "yes",
            reasoning: caps.reasoning === "" ? null : caps.reasoning === "yes",
            contextWindow: caps.contextWindow.trim() === "" ? null : caps.contextWindow.trim(),
            maxTokens: caps.maxTokens.trim() === "" ? null : caps.maxTokens.trim(),
            compat: caps.compat.trim() === "" ? null : caps.compat,
          },
        }),
      });
      const data = (await response.json()) as TestResult & { error?: string };
      if (!response.ok && !data.error) {
        fail("测试失败。");
        return;
      }
      setTestResult(data);
    } catch {
      fail("网络错误。");
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <header className="hud">
        <div className="hud-l">
          <Link className="hud-logo" href="/app">
            <span
              className="mark"
              style={{ background: "var(--l3-c)", boxShadow: "inset 0 0 0 4px var(--l3-a)" }}
              aria-hidden="true"
            >
              P
            </span>
            ADMIN
            <span className="cn-name">后台管理</span>
          </Link>
          <div className="hud-stats">
            <div className="stat">
              <span>USERS</span>
              <b>{users ? `${users.length} 个` : "…"}</b>
            </div>
            {pendingApplications > 0 ? (
              <div className="stat">
                <span>BETA</span>
                <b>{pendingApplications} 条待审核</b>
              </div>
            ) : null}
          </div>
        </div>
        <div className="hud-stats">
          <button className="stat" type="button" onClick={() => void load()}>
            <span>RELOAD</span>
            <b>刷新</b>
          </button>
          <Link className="stat" href="/admin/applications">
            <span>BETA</span>
            <b>内测申请{pendingApplications > 0 ? ` (${pendingApplications})` : ""}</b>
          </Link>
          <Link className="stat" href="/admin/usage"><span>USAGE</span><b>用量与费用</b></Link>
          <Link className="stat" href="/app">
            <span>MAP</span>
            <b>返回上传页</b>
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

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            gap: 24,
            alignItems: "start",
          }}
        >
          <section className="panel" aria-labelledby="settings-heading">
            <div className="panel-h">
              <h2 id="settings-heading">
                <span className="px" style={{ color: "var(--l2-c)" }} aria-hidden="true">▲</span>
                模型配置
              </h2>
              <span className="aside">SERVER SIDE</span>
            </div>
            <div className="panel-b">
              <form method="post" className="stack" onSubmit={saveSettings}>
                <label className="stack-tight">
                  <span className="field-label">PROVIDER</span>
                  <input
                    className="input"
                    value={form.provider}
                    onChange={(e) => setForm({ ...form, provider: e.target.value })}
                    placeholder="deepseek"
                  />
                </label>
                <label className="stack-tight">
                  <span className="field-label">BASE URL</span>
                  <input
                    className="input"
                    value={form.baseUrl}
                    onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                    placeholder="https://api.deepseek.com/v1"
                  />
                </label>
                <label className="stack-tight">
                  <span className="field-label">MODEL</span>
                  <input
                    className="input"
                    value={form.model}
                    onChange={(e) => setForm({ ...form, model: e.target.value })}
                    placeholder="deepseek-flash"
                  />
                </label>
                <label className="stack-tight">
                  <span className="field-label">
                    API KEY
                    {settings?.hasApiKey ? (
                      <span className="badge badge-key"> 已保存 {settings.apiKeyMask} · 留空不改动</span>
                    ) : (
                      <span className="badge badge-off"> 未设置</span>
                    )}
                  </span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    value={form.apiKey}
                    onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                    placeholder={settings?.hasApiKey ? "留空表示不修改" : "粘贴 API 密钥"}
                  />
                </label>
                <details className="stack-tight" style={{ marginTop: 4 }}>
                  <summary className="field-label" style={{ cursor: "pointer" }}>
                    高级：模型能力（provider / 模型没在 models.json 里声明时必填）
                  </summary>
                  <p className="hintline" style={{ marginTop: 8 }}>
                    这三个决定一次运行能不能成：读不了图就识别不了试卷；模型会思考却没声明，
                    它可能把输出预算全花在思考上、整轮没有内容，任务就停在半路。
                    留空 = 让 PaperForge 按 pi 默认值猜（会记一条告警）。
                  </p>
                  <label className="stack-tight">
                    <span className="field-label cn-label">能读图</span>
                    <select
                      className="input"
                      value={caps.vision}
                      onChange={(e) =>
                        setCaps({ ...caps, vision: e.target.value as CapabilityForm["vision"] })
                      }
                    >
                      <option value="">自动</option>
                      <option value="yes">能（会真的把试卷照片发给它）</option>
                      <option value="no">不能（纯文本，会被拒绝）</option>
                    </select>
                  </label>
                  <label className="stack-tight">
                    <span className="field-label cn-label">会思考（reasoning）</span>
                    <select
                      className="input"
                      value={caps.reasoning}
                      onChange={(e) =>
                        setCaps({
                          ...caps,
                          reasoning: e.target.value as CapabilityForm["reasoning"],
                        })
                      }
                    >
                      <option value="">自动</option>
                      <option value="yes">会（回复里带 reasoning_content）</option>
                      <option value="no">不会</option>
                    </select>
                  </label>
                  <label className="stack-tight">
                    <span className="field-label cn-label">上下文窗口（token）</span>
                    <input
                      className="input"
                      inputMode="numeric"
                      value={caps.contextWindow}
                      onChange={(e) => setCaps({ ...caps, contextWindow: e.target.value })}
                      placeholder="留空 = pi 默认 128K"
                    />
                  </label>
                  <label className="stack-tight">
                    <span className="field-label cn-label">输出上限（token）</span>
                    <input
                      className="input"
                      inputMode="numeric"
                      value={caps.maxTokens}
                      onChange={(e) => setCaps({ ...caps, maxTokens: e.target.value })}
                      placeholder="留空 = pi 默认 16.4K（推理模型建议 32768）"
                    />
                  </label>
                  <label className="stack-tight">
                    <span className="field-label">COMPAT（可选 JSON）</span>
                    <textarea
                      className="input"
                      rows={4}
                      value={caps.compat}
                      onChange={(e) => setCaps({ ...caps, compat: e.target.value })}
                      placeholder={'{"supportsDeveloperRole": false, "maxTokensField": "max_tokens"}'}
                    />
                  </label>
                </details>
                <button className="act go" type="submit" style={{ minHeight: 48 }}>
                  保存配置
                </button>
                <button
                  className="act quiet"
                  type="button"
                  style={{ minHeight: 48 }}
                  disabled={testing}
                  onClick={() => void testSettings()}
                >
                  {testing ? "正在测试 …" : "测试连接"}
                </button>
                <p className="hintline">
                  测试会用当前的表单值（含未保存的改动）真发一次最小请求：
                  能当场看出密钥对不对、model 名在不在这个端点上。
                </p>
              </form>

              {testResult ? (
                <div
                  className={testResult.ok ? "alert alert-info" : "alert alert-error"}
                  role="status"
                  style={{ marginTop: 12, display: "block" }}
                >
                  <b>{testResult.ok ? "✅ 连接正常" : "❌ 跑不通"}</b>
                  {testResult.timedOut ? (
                    <span className="hintline" style={{ color: "#ff8b7d" }}>
                      {" "}
                      （超时：端点在 45 秒内没有任何响应）
                    </span>
                  ) : null}
                  {typeof testResult.elapsedMs === "number" ? (
                    <span className="hintline"> （{testResult.elapsedMs} ms）</span>
                  ) : null}
                  <div className="hintline" style={{ marginTop: 6 }}>
                    {testResult.provider} / {testResult.model}
                    {testResult.modelSource
                      ? ` · 模型来源：${MODEL_SOURCE_LABEL[testResult.modelSource] ?? testResult.modelSource}`
                      : ""}
                  </div>
                  {testResult.vision === false ? (
                    <div className="hintline" style={{ marginTop: 6, color: "#ff8b7d" }}>
                      ⚠️ 你在 models.json 里把这个模型声明为纯文本（input 里没有
                      image），它读不了试卷照片。
                    </div>
                  ) : null}
                  {testResult.vision === true ? (
                    <div className="hintline" style={{ marginTop: 6 }}>
                      模型能力（来自你的 models.json）：可读图 · 上下文{" "}
                      {compactNumber(testResult.contextWindow)} · 输出上限{" "}
                      {compactNumber(testResult.maxTokens)}
                    </div>
                  ) : null}
                  {testResult.piModel ? (
                    <div className="hintline" style={{ marginTop: 6 }}>
                      pi 会按 <b>上下文 {testResult.piModel.contextWindow}</b> ·{" "}
                      <b>输出上限 {testResult.piModel.maxOut}</b> · thinking{" "}
                      {testResult.piModel.thinking} · images {testResult.piModel.images} 发请求
                      {testResult.piModel.thinking === "no" &&
                      testResult.assumedCapabilities ? (
                        <span style={{ color: "#ff8b7d" }}>
                          {" "}
                          —— 推理模型的 thinking 可能吃光这个输出预算，让一轮回答变成空内容
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                  {testResult.assumedCapabilities ? (
                    <div className="hintline" style={{ marginTop: 6, color: "#ffd479" }}>
                      ⚠️ 下面是猜的：
                      {(testResult.assumedFields ?? []).join("、") ||
                        "模型能力"}
                      。推理模型被猜成「不会思考、输出上限 16.4K」时，可能把整个输出预算
                      花在思考上、一轮回答没有任何内容，任务就停在半路。
                    </div>
                  ) : (
                    <div className="hintline" style={{ marginTop: 6 }}>
                      ✅ 能力已声明：能读图 {String(testResult.vision)} · 会思考{" "}
                      {String(testResult.reasoning)} · 上下文{" "}
                      {compactNumber(testResult.contextWindow)} · 输出上限{" "}
                      {compactNumber(testResult.maxTokens)}
                    </div>
                  )}
                  {testResult.error ? (
                    <pre className="note" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                      {testResult.error}
                    </pre>
                  ) : null}
                  {testResult.hint ? (
                    <div style={{ marginTop: 8 }}>{testResult.hint}</div>
                  ) : null}
                  {testResult.ok && testResult.output ? (
                    <pre className="note" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
                      {testResult.output}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          <section className="panel" aria-labelledby="newuser-heading">
            <div className="panel-h">
              <h2 id="newuser-heading">
                <span className="px" style={{ color: "var(--l1-c)" }} aria-hidden="true">✦</span>
                新建用户
              </h2>
              <span className="aside">NEW</span>
            </div>
            <div className="panel-b">
              <form method="post" className="stack" onSubmit={createUser}>
                <label className="stack-tight">
                  <span className="field-label cn-label">用户名</span>
                  <input
                    className="input"
                    value={newUser.username}
                    onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                    required
                  />
                </label>
                <label className="stack-tight">
                  <span className="field-label cn-label">初始密码 · 至少 8 位</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                    required
                  />
                </label>
                <label className="stack-tight">
                  <span className="field-label cn-label">邮箱（可选）</span>
                  <input
                    className="input"
                    type="email"
                    autoComplete="off"
                    placeholder="留空 = 用户下次登录时自己填"
                    value={newUser.email}
                    onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                  />
                </label>
                <label className="stack-tight">
                  <span className="field-label cn-label">生成次数上限</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={newUser.quota}
                    onChange={(e) =>
                      setNewUser({ ...newUser, quota: Number(e.target.value) || 0 })
                    }
                  />
                </label>
                <button className="act" type="submit" style={{ minHeight: 48 }}>
                  创建用户
                </button>
              </form>
            </div>
          </section>
        </div>

        <section className="panel" aria-labelledby="users-heading">
          <div className="panel-h">
            <h2 id="users-heading">
              <span className="px" style={{ color: "var(--l1-c)" }} aria-hidden="true">■</span>
              用户
            </h2>
            <span className="aside">{users ? `${users.length} USERS` : "…"}</span>
          </div>
          <div className="panel-b flush">
            {!users ? (
              <div className="b">
                <p className="hintline">正在读取 …</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>用户名</th>
                      <th>邮箱</th>
                      <th>用量</th>
                      <th>上限</th>
                      <th>最近登录</th>
                      <th style={{ textAlign: "right" }}>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          {user.username}{" "}
                          {user.role === "admin" ? <span className="badge badge-admin">管理员</span> : null}
                          {user.disabled ? <span className="badge badge-off">已停用</span> : null}
                          {user.betaAppliedAt !== null && user.betaStatus === "pending" ? (
                            <span className="badge badge-key">待审核</span>
                          ) : null}
                          {user.betaAppliedAt !== null && user.betaStatus === "rejected" ? (
                            <span className="badge badge-off">未通过</span>
                          ) : null}
                        </td>
                        <td>
                          {isEmailSet(user.email) ? (
                            <span className="admin-email">{user.email}</span>
                          ) : (
                            <span className="badge badge-key">未填写</span>
                          )}
                        </td>
                        <td className="num">{user.used}/{user.quota}</td>
                        <td>
                          <input
                            className="input"
                            type="number"
                            min={0}
                            defaultValue={user.quota}
                            style={{ width: 92, minHeight: 40 }}
                            aria-label={`${user.username} 的次数上限`}
                            onBlur={(e) => {
                              const quota = Number(e.target.value);
                              if (Number.isFinite(quota) && quota >= 0 && quota !== user.quota) {
                                void patchUser(user.id, { quota });
                              }
                            }}
                          />
                        </td>
                        <td className="num">{when(user.lastLoginAt)}</td>
                        <td>
                          <div className="admin-actions">
                            <button
                              className="btn btn-sm"
                              type="button"
                              onClick={() => void patchUser(user.id, { resetUsage: true })}
                            >
                              清零用量
                            </button>
                            <button
                              className="btn btn-sm"
                              type="button"
                              onClick={() => void patchUser(user.id, { disabled: !user.disabled })}
                            >
                              {user.disabled ? "启用" : "停用"}
                            </button>
                            <button
                              className="btn btn-sm"
                              type="button"
                              onClick={() => {
                                const password = window.prompt(`给「${user.username}」设置新密码（至少 8 位）：`);
                                if (password) void patchUser(user.id, { password });
                              }}
                            >
                              改密码
                            </button>
                            {/* 删除必须远离其他动作 */}
                            <button
                              className="btn btn-sm btn-danger-ghost"
                              type="button"
                              onClick={() => void removeUser(user.id, user.username)}
                              style={{ marginLeft: 12 }}
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </main>
    </>
  );
}