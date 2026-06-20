import express from "express";
import multer from "multer";
import path from "node:path";
import { config } from "./config.js";
import { nowIso } from "./util.js";
import { generateReport } from "./core/pipeline.js";
import { reserveReportQuota } from "./core/quota.js";
import { renderReport, renderInsufficient, renderFailed } from "./render/report.js";
import type { ImageInput } from "./providers/llm.js";
import type { Tier, UserInputs, ReportMeta } from "./types.js";

export const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(config.paths.publicDir));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024, files: 4 }, // 3MB×4：控制 base64 体积与 LLM 输入成本
});

const GEN_TIMEOUT_MS = 280_000; // 留在 Vercel maxDuration(300s) 之内主动兜底，避免被强杀
const MAX_TOTAL_B64 = 8 * 1024 * 1024; // 所有图片 base64 合计上限

function splitList(v: unknown): string[] {
  if (typeof v !== "string" || !v.trim()) return [];
  return v.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean);
}

function toImageInput(f: Express.Multer.File): ImageInput {
  const mt = (
    ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(f.mimetype) ? f.mimetype : "image/jpeg"
  ) as ImageInput["media_type"];
  return { media_type: mt, data: f.buffer.toString("base64") };
}

// 同步生成：一个请求跑完整条流水线并直接返回报告 HTML。无存盘、无轮询，Vercel 友好。
app.post("/api/report/generate", upload.array("images", 4), async (req, res) => {
  const tier: Tier = req.body.tier === "full" ? "full" : "trial";
  // 当前仅中文报告；多语言留作后续（不读未用的 lang，避免死参数）
  const inputs: UserInputs = {
    target_locations: splitList(req.body.target_locations),
    target_countries: splitList(req.body.target_countries),
    desired_roles: splitList(req.body.desired_roles),
    avoid_roles: splitList(req.body.avoid_roles),
    school: req.body.school || undefined,
    major: req.body.major || undefined,
    grade_or_years: req.body.grade_or_years || undefined,
    constraints: splitList(req.body.constraints),
    declared_goal: ["stable", "upside", "balance"].includes(req.body.declared_goal) ? req.body.declared_goal : "balance",
    notes: req.body.notes || undefined,
  };

  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const images = files.filter((f) => f.mimetype.startsWith("image/")).map(toImageInput);

  const totalB64 = images.reduce((s, i) => s + i.data.length, 0);
  if (totalB64 > MAX_TOTAL_B64) {
    res.status(413).set("Content-Type", "text/html; charset=utf-8");
    return res.send(
      renderFailed({ tier, createdAt: nowIso(), status: "failed", error: "图片总体积过大，请减少张数或上传更小/更清晰的截图。" }),
    );
  }

  try {
    const quota = await reserveReportQuota(tier);
    if (!quota.allowed) {
      res.status(429).set("Content-Type", "text/html; charset=utf-8");
      return res.send(
        renderFailed({
          tier,
          createdAt: nowIso(),
          status: "failed",
          error: `今天的完整报告名额已用完（${quota.used}/${quota.limit}）。请明天再试，或先使用快速版。`,
        }),
      );
    }

    // 主动超时兜底：即使某个 worker 卡住，也在 Vercel 强杀前返回友好失败。
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("生成超时（请稍后重试或减少图片）")), GEN_TIMEOUT_MS));
    const result = await Promise.race([generateReport(images, inputs), timeout]);
    const meta: ReportMeta = { tier, createdAt: nowIso(), status: result.status, error: result.error };
    res.set("Content-Type", "text/html; charset=utf-8");
    if (result.status === "insufficient_input") return res.send(renderInsufficient(result.artifacts));
    if (result.status.endsWith("failed")) return res.send(renderFailed(meta));
    return res.send(renderReport(meta, result.artifacts));
  } catch (e) {
    console.error(e);
    res.status(500).set("Content-Type", "text/html; charset=utf-8");
    return res.send(renderFailed({ tier, createdAt: nowIso(), status: "failed", error: e instanceof Error ? e.message : "生成失败" }));
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true, provider: config.provider }));
app.get("/", (_req, res) => res.sendFile(path.join(config.paths.publicDir, "index.html")));

export default app;
