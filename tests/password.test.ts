import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("password changes verify ownership, preserve accounts and revoke prior sessions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-password-test-"));
  process.env.PAPERFORGE_DB_PATH = path.join(dir, "test.db");
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  const db = await import("../src/lib/db");
  const auth = await import("../src/lib/auth");
  const { changeOwnPassword } = await import("../src/lib/password");
  try {
    // Exercise migration of an existing database as well as repeated startup.
    db.rawDb().exec(`CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
      quota INTEGER NOT NULL DEFAULT 20, used INTEGER NOT NULL DEFAULT 0,
      disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER
    )`);
    db.migrate();
    db.migrate();
    const user = db.createUser({ username: "teacher", passwordHash: auth.hashPassword("old password"), quota: 31 });
    const other = db.createUser({ username: "other", passwordHash: auth.hashPassword("other password") });
    const oldHash = db.getPasswordHashByUsername(user.username)!;
    const valid = { currentPassword: "old password", newPassword: "new password", confirmPassword: "new password" };
    for (const input of [null, [], {}, { ...valid, currentPassword: "wrong" },
      { ...valid, newPassword: "short", confirmPassword: "short" },
      { ...valid, newPassword: "x".repeat(129), confirmPassword: "x".repeat(129) },
      { ...valid, confirmPassword: "different" },
      { ...valid, newPassword: "old password", confirmPassword: "old password" }]) {
      assert.equal(changeOwnPassword(user.id, input).ok, false);
      assert.equal(db.getPasswordHashByUsername(user.username), oldHash);
      assert.equal(db.getUserSessionVersion(user.id), 0);
    }
    assert.deepEqual(changeOwnPassword(user.id, { ...valid, userId: other.id }), { ok: true });
    const newHash = db.getPasswordHashByUsername(user.username)!;
    assert.equal(auth.verifyPassword("new password", newHash), true);
    assert.equal(auth.verifyPassword("old password", newHash), false);
    assert.equal(db.getUserSessionVersion(user.id), 1);
    assert.deepEqual(db.getUserById(user.id), user);
    assert.equal(auth.verifyPassword("other password", db.getPasswordHashByUsername(other.username)!), true);
    assert.equal(db.replaceUserPassword(user.id, oldHash, auth.hashPassword("stale password")), false);
    db.updateUser(user.id, { disabled: true });
    assert.equal(changeOwnPassword(user.id, { ...valid, currentPassword: "new password" }).ok, false);
    assert.equal(changeOwnPassword(9999, valid).ok, false);
    // Admin resets revoke sessions too.
    db.setUserPassword(other.id, auth.hashPassword("reset password"));
    assert.equal(db.getUserSessionVersion(other.id), 1);
  } finally {
    db.rawDb().close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
