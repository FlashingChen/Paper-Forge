import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("legacy cookies survive migration, resets revoke cookies and concurrent login cannot renew a revoked session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-session-test-"));
  process.env.PAPERFORGE_DB_PATH = path.join(dir, "test.db");
  process.env.SESSION_SECRET = "session-regression-test-secret";
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  // Next installs this global at server boot; reproduce its request context here.
  Object.assign(globalThis, { AsyncLocalStorage });
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external");
  const { createRequestStoreForAPI } = await import("next/dist/server/async-storage/request-store");
  const { NextRequest } = await import("next/server");
  const db = await import("../src/lib/db");
  const auth = await import("../src/lib/auth");
  const run = <T>(cookie: string, action: (store: ReturnType<typeof createRequestStoreForAPI>) => T): T => {
    const url = new URL("http://localhost/api/auth/login");
    const store = createRequestStoreForAPI(new NextRequest(url, { headers: { cookie } }), url,
      { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined);
    // Only dynamic request fields are used by cookies(); no rendering takes place.
    const work = { route: url.pathname, isStaticGeneration: false } as Parameters<typeof workAsyncStorage.run>[0];
    return workAsyncStorage.run(work, () => workUnitAsyncStorage.run(store, () => action(store)));
  };
  try {
    db.migrate();
    const user = db.createUser({ username: "teacher", passwordHash: auth.hashPassword("old password") });
    const body = Buffer.from(JSON.stringify({ uid: user.id, username: user.username, role: user.role, iat: Date.now() })).toString("base64url");
    const legacy = `${body}.${createHmac("sha256", process.env.SESSION_SECRET).update(body).digest("base64url")}`;
    assert.equal((await run(`pf_session=${legacy}`, () => auth.currentUser()))?.id, user.id);
    let issued = "";
    await run("", async store => {
      await auth.startSession(user, db.getLoginCredentialsByUsername(user.username)!.sessionVersion);
      issued = store.mutableCookies.get("pf_session")!.value;
    });
    assert.equal(auth.verifySessionCookie(issued)?.version, 0);
    assert.equal((await run(`pf_session=${issued}`, () => auth.currentUser()))?.id, user.id);
    let raced = "";
    await run("", async store => {
      const credentials = db.getLoginCredentialsByUsername(user.username)!;
      // Another process may reset credentials even before startSession is called.
      db.setUserPassword(user.id, auth.hashPassword("first reset password"));
      const pending = auth.startSession(user, credentials.sessionVersion);
      db.setUserPassword(user.id, auth.hashPassword("reset password"));
      await pending;
      raced = store.mutableCookies.get("pf_session")!.value;
    });
    assert.equal(auth.verifySessionCookie(raced)?.version, 0);
    for (const value of [legacy, issued, raced]) {
      assert.equal(await run(`pf_session=${value}`, () => auth.currentUser()), null);
    }
    await run("", async store => {
      await auth.startSession(user, db.getLoginCredentialsByUsername(user.username)!.sessionVersion);
      issued = store.mutableCookies.get("pf_session")!.value;
    });
    assert.equal(auth.verifySessionCookie(issued)?.version, 2);
    assert.equal((await run(`pf_session=${issued}`, () => auth.currentUser()))?.id, user.id);
    db.updateUser(user.id, { disabled: true });
    assert.equal(await run(`pf_session=${issued}`, () => auth.currentUser()), null);
    db.deleteUser(user.id);
    assert.equal(await run(`pf_session=${issued}`, () => auth.currentUser()), null);
  } finally {
    db.rawDb().close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
