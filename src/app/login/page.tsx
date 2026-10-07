"use client";

import { loginReturnTarget } from "@/lib/account-navigation";
import { BETA_CONTACT } from "@/lib/beta-contact";

import Link from "next/link";
import BetaNotice from "@/components/BetaNotice";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

/**
 * /login
 *
 * The whole point of this page is to get out of the way: one field each, one
 * button, and a clear Chinese error. A teacher should never have to think about
 * this screen. The error message is deliberately loud — failed login is the
 * most anxious moment in the whole flow.
 */

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await response.json()) as {
        error?: string;
        needEmail?: boolean;
        user?: { role?: string };
      };

      if (!response.ok) {
        setError(data.error ?? "登录失败，请重试。");
        setBusy(false);
        return;
      }

      // Return the teacher to wherever the guard intercepted them.
      const next = params.get("next");
      const target = loginReturnTarget(next);

      // Accounts with no address on file go there first. This is only the
      // friendly half: the server refuses to run anything until it is set.
      if (data.needEmail) {
        router.replace(`/account?next=${encodeURIComponent(target)}`);
        router.refresh();
        return;
      }

      router.replace(target);
      router.refresh();
    } catch {
      setError("网络出错了，请检查连接后重试。");
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <section className="panel auth-card">
        <div className="panel-h">
          <h2>
            <span className="auth-mark" aria-hidden="true">
              P
            </span>
            <span className="auth-title">PAPERFORGE</span>
          </h2>
          <span className="aside">内测试用</span>
        </div>

        <div className="panel-b">
          <div className="stack-tight">
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>拍照转 Word</h1>
            <p className="hintline">登录后，选好照片就能开始整理。</p>
          </div>

          <BetaNotice />

          <form method="post" className="stack" onSubmit={submit}>
            <label className="stack-tight">
              <span className="field-label cn-label">账号</span>
              <input
                className="input"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </label>

            <label className="stack-tight">
              <span className="field-label cn-label">密码</span>
              <input
                className="input"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>

            {error ? (
              <div className="alert alert-error" role="alert">
                <span className="px" aria-hidden="true">✕ </span>
                {error}
              </div>
            ) : null}

            <button className="act" type="submit" disabled={busy}>
              {busy ? "登录中 …" : "登录，上传照片"}
            </button>
          </form>

          <p className="hintline">
            还没有账号？<Link className="footnote" href="/register">申请内测 →</Link>
          </p>
          <p className="hintline">
            已有账号但忘了密码？可以私信{BETA_CONTACT}帮你重置。
          </p>
          <Link className="footnote" href="/">
            返回首页 →
          </Link>
        </div>
      </section>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}