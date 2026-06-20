// 同步生成：一个请求里跑完整条证据脊柱，直接返回结果。无存盘、无后台任务，
// 因此能直接跑在 Vercel serverless 上（serverless 不保留内存状态、响应后不能继续后台跑）。
import type { ImageInput } from "../providers/llm.js";
import { nowIso } from "../util.js";
import { WEIGHTS, config } from "../config.js";
import type { ReportStatus, ReportArtifacts, WorkerMeta, EvidenceItem, ParsedResume, UserInputs, Tier, RoleArchetype } from "../types.js";

import { parseResume } from "../workers/parseResume.js";
import { extractEvidence } from "../workers/extractEvidence.js";
import { buildCapabilityVector, evidenceContribution } from "../workers/capabilityVector.js";
import { synthesizeRoles } from "../workers/synthesizeRoles.js";
import { opportunityScout } from "../workers/opportunityScout.js";
import { marketSignal } from "../workers/marketSignal.js";
import { scoreRoles } from "../workers/scoreRoles.js";
import { strategy as runStrategy } from "../workers/strategy.js";
import { redTeam } from "../workers/redTeam.js";
import { arbitrate } from "../workers/arbitrate.js";
import { runQa } from "../workers/qa.js";

export interface GenerateResult {
  status: ReportStatus;
  artifacts: ReportArtifacts;
  error?: string;
}

export interface GenerateOptions {
  tier?: Tier;
}

function meta(name: string, model: string, confidence?: number, durationMs?: number): WorkerMeta {
  return { worker_name: name, worker_version: "0.1.0", model, created_at: nowIso(), confidence, duration_ms: durationMs };
}

async function timed<T>(name: string, run: () => Promise<T>): Promise<{ value: T; durationMs: number }> {
  const started = Date.now();
  console.info(`[worker:start] ${name}`);
  try {
    const value = await run();
    const durationMs = Date.now() - started;
    console.info(`[worker:done] ${name} duration_ms=${durationMs}`);
    return { value, durationMs };
  } catch (err) {
    const durationMs = Date.now() - started;
    console.error(`[worker:fail] ${name} duration_ms=${durationMs}`, err);
    throw err;
  }
}

async function optionalTimed<T>(
  name: string,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T; durationMs: number } | { ok: false; error: unknown; durationMs: number }> {
  const started = Date.now();
  console.info(`[worker:start] ${name}`);
  try {
    const value = await run();
    const durationMs = Date.now() - started;
    console.info(`[worker:done] ${name} duration_ms=${durationMs}`);
    return { ok: true, value, durationMs };
  } catch (error) {
    const durationMs = Date.now() - started;
    console.error(`[worker:fail] ${name} duration_ms=${durationMs}`, error);
    return { ok: false, error, durationMs };
  }
}

function timedSync<T>(name: string, run: () => T): { value: T; durationMs: number } {
  const started = Date.now();
  const value = run();
  const durationMs = Date.now() - started;
  console.info(`[worker:done] ${name} duration_ms=${durationMs}`);
  return { value, durationMs };
}

function mergeRoles(base: RoleArchetype[], scout: RoleArchetype[]): RoleArchetype[] {
  // 合并而非静默去重：同 role_id 命中时，保留【更高价值的召回通道】分类。
  const rank: Record<string, number> = { emerging: 4, transferable_adjacent: 3, market_pull: 2, user_thesis: 1, evidence_near: 0 };
  const byId = new Map(base.map((r) => [r.role_id, r]));
  const extra: RoleArchetype[] = [];
  for (const sr of scout) {
    const ex = byId.get(sr.role_id);
    if (ex) {
      if ((rank[sr.recall_source ?? ""] ?? -1) > (rank[ex.recall_source ?? ""] ?? -1)) ex.recall_source = sr.recall_source;
    } else {
      extra.push(sr);
    }
  }
  return [...base, ...extra];
}

// 客观的“输入不足”判定：用证据信号量化（阈值来自 scoring_weights.json，可校准），不让模型随口说不足。
function insufficiency(parsed: ParsedResume, evidence: EvidenceItem[]): string | null {
  const s = WEIGHTS.sufficiency;
  const meaningful = evidence.filter((e) => e.evidence_strength >= s.min_meaningful_strength);
  const totalSignal = evidence.reduce((acc, e) => acc + evidenceContribution(e), 0);
  if (evidence.length < s.min_evidence) return `可识别的职业证据过少（不足 ${s.min_evidence} 条）。`;
  if (meaningful.length === 0) return "没有任何达到‘学习经历’及以上强度的证据，全部是自称/技能罗列。";
  if (parsed.ocr_confidence < s.low_ocr && evidence.length < 3) return "图片识别置信很低且证据稀少，无法给出可信判断。";
  if (totalSignal < s.signal_threshold) return "整体证据信号过弱，不足以支撑高置信职业排序。";
  return null;
}

