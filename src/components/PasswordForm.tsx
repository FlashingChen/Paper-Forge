"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function PasswordForm({ onChanged, onBusyChange, disabled = false }: { onChanged: () => void; onBusyChange: (busy: boolean) => void; disabled?: boolean }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || disabled) return;
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致。");
      return;
    }
    if (newPassword === currentPassword) {
      setError("新密码不能与当前密码相同。");
      return;
    }
    setBusy(true);
    onBusyChange(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      const data = await response.json() as { error?: string };
      if (response.status === 401) {
        router.replace("/login?next=/account");
        router.refresh();
        return;
      }
      if (!response.ok) {
        setError(data.error ?? "修改失败，请重试。");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setChanged(true);
      onChanged();
    } catch {
      setError("网络出错了，请检查连接后重试。");
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  }

  return (
    <>
      <section className="account-section" id="password" aria-labelledby="password-title">
          <h2 id="password-title">修改密码</h2>
            {changed ? (
              <div className="stack" role="status">
                <p>密码已修改，所有旧登录已失效。请使用新密码重新登录。</p>
                <Link className="act" href="/login">重新登录</Link>
              </div>
            ) : (
              <>
                <p className="hintline">新密码需为 8～128 位。修改后需重新登录。</p>
                <form method="post" className="stack" onSubmit={submit}>
                  <fieldset className="stack account-fields" disabled={busy || disabled}>
                    <label className="stack-tight">
                      <span className="field-label cn-label">当前密码</span>
                      <input className="input" name="currentPassword" type="password" autoComplete="current-password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
                    </label>
                    <label className="stack-tight">
                      <span className="field-label cn-label">新密码</span>
                      <input className="input" name="newPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
                    </label>
                    <label className="stack-tight">
                      <span className="field-label cn-label">确认新密码</span>
                      <input className="input" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
                    </label>
                    {error ? <div className="alert alert-error" role="alert">{error}</div> : null}
                    <button className="act" type="submit">{busy ? "修改中 …" : "保存新密码"}</button>
                  </fieldset>
                </form>
              </>
            )}
      </section>
    </>
  );
}
