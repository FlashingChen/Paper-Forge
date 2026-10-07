import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  DEEPSEEK_CATALOG_MODEL,
  authJsonPath,
  piAgentDir,
  readModelsJsonProvider,
  resolvePiBin,
} from "./config";
import type { ModelsJsonModel, ModelsJsonProvider } from "./config";
import type { ModelCapabilities } from "./auth";


export const PI_API_KEY_ENV = "PAPERFORGE_PI_API_KEY";


export type ModelSource = "settings" | "declared" | "catalog-default";


export interface ResolvedProviderConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;

  source: ModelSource;

  declared?: ModelsJsonProvider;

  declaredModel?: ModelsJsonModel;

  assumedCapabilities: boolean;

  effective: MergedCapabilities;

  assumedFields: string[];
}


export interface MergedCapabilities {
  input?: string[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;

  complete: boolean;
}


export class ProviderConfigError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ProviderConfigError";
    this.hint = hint;
  }


  toString(): string {
    return this.hint ? `${this.message} ${this.hint}` : this.message;
  }
}


const CATALOG_DEFAULT_MODELS: Record<string, string> = {
  deepseek: DEEPSEEK_CATALOG_MODEL,
};

export interface ProviderSettingsInput {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;

  capabilities?: ModelCapabilities;
}


export function resolveProviderConfig(
  settings: ProviderSettingsInput,
): ResolvedProviderConfig {
  const provider = (settings.provider ?? "").trim() || "deepseek";
  const declared = readModelsJsonProvider(provider);
  const baseUrl = (settings.baseUrl ?? "").trim() || declared?.baseUrl?.trim() || "";

  const explicitModel = (settings.model ?? "").trim();
  const declaredModels = declared?.models ?? [];

  let model = explicitModel;
  let source: ModelSource = "settings";

  if (!model && declaredModels.length === 1) {
    model = declaredModels[0].id;
    source = "declared";
  }

  if (!model && declaredModels.length > 1) {
    const ids = declaredModels.map((entry) => entry.id).join(" 或 ");
    throw new ProviderConfigError(
      `provider「${provider}」在 models.json 里声明了 ${declaredModels.length} 个模型，` +
        `但后台没有指定用哪一个，PaperForge 不会替你猜。`,
      `请在后台「模型配置」的 MODEL 里填：${ids}`,
    );
  }

  if (!model) {
    const catalogDefault = CATALOG_DEFAULT_MODELS[provider];
    if (catalogDefault) {
      model = catalogDefault;
      source = "catalog-default";
    }
  }

  if (!model) {
    throw new ProviderConfigError(
      `没有可用的模型名：provider「${provider}」既没有在后台配置 MODEL，` +
        `也没有在 ~/.pi/agent/models.json 里为它声明 models。`,
      `请在后台「模型配置」里填 MODEL（可先用 pi --list-models ${provider} 看有哪些），` +
        `或在 models.json 里给这个 provider 加上 models 列表。`,
    );
  }

  const declaredModel = declaredModels.find((entry) => entry.id === model);
  const overrides = settings.capabilities ?? {};

  // "自动" in the console arrives here as null. It means "not stated", exactly
  // like an omitted field, and must be treated that way twice over: it must not
  // erase a models.json declaration, and it must never reach the generated
  // models.json — pi refuses to load a provider whose model entry carries a
  // null, and reports it as `Unknown provider "<name>"`.
  const stated = <T>(value: T | null | undefined): T | undefined =>
    value === null ? undefined : value;

  const vision = stated(overrides.vision);
  const reasoning = stated(overrides.reasoning);
  const contextWindow = stated(overrides.contextWindow);
  const maxTokens = stated(overrides.maxTokens);
  const compat = stated(overrides.compat);

  const merged: MergedCapabilities = {
    input:
      vision === undefined ? declaredModel?.input : vision ? ["text", "image"] : ["text"],
    reasoning: reasoning === undefined ? declaredModel?.reasoning : reasoning,
    contextWindow:
      contextWindow === undefined ? declaredModel?.contextWindow : contextWindow,
    maxTokens: maxTokens === undefined ? declaredModel?.maxTokens : maxTokens,
    compat: compat === undefined ? declared?.compat : compat,
    complete: false,
  };

  let modalities = merged.input;
  const visionStated = modalities !== undefined;

  if (modalities === undefined) {
    if (declaredModel) {
      throw new ProviderConfigError(
        `模型「${model}」在 models.json 里没有声明 input，pi 会当成只能读文字，` +
          `试卷照片不会被送进去。`,
        `请在后台「高级：模型能力」里把「能读图」设为「能」，或把该模型的 input 改成 ["text", "image"]。`,
      );
    }
    modalities = ["text", "image"];
    merged.input = modalities;
  }

  if (!modalities.includes("image")) {
    throw new ProviderConfigError(
      `模型「${model}」被声明为纯文本（input: [${modalities
        .map((value) => `"${value}"`)
        .join(", ")}]），不能读图；PaperForge 靠看图识别试卷，必须用支持图片的模型。`,
      `如果它其实能读图，请在后台把「能读图」改成「能」（或把 models.json 里的 input 改成 ["text","image"]）；否则换一个视觉模型。`,
    );
  }

  if (!baseUrl && !declared && !piKnowsProvider(provider)) {
    throw new ProviderConfigError(
      `provider「${provider}」不是 pi 自带的，也没有在 models.json 里声明，` +
        `PaperForge 不知道要请求哪个地址。`,
      `请在后台「模型配置」里填 BASE URL，或在 models.json 里声明这个 provider 的 baseUrl。`,
    );
  }
  const assumedFields: string[] = [];
  if (!visionStated) assumedFields.push("能读图");
  if (merged.reasoning === undefined) assumedFields.push("是否会思考 reasoning");
  if (merged.maxTokens === undefined) assumedFields.push("输出上限 maxTokens");

  merged.complete = assumedFields.length === 0;

  return {
    provider,
    baseUrl,
    model,
    apiKey: settings.apiKey?.trim() || undefined,
    source,
    declared,
    declaredModel,
    assumedCapabilities: !merged.complete,
    effective: merged,
    assumedFields,
  };
}

