import assert from "node:assert/strict";
import { test } from "node:test";
import { isSameOriginRequest } from "../src/lib/request-origin";

test("password request origin uses the public host behind TLS termination", () => {
  const request = (headers: Record<string, string>) => new Request("http://localhost:3000/api/auth/password", { headers });
  assert.equal(isSameOriginRequest(request({ origin: "http://localhost:3000" })), true);
  assert.equal(isSameOriginRequest(request({ origin: "https://paperforge.example", host: "paperforge.example" })), true);
  assert.equal(isSameOriginRequest(request({ origin: "https://paperforge.example", host: "internal:3000", "x-forwarded-host": "paperforge.example" })), true);
  assert.equal(isSameOriginRequest(request({ origin: "https://evil.example", host: "paperforge.example" })), false);
  assert.equal(isSameOriginRequest(request({ origin: "https://paperforge.example:444", host: "paperforge.example" })), false);
  for (const origin of ["null", "invalid", "https://paperforge.example/path", "ftp://paperforge.example"]) {
    assert.equal(isSameOriginRequest(request({ origin, host: "paperforge.example" })), false);
  }
  assert.equal(isSameOriginRequest(request({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(isSameOriginRequest(request({})), true);
});
