
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  ProviderConfigError,
  preparePiAgentDir,
  resolveProviderConfig,
} from "../src/lib/pi-provider";


const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pf-provider-tests-"));
process.env.HOME = sandbox;


const fakePi = path.join(sandbox, "fake-pi");
fs.writeFileSync(
  fakePi,
  [
    "#!/bin/sh",
    'if [ "$1" = "--list-models" ] && [ "$2" = "deepseek" ]; then',
    "  printf 'provider  model           context  max-out  thinking  images\\n'",
    "  printf 'deepseek  deepseek-flash  1M       384K     yes       yes\\n'",
    "  exit 0",
    "fi",
    'printf \'No models available for "%s".\\n\' "$2" >&2',
    "exit 1",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
process.env.PAPERFORGE_PI_BIN = fakePi;

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeModelsJson(providers: Record<string, unknown>): void {
  const dir = path.join(sandbox, ".pi", "agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "models.json"),
    `${JSON.stringify({ providers }, null, 2)}\n`,
  );
}

const VISION_MODEL = {
  id: "vision-a",
  input: ["text", "image"],
  contextWindow: 1_000_000,
  maxTokens: 32_768,
  reasoning: true,
};

const TEXT_MODEL = { id: "text-b", input: ["text"], contextWindow: 128_000 };

function declaredProvider(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Custom Endpoint",
    baseUrl: "https://api.example.test/v1",
    api: "openai-completions",
    compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    apiKey: "test-key-literal-key-from-operator-file",
    models: [VISION_MODEL, TEXT_MODEL],
    ...overrides,
  };
}

function readGeneratedModels(dir: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(dir, ".pi-agent", "models.json"), "utf8"));
}

function newDir(): string {
  return fs.mkdtempSync(path.join(sandbox, "job-"));
}

/* ------------------------------------------------------------ model choice -- */

test("an explicitly configured model wins over the declared list", () => {
  writeModelsJson({ custom: declaredProvider() });
  const resolved = resolveProviderConfig({
    provider: "custom",
    baseUrl: "",
    model: "vision-a",
  });

  assert.equal(resolved.model, "vision-a");
  assert.equal(resolved.source, "settings");
});

test("with exactly one declared model and none configured, that model is used", () => {
  writeModelsJson({ custom: declaredProvider({ models: [VISION_MODEL] }) });

  const resolved = resolveProviderConfig({ provider: "custom", baseUrl: "", model: "" });

  assert.equal(resolved.model, "vision-a");
  assert.equal(resolved.source, "declared");
});

test("several declared models and no choice is refused, with the ids in the hint", () => {
  writeModelsJson({ custom: declaredProvider() });

  assert.throws(
    () => resolveProviderConfig({ provider: "custom", baseUrl: "", model: "" }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderConfigError);
      assert.match(error.message, /声明了 2 个模型/);
      assert.match(error.hint ?? "", /vision-a/);
      assert.match(error.hint ?? "", /text-b/);
      return true;
    },
  );
});

test("pi's own deepseek provider gets a real catalog default, not a guess", () => {
  writeModelsJson({});

  const resolved = resolveProviderConfig({ provider: "deepseek", baseUrl: "", model: "" });

  assert.equal(resolved.model, "deepseek-flash");
  assert.equal(resolved.source, "catalog-default");
});

test("an unknown provider with no model is refused instead of inheriting a model id", () => {
  writeModelsJson({});

  assert.throws(
    () => resolveProviderConfig({ provider: "someone-elses-proxy", baseUrl: "", model: "" }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderConfigError);
      assert.doesNotMatch(error.message, /deepseek-flash/);
      assert.match(error.hint ?? "", /MODEL/);
      return true;
    },
  );
});

test("an unknown provider with no base URL is refused", () => {
  writeModelsJson({});

  assert.throws(
    () => resolveProviderConfig({ provider: "someone-elses-proxy", baseUrl: "", model: "m" }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderConfigError);
      assert.match(error.message, /不知道要请求哪个地址/);
      return true;
    },
  );
});

test("a provider pi ships needs no base URL", () => {
  writeModelsJson({});

  const resolved = resolveProviderConfig({ provider: "deepseek", baseUrl: "", model: "x" });

  assert.equal(resolved.provider, "deepseek");
  assert.equal(resolved.baseUrl, "");
});

/* --------------------------------------------------------------- vision ---- */

test("a model declared text-only is refused before any run", () => {
  writeModelsJson({ custom: declaredProvider() });

  assert.throws(
    () => resolveProviderConfig({ provider: "custom", baseUrl: "", model: "text-b" }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderConfigError);
      assert.match(error.message, /不能读图/);
      assert.match(error.hint ?? "", /"text","image"/);
      return true;
    },
  );
});

