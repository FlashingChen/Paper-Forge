"use client";

import Link from "next/link";
import { useState } from "react";
import {
  EMAIL_HINT,
  isValidEmail,
  OCCUPATIONS,
  PASSWORD_HINT,
  REGIONS,
  USERNAME_HINT,
} from "@/lib/registration";

/**
 * /register
 *
 * Registration and the beta application are the same action: one short form,
 * and the applicant is done. The account is created immediately but stays
 * dormant — the success screen says plainly that a human still has to approve
 * it, because that is the part people get anxious about.
 */

type Phase = "form" | "done";

interface FieldErrors {
  username?: string;
  password?: string;
  email?: string;
  occupation?: string;
  region?: string;
}

export default function RegisterPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [email, setEmail] = useState("");
  const [occupation, setOccupation] = useState("");
  const [region, setRegion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>("form");

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    const name = username.trim();
    if (!name) errors.username = "请填写用户名。";
    else if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(name)) errors.username = USERNAME_HINT;
    if (!password) errors.password = "请填写密码。";
    else if (password.length < 8 || password.length > 128) errors.password = PASSWORD_HINT;
    else if (password !== confirm) errors.password = "两次输入的密码不一致。";
    if (!email.trim()) errors.email = "请填写邮箱，方便我们把内测消息发给你。";
    else if (!isValidEmail(email)) errors.email = EMAIL_HINT;
    if (!occupation) errors.occupation = "请选择你的职业。";
    if (!region) errors.region = "请选择你所在的省份。";
    return errors;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    const errors = validate();
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setError("还有几项没填对，看一下标红的地方。");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          email: email.trim(),
          occupation,
          region,
        }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? "提交失败，请重试。");
        setBusy(false);
        return;
      }
      setPhase("done");
    } catch {
      setError("网络出错了，请检查连接后重试。");
      setBusy(false);
    }
  }

  if (phase === "done") {
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
              <h1 style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>
                申请已提交
              </h1>
              <p className="hintline">
                账号「{username.trim()}」已经建好，内测申请也一并提交了。
                等审核通过、并且发放了配额，就可以用它登录。
              </p>
            </div>

            <div className="alert alert-info" role="status">
              <span className="px" aria-hidden="true">
                ⏳{" "}
              </span>
              审核一般很快，通过后直接去登录页登录即可。
            </div>

            <dl className="stack-tight" style={{ margin: 0 }}>
              <div className="hintline">邮箱：{email.trim()}</div>
              <div className="hintline">职业：{occupation}</div>
              <div className="hintline">地区：{region}</div>
            </dl>

            <Link className="act" href="/login" style={{ textAlign: "center", minHeight: 48 }}>
              去登录页
            </Link>
            <Link className="footnote" href="/">
              返回首页 →
            </Link>
          </div>
        </section>
      </div>
    );
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
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>申请内测</h1>
            <p className="hintline">
              填好就能提交申请。通过后我们会给你开通账号和配额，邮箱用来通知你。
            </p>
          </div>

          <form method="post" className="stack" onSubmit={submit} noValidate>
            <label className="stack-tight">
              <span className="field-label cn-label">用户名</span>
              <input
                className="input"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                aria-invalid={fieldErrors.username ? true : undefined}
                required
              />
              <span className="hintline">
                {fieldErrors.username ?? USERNAME_HINT}
              </span>
            </label>

            <label className="stack-tight">
              <span className="field-label cn-label">密码</span>
              <input
                className="input"
                name="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={fieldErrors.password ? true : undefined}
                required
              />
              <span className="hintline">{fieldErrors.password ?? PASSWORD_HINT}</span>
            </label>

            <label className="stack-tight">
              <span className="field-label cn-label">确认密码</span>
              <input
                className="input"
                name="confirm"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
            </label>

            <label className="stack-tight">
              <span className="field-label cn-label">邮箱</span>
              <input
                className="input"
                name="email"
                type="email"
                autoComplete="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={fieldErrors.email ? true : undefined}
                required
              />
              <span className="hintline">
                {fieldErrors.email ?? "用来通知你审核结果，不会公开。"}
              </span>
            </label>

            <label className="stack-tight">
              <span className="field-label cn-label">职业</span>
              <select
                className="input"
                name="occupation"
                value={occupation}
                onChange={(e) => setOccupation(e.target.value)}
                aria-invalid={fieldErrors.occupation ? true : undefined}
                required
              >
                <option value="">请选择</option>
                {OCCUPATIONS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label className="stack-tight">
              <span className="field-label cn-label">地区（省）</span>
              <select
                className="input"
                name="region"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                aria-invalid={fieldErrors.region ? true : undefined}
                required
              >
                <option value="">请选择</option>
                {REGIONS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            {error ? (
              <div className="alert alert-error" role="alert">
                <span className="px" aria-hidden="true">
                  ✕{" "}
                </span>
                {error}
              </div>
            ) : null}

            <button className="act" type="submit" disabled={busy}>
              {busy ? "提交中 …" : "提交内测申请"}
            </button>
          </form>

          <p className="hintline">
            已经提交过？审核通过后到
            <Link className="footnote" href="/login">
              {" "}
              登录页{" "}
            </Link>
            登录。
          </p>
          <Link className="footnote" href="/">
            返回首页 →
          </Link>
        </div>
      </section>
    </div>
  );
}
