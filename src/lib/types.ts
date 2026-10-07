/**
 * Shared contract for PaperForge.
 *
 * Every other module (API routes, frontend, Docker entrypoint) depends on
 * these exact shapes. Do not rename fields.
 */

export type JobStatus = "queued" | "running" | "done" | "error";

export type LogLevel = "info" | "warn" | "error" | "success";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  text: string;
}

export interface Job {
  id: string;
  /** Owning account. Absent only for jobs created before the auth upgrade. */
  userId?: number;
  status: JobStatus;
  createdAt: number;
  imageCount: number;
  logs: LogEntry[];
  resultPath?: string;
  resultSize?: number;
  error?: string;
  note?: string;
}

export interface RunOptions {
  jobId: string;
  jobDir: string;
  images: { index: number; filename: string; buffer: Buffer }[];
  onLog: (level: LogLevel, text: string) => void;
}
