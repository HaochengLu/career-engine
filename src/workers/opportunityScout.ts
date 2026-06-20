// 漏检审查（Missed Opportunity Reviewer）：Red Team 防“过度乐观”，这个 worker 专门防“漏掉高上限相邻/新兴方向”。
// 它看证据 + 前沿信号 + 当前候选名单，只补“被漏掉的、天花板更高的相邻/新兴方向”。通用于任何职业，不是 AI 专用。
import { getLlm } from "../providers/llm.js";
import { RoleListSchema } from "../schemas.js";
import { workerModels } from "../config.js";
import { CAPABILITY_LIST_TEXT } from "../core/rubric.js";
import type { EvidenceItem, RoleArchetype, UserInputs } from "../types.js";

const SYSTEM = `你是“漏检审查官”。别人已经给出了一个候选职业名单，但容易犯一个错：只把人归到“最像的传统岗位”，漏掉“现有能力 + 一点补强/市场拉动就能够到、且天花板更高”的相邻与新兴方向。
你的唯一任务：找出名单【漏掉】的高上限相邻/新兴方向（不要重复已在名单里的）。
判断标准：不是“他做过没有”，而是“他的证据能否迁移过去 + 这个方向是否天花板更高/正被市场拉动”。
通用而非只懂 AI：当下 AI 复合岗最常见（营销/增长/商业化 + AI 理解 → AI GTM / AI 产品市场 / AI 商业化运营 / AI 搜索可见性增长），
但对任何领域都要会做（临床→临床信息化、法律→合规科技、财务→FP&A 自动化、供应链→碳核算/可持续运营 等）。
诚实：如果名单已经覆盖得很好、确实没有遗漏，就返回空数组，不要硬凑。每个补充项标 recall_source（transferable_adjacent / market_pull / emerging）。
全程中文。`;

export async function opportunityScout(
  existing: RoleArchetype[],
  evidence: EvidenceItem[],
  inputs: UserInputs,
  marketContext = "",
): Promise<{ value: RoleArchetype[]; model: string }> {
  const frontier = [...new Set(evidence.flatMap((e) => e.frontier_signals))];
  const userText = `当前候选名单（不要重复这些）：
${existing.map((r) => `- ${r.role_id}：${r.display_name}（${r.recall_source ?? "?"}）`).join("\n")}

证据摘要：
${JSON.stringify(evidence.map((e) => ({ id: e.evidence_id, claim: e.claim, capabilities: e.capabilities, frontier_signals: e.frontier_signals, strength: e.evidence_strength })), null, 2)}

汇总前沿/新兴信号：${frontier.length ? frontier.join("、") : "（无显著前沿信号）"}

用户意愿与约束：
${JSON.stringify(inputs, null, 2)}

能力维度 id（required_evidence.capability 只能用这些）：
${CAPABILITY_LIST_TEXT}
${marketContext ? `\n【实时市场信号（联网检索，供找漏参考；需结合证据判断适配）】\n${marketContext}\n` : ""}
只输出【被漏掉】的高上限相邻/新兴候选（0-5 个），结构同 role_archetype。没有遗漏就返回 {"roles": []}。`;

  const { value, model } = await getLlm().complete({
    system: SYSTEM,
    userText,
    schema: RoleListSchema,
    schemaName: "RoleListScout",
    model: workerModels.opportunityScout ?? workerModels.synthesizeRoles!,
    effort: "high",
  });

  const existingIds = new Set(existing.map((r) => r.role_id));
  const roles: RoleArchetype[] = value.roles
    .filter((r) => !existingIds.has(r.role_id))
    .map((r) => ({ ...r, origin: "synthesized" as const, recall_source: r.recall_source ?? "emerging" }));
  return { value: roles, model };
}
