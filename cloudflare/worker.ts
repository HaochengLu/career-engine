import { setRuntimeEnv, config } from "../src/config.js";
import { nowIso } from "../src/util.js";
import { generateReport } from "../src/core/pipeline.js";
import { reserveReportQuota, type QuotaDecision } from "../src/core/quota.js";
import { renderReport, renderInsufficient, renderFailed } from "../src/render/report.js";
import type { ImageInput } from "../src/providers/llm.js";
import type { Tier, UserInputs, ReportMeta } from "../src/types.js";

interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectId {}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface WorkerEnv extends Record<string, unknown> {
  ASSETS?: AssetBinding;
  QUOTA_DO?: DurableObjectNamespace;
}

interface UploadFile {
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

const MAX_FILES = 4;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_B64 = 6 * 1024 * 1024;

function splitList(v: unknown): string[] {
  if (typeof v !== "string" || !v.trim()) return [];
  return v
    .split(/[,，;；\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function textValue(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function declaredGoal(v: unknown): UserInputs["declared_goal"] {
  return typeof v === "string" && ["stable", "upside", "balance"].includes(v) ? (v as UserInputs["declared_goal"]) : "balance";
}

function mediaType(type: string): ImageInput["media_type"] {
  return (["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type) ? type : "image/jpeg") as ImageInput["media_type"];
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function toImageInput(file: UploadFile): Promise<ImageInput> {
  return {
    media_type: mediaType(file.type),
    data: arrayBufferToBase64(await file.arrayBuffer()),
  };
}

function isUploadFile(item: unknown): item is UploadFile {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as UploadFile).type === "string" &&
    typeof (item as UploadFile).size === "number" &&
    typeof (item as UploadFile).arrayBuffer === "function" &&
    (item as UploadFile).type.startsWith("image/")
  );
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function dayKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: config.quota.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function quotaKey(tier: Tier): string {
  return `quota:${tier}:${dayKey()}`;
}

async function reserveWorkerQuota(tier: Tier, env: WorkerEnv): Promise<QuotaDecision> {
  if (tier !== "full" || !env.QUOTA_DO) return reserveReportQuota(tier);

  const limit = Math.floor(config.quota.fullDailyLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, used: 0, limit: 0, remaining: 0, mode: "off" };
  }

  const key = quotaKey(tier);
  const id = env.QUOTA_DO.idFromName(key);
  const res = await env.QUOTA_DO.get(id).fetch(
    new Request("https://quota.local/reserve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, limit }),
    }),
  );
  if (!res.ok) throw new Error(`Cloudflare quota counter failed: ${res.status}`);
  return (await res.json()) as QuotaDecision;
}

async function parseRequest(request: Request): Promise<{ tier: Tier; inputs: UserInputs; images: ImageInput[]; error?: Response }> {
  const form = await request.formData();
  const tier: Tier = form.get("tier") === "full" ? "full" : "trial";
  const inputs: UserInputs = {
    target_locations: splitList(form.get("target_locations")),
    target_countries: splitList(form.get("target_countries")),
    desired_roles: splitList(form.get("desired_roles")),
    avoid_roles: splitList(form.get("avoid_roles")),
    school: textValue(form.get("school")),
    major: textValue(form.get("major")),
    grade_or_years: textValue(form.get("grade_or_years")),
    constraints: splitList(form.get("constraints")),
    declared_goal: declaredGoal(form.get("declared_goal")),
    notes: textValue(form.get("notes")),
  };

  const files = (form.getAll("images") as unknown[]).filter(isUploadFile);
  if (files.length > MAX_FILES) {
    return {
      tier,
      inputs,
      images: [],
      error: html(renderFailed({ tier, createdAt: nowIso(), status: "failed", error: "图片上传失败，请最多上传 4 张截图。" }), 413),
    };
  }
  if (files.some((file) => file.size > MAX_FILE_BYTES)) {
    return {
      tier,
      inputs,
      images: [],
      error: html(renderFailed({ tier, createdAt: nowIso(), status: "failed", error: "单张图片过大，请裁剪截图或换成更小的 JPG/PNG 后重试。" }), 413),
    };
  }

  const images = await Promise.all(files.map(toImageInput));
  const totalB64 = images.reduce((s, i) => s + i.data.length, 0);
  if (totalB64 > MAX_TOTAL_B64) {
    return {
      tier,
      inputs,
      images: [],
      error: html(renderFailed({ tier, createdAt: nowIso(), status: "failed", error: "图片总体积过大，请减少张数或上传更小/更清晰的截图。" }), 413),
    };
  }

  return { tier, inputs, images };
}

async function handleGenerate(request: Request, env: WorkerEnv): Promise<Response> {
  const parsed = await parseRequest(request);
  if (parsed.error) return parsed.error;

  const { tier, inputs, images } = parsed;

  try {
    const quota = await reserveWorkerQuota(tier, env);
    if (!quota.allowed) {
      return html(
        renderFailed({
          tier,
          createdAt: nowIso(),
          status: "failed",
          error: `今天的完整报告名额已用完（${quota.used}/${quota.limit}）。请明天再试，或先使用快速版。`,
        }),
        429,
      );
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timeoutId = setTimeout(() => rej(new Error("生成超时（请稍后重试或减少图片）")), config.generationTimeoutMs);
    });
    const result = await (async () => {
      try {
        return await Promise.race([generateReport(images, inputs, { tier }), timeout]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    })();

    const meta: ReportMeta = { tier, createdAt: nowIso(), status: result.status, error: result.error };
    if (result.status === "insufficient_input") return html(renderInsufficient(result.artifacts));
    if (result.status.endsWith("failed")) return html(renderFailed(meta));
    return html(renderReport(meta, result.artifacts));
  } catch (e) {
    console.error(e);
    return html(renderFailed({ tier, createdAt: nowIso(), status: "failed", error: e instanceof Error ? e.message : "生成失败" }), 500);
  }
}

export class QuotaCounter {
  constructor(private state: { storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> } }) {}

  async fetch(request: Request): Promise<Response> {
    const { key, limit } = (await request.json()) as { key: string; limit: number };
    const used = ((await this.state.storage.get<number>(key)) ?? 0) + 1;
    await this.state.storage.put(key, used);
    const cappedUsed = Math.min(used, limit);
    return json({
      allowed: used <= limit,
      used: cappedUsed,
      limit,
      remaining: Math.max(0, limit - cappedUsed),
      mode: "durable_object",
      key,
      reason: used <= limit ? undefined : "今日完整报告名额已用完。",
    } satisfies QuotaDecision);
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    setRuntimeEnv(env);
    const url = new URL(request.url);

    if (url.pathname === "/cloudflare-healthz" || url.pathname === "/healthz") {
      return json({
        ok: true,
        provider: config.provider,
        runtime: "cloudflare-worker",
        assets: Boolean(env.ASSETS),
        quota: env.QUOTA_DO ? "durable_object" : "fallback",
      });
    }

    if (request.method === "POST" && url.pathname === "/api/report/generate") {
      return handleGenerate(request, env);
    }

    if (env.ASSETS && ["GET", "HEAD"].includes(request.method)) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