test("a declared model that says nothing about input is refused too", () => {
  writeModelsJson({ custom: declaredProvider({ models: [{ id: "silent" }] }) });

  assert.throws(
    () => resolveProviderConfig({ provider: "custom", baseUrl: "", model: "silent" }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderConfigError);
      assert.match(error.message, /没有声明 input/);
      return true;
    },
  );
});

test("a vision model passes and reports what was declared", () => {
  writeModelsJson({ custom: declaredProvider() });

  const resolved = resolveProviderConfig({ provider: "custom", baseUrl: "", model: "vision-a" });

  assert.equal(resolved.declaredModel?.contextWindow, 1_000_000);
  assert.equal(resolved.declaredModel?.maxTokens, 32_768);
  assert.equal(resolved.declaredModel?.reasoning, true);
  assert.equal(resolved.assumedCapabilities, false);
});

/* --------------------------------------------- what pi is actually told ---- */

test("a declared provider is copied verbatim, keeping compat and capabilities", () => {
  writeModelsJson({ custom: declaredProvider() });
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "custom",
    baseUrl: "",
    model: "vision-a",
    apiKey: "test-key-admin-key",
  });

  const prepared = preparePiAgentDir(dir, resolved);
  assert.ok(prepared);
  assert.equal(prepared.invented, false);
  assert.deepEqual(prepared.warnings, []);

  const entry = readGeneratedModels(dir).providers.custom;
  assert.deepEqual(entry.compat, {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
  });
  assert.equal(entry.baseUrl, "https://api.example.test/v1");
  assert.equal(entry.api, "openai-completions");

  const model = entry.models.find((m: any) => m.id === "vision-a");
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 32_768);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.inputLimits.images.resize.maxWidth, 1568);
  assert.equal(entry.apiKey, "$PAPERFORGE_PI_API_KEY");
  assert.doesNotMatch(JSON.stringify(entry), /test-key-admin-key/);
  assert.doesNotMatch(JSON.stringify(entry), /test-key-literal-key-from-operator-file/);
});

test("with no admin key, the operator's own key is not written to disk either", () => {
  writeModelsJson({ custom: declaredProvider() });
  const dir = newDir();
  const resolved = resolveProviderConfig({ provider: "custom", baseUrl: "", model: "vision-a" });

  preparePiAgentDir(dir, resolved);

  const text = fs.readFileSync(path.join(dir, ".pi-agent", "models.json"), "utf8");
  assert.doesNotMatch(text, /test-key-literal-key-from-operator-file/);
  assert.equal(readGeneratedModels(dir).providers.custom.apiKey, undefined);
});

test("pointing at an undeclared model keeps the provider facts and warns", () => {
  writeModelsJson({ custom: declaredProvider() });
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "custom",
    baseUrl: "",
    model: "brand-new-model",
  });

  const prepared = preparePiAgentDir(dir, resolved);
  assert.ok(prepared);
  assert.equal(prepared.invented, true);
  assert.equal(prepared.warnings.length, 1);
  assert.match(prepared.warnings[0], /没有声明模型「brand-new-model」/);

  const entry = readGeneratedModels(dir).providers.custom;
  assert.deepEqual(entry.compat, {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
  });
  const added = entry.models.find((m: any) => m.id === "brand-new-model");
  assert.deepEqual(added.input, ["text", "image"]);
  assert.equal(added.inputLimits.images.resize.maxWidth, 1568);
});

test("an undeclared provider gets a synthetic definition and says so", () => {
  writeModelsJson({});
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "nobody-knows-this",
    baseUrl: "https://api.example.test/v1",
    model: "m1",
    apiKey: "test-key-admin-key",
  });

  const prepared = preparePiAgentDir(dir, resolved);
  assert.ok(prepared);
  assert.equal(prepared.invented, true);
  assert.match(prepared.warnings.join(" "), /以下能力是猜的/);

  const entry = readGeneratedModels(dir).providers["nobody-knows-this"];
  assert.equal(entry.baseUrl, "https://api.example.test/v1");
  assert.equal(entry.api, "openai-completions");
  assert.equal(entry.apiKey, "$PAPERFORGE_PI_API_KEY");
  assert.deepEqual(entry.models[0].input, ["text", "image"]);
});

