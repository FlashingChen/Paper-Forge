"use client";

import { useEffect, useRef } from "react";
import type { LogEntry } from "@/lib/types";

export interface LogViewProps {
  entries: LogEntry[];
  /** Height cap in px; defaults to the CSS class value. */
  maxHeight?: number;
  emptyText?: string;
}

/** Log levels map onto terminal colours: success green, warning amber, error red. */
function levelClass(level: LogEntry["level"]): string {
  if (level === "success") return "ok";
  if (level === "warn") return "warn";
  if (level === "error") return "err";
  return "";
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Monospace, colour-coded log list that keeps itself scrolled to the newest
 * line — unless the user has scrolled up to read something, in which case we
 * stay put until they return to the bottom.
 */
export default function LogView({
  entries,
  maxHeight,
  emptyText = "还没有日志。",
}: LogViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    if (stickToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [entries]);

  const onScroll = () => {
    const node = containerRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottomRef.current = distance < 40;
  };

  return (
    <div
      className="term"
      ref={containerRef}
      onScroll={onScroll}
      style={maxHeight ? { maxHeight } : undefined}
      role="log"
      aria-live="polite"
      aria-label="运行日志"
    >
      {entries.length === 0 ? (
        <div className="term-empty">{emptyText}</div>
      ) : (
        entries.map((entry, index) => (
          <div
            key={`${entry.ts}-${index}`}
            className={`tl ${levelClass(entry.level)}`}
          >
            <span className="t">{formatTime(entry.ts)}</span>
            <span className="m">{entry.text}</span>
          </div>
        ))
      )}
    </div>
  );
}
