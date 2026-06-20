import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import weights from "./data/scoring_weights.json" with { type: "json" };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

function openAiBaseUrl(raw: string | undefined): string {
  const base = (raw ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return base.endsWith("/v1") ? base : `${base}/v1`;
}

function modelFor(envName: string, fallback: string): string {
  return process.env[envName] || fallback;
}

export const config = {
  provider: (process.env.LLM_PROVIDER ?? "mock") as "mock" | "anthropic" | "openai",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  defaultModel: process.env.DEFAULT_MODEL ?? "gpt-5.4",
  // OpenAI 兼容端点（可指向任意 OpenAI 协议代理，如 newapi/oneapi）
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    baseURL: openAiBaseUrl(process.env.OPENAI_BASE_URL),
    model: process.env.OPENAI_MODEL ?? "gpt-5.4-mini",
  },
  // 联网检索（默认关）：开启后用一次检索为“市场拉动/新兴岗位”召回注入实时市场信号；失败自动降级为无检索。
  enableWebSearch: process.env.ENABLE_WEB_SEARCH === "true",
  port: Number(process.env.PORT ?? 3000),
  // 全凭自觉付费：微信收款码图片（放在 public/，Vercel 会按根路径静态托管）
  payment: {
    qrTrial: process.env.PAY_QR_TRIAL ?? "/pay-1.png",
    qrFull: process.env.PAY_QR_FULL ?? "/pay-10.png",
    qrCustom: process.env.PAY_QR_CUSTOM ?? "/pay-custom.png",
  },
  paths: {
    publicDir: path.join(ROOT, "public"),
  },
};

// 每个 worker 可单独指定模型；默认走 defaultModel。
// “模型即配置”：想给某些 worker 换更便宜/更快的模型（降低 Vercel 单次时延），改这里即可，不改业务逻辑。
export const workerModels: Record<string, string> = {
  parseResume: modelFor("WORKER_MODEL_PARSE_RESUME", "gpt-5.4"),
  extractEvidence: modelFor("WORKER_MODEL_EXTRACT_EVIDENCE", "gpt-5.5"),
  synthesizeRoles: modelFor("WORKER_MODEL_SYNTHESIZE_ROLES", "gpt-5.5"),
  opportunityScout: modelFor("WORKER_MODEL_OPPORTUNITY_SCOUT", "gpt-5.4"),
  strategy: modelFor("WORKER_MODEL_STRATEGY", "gpt-5.5"),
  redTeam: modelFor("WORKER_MODEL_RED_TEAM", "gpt-5.5"),
};

export const WEIGHTS = weights;