export async function generateReport(
  images: ImageInput[],
  inputs: UserInputs,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const artifacts: ReportArtifacts = { user_inputs: inputs, worker_log: [] };
  const tier = options.tier ?? "full";
  const totalStarted = Date.now();
  console.info(`[generate:start] tier=${tier} images=${images.length}`);

  try {
    // 1) 解析简历（视觉）
    const parsedTimed = await timed("parseResume", () => parseResume(images, inputs));
    const parsed = parsedTimed.value;
    artifacts.parsed = parsed.value;
    artifacts.worker_log.push(meta("parseResume", parsed.model, parsed.value.ocr_confidence, parsedTimed.durationMs));

    // 2) 抽取 + 评级证据
    const evTimed = await timed("extractEvidence", () => extractEvidence(parsed.value, inputs));
    const ev = evTimed.value;
    artifacts.evidence = ev.value;
    artifacts.worker_log.push(meta("extractEvidence", ev.model, undefined, evTimed.durationMs));

    // 3) 能力向量（确定性）
    const capabilityTimed = timedSync("capabilityVector", () => buildCapabilityVector(ev.value));
    artifacts.capability_vector = capabilityTimed.value;
    artifacts.worker_log.push(meta("capabilityVector", "code", undefined, capabilityTimed.durationMs));
    artifacts.overall_confidence = ev.value.length
      ? ev.value.reduce((s, e) => s + e.confidence, 0) / ev.value.length
      : 0;

    // 客观“输入不足”闸门：宁可不出，也不硬编
    const reason = insufficiency(parsed.value, ev.value);
    if (reason) {
      artifacts.insufficient_reason = reason;
      console.info(`[generate:done] status=insufficient_input duration_ms=${Date.now() - totalStarted}`);
      return { status: "insufficient_input", artifacts };
    }

    // 3.5) 市场信号（可选联网；关闭时返回空串，不影响流程）
    const marketTimed = await timed("marketSignal", () => marketSignal(artifacts.capability_vector!, ev.value, inputs));
    const market = marketTimed.value;
    if (market) artifacts.worker_log.push(meta("marketSignal", "web_search", undefined, marketTimed.durationMs));
    else if (config.enableWebSearch) artifacts.worker_log.push(meta("marketSignal(failed)", "web_search", undefined, marketTimed.durationMs));
    else artifacts.worker_log.push(meta("marketSignal(skipped)", "code", undefined, marketTimed.durationMs));

    // 4) 多通道召回候选职业本体（证据近 + 相邻迁移 + 市场拉动 + 用户意愿 + 新兴前沿）
    const roleMode = tier === "trial" ? "fast" : "full";
    const rolesPromise = timed(`synthesizeRoles(${roleMode})`, () =>
      synthesizeRoles(artifacts.capability_vector!, ev.value, inputs, market, { mode: roleMode }),
    );
    const scoutPromise =
      tier === "full"
        ? optionalTimed("opportunityScout(parallel)", () => opportunityScout([], ev.value, inputs, market))
        : Promise.resolve({ ok: false as const, error: new Error("skipped for trial"), durationMs: 0 });

    const [rolesTimed, scoutTimed] = await Promise.all([rolesPromise, scoutPromise]);
    const roles = rolesTimed.value;
    artifacts.worker_log.push(meta(`synthesizeRoles(${roleMode})`, roles.model, undefined, rolesTimed.durationMs));
    artifacts.roles = roles.value;

    if (scoutTimed.ok) {
      const scout = scoutTimed.value;
      artifacts.worker_log.push(meta("opportunityScout(parallel)", scout.model, scout.value.length, scoutTimed.durationMs));
      artifacts.roles = mergeRoles(roles.value, scout.value);
    } else if (tier === "full") {
      artifacts.worker_log.push(meta("opportunityScout(failed)", "code", undefined, scoutTimed.durationMs));
    } else {
      artifacts.worker_log.push(meta("opportunityScout(skipped:trial)", "code", undefined, scoutTimed.durationMs));
    }

    // 5) 打分（确定性：覆盖度计分 + 硬门槛 + 决策分，权重按用户目标 profile）
    const scoresTimed = timedSync("scoreRoles", () => scoreRoles(artifacts.roles!, ev.value, inputs));
    artifacts.scores = scoresTimed.value;
    artifacts.worker_log.push(meta("scoreRoles", "code", undefined, scoresTimed.durationMs));

    // 6) 战略
    const stratTimed = await timed("strategy", () => runStrategy(artifacts.scores!, ev.value, inputs));
    const strat = stratTimed.value;
    artifacts.strategy = strat.value;
    artifacts.worker_log.push(meta("strategy", strat.model, undefined, stratTimed.durationMs));

    // 7) 对抗 review
    const rt =
      tier === "full"
        ? await timed("redTeam", () => redTeam(strat.value, artifacts.scores!, ev.value))
        : { value: { value: [], entailment: [], model: "code" }, durationMs: 0 };
    artifacts.findings = rt.value.value;
    artifacts.worker_log.push(meta(tier === "full" ? "redTeam" : "redTeam(skipped:trial)", rt.value.model, undefined, rt.durationMs));

    // 8) 仲裁（确定性硬规则：清幻觉 id、未达硬门槛主路径降级、置信传播）
    const arbTimed = timedSync("arbitrate", () => arbitrate(strat.value, rt.value.value, artifacts.scores!, ev.value, rt.value.entailment));
    const arb = arbTimed.value;
    artifacts.strategy = arb.strategy;
    artifacts.findings = arb.findings;
    artifacts.worker_log.push(meta("arbitrate", "code", arb.actions.length ? 1 : 0, arbTimed.durationMs));

    // 9) QA
    const qaTimed = timedSync("qa", () => runQa(arb.strategy, artifacts.scores!, ev.value));
    artifacts.qa = qaTimed.value;
    artifacts.worker_log.push(meta("qa", "code", artifacts.qa.passed ? 1 : 0, qaTimed.durationMs));

    console.info(`[generate:done] status=rendered duration_ms=${Date.now() - totalStarted}`);
    return { status: "rendered", artifacts };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    let status: ReportStatus = "failed";
    if (!artifacts.parsed || !artifacts.evidence) status = "parse_failed";
    else if (!artifacts.roles || !artifacts.scores || !artifacts.strategy) status = "review_failed";
    console.error(`[generate] ${status} duration_ms=${Date.now() - totalStarted}: ${msg}`);
    return { status, artifacts, error: msg };
  }
}