test("the admin's base URL overrides the declared one, and the declaration survives", () => {
  writeModelsJson({ custom: declaredProvider() });
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "custom",
    baseUrl: "https://override.example.test/v1",
    model: "vision-a",
  });

  preparePiAgentDir(dir, resolved);

  const entry = readGeneratedModels(dir).providers.custom;
  assert.equal(entry.baseUrl, "https://override.example.test/v1");
  assert.deepEqual(entry.compat, {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
  });
});

test("an explicit base URL survives even for a provider pi ships", () => {
  writeModelsJson({});
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "deepseek",
    baseUrl: "https://proxy.example.test/v1",
    model: "openclaw-model",
    apiKey: "test-key-admin-key",
  });

  const prepared = preparePiAgentDir(dir, resolved);
  assert.ok(prepared);

  const entry = readGeneratedModels(dir).providers.deepseek;
  assert.equal(entry.baseUrl, "https://proxy.example.test/v1");
  assert.equal(entry.modelOverrides["openclaw-model"].inputLimits.images.resize.maxWidth, 1568);
});

test("no configured base URL means pi's own endpoint, not an invented one", () => {
  writeModelsJson({});
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "deepseek",
    baseUrl: "",
    model: "",
    apiKey: "test-key-admin-key",
  });

  preparePiAgentDir(dir, resolved);

  const entry = readGeneratedModels(dir).providers.deepseek;
  assert.equal(entry.baseUrl, undefined);
});

test("a host auth.json is carried only when PaperForge has no key of its own", () => {
  writeModelsJson({ custom: declaredProvider() });
  const authPath = path.join(sandbox, ".pi", "agent", "auth.json");
  fs.writeFileSync(authPath, JSON.stringify({ custom: { key: "test-key-someone-elses-account" } }));

  try {
    const withKey = newDir();
    preparePiAgentDir(
      withKey,
      resolveProviderConfig({
        provider: "custom",
        baseUrl: "",
        model: "vision-a",
        apiKey: "test-key-admin-key",
      }),
    );
    assert.equal(
      fs.existsSync(path.join(withKey, ".pi-agent", "auth.json")),
      false,
      "auth.json must not shadow an explicitly configured key",
    );

    const withoutKey = newDir();
    preparePiAgentDir(
      withoutKey,
      resolveProviderConfig({ provider: "custom", baseUrl: "", model: "vision-a" }),
    );
    assert.equal(
      fs.existsSync(path.join(withoutKey, ".pi-agent", "auth.json")),
      true,
      "local development still needs the host credential when nothing is configured",
    );
  } finally {
    fs.rmSync(authPath, { force: true });
  }
});

test("a provider pi ships is left to pi, with only the image cap added", () => {
  writeModelsJson({});
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "deepseek",
    baseUrl: "",
    model: "",
    apiKey: "test-key-admin-key",
  });

  const prepared = preparePiAgentDir(dir, resolved);
  assert.ok(prepared);
  assert.equal(prepared.invented, false);
  assert.deepEqual(prepared.warnings, []);

  const entry = readGeneratedModels(dir).providers.deepseek;
  assert.equal(entry.models, undefined);
  assert.equal(entry.baseUrl, undefined);
  assert.equal(entry.apiKey, "$PAPERFORGE_PI_API_KEY");
  assert.equal(entry.modelOverrides["deepseek-flash"].inputLimits.images.resize.maxWidth, 1568);
});

/* ------------------------------------------------ console capability overrides -- */

test("an undeclared model assumes vision but names what it guessed", () => {
  writeModelsJson({});
  const resolved = resolveProviderConfig({
    provider: "flc",
    baseUrl: "https://api.example.test/v1",
    model: "openclaw-model",
  });

  assert.deepEqual(resolved.effective.input, ["text", "image"]);
  assert.equal(resolved.assumedCapabilities, true);
  assert.deepEqual(resolved.assumedFields, [
    "能读图",
    "是否会思考 reasoning",
    "输出上限 maxTokens",
  ]);
});

test("console capabilities replace the guess and reach the generated config", () => {
  writeModelsJson({});
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "flc",
    baseUrl: "https://api.example.test/v1",
    model: "openclaw-model",
    apiKey: "test-key-admin-key",
    capabilities: { vision: true, reasoning: true, maxTokens: 32768, contextWindow: 1_000_000 },
  });

  assert.equal(resolved.assumedCapabilities, false);

  const prepared = preparePiAgentDir(dir, resolved);
  assert.ok(prepared);
  assert.equal(prepared.invented, false);
  assert.deepEqual(prepared.warnings, []);

  const model = readGeneratedModels(dir).providers.flc.models[0];
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.reasoning, true);
  assert.equal(model.maxTokens, 32768);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.inputLimits.images.resize.maxWidth, 1568);
});

