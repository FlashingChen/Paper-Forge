"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { UsagePrice } from "@/lib/usage-types";

interface Summary {
  calls: number; tokens: number; input: number; output: number; cacheRead: number; cacheWrite: number;
  costUsd: number | null; unpricedCalls: number | null; unknownCalls: number | null;
}
interface JobUsage {
  id: string; status: string; createdAt: number; imageCount: number; calls: number;
  tokens: number | null; input: number | null; output: number | null;
  cacheRead: number | null; cacheWrite: number | null; costUsd: number | null;
  unpricedCalls: number; unknownCalls: number; models: string | null; sources: string | null;
}
interface Report {
  summary: Summary; jobs: JobUsage[]; current: { provider: string; model: string } | null; price: UsagePrice | null;
}
const labels = { input: "输入", output: "输出（含推理）", cacheRead: "缓存读取", cacheWrite: "缓存写入" };
const keys = Object.keys(labels) as (keyof UsagePrice)[];
const statuses: Record<string, string> = { queued: "排队", running: "生成中", done: "完成", error: "失败" };
function number(value: number | null) { return value === null ? "未记录" : value.toLocaleString("zh-CN"); }
function money(value: number | null) { return value === null ? "未定价" : `$${value.toFixed(6)}`; }

export default function UsagePage() {
  const [report, setReport] = useState<Report | null>(null);
  const [form, setForm] = useState<Record<keyof UsagePrice, string>>({ input: "", output: "", cacheRead: "", cacheWrite: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async (fillForm = false) => {
    try {
      const response = await fetch("/api/admin/usage", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "读取用量失败");
      const next = data as Report;
      setReport(next);
      setError(null);
      if (fillForm) setForm(Object.fromEntries(keys.map(key => [key, next.price ? String(next.price[key]) : ""])) as Record<keyof UsagePrice, string>);
    } catch (e) { setError(e instanceof Error ? e.message : "读取失败"); }
  }, []);
  useEffect(() => {
    void load(true);
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!report?.current) return;
    setSaving(true); setNotice(null);
    try {
      const response = await fetch("/api/admin/usage", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...report.current, price: Object.fromEntries(keys.map(key => [key, form[key].trim() === "" ? null : Number(form[key])])) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "保存失败");
      setNotice("单价已保存，从下一次新任务生效。历史估算金额保持不变。");
      await load(true);
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setSaving(false); }
  }
  return <>
    <header className="hud">
      <div className="hud-l"><Link className="hud-logo" href="/admin">ADMIN<span className="cn-name">用量与费用</span></Link></div>
      <div className="hud-stats"><button className="stat" onClick={() => void load()}><span>RELOAD</span><b>刷新</b></button><Link className="stat" href="/admin/applications"><span>BETA</span><b>内测申请</b></Link><Link className="stat" href="/admin"><span>ADMIN</span><b>返回后台</b></Link></div>
    </header>
    <main className="page wide" style={{ paddingTop: 24 }}>
      {error && <div className="alert alert-warn" role="alert">{error}</div>}
      {notice && <div className="alert alert-info" role="status">{notice}</div>}
      <p>记录功能启用后的模型用量，每 15 秒刷新。金额为美元估算，不含服务器、存储等费用，最终以服务商账单为准。旧任务无法补算；失败任务的已记录消耗也计入。</p>
      {!report && !error && <p>正在加载…</p>}
      {report && <>
        <section className="panel" style={{ marginBottom: 24 }}>
          <div className="panel-h"><h2>累计用量</h2><span className="aside">ALL TIME</span></div>
          <div className="panel-b">
            <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
              <div>已结束的模型调用<b style={{ display: "block" }}>{number(report.summary.calls)}</b></div>
              <div>已记录 Token<b style={{ display: "block" }}>{number(report.summary.tokens)}</b></div>
              <div>已定价部分预计费用<b style={{ display: "block" }}>{money(report.summary.costUsd)} USD</b></div>
            </div>
            <p>输入 {number(report.summary.input)} · 输出 {number(report.summary.output)} · 缓存读取 {number(report.summary.cacheRead)} · 缓存写入 {number(report.summary.cacheWrite)}</p>
            {(!!report.summary.unpricedCalls || !!report.summary.unknownCalls) && <p role="status">{report.summary.unpricedCalls ?? 0} 次调用未定价，{report.summary.unknownCalls ?? 0} 次调用缺少用量数据，汇总可能不完整。</p>}
          </div>
        </section>
        <section className="panel" style={{ marginBottom: 24 }}>
          <div className="panel-h"><h2>估算单价</h2><span className="aside">USD / 1M TOKENS</span></div>
          <div className="panel-b">
            <p>当前模型：{report.current ? `${report.current.provider} / ${report.current.model}` : "尚未配置有效模型"}</p>
            <p>填写你实际使用渠道的每百万 Token 美元单价。未配置时使用模型目录估价；目录没有有效价格时显示“未定价”。缓存两项请按渠道价格填写，免费可填 0。</p>
            <form method="post" onSubmit={save} className="stack">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16 }}>
                {keys.map(key => <label className="stack-tight" key={key}><span>{labels[key]}</span><input className="input" type="number" min="0" max="1000000" step="any" required value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} /></label>)}
              </div>
              <button className="btn" type="submit" disabled={saving || !report.current}>{saving ? "保存中…" : "保存单价"}</button>
            </form>
          </div>
        </section>
        <section className="panel">
          <div className="panel-h"><h2>任务明细</h2><span className="aside">LATEST 200</span></div>
          <div className="panel-b" style={{ overflowX: "auto" }}>
            <table className="admin-table"><thead><tr><th>任务 / 时间</th><th>状态 / 页数</th><th>模型</th><th>调用</th><th>输入</th><th>输出</th><th>缓存读 / 写</th><th>总 TOKEN</th><th>预计费用 USD</th></tr></thead>
              <tbody>{report.jobs.map(job => <tr key={job.id}>
                <td><Link href={`/job/${encodeURIComponent(job.id)}`}>{job.id.slice(0, 8)}</Link><div>{new Date(job.createdAt).toLocaleString("zh-CN")}</div></td>
                <td>{statuses[job.status] ?? job.status} / {job.imageCount}</td><td>{job.models ?? "未记录"}</td><td className="num">{job.calls}</td><td className="num">{number(job.input)}</td><td className="num">{number(job.output)}</td><td className="num">{number(job.cacheRead)} / {number(job.cacheWrite)}</td><td className="num">{number(job.tokens)}{job.unknownCalls > 0 && "（不完整）"}</td>
                <td className="num">{job.calls === 0 ? "未记录" : money(job.costUsd)}{job.costUsd !== null && job.unpricedCalls > 0 && "（部分）"}<div>{job.sources?.includes("configured") ? "配置单价 " : ""}{job.sources?.includes("catalog") ? "目录估价" : ""}</div></td>
              </tr>)}</tbody>
            </table>
            {report.jobs.length === 0 && <p>暂无任务。</p>}
          </div>
        </section>
      </>}
    </main>
  </>;
}
