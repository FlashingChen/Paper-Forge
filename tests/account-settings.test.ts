import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { accountReturnTarget, loginReturnTarget } from "../src/lib/account-navigation";

test("account return destinations stay local and do not loop through onboarding", () => {
  for (const value of [null, "https://example.com", "//example.com", "/\\example.com", "/\n/example.com", "/account", "/account/email?next=/app", "/login"]) {
    assert.equal(accountReturnTarget(value), "/app");
  }
  assert.equal(accountReturnTarget("/job/example?view=preview"), "/job/example?view=preview");
  assert.equal(accountReturnTarget("/admin/usage"), "/admin/usage");
  assert.equal(loginReturnTarget("/account"), "/account");
  assert.equal(loginReturnTarget("//example.com"), "/app");
});

test("missing email blocks work until saved; identity is readable and password changes revoke login", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-account-test-"));
  process.env.PAPERFORGE_DB_PATH = path.join(dir, "test.db");
  process.env.SESSION_SECRET = "account-settings-test-secret";
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  Object.assign(globalThis, { AsyncLocalStorage });
  const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external");
  const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external");
  const { createRequestStoreForAPI } = await import("next/dist/server/async-storage/request-store");
  const { NextRequest } = await import("next/server");
  const db = await import("../src/lib/db");
  const auth = await import("../src/lib/auth");
  const login = await import("../src/app/api/auth/login/route");
  const me = await import("../src/app/api/auth/me/route");
  const email = await import("../src/app/api/auth/email/route");
  const password = await import("../src/app/api/auth/password/route");
  const { requireEmailSet } = await import("../src/lib/email-guard");
  let cookie = "";
  const run = <T>(action: (store: ReturnType<typeof createRequestStoreForAPI>) => T): T => {
    const url = new URL("http://localhost/api/auth/me");
    const store = createRequestStoreForAPI(new NextRequest(url, { headers: { cookie } }), url,
      { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined);
    const work = { route: url.pathname, isStaticGeneration: false } as Parameters<typeof workAsyncStorage.run>[0];
    return workAsyncStorage.run(work, () => workUnitAsyncStorage.run(store, () => action(store)));
  };
  const request = (url: string, body: unknown) => new Request(`http://localhost${url}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" }, body: JSON.stringify(body),
  });
  try {
    db.migrate();
    db.createUser({ username: "invited_teacher", passwordHash: auth.hashPassword("original password") });
    const response = await run(async store => {
      const result = await login.POST(request("/api/auth/login", { username: "invited_teacher", password: "original password" }));
      cookie = `pf_session=${store.mutableCookies.get("pf_session")!.value}`;
      return result;
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).needEmail, true);
    const identity = await (await run(() => me.GET())).json();
    assert.equal(identity.user.username, "invited_teacher");
    assert.equal(identity.user.role, "user");
    assert.equal(identity.user.email, null);
    assert.equal(identity.user.occupation, null);
    const gate = await run(() => requireEmailSet());
    assert.equal(gate.ok, false);
    if (!gate.ok) {
      assert.equal(gate.response.status, 409);
      assert.equal((await gate.response.json()).code, "email_required");
    }
    for (const input of [null, [], { email: "" }, { email: "invalid" }]) {
      assert.equal((await run(() => email.POST(request("/api/auth/email", input)))).status, 400);
    }
    assert.equal((await run(() => email.POST(request("/api/auth/email", { email: " teacher@example.com " })))).status, 200);
    assert.equal((await run(() => requireEmailSet())).ok, true);
    assert.equal((await (await run(() => me.GET())).json()).user.email, "teacher@example.com");
    assert.equal((await run(() => password.POST(request("/api/auth/password", {
      currentPassword: "incorrect", newPassword: "new password", confirmPassword: "new password",
    })))).status, 400);
    assert.equal((await run(() => password.POST(request("/api/auth/password", {
      currentPassword: "original password", newPassword: "new password", confirmPassword: "new password",
    })))).status, 200);
    assert.equal((await run(() => me.GET())).status, 401);
  } finally {
    db.rawDb().close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
