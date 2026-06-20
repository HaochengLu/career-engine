import path from "node:path";
import { fileURLToPath } from "node:url";
import weights from "./data/scoring_weights.json" with { type: "json" };

function currentRoot(): string {
  try {
    return typeof import.meta.url === "string" ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") : ".";
  } catch {
    return ".";
  }
}

export const ROOT = currentRoot();

type EnvMap = Record<string, string | undefined>;

function nodeEnv(): EnvMap {
  return (globalThis as unknown as { process?: { env?: EnvMap } }).process?.env ?? {};
}

let runtimeEnv: EnvMap = { ...nodeEnv() };

export function setRuntimeEnv(env: Record<string, unknown>): void {
  const next: EnvMap = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") next[key] = value;
  }
  runtimeEnv = { ...nodeEnv(), ...runtimeEnv, ...next };
}

function env(name: string): string | undefined {
  return runtimeEnv[name] ?? nodeEnv()[name];
}

function openAiBaseUrl(raw: string | undefined): string {
  const base = (raw ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function modelFor(envName: string, fallback: string): string {
  return env(envName) || fallback;
}

function listFromEnv(name: string): string[] {
  return (env(name) ?? "")
    .split(/[\n,，]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  get provider() {
    return (env("LLM_PROVIDER") ?? "mock") as "mock" | "anthropic" | "openai";
  },
  get anthropicApiKey() {
    return env("ANTHROPIC_API_KEY") ?? "";
  },
  get defaultModel() {
    return env("DEFAULT_MODEL") ?? "gpt-5.4";
  },
  // OpenAI 兼容端点（可指向任意 OpenAI 协议代理，如 newapi/oneapi）
  openai: {
    get apiKey() {
      return env("OPENAI_API_KEY") ?? "";
    },
    get apiKeys() {
      return listFromEnv("OPENAI_API_KEYS");
    },
    get baseURL() {
      return openAiBaseUrl(env("OPENAI_BASE_URL"));
    },
    get model() {
      return env("OPENAI_MODEL") ?? "gpt-5.4-mini";
    },
    get perKeyConcurrency() {
      return Number(env("OPENAI_PER_KEY_CONCURRENCY") ?? 8);
    },
  },
  quota: {
    get dailyLimit() {
      return Number(env("QUOTA_DAILY_LIMIT") ?? env("QUOTA_FULL_DAILY_LIMIT") ?? 100);
    },
    get fullDailyLimit() {
      return Number(env("QUOTA_DAILY_LIMIT") ?? env("QUOTA_FULL_DAILY_LIMIT") ?? 100);
    },
    get timeZone() {
      return env("QUOTA_TIME_ZONE") ?? "Asia/Shanghai";
    },
    get redisRestUrl() {
      return env("QUOTA_REDIS_REST_URL") ?? "";
    },
    get redisRestToken() {
      return env("QUOTA_REDIS_REST_TOKEN") ?? "";
    },
  },
  // 联网检索（默认关）：开启后用一次检索为“市场拉动/新兴岗位”召回注入实时市场信号；失败自动降级为无检索。
  get enableWebSearch() {
    return env("ENABLE_WEB_SEARCH") === "true";
  },
  get port() {
    return Number(env("PORT") ?? 3000);
  },
  get generationTimeoutMs() {
    return Number(env("GEN_TIMEOUT_MS") ?? 280_000);
  },
  // 全凭自觉付费：微信收款码图片（放在 public/，Vercel 会按根路径静态托管）
  payment: {
    get qrTrial() {
      return env("PAY_QR_TRIAL") ?? "/pay-1.png";
    },
    get qrFull() {
      return env("PAY_QR_FULL") ?? "/pay-10.png";
    },
    get qrCustom() {
      return env("PAY_QR_CUSTOM") ?? "/pay-custom.png";
    },
  },
  paths: {
    publicDir: path.join(ROOT, "public"),
  },
};

// 每个 worker 可单独指定模型；默认走 defaultModel。
// “模型即配置”：想给某些 worker 换更便宜/更快的模型（降低 Vercel 单次时延），改这里即可，不改业务逻辑。
export const workerModels: Record<string, string> = {
  get parseResume() {
    return modelFor("WORKER_MODEL_PARSE_RESUME", "gpt-5.4-mini");
  },
  get extractEvidence() {
    return modelFor("WORKER_MODEL_EXTRACT_EVIDENCE", "gpt-5.5");
  },
  get synthesizeRolesFast() {
    return modelFor("WORKER_MODEL_SYNTHESIZE_ROLES_FAST", "gpt-5.4-mini");
  },
  get synthesizeRoles() {
    return modelFor("WORKER_MODEL_SYNTHESIZE_ROLES", "gpt-5.5");
  },
  get opportunityScout() {
    return modelFor("WORKER_MODEL_OPPORTUNITY_SCOUT", "gpt-5.4");
  },
  get strategyFast() {
    return modelFor("WORKER_MODEL_STRATEGY_FAST", "gpt-5.4-mini");
  },
  get strategy() {
    return modelFor("WORKER_MODEL_STRATEGY", "gpt-5.5");
  },
  get redTeam() {
    return modelFor("WORKER_MODEL_RED_TEAM", "gpt-5.5");
  },
};

export const WEIGHTS = weights;
