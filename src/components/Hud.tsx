"use client";

import Link from "next/link";

/** Shared account navigation and document progress. */

export interface HudUser {
  username: string;
  role: "user" | "admin";
  quota: number;
  used: number;
  remaining: number;
  /** Not rendered here — the user bar uses these to flag a missing address. */
  email?: string | null;
  needEmail?: boolean;
}

export interface HudAction {
  label: string;
  key: string;
  href?: string;
  onClick?: () => void;
}

/** The four stages, in order. Index is the level number minus one. */
export const LEVELS = ["选好照片", "识别题目", "整理版面", "下载 Word"] as const;

export function Hud({
  user,
  actions = [],
  markTone = "green",
}: {
  user?: HudUser | null;
  actions?: HudAction[];
  /** Which level colour tints the logo mark. */
  markTone?: "green" | "blue" | "purple" | "orange";
}) {
  const markBg: Record<string, string> = {
    green: "var(--l1-c)",
    blue: "var(--l2-c)",
    purple: "var(--l3-c)",
    orange: "var(--l4-c)",
  };
  const markIn: Record<string, string> = {
    green: "var(--l1-a)",
    blue: "var(--l2-a)",
    purple: "var(--l3-a)",
    orange: "var(--l4-a)",
  };

  const low = user ? user.remaining <= 3 : false;

  return (
    <header className="hud">
      <div className="hud-l">
        <Link className="hud-logo" href="/app">
          <span
            className="mark"
            style={{ background: markBg[markTone], boxShadow: `inset 0 0 0 4px ${markIn[markTone]}` }}
          >
            P
          </span>
          PAPERFORGE
        </Link>
        <span className="beta-badge">正在内测</span>
        {user ? (
          <div className="hud-stats">
            <div className="stat">
              <span>USER</span>
              <b>
                {user.username}
                {user.role === "admin" ? " · 管理员" : ""}
              </b>
            </div>
            <div className="stat coin">
              <span>RUNS</span>
              <b className={low ? "coin-low" : undefined}>
                {user.remaining} / {user.quota}
              </b>
            </div>
          </div>
        ) : null}
      </div>

      {actions.length > 0 ? (
        <div className="hud-stats">
          {actions.map((action) => {
            const body = <><span>{action.key}</span><b>{action.label}</b></>;
            return action.href ? (
              <Link key={action.key} className="stat" href={action.href}>
                {body}
              </Link>
            ) : (
              <button key={action.key} className="stat" type="button" onClick={action.onClick}>
                {body}
              </button>
            );
          })}
        </div>
      ) : null}
    </header>
  );
}

/**
 * Progress axis. `current` is the level being worked on right now (1-based);
 * everything below it reads as cleared.
 */
export function LevelBar({ current }: { current: number }) {
  return (
    <nav className="levelbar" aria-label="生成进度">
      {LEVELS.map((label, i) => {
        const n = i + 1;
        const state = n < current ? "done" : n === current ? "now" : "";
        return (
          <div key={label} className={`lv ${state}`.trim()} aria-current={n === current ? "step" : undefined}>
            <span className="lv-chip" aria-hidden="true">
              {n < current ? "✓" : n}
            </span>
            <span className="lv-label">
              {n < current ? <span className="sr-only">已完成：</span> : null}
              {n === current ? <span className="sr-only">当前：</span> : null}
              {label}
            </span>
          </div>
        );
      })}
    </nav>
  );
}