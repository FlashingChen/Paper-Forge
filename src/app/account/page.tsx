"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import UserBar, { type MeResponse } from "@/components/UserBar";
import PasswordForm from "@/components/PasswordForm";
import { accountReturnTarget } from "@/lib/account-navigation";
import { EMAIL_HINT, isValidEmail } from "@/lib/registration";

function AccountSettings() {
  const router = useRouter();
  const params = useSearchParams();
  const target = accountReturnTarget(params.get("next"));
  const [user, setUser] = useState<MeResponse["user"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      if (response.status === 401) {
        router.replace(`/login?next=${encodeURIComponent("/account")}`);
        return;
      }
      if (!response.ok) throw new Error("load failed");
      const data = await response.json() as MeResponse;
      setUser(data.user);
      setEmail(data.user.email ?? "");
    } catch {
      setLoadError("账号信息读取失败，请检查连接后重试。");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  async function saveEmail(event: React.FormEvent) {
    event.preventDefault();
    if (!user || emailBusy || passwordBusy) return;
    setEmailError(null);
    setSaved(false);
    const value = email.trim();
    if (!isValidEmail(value)) {
      setEmailError(value ? EMAIL_HINT : "请填写联系邮箱。");
      return;
    }
    setEmailBusy(true);
    try {
      const response = await fetch("/api/auth/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const data = await response.json() as { error?: string; email?: string };
      if (response.status === 401) {
        router.replace("/login?next=/account");
        return;
      }
      if (!response.ok) {
        setEmailError(data.error ?? "邮箱保存失败，请重试。");
        return;
      }
      setUser({ ...user, email: data.email ?? value, needEmail: false });
      setEmail(data.email ?? value);
      setSaved(true);
      setRefreshKey((key) => key + 1);
      // Onboarding resumes the original task; ordinary edits stay in settings.
      if (user.needEmail) {
        router.replace(target);
        router.refresh();
      }
    } catch {
      setEmailError("网络出错了，请检查连接后重试。");
    } finally {
      setEmailBusy(false);
    }
  }

  return (
    <>
      {!passwordChanged ? <UserBar refreshKey={refreshKey} /> : null}
      <main className="account-wrap">
        <div className="panel account-panel">
          <div className="panel-h"><h1>账号设置</h1></div>
          <div className="panel-b account-content">
            {loading ? <p role="status">正在读取账号信息 …</p> : loadError ? (
              <div className="stack">
                <p className="alert alert-error" role="alert">{loadError}</p>
                <button className="act" type="button" onClick={() => void load()}>重新读取</button>
              </div>
            ) : user ? (
              <>
                {!passwordChanged ? (
                  <>
                    {user.needEmail ? <p className="alert alert-warn" role="alert">请先填写联系邮箱，再继续使用。我们会通过这个邮箱联系你处理内测进度和问题。</p> : null}
                    <section className="account-section" aria-labelledby="identity-title">
                      <h2 id="identity-title">身份信息</h2>
                      <dl className="account-identity">
                        <div><dt>用户名</dt><dd>{user.username}</dd></div>
                        <div><dt>账号身份</dt><dd>{user.role === "admin" ? "管理员" : "普通用户"}</dd></div>
                        <div><dt>职业</dt><dd>{user.occupation ?? "未填写"}</dd></div>
                        <div><dt>所在省份</dt><dd>{user.region ?? "未填写"}</dd></div>
                        <div><dt>生成额度</dt><dd>剩余 {user.remaining} 次 / 共 {user.quota} 次</dd></div>
                      </dl>
                    </section>
                    <section className="account-section" id="email" aria-labelledby="email-title">
                      <h2 id="email-title">联系邮箱</h2>
                      <p className="hintline" id="email-hint">用于内测通知和问题联系，登录仍使用用户名。</p>
                      <form className="stack" onSubmit={saveEmail}>
                        <fieldset className="stack account-fields" disabled={emailBusy || passwordBusy}>
                          <label className="stack-tight">
                            <span className="field-label cn-label">邮箱</span>
                            <input className="input" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={254} placeholder="name@example.com" aria-describedby="email-hint" value={email} onChange={(event) => { setEmail(event.target.value); setSaved(false); setEmailError(null); }} />
                          </label>
                          {emailError ? <p className="alert alert-error" role="alert">{emailError}</p> : null}
                          {saved ? <p className="alert alert-info" role="status">联系邮箱已保存。</p> : null}
                          <button className="act" type="submit" disabled={!user.needEmail && email.trim() === user.email}>{emailBusy ? "保存中 …" : user.needEmail ? "保存邮箱并继续" : "保存邮箱"}</button>
                        </fieldset>
                      </form>
                    </section>
                  </>
                ) : null}
                <PasswordForm disabled={emailBusy} onBusyChange={setPasswordBusy} onChanged={() => setPasswordChanged(true)} />
                {!user.needEmail && !passwordChanged ? <Link className="footnote" href={target}>返回工作页面 →</Link> : null}
              </>
            ) : null}
          </div>
        </div>
      </main>
    </>
  );
}

export default function AccountPage() {
  return <Suspense fallback={<main className="account-wrap"><p role="status">正在读取账号信息 …</p></main>}><AccountSettings /></Suspense>;
}
