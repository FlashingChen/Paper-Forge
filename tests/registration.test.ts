import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/** Pure field validation; no database involved. */
test("registration validation accepts a complete application and rejects each bad field", async () => {
  const { OCCUPATIONS, REGIONS, parseRegistration } = await import("../src/lib/registration");

  const good = {
    username: "teacher_li",
    password: "a good password",
    email: "teacher.li@example.com",
    occupation: OCCUPATIONS[0],
    region: REGIONS[0],
  };
  const parsed = parseRegistration(good);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.value, good);

  // Whitespace around the username is trimmed; the password is left untouched.
  const padded = parseRegistration({
    ...good,
    username: "  teacher_li  ",
    password: "  spaced password  ",
  });
  assert.equal(padded.ok, true);
  assert.equal(padded.ok && padded.value.username, "teacher_li");
  assert.equal(padded.ok && padded.value.password, "  spaced password  ");

  const rejects = (body: unknown): string => {
    const result = parseRegistration(body);
    assert.equal(result.ok, false);
    return result.ok ? "" : result.error;
  };

  assert.match(rejects(null), /请求格式不对/);
  assert.match(rejects({ ...good, username: "a" }), /用户名/);
  assert.match(rejects({ ...good, username: "有中文" }), /用户名/);
  assert.match(rejects({ ...good, password: "short" }), /密码/);
  assert.match(rejects({ ...good, password: "x".repeat(129) }), /密码/);
  assert.match(rejects({ ...good, occupation: "皇帝" }), /职业/);
  assert.match(rejects({ ...good, region: "某个省" }), /省份/);
  assert.match(rejects({ ...good, occupation: "" }), /职业/);

  // The email is required and has to look like one.
  assert.match(rejects({ ...good, email: "" }), /邮箱/);
  assert.match(rejects({ ...good, email: "   " }), /邮箱/);
  assert.match(rejects({ ...good, email: "not-an-email" }), /邮箱/);
  assert.match(rejects({ ...good, email: "a@b" }), /邮箱/);
  assert.match(rejects({ ...good, email: "a b@example.com" }), /邮箱/);
  assert.match(rejects({ ...good, email: "a@example.com " + "x".repeat(250) }), /邮箱/);
});

test("email rules: the sentinel counts as 'not set', real addresses do not", async () => {
  const { EMAIL_UNSET, isEmailSet, isValidEmail } = await import("../src/lib/registration");

  assert.equal(EMAIL_UNSET, "null");
  // What a pre-feature row, or an account created without an address, holds.
  assert.equal(isEmailSet(EMAIL_UNSET), false);
  assert.equal(isEmailSet("NULL"), false);
  assert.equal(isEmailSet(""), false);
  assert.equal(isEmailSet("   "), false);
  assert.equal(isEmailSet(null), false);
  assert.equal(isEmailSet(undefined), false);
  assert.equal(isEmailSet("teacher@example.com"), true);

  assert.equal(isValidEmail("teacher@example.com"), true);
  assert.equal(isValidEmail("first.last+tag@sub.example.co.uk"), true);
  assert.equal(isValidEmail("null"), false);
  assert.equal(isValidEmail("a@b"), false);
  assert.equal(isValidEmail("a@@b.com"), false);
  assert.equal(isValidEmail("a@.com"), false);
});

/** Database side of the flow: pending on insert, reviewable once, quota only on approval. */
test("a self-registered account starts pending and an admin review decides access and quota", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-register-test-"));
  process.env.PAPERFORGE_DB_PATH = path.join(dir, "test.db");
  process.env.SESSION_SECRET = "registration-test-secret";
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;

  const db = await import("../src/lib/db");
  const { hashPassword } = await import("../src/lib/auth");
  const { EMAIL_UNSET } = await import("../src/lib/registration");
  try {
    db.migrate();

    const applicant = db.createUser({
      username: "applicant",
      passwordHash: hashPassword("applicant password"),
      quota: 0,
      email: "applicant@example.com",
      application: { occupation: "中小学老师", region: "浙江" },
    });
    assert.equal(applicant.betaStatus, "pending");
    assert.equal(applicant.quota, 0);
    assert.equal(applicant.email, "applicant@example.com");
    assert.equal(applicant.occupation, "中小学老师");
    assert.equal(applicant.region, "浙江");
    assert.ok(applicant.betaAppliedAt);

    // Administrator-created accounts are approved from the start and never
    // show up in the review queue. With no address they carry the sentinel,
    // which is what makes the login flow ask for one.
    const invited = db.createUser({ username: "invited", passwordHash: hashPassword("invited password") });
    assert.equal(invited.betaStatus, "approved");
    assert.equal(invited.betaAppliedAt, null);
    assert.equal(invited.email, EMAIL_UNSET);

    // Filling it in later replaces the sentinel.
    assert.equal(db.setUserEmail(invited.id, "invited@example.com"), true);
    assert.equal(db.getUserById(invited.id)?.email, "invited@example.com");
    assert.equal(db.setUserEmail(9999, "nobody@example.com"), false);

    assert.deepEqual(db.listBetaApplications().map((u) => u.username), ["applicant"]);
    assert.equal(db.countPendingBetaApplications(), 1);

    // Rejecting keeps the account out and hands out nothing.
    const rejected = db.reviewBetaApplication(applicant.id, { status: "rejected", reviewerId: invited.id });
    assert.equal(rejected?.betaStatus, "rejected");
    assert.equal(rejected?.quota, 0);
    assert.equal(rejected?.betaReviewedBy, invited.id);
    assert.equal(db.countPendingBetaApplications(), 0);

    // Approving with a quota lets them in with credits to spend.
    const approved = db.reviewBetaApplication(applicant.id, {
      status: "approved",
      quota: 20,
      reviewerId: invited.id,
    });
    assert.equal(approved?.betaStatus, "approved");
    assert.equal(approved?.quota, 20);

    // Approving without a quota is allowed and leaves the balance at zero.
    const ungranted = db.reviewBetaApplication(applicant.id, {
      status: "approved",
      quota: 0,
      reviewerId: invited.id,
    });
    assert.equal(ungranted?.betaStatus, "approved");
    assert.equal(ungranted?.quota, 0);

    // Accounts that never applied cannot be reviewed through this path.
    assert.equal(db.reviewBetaApplication(invited.id, { status: "rejected", reviewerId: invited.id }), undefined);
    assert.equal(db.reviewBetaApplication(9999, { status: "rejected", reviewerId: invited.id }), undefined);
  } finally {
    db.rawDb().close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
