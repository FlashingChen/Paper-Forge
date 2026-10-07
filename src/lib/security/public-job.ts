import { isProgressLabel, progressLabel } from "../agent-progress";
import type { Job, LogEntry } from "../types";
// Only fixed messages and validated activity tags cross the user boundary. Never
// display tool output, model text, provider configuration or upstream errors.
export function publicLog(entry: LogEntry): LogEntry | undefined {
  const text = entry.text;
  let safe: string | undefined;
  const activity = progressLabel(text) ?? (isProgressLabel(text) ? text : undefined);
  if (activity) return { ts: entry.ts, level: "info", text: activity };
  if (["图片已接收","开始处理","正在检查文档","文档已生成","处理超时，请稍后重试"].includes(text)) return { ts: entry.ts, level: entry.level, text };
  if (/^Wrote \d+ image\(s\) to in\/$/.test(text)) safe = "图片已接收";
  else if (/^Starting pi \(/.test(text)) safe = "开始处理";
  else if (text === "Agent finished its run" || text === "pi session settled") safe = "正在检查文档";
  else if (/^Result ready:/.test(text)) safe = "文档已生成";
  else if (/^Timed out after/.test(text)) safe = "处理超时，请稍后重试";
  return safe ? { ts: entry.ts, level: entry.level, text: safe } : undefined;
}
export function publicLogs(logs: LogEntry[]): LogEntry[] {
  return logs.flatMap(entry => { const safe = publicLog(entry); return safe ? [safe] : []; }).filter((entry, i, all) => i === 0 || entry.text !== all[i - 1].text);
}
export function publicJob(job: Job): Job {
  return { id: job.id, status: job.status, createdAt: job.createdAt, imageCount: job.imageCount,
    resultSize: job.resultSize, logs: publicLogs(job.logs),
    ...(job.status === "error" ? { error: `任务处理失败，请联系管理员（编号 ${job.id.slice(0, 8)}）。` } : {}) };
}