test("console capabilities override a models.json declaration", () => {
  writeModelsJson({ custom: declaredProvider() });
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "custom",
    baseUrl: "",
    model: "vision-a",
    capabilities: { maxTokens: 8192, reasoning: false },
  });

  preparePiAgentDir(dir, resolved);

  const model = readGeneratedModels(dir).providers.custom.models.find(
    (m: any) => m.id === "vision-a",
  );
  assert.equal(model.maxTokens, 8192);
  assert.equal(model.reasoning, false);
  assert.equal(model.contextWindow, 1_000_000);
  assert.deepEqual(model.input, ["text", "image"]);
});

test("saying a model cannot see images is refused, not silently ignored", () => {
  writeModelsJson({});
  assert.throws(
    () =>
      resolveProviderConfig({
        provider: "flc",
        baseUrl: "https://api.example.test/v1",
        model: "text-only",
        capabilities: { vision: false },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderConfigError);
      assert.match(error.message, /不能读图/);
      return true;
    },
  );
});

test("a console compat block is written for an undeclared provider", () => {
  writeModelsJson({});
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "flc",
    baseUrl: "https://api.example.test/v1",
    model: "m",
    capabilities: {
      vision: true,
      reasoning: true,
      maxTokens: 16384,
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    },
  });

  preparePiAgentDir(dir, resolved);

  const entry = readGeneratedModels(dir).providers.flc;
  assert.deepEqual(entry.compat, {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
  });
});

/* ------------------------------------------- what the console's "自动" means -- */

test("a capability left on 自动 (null) does not erase the models.json declaration", () => {
  writeModelsJson({ custom: declaredProvider({ models: [VISION_MODEL] }) });

  // The admin form sends an explicit null for every field left on 自动.
  const resolved = resolveProviderConfig({
    provider: "custom",
    baseUrl: "",
    model: "vision-a",
    capabilities: { vision: null, reasoning: null, contextWindow: null, maxTokens: null, compat: null },
  });

  assert.deepEqual(resolved.effective.input, ["text", "image"]);
  assert.equal(resolved.effective.reasoning, true);
  assert.equal(resolved.effective.contextWindow, 1_000_000);
  assert.equal(resolved.effective.maxTokens, 32_768);
  assert.equal(resolved.assumedCapabilities, false);
});

test("a null capability never reaches the generated models.json", () => {
  // pi refuses to load a provider whose model entry carries a null, and reports
  // it as `Unknown provider "<name>"` — so 自动 must fall back to the
  // declaration rather than write a null into the file.
  writeModelsJson({ custom: declaredProvider({ models: [VISION_MODEL] }) });
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "custom",
    baseUrl: "",
    model: "vision-a",
    capabilities: { vision: true, reasoning: null, contextWindow: null, maxTokens: null },
  });

  const prepared = preparePiAgentDir(dir, resolved);
  assert.ok(prepared);

  const entry = readGeneratedModels(dir).providers.custom;
  const model = entry.models.find((m: any) => m.id === "vision-a");
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.reasoning, true);
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 32_768);
  assert.doesNotMatch(JSON.stringify(entry), /null/);
});

test("a null capability for an undeclared provider is omitted, not written", () => {
  // No models.json declaration to fall back to: the field must simply not be
  // written, never written as null.
  writeModelsJson({});
  const dir = newDir();
  const resolved = resolveProviderConfig({
    provider: "flc",
    baseUrl: "https://api.example.test/v1",
    model: "m",
    capabilities: { vision: true, reasoning: null, contextWindow: null, maxTokens: null },
  });

  const prepared = preparePiAgentDir(dir, resolved);
  assert.ok(prepared);

  const entry = readGeneratedModels(dir).providers.flc;
  const model = entry.models.find((m: any) => m.id === "m");
  assert.equal(model.reasoning, undefined);
  assert.equal(model.contextWindow, undefined);
  assert.equal(model.maxTokens, undefined);
  assert.doesNotMatch(JSON.stringify(entry), /null/);
});

test("a provider declared in another case is still found", () => {
  // pi matches provider names case-insensitively; the console must not lose the
  // declaration just because it was typed as the provider's display name.
  writeModelsJson({ commandcode: declaredProvider({ models: [VISION_MODEL] }) });

  const resolved = resolveProviderConfig({
    provider: "CommandCode",
    baseUrl: "",
    model: "vision-a",
  });

  assert.equal(resolved.declaredModel?.reasoning, true);
  assert.equal(resolved.assumedCapabilities, false);
});
