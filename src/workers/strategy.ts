// 生成路径组合 + 缺口 + 项目 + 叙事 + 战略卡 + claim ledger。
// 输入是已打分的候选角色与证据；LLM 负责判断与表达，但必须落到证据 id，且尊重硬门槛与分数排序。
import { getLlm } from "../providers/llm.js";
import { StrategySchema } from "../schemas.js";
import { workerModels, WEIGHTS } from "../config.js";
import type { EvidenceItem, RoleScore, Strategy, UserInputs } from "../types.js";

function band(score: number): "强" | "中" | "弱" {
  if (score >= WEIGHTS.bands.strong) return "强";
  if (score >= WEIGHTS.bands.medium) return "中";
  return "弱";
}

const SYSTEM = `你是职业战略 worker。把已打分的候选职业转成一份明确、敢于否定、可执行的路径组合报告。
铁律：
- 只给 3 条主路径：近期最现实(near_term)、未来最有上限(high_ceiling)、挑战型(challenge)；并至少给 1 条“暂不建议优先”的方向。
- 必须单独填 adjacent_upside（高上限相邻路径）：选一个“不一定近期最现实、但天花板更高、且证据可迁移过去”的相邻/新兴方向（优先 recall_source 为 emerging / transferable_adjacent / market_pull 的候选）。绝不能因为它不是“当前最像”就把它漏掉——这是这份报告的高价值槽位。
- 每条路径、每个 claim 都必须引用真实存在的 evidence_id（只能用给定列表里的 id），不得编造经历或 id。
- 尊重排序与门槛：decision_score 高、可行性高的更适合做 near_term；存在未满足硬门槛的方向不能作为近期现实主路径；天花板更高但需补强的适合 high_ceiling / adjacent_upside。
- 缺口要写成“证据缺口”，并给最短补法与成本；项目要可放进简历/作品集、面试能讲、2-4 周可完成第一版。
- 禁止任何过度承诺（如“保证/一定/必拿 offer/100%”）。不确定的地方用低置信表达，不要装确定。
- 风格像咨询报告 + 求职战略卡：判断明确、短句、可截图转发。全程中文。`;

export async function strategy(
  scores: RoleScore[],
  evidence: EvidenceItem[],
  inputs: UserInputs,
): Promise<{ value: Strategy; model: string }> {
  const top = scores.slice(0, 8);
  const scoredSummary = top.map((s) => ({
    role_id: s.role_id,
    display_name: s.display_name,
    recall_source: s.recall_source,
    decision_band: band(s.decision_score),
    current_fit_band: band(s.current_fit),
    market_band: band(s.market_potential),
    entry_feasibility_band: band(s.entry_feasibility),
    confidence: Number(s.confidence.toFixed(2)),
    unmet_blocking_gates: s.unmet_blocking_gates.map((g) => g.label_zh),
    covered_must: s.coverage.must_have.map((d) => ({ k: d.label_zh, covered: Number(d.covered.toFixed(2)), ev: d.matched_evidence_ids })),
    notes: s.notes,
  }));

  const evidenceList = evidence.map((e) => ({
    id: e.evidence_id,
    claim: e.claim,
    strength: e.evidence_strength,
    limitations: e.limitations,
  }));
  const validIds = evidence.map((e) => e.evidence_id).join(", ");

  const userText = `根据以下已打分候选角色与证据，产出完整战略报告。

候选角色（已按 decision_score 排序，band 是内部分数的弱/中/强映射，仅供你判断，不要把两位数分写进报告）：
${JSON.stringify(scoredSummary, null, 2)}

证据列表（引用时只能用这些 id：${validIds}）：
${JSON.stringify(evidenceList, null, 2)}

用户意愿与约束：
${JSON.stringify(inputs, null, 2)}

要求：
- paths 给 3 条，rank=1/2/3，label 分别尽量为 near_term / high_ceiling / challenge。
- adjacent_upside 必填，且其 role_id 不得与三条 paths 的 role_id 重复（必须是另一个方向）；写清 why（为什么天花板更高且证据可迁移）与 what_to_build，并引用真实 evidence_id。
- confidence_band 按所给 confidence 数值映射：≥0.7→高，0.4-0.7→中，<0.4→低；若你判断与数值不一致（如用户强烈想要但证据弱），必须在 recommendation 里说明理由。
- 每个 project 必须对应 gap_map 里的某个缺口（在 proves 里点名它补的是哪个缺口），不要给与缺口无关的项目。
- not_recommended 至少 1 条，写清为什么不建议优先以及更好的策略。
- gap_map 至少 3 条；每条给 supporting_evidence_ids（指出哪条证据表明该缺口存在/相关，只能用真实 id；若纯属完全缺失则给空数组）。
- projects 至少 1 个完整项目；thirty_day_plan 给可执行步骤。
- claims 至少包含 1 条核心判断，带 supporting_evidence_ids 与 counter_evidence_ids。
- 所有 *_evidence_ids 只能用上面列出的 id。`;

  const { value, model } = await getLlm().complete({
    system: SYSTEM,
    userText,
    schema: StrategySchema,
    schemaName: "Strategy",
    model: workerModels.strategy!,
    effort: "high",
    // 输出规模随候选数/证据数增长，动态给上限，避免大输入时被 16000 截断。
    maxTokens: Math.min(24000, 10000 + scores.length * 250 + evidence.length * 120),
  });
  return { value: value as Strategy, model };
}
