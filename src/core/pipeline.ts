// 同步生成：一个请求里跑完整条证据脊柱，直接返回结果。无存盘、无后台任务，
// 因此能直接跑在 Vercel serverless 上（serverless 不保留内存状态、响应后不能继续后台跑）。
import type { ImageInput } from "../providers/llm.js";
import { nowIso } from "../util.js";
import { WEIGHTS, config } from "../config.js";
import type { ReportStatus, ReportArtifacts, WorkerMeta, EvidenceItem, ParsedResume, UserInputs } from "../types.js";

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

function meta(name: string, model: string, confidence?: number): WorkerMeta {
  return { worker_name: name, worker_version: "0.1.0", model, created_at: nowIso(), confidence };
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
): Promise<GenerateResult> {
  const artifacts: ReportArtifacts = { user_inputs: inputs, worker_log: [] };

  try {
    // 1) 解析简历（视觉）
    const parsed = await parseResume(images, inputs);
    artifacts.parsed = parsed.value;
    artifacts.worker_log.push(meta("parseResume", parsed.model, parsed.value.ocr_confidence));

    // 2) 抽取 + 评级证据
    const ev = await extractEvidence(parsed.value, inputs);
    artifacts.evidence = ev.value;
    artifacts.worker_log.push(meta("extractEvidence", ev.model));

    // 3) 能力向量（确定性）
    artifacts.capability_vector = buildCapabilityVector(ev.value);
    artifacts.overall_confidence = ev.value.length
      ? ev.value.reduce((s, e) => s + e.confidence, 0) / ev.value.length
      : 0;

    // 客观“输入不足”闸门：宁可不出，也不硬编
    const reason = insufficiency(parsed.value, ev.value);
    if (reason) {
      artifacts.insufficient_reason = reason;
      return { status: "insufficient_input", artifacts };
    }

    // 3.5) 市场信号（可选联网；关闭时返回空串，不影响流程）
    const market = await marketSignal(artifacts.capability_vector, ev.value, inputs);
    if (market) artifacts.worker_log.push(meta("marketSignal", "web_search"));
    else if (config.enableWebSearch) artifacts.worker_log.push(meta("marketSignal(failed)", "web_search"));

    // 4) 多通道召回候选职业本体（证据近 + 相邻迁移 + 市场拉动 + 用户意愿 + 新兴前沿）
    const roles = await synthesizeRoles(artifacts.capability_vector, ev.value, inputs, market);
    artifacts.worker_log.push(meta("synthesizeRoles", roles.model));

    // 4.5) 漏检审查（条件触发，省一次调用/降低 Vercel 时延）：
    //   只有当“可能漏了高上限相邻/新兴方向”时才跑——存在前沿信号，或主召回里相邻/市场拉动/新兴候选不足。
    const adjacentSources = new Set(["emerging", "transferable_adjacent", "market_pull"]);
    const hasFrontier = ev.value.some((e) => e.frontier_signals.length > 0);
    const adjacentCount = roles.value.filter((r) => r.recall_source && adjacentSources.has(r.recall_source)).length;
    // 召回通道多样性 + 名单规模 + 单通道缺失：任一相邻/市场/新兴通道为 0，或通道太少、名单偏小 → 触发漏检审查。
    const distinctSources = new Set(roles.value.map((r) => r.recall_source).filter(Boolean)).size;
    const bySource = (src: string) => roles.value.filter((r) => r.recall_source === src).length;
    const missingChannel = bySource("emerging") < 1 || bySource("transferable_adjacent") < 1 || bySource("market_pull") < 1;
    const shouldScout = hasFrontier || adjacentCount < 2 || distinctSources < 3 || roles.value.length < 10 || missingChannel;
    artifacts.roles = roles.value;
    if (shouldScout) {
      const scout = await opportunityScout(roles.value, ev.value, inputs, market);
      artifacts.worker_log.push(meta("opportunityScout", scout.model, scout.value.length));
      // 合并而非静默去重：同 role_id 命中时，保留【更高价值的召回通道】分类（避免 scout 标出的 emerging 被原 evidence_near 覆盖丢弃）。
      const rank: Record<string, number> = { emerging: 4, transferable_adjacent: 3, market_pull: 2, user_thesis: 1, evidence_near: 0 };
      const byId = new Map(roles.value.map((r) => [r.role_id, r]));
      const extra: typeof scout.value = [];
      for (const sr of scout.value) {
        const ex = byId.get(sr.role_id);
        if (ex) {
          if ((rank[sr.recall_source ?? ""] ?? -1) > (rank[ex.recall_source ?? ""] ?? -1)) ex.recall_source = sr.recall_source;
        } else {
          extra.push(sr);
        }
      }
      artifacts.roles = [...roles.value, ...extra];
    } else {
      artifacts.worker_log.push(meta("opportunityScout(skipped)", "code"));
    }

    // 5) 打分（确定性：覆盖度计分 + 硬门槛 + 决策分，权重按用户目标 profile）
    artifacts.scores = scoreRoles(artifacts.roles, ev.value, inputs);

    // 6) 战略
    const strat = await runStrategy(artifacts.scores, ev.value, inputs);
    artifacts.strategy = strat.value;
    artifacts.worker_log.push(meta("strategy", strat.model));

    // 7) 对抗 review
    const rt = await redTeam(strat.value, artifacts.scores, ev.value);
    artifacts.findings = rt.value;
    artifacts.worker_log.push(meta("redTeam", rt.model));

    // 8) 仲裁（确定性硬规则：清幻觉 id、未达硬门槛主路径降级、置信传播）
    const arb = arbitrate(strat.value, rt.value, artifacts.scores, ev.value, rt.entailment);
    artifacts.strategy = arb.strategy;
    artifacts.findings = arb.findings;
    if (arb.actions.length) artifacts.worker_log.push(meta("arbitrate", "code"));

    // 9) QA
    artifacts.qa = runQa(arb.strategy, artifacts.scores, ev.value);
    artifacts.worker_log.push(meta("qa", "code", artifacts.qa.passed ? 1 : 0));

    return { status: "rendered", artifacts };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    let status: ReportStatus = "failed";
    if (!artifacts.parsed || !artifacts.evidence) status = "parse_failed";
    else if (!artifacts.roles || !artifacts.scores || !artifacts.strategy) status = "review_failed";
    console.error(`[generate] ${status}: ${msg}`);
    return { status, artifacts, error: msg };
  }
}