/* ------------------------------------------------ image encoding limits --- */


export interface ImageResizeLimits {
  maxWidth: number;
  maxHeight: number;

  maxBytes: number;
  jpegQuality: number;
}

const DEFAULT_IMAGE_MAX_EDGE = 1568;
const DEFAULT_IMAGE_MAX_BYTES = 262_144; // 256 KiB of base64
const DEFAULT_IMAGE_JPEG_QUALITY = 75;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}


export function imageResizeLimits(): ImageResizeLimits {
  const edge = positiveInt(process.env.PAPERFORGE_IMAGE_MAX_EDGE, DEFAULT_IMAGE_MAX_EDGE);
  return {
    maxWidth: edge,
    maxHeight: edge,
    maxBytes: positiveInt(process.env.PAPERFORGE_IMAGE_MAX_BYTES, DEFAULT_IMAGE_MAX_BYTES),
    jpegQuality: positiveInt(
      process.env.PAPERFORGE_IMAGE_JPEG_QUALITY,
      DEFAULT_IMAGE_JPEG_QUALITY,
    ),
  };
}


const knownProviders = new Map<string, boolean>();


function apiKeyEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function piKnowsProvider(provider: string): boolean {
  const cached = knownProviders.get(provider);
  if (cached !== undefined) return cached;

  let known = false;
  let cleanDir: string | undefined;
  try {
    cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-probe-"));
    const out = execFileSync(resolvePiBin(), ["--list-models", provider], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        PI_OFFLINE: "1",
        PI_CODING_AGENT_DIR: cleanDir,
        [apiKeyEnvVar(provider)]: "probe",
      },
    });
    const names = out
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
    known = names.includes(provider);
  } catch {
    known = false;
  } finally {
    if (cleanDir) {
      try {
        fs.rmSync(cleanDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  knownProviders.set(provider, known);
  return known;
}


const RUN_AGENT_DIR = ".pi-agent";


const OPENAI_COMPATIBLE_API = "openai-completions";


export interface PreparedPiAgentDir {

  dir: string;

  warnings: string[];

  invented: boolean;
}


function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}


function modelEntryFrom(
  model: string,
  effective: MergedCapabilities,
  declaredModel: ModelsJsonModel | undefined,
  resize: ImageResizeLimits,
): ModelsJsonModel {
  const entry: ModelsJsonModel = {
    ...(declaredModel ?? {}),
    id: model,
  };
  // Only real values are written. A null reaching this file makes pi drop the
  // entire provider, which surfaces as a baffling `Unknown provider "<name>"`.
  if (effective.input) entry.input = effective.input;
  if (effective.contextWindow != null) entry.contextWindow = effective.contextWindow;
  if (effective.maxTokens != null) entry.maxTokens = effective.maxTokens;
  if (effective.reasoning != null) entry.reasoning = effective.reasoning;
  return withImageLimit(entry, resize);
}


function withImageLimit(model: ModelsJsonModel, resize: ImageResizeLimits): ModelsJsonModel {
  const existing = (model.inputLimits ?? {}) as Record<string, unknown>;
  const images = (existing["images"] ?? {}) as Record<string, unknown>;
  return {
    ...model,
    inputLimits: { ...existing, images: { ...images, resize } },
  };
}


export function preparePiAgentDir(
  jobDir: string,
  config: ResolvedProviderConfig,
): PreparedPiAgentDir | undefined {
  const provider = config.provider.trim();
  const baseUrl = config.baseUrl.trim();
  const model = config.model.trim();
  if (!provider || !model) return undefined;

  const resize = imageResizeLimits();
  const warnings: string[] = [];
  const declared = config.declared;
  const hasApiKey = Boolean(config.apiKey);
  const catalog = declared ? false : piKnowsProvider(provider);
  if (!declared && !catalog && !baseUrl) return undefined;

  let providerEntry: Record<string, unknown>;
  let invented = false;

  if (declared) {
    providerEntry = clone(declared) as Record<string, unknown>;
    delete providerEntry["apiKey"];
    if (hasApiKey) providerEntry["apiKey"] = `$${PI_API_KEY_ENV}`;
    providerEntry["baseUrl"] = baseUrl || declared.baseUrl;
    providerEntry["api"] = declared.api ?? OPENAI_COMPATIBLE_API;

    const models: ModelsJsonModel[] = (declared.models ?? []).map((entry) => clone(entry));
    const target = models.find((entry) => entry.id === model);
    const mergedEntry = modelEntryFrom(model, config.effective, target, resize);

    if (target) {
      providerEntry["models"] = models.map((entry) =>
        entry.id === model ? mergedEntry : entry,
      );
    } else {
      models.push(mergedEntry);
      providerEntry["models"] = models;
      if (!config.effective.complete) {
        invented = true;
        warnings.push(
          `models.json 里的 provider「${provider}」没有声明模型「${model}」，` +
            `以下能力是猜的：${config.assumedFields.join("、")}（pi 会按 128K 上下文 / ` +
            `16.4K 输出 / 无思考发请求）。建议在后台「高级：模型能力」里填上，` +
            `或在 models.json 里补 contextWindow / maxTokens / reasoning / input。`,
        );
      }
    }
  } else if (catalog) {
    providerEntry = {
      modelOverrides: {
        [model]: { inputLimits: { images: { resize } } },
      },
    };
    if (hasApiKey) providerEntry["apiKey"] = `$${PI_API_KEY_ENV}`;
    if (baseUrl) {
      providerEntry["baseUrl"] = baseUrl;
    }
  } else {
    providerEntry = {
      baseUrl,
      api: OPENAI_COMPATIBLE_API,
      models: [modelEntryFrom(model, config.effective, undefined, resize)],
    };
    if (config.effective.compat) providerEntry["compat"] = config.effective.compat;
    if (hasApiKey) providerEntry["apiKey"] = `$${PI_API_KEY_ENV}`;
    if (!config.effective.complete) {
      invented = true;
      warnings.push(
        `provider「${provider}」既不是 pi 自带的，也没有在 models.json 里声明，` +
          `PaperForge 按 OpenAI 兼容端点生成了一份定义；以下能力是猜的：` +
          `${config.assumedFields.join("、")}。` +
          `推理模型在被猜成「不会思考、输出上限 16.4K」时，可能把整个输出预算花在思考上、` +
          `一轮回答没有任何内容，任务就停在半路。建议到后台「高级：模型能力」把它们填上。`,
      );
    }
  }

  const dir = path.join(jobDir, RUN_AGENT_DIR);
  try {
    fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(
      path.join(dir, "models.json"),
      `${JSON.stringify({ providers: { [provider]: providerEntry } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const source = authJsonPath();
    if (!hasApiKey && fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(dir, "auth.json"));
    }

    return { dir, warnings, invented };
  } catch {
    return undefined;
  }
}


export function discardPiAgentDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------ endpoint self-test --- */


export interface PiModelInfo {
  contextWindow: string;
  maxOut: string;
  thinking: string;
  images: string;
}


export function describeModel(
  agentDir: string,
  provider: string,
  model: string,
  apiKey?: string,
): PiModelInfo | null {
  try {
    const out = execFileSync(resolvePiBin(), ["--list-models", provider], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        ...(apiKey ? { [PI_API_KEY_ENV]: apiKey } : {}),
      },
    });
    for (const line of out.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 6) continue;
      if (columns[0] !== provider || columns[1] !== model) continue;
      return {
        contextWindow: columns[2],
        maxOut: columns[3],
        thinking: columns[4],
        images: columns[5],
      };
    }
    return null;
  } catch {
    return null;
  }
}

export interface EndpointProbeResult {
  ok: boolean;

  piModel: PiModelInfo | null;

  output: string;

  error?: string;

  timedOut?: boolean;
  elapsedMs: number;
}


const PROBE_PROMPT = "回复两个字：收到";


const PROBE_TIMEOUT_MS = 45_000;


const MAX_PROBE_OUTPUT = 64 * 1024;


export function probeEndpoint(config: ResolvedProviderConfig): Promise<EndpointProbeResult> {
  const startedAt = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pf-pi-probe-"));
  const redact = (text: string) =>
    config.apiKey ? text.split(config.apiKey).join("***") : text;

  return new Promise((resolve) => {
    let done = false;
    let piModel: PiModelInfo | null = null;
    const finish = (result: {
      ok: boolean;
      output: string;
      error?: string;
      timedOut?: boolean;
    }) => {
      if (done) return;
      done = true;
      discardPiAgentDir(dir);
      resolve({ ...result, piModel, elapsedMs: Date.now() - startedAt });
    };

    const prepared = preparePiAgentDir(dir, config);
    if (prepared) {
      piModel = describeModel(prepared.dir, config.provider, config.model, config.apiKey);
    }
    if (!prepared) {
      finish({
        ok: false,
        output: "",
        error: "无法写入 pi 配置：provider / model / base URL 不完整。",
      });
      return;
    }

    const child = spawn(
      resolvePiBin(),
      [
        "--mode",
        "text",
        "--no-session",
        "--provider",
        config.provider,
        "--model",
        config.model,
        PROBE_PROMPT,
      ],
      {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: prepared.dir,
          ...(config.apiKey ? { [PI_API_KEY_ENV]: config.apiKey } : {}),
        },
      },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const collect = (chunk: Buffer, into: "out" | "err") => {
      const text = chunk.toString("utf8");
      if (into === "out") {
        stdout = (stdout + text).slice(-MAX_PROBE_OUTPUT);
      } else {
        stderr = (stderr + text).slice(-MAX_PROBE_OUTPUT);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "out"));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "err"));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);

    child.on("error", (error: Error) => {
      clearTimeout(timer);
      finish({ ok: false, output: "", error: redact(error.message) });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const out = stdout.trim();
      const err = stderr.trim();
      const detail = redact([out, err].filter(Boolean).join("\n")).slice(0, 4000);

      if (timedOut) {
        finish({
          ok: false,
          output: out,
          timedOut: true,
          error:
            detail ||
            `等了 ${Math.round(PROBE_TIMEOUT_MS / 1000)} 秒没有任何响应。` +
              `密钥可能是对的但该模型的通道不通，或者这个端点卡住了。`,
        });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, output: out, error: detail || `pi 退出码 ${code}` });
        return;
      }
      if (!out) {
        finish({ ok: false, output: "", error: detail || "模型没有返回任何内容。" });
        return;
      }
      finish({ ok: true, output: redact(out).slice(0, 2000) });
    });
  });
}


export function piAgentDirForLogging(): string {
  return piAgentDir();
}
