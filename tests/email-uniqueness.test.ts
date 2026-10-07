import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * One address belongs to one account, and the accounts that were already there
 * are not part of the bargain.
 *
 * There is no UNIQUE index behind the rule — a database that already holds two
 * accounts sharing an address cannot carry one, and creating it would mean
 * rewriting or disabling production rows. What is tested here is that the
 * write path enforces the rule on its own, that it is case- and
 * whitespace-insensitive, that the sentinel is never a value, and that a
 * database in the "already duplicated" state migrates and keeps working.
 */
test("an address is claimed once and existing rows are left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-email-unique-"));
  process.env.PAPERFORGE_DB_PATH = path.join(dir, "test.db");
  process.env.SESSION_SECRET = "email-uniqueness-test-secret";
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;

  const db = await import("../src/lib/db");
  const { hashPassword } = await import("../src/lib/auth");
  const { EMAIL_UNSET, EmailTakenError, normalizeEmailKey } =
    await import("../src/lib/registration");
  const register = await import("../src/app/api/auth/register/route");
  const apply = (body: unknown) =>
    new Request("http://localhost/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(body),
    });

  try {
    db.migrate();

    // The comparison key: trimmed, case-folded, and empty for "no address yet".
    assert.equal(normalizeEmailKey("  Teacher.Li@Example.com "), "teacher.li@example.com");
    assert.equal(normalizeEmailKey(EMAIL_UNSET), "");
    assert.equal(normalizeEmailKey("NULL"), "");
    assert.equal(normalizeEmailKey(""), "");
    assert.equal(normalizeEmailKey(null), "");

    // Accounts still waiting for an address do not collide with one another.
    const waiting = db.createUser({
      username: "waiting",
      passwordHash: hashPassword("waiting password"),
    });
    const alsoWaiting = db.createUser({
      username: "also_waiting",
      passwordHash: hashPassword("also waiting password"),
    });
    assert.equal(waiting.email, EMAIL_UNSET);
    assert.equal(alsoWaiting.email, EMAIL_UNSET);
    assert.equal(db.findUserByEmail(EMAIL_UNSET), undefined);
    assert.equal(db.findUserByEmail(""), undefined);

    // A real address is claimed once, however it is spelled.
    const owner = db.createUser({
      username: "owner",
      passwordHash: hashPassword("owner password"),
      email: "Teacher.Li@Example.com",
    });
    assert.equal(db.findUserByEmail("teacher.li@example.com")?.id, owner.id);
    assert.equal(db.findUserByEmail("  TEACHER.LI@EXAMPLE.COM  ")?.id, owner.id);
    assert.throws(
      () =>
        db.createUser({
          username: "copycat",
          passwordHash: hashPassword("copycat password"),
          email: "teacher.li@EXAMPLE.com",
        }),
      EmailTakenError,
    );
    assert.equal(db.getUserByUsername("copycat"), undefined);

    // The endpoint reports a conflict rather than a server error...
    const application = {
      password: "applicant password",
      email: "Teacher.Li@example.com",
      occupation: "中小学老师",
      region: "浙江",
    };
    const taken = await register.POST(apply({ ...application, username: "applicant_one" }));
    assert.equal(taken.status, 409);
    assert.match((await taken.json()).error, /邮箱/);
    assert.equal(db.getUserByUsername("applicant_one"), undefined);

    // ...and still accepts an address nobody holds.
    const accepted = await register.POST(
      apply({ ...application, username: "applicant_two", email: "applicant.two@example.com" }),
    );
    assert.equal(accepted.status, 201);
    assert.equal(db.getUserByUsername("applicant_two")?.betaStatus, "pending");

    // An account may re-save the address it already owns...
    assert.equal(db.setUserEmail(owner.id, "  teacher.li@example.com "), true);
    assert.equal(db.getUserById(owner.id)?.email, "teacher.li@example.com");
    // ...but never take somebody else's, and the row it tried to touch is intact.
    const other = db.createUser({
      username: "other",
      passwordHash: hashPassword("other password"),
      email: "other@example.com",
    });
    assert.throws(() => db.setUserEmail(other.id, "TEACHER.LI@example.com"), EmailTakenError);
    assert.equal(db.getUserById(other.id)?.email, "other@example.com");
    assert.equal(db.setUserEmail(9999, "nobody@example.com"), false);
    assert.equal(db.setUserEmail(other.id, EMAIL_UNSET), true);

    // A database that already carries the same address twice — the production
    // upgrade path. Such rows are written around the API on purpose, because
    // that is how they got there in the first place.
    const legacy = db.rawDb();
    const insert = legacy.prepare(
      `INSERT INTO users (username, password_hash, role, quota, used, disabled, created_at, email)
       VALUES (?, 'scrypt$legacy$fixture', 'user', 20, 0, 0, ?, ?)`,
    );
    insert.run("legacy_one", 1, "shared@example.com");
    insert.run("legacy_two", 2, "SHARED@example.com");
    const before = legacy
      .prepare("SELECT id, username, email, quota, used, disabled, beta_status FROM users WHERE username LIKE 'legacy_%' ORDER BY id")
      .all();

    // Migrating over the duplicates must not throw, must not rewrite them...
    assert.doesNotThrow(() => db.migrate());
    assert.deepEqual(
      legacy
        .prepare("SELECT id, username, email, quota, used, disabled, beta_status FROM users WHERE username LIKE 'legacy_%' ORDER BY id")
        .all(),
      before,
    );
    // ...and those accounts keep signing in as usual.
    assert.equal(db.getUserByUsername("legacy_one")?.disabled, false);
    assert.equal(db.getUserByUsername("legacy_two")?.betaStatus, "approved");

    // The address they share is still not available to a new account.
    assert.throws(
      () =>
        db.createUser({
          username: "third",
          passwordHash: hashPassword("third password"),
          email: "Shared@Example.com",
        }),
      EmailTakenError,
    );
    assert.equal(db.getUserByUsername("third"), undefined);
  } finally {
    db.rawDb().close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
