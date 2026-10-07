import { hashPassword, verifyPassword } from "./auth";
import { getPasswordHashByUsername, getUserById, replaceUserPassword } from "./db";

export type PasswordChangeResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** userId must come from the authenticated session, never from the request body. */
export function changeOwnPassword(userId: number, input: unknown): PasswordChangeResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, status: 400, error: "请求格式不对" };
  }
  const { currentPassword, newPassword, confirmPassword } = input as Record<string, unknown>;
  if (typeof currentPassword !== "string" || !currentPassword ||
      typeof newPassword !== "string" || typeof confirmPassword !== "string") {
    return { ok: false, status: 400, error: "请填写当前密码、新密码和确认密码。" };
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return { ok: false, status: 400, error: "新密码长度应为 8～128 位。" };
  }
  if (newPassword !== confirmPassword) {
    return { ok: false, status: 400, error: "两次输入的新密码不一致。" };
  }
  if (newPassword === currentPassword) {
    return { ok: false, status: 400, error: "新密码不能与当前密码相同。" };
  }
  const user = getUserById(userId);
  if (!user || user.disabled) return { ok: false, status: 401, error: "请先登录" };
  const stored = getPasswordHashByUsername(user.username);
  if (!stored || !verifyPassword(currentPassword, stored)) {
    return { ok: false, status: 400, error: "当前密码不对。" };
  }
  if (!replaceUserPassword(userId, stored, hashPassword(newPassword))) {
    return { ok: false, status: 409, error: "账号状态已变化，请重新登录后再试。" };
  }
  return { ok: true };
}
