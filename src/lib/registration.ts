/**
 * Shared contract for self-service registration.
 *
 * Both the browser form and the API route import this module, so it must stay
 * free of Node-only imports (`node:sqlite`, `next/headers`, …). It holds the
 * field lists, the validation rules and the messages, so the two sides can
 * never disagree about what a valid application looks like.
 */

export const OCCUPATIONS = [
  "中小学老师",
  "大学老师",
  "培训机构老师",
  "家教",
  "学校教务 / 教研",
  "学生",
  "家长",
  "出版社 / 编辑",
  "其他",
] as const;

export const REGIONS = [
  "北京",
  "天津",
  "河北",
  "山西",
  "内蒙古",
  "辽宁",
  "吉林",
  "黑龙江",
  "上海",
  "江苏",
  "浙江",
  "安徽",
  "福建",
  "江西",
  "山东",
  "河南",
  "湖北",
  "湖南",
  "广东",
  "广西",
  "海南",
  "重庆",
  "四川",
  "贵州",
  "云南",
  "西藏",
  "陕西",
  "甘肃",
  "青海",
  "宁夏",
  "新疆",
  "香港",
  "澳门",
  "台湾",
  "海外",
] as const;

export interface RegistrationInput {
  username: string;
  password: string;
  email: string;
  occupation: string;
  region: string;
}

export type RegistrationParse =
  | { ok: true; value: RegistrationInput }
  | { ok: false; error: string };

export const USERNAME_MIN = 2;
export const USERNAME_MAX = 32;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const EMAIL_MAX = 254;

/**
 * What an account holds when nobody has given an address yet.
 *
 * Deliberately the literal text `null`, not SQL NULL: accounts created before
 * the field existed (and ones created without one) get this value from the
 * column default, and it is what the login flow looks for to decide that the
 * user must supply an address before doing anything else.
 */
export const EMAIL_UNSET = "null";

/** Same shape the administrator console accepts, so both paths agree. */
export const USERNAME_PATTERN = /^[A-Za-z0-9_.@-]{2,32}$/;

/**
 * Deliberately permissive: one @, something on both sides, a dot in the domain,
 * no whitespace. Stricter rules reject real addresses (plus-tags, long TLDs,
 * IDN, school domains); looser ones accept typos we cannot verify anyway. The
 * address is only ever used to reach the person.
 */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export const USERNAME_HINT = "用户名只能用字母、数字、下划线、点、@ 或减号，长度 2~32。";
export const PASSWORD_HINT = `密码长度应为 ${PASSWORD_MIN}～${PASSWORD_MAX} 位。`;
export const EMAIL_HINT = "请填写一个正确的邮箱，例如 name@example.com。";
export const OCCUPATION_HINT = "请从列表里选择你的职业。";
export const REGION_HINT = "请从列表里选择你所在的省份。";

/** True when a real address is on file — not the sentinel and not empty. */
export function isEmailSet(value: string | null | undefined): boolean {
  const email = (value ?? "").trim();
  return email.length > 0 && email.toLowerCase() !== EMAIL_UNSET;
}

/**
 * What the uniqueness rule compares on: trimmed and case-folded.
 *
 * Returns the empty string for anything that is not a real address — the
 * sentinel, blank, or missing. Those rows are deliberately exempt: several
 * accounts may be waiting for an address at the same time, and treating the
 * sentinel as a value would make every one of them collide with the rest.
 *
 * Case folding is ASCII-only, which is what the column holds in practice; a
 * domain is case-insensitive anyway, and treating the local part the same way
 * is the rule users expect.
 */
export function normalizeEmailKey(value: string | null | undefined): string {
  const email = (value ?? "").trim().toLowerCase();
  return email === EMAIL_UNSET ? "" : email;
}

export const EMAIL_TAKEN_MESSAGE = "这个邮箱已经被别的账号用了，换一个吧。";

/**
 * Raised by the write paths when a second account claims an address.
 *
 * A thrown error rather than a return value because the check has to happen
 * inside the same transaction as the write — see createUser/setUserEmail in
 * ./db — and a boolean return cannot distinguish "taken" from "no such account".
 */
export class EmailTakenError extends Error {
  constructor() {
    super(EMAIL_TAKEN_MESSAGE);
    this.name = "EmailTakenError";
  }
}

export function isValidEmail(value: string): boolean {
  const email = value.trim();
  return email.length <= EMAIL_MAX && EMAIL_PATTERN.test(email);
}

export function isOccupation(value: string): boolean {
  return (OCCUPATIONS as readonly string[]).includes(value);
}

export function isRegion(value: string): boolean {
  return (REGIONS as readonly string[]).includes(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validate one application. The password is intentionally *not* trimmed: a
 * leading or trailing space is part of what the applicant typed.
 */
export function parseRegistration(raw: unknown): RegistrationParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "请求格式不对" };
  }
  const body = raw as Record<string, unknown>;

  const username = asTrimmedString(body.username);
  const password = typeof body.password === "string" ? body.password : "";
  const email = asTrimmedString(body.email);
  const occupation = asTrimmedString(body.occupation);
  const region = asTrimmedString(body.region);

  if (!username || !password) {
    return { ok: false, error: "请填写用户名和密码。" };
  }
  if (!USERNAME_PATTERN.test(username)) {
    return { ok: false, error: USERNAME_HINT };
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return { ok: false, error: PASSWORD_HINT };
  }
  if (!email) {
    return { ok: false, error: "请填写邮箱，方便我们把内测消息发给你。" };
  }
  if (!isValidEmail(email)) {
    return { ok: false, error: EMAIL_HINT };
  }
  if (!isOccupation(occupation)) {
    return { ok: false, error: OCCUPATION_HINT };
  }
  if (!isRegion(region)) {
    return { ok: false, error: REGION_HINT };
  }

  return { ok: true, value: { username, password, email, occupation, region } };
}

export const BETA_STATUS_LABELS: Record<"pending" | "approved" | "rejected", string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "未通过",
};
