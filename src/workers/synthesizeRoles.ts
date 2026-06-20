// 泛化引擎 + 多通道召回：不维护几千个岗位，也不把人塞回“最像的传统岗位”。
// 根因修复：候选召回必须是多通道的——证据最近 + 可迁移相邻 + 市场拉动 + 用户意愿 + 新兴前沿，
// 否则会系统性漏掉“相邻高上限/新型复合岗位”。这套机制对任何职业/任何时代都成立（AI 只是当下最常见的一类新兴方向）。
import { getLlm } from "../providers/llm.js";
import { RoleListSchema } from "../schemas.js";
import { workerModels } from "../config.js";
import { CAPABILITY_LIST_TEXT } from "../core/rubric.js";
import seed from "../data/seed_ontology.json" with { type: "json" };
import type { CapabilityScore, EvidenceItem, RoleArchetype, UserInputs } from "../types.js";

const SEED_IDS = new Set(seed.archetypes.map((a) => a.role_id));
// few-shot 锚点刻意选成跨域多样（含 AI/产品、credential-gate 白领、license-gate 蓝领、分析），避免把人带偏向互联网。
const ANCHOR_IDS = [
  "product.ai_application_pm", // 白领/AI/产品
  "data.business_analyst", // 白领/分析
  "legal.compliance", // 白领/受监管（无可展示产物但需深度领域知识）
  "education.teacher_k12", // credential-gate
  "healthcare.registered_nurse", // license-gate / 临床 / 体力
  "trade.electrician", // license-gate / 蓝领 / 实操
];
const ANCHOR_EXAMPLES = ANCHOR_IDS.map((id) => seed.archetypes.find((a) => a.role_id === id)).filter(Boolean);
const SEED_INDEX = seed.archetypes.map((a) => `${a.role_id} = ${a.display_name}`).join("\n");
const FAST_ANCHOR_EXAMPLES = ANCHOR_EXAMPLES.slice(0, 3);

const SYSTEM = `你是职业本体合成器 + 多通道召回器。给定用户的能力证据与意愿，产出 12-18 个候选职业原型（role_archetype），每个都是结构化“证据契约”。

【最重要：候选必须来自多条召回通道，不能只挑“当前最像的传统岗位”】
Candidate Longlist =
  evidence_near        证据最相近的方向
+ transferable_adjacent 可迁移的相邻跃迁（不是已做过的岗位，而是“现有能力 + 一点补强”就能够到的相邻方向）
+ market_pull          市场正在拉动、需求/上限更高的方向
+ user_thesis          用户明确想要的方向（即使证据弱）
+ emerging             新兴/前沿、天花板更高的复合方向
- hard_gate_blocked    被硬门槛挡死且短期无法补的，剔除
给每个候选标 recall_source 说明它从哪条通道来。务必让 transferable_adjacent / market_pull / emerging 各至少有 1-2 个，不能整张表都是 evidence_near。

【emerging 不是只为 AI 设的，要按这个人所在领域泛化】
- 看用户证据里的 frontier_signals 与领域：把“现有能力 + 该领域正在发生的结构性变化”组合成新型复合岗位。
- 当下最常见的一类是 AI 复合岗（如 营销/增长/商业化 + AI 理解 → AI GTM / AI 产品市场 / AI 商业化运营 / AI 搜索可见性增长）；
  但务必对其它领域做【同样详细】的合成，不要只会写 AI。非 AI 同等示例：
  · 临床护士/生科 + 数据与系统 → 临床信息化协调：must=domain_knowledge(临床)≥3 + technical_delivery(EMR/系统)≥2 + operations_process(流程)≥2，market_pull=医院数字化。
  · 法务/合规 + 监管科技 → 合规科技/法务运营：must=domain_knowledge(法规)≥3 + compliance_risk≥3 + technical_delivery(工具)≥2。
  · 财务 + 自动化/数据 → FP&A 自动化：must=data_quant≥3 + domain_knowledge(财务)≥3 + technical_delivery≥2。
  · 供应链 + 可持续 → 碳核算/可持续运营：must=operations_process≥3 + data_quant≥2 + compliance_risk≥2。
  · 电工/技工 + 新能源/楼宇智能 → 光伏运维/楼宇自控：must=craft_physical≥3 + compliance_risk(规范)≥2 + operations_process≥2。
- 关键判断不是“他做过没有”，而是“他的证据能不能迁移过去 + 这个方向天花板是否更高”。

其它原则：
- 高频职业可直接复用给定 seed 的 role_id；没给到的（罕见/交叉/新兴/蓝领/受监管）即时合成同结构契约。
- 诚实标注硬门槛 hard_gates（律师/医护/教师/会计审计/工程资质等），不要为了好看省略。
- required_evidence 的 capability 只能取给定维度 id；min_strength 用 0-5；role_id 用 family.archetype 形式且稳定。
全程中文 display_name。`;

const FAST_SYSTEM = `你是职业候选召回器。给定用户能力证据与意愿，快速产出 6-8 个候选职业原型，供初版报告排序使用。
要求：
- 必须覆盖 evidence_near、user_thesis，并至少包含 1 个 transferable_adjacent / market_pull / emerging 中的高上限相邻方向。
- 候选要少而准：优先选能形成 Top 3 的方向，不要为了凑数量扩写。
- 诚实标注硬门槛 hard_gates，不要把兴趣当能力，不要发明证据。
- required_evidence.capability 只能取给定能力维度 id；role_id 用 family.archetype 形式且稳定。
全程中文 display_name。`;

export interface SynthesizeRolesOptions {
  mode?: "full" | "fast";
}

export async function synthesizeRoles(
  capabilityVector: CapabilityScore[],
  evidence: EvidenceItem[],
  inputs: UserInputs,
  marketContext = "",
  options: SynthesizeRolesOptions = {},
): Promise<{ value: RoleArchetype[]; model: string }> {
  const fast = options.mode === "fast";
  const evidenceSummary = evidence.map((e) => ({
    id: e.evidence_id,
    claim: e.claim,
    capabilities: e.capabilities,
    frontier_signals: e.frontier_signals,
    strength: e.evidence_strength,
  }));
  const frontier = [...new Set(evidence.flatMap((e) => e.frontier_signals))];

  const userText = `请为该用户做多通道候选召回，产出 ${fast ? "6-8" : "12-18"} 个候选职业原型 longlist。

能力维度 id（required_evidence.capability 只能用这些）：
${CAPABILITY_LIST_TEXT}

用户能力向量（0-1）：
${JSON.stringify(capabilityVector.map((c) => ({ id: c.capability, name: c.name_zh, score: Number(c.score.toFixed(2)), band: c.band })), null, 2)}

证据摘要（含 frontier_signals）：
${JSON.stringify(evidenceSummary, null, 2)}

汇总的前沿/新兴信号：${frontier.length ? frontier.join("、") : "（无显著前沿信号）"}

用户意愿与约束：
${JSON.stringify(inputs, null, 2)}

可直接复用的高频职业（命中就用同样的 role_id；不在列表里的请自行合成）：
${SEED_INDEX}

证据契约的结构示范（照此结构产出，但内容与召回通道要贴合本用户）：
${JSON.stringify(fast ? FAST_ANCHOR_EXAMPLES : ANCHOR_EXAMPLES, null, 2)}
${marketContext ? `\n【实时市场信号（来自联网检索，供 market_pull / emerging 召回参考；需结合用户证据判断适配，不要照单全收）】\n${marketContext}\n` : ""}
硬性要求：
- ${fast ? "覆盖 evidence_near、user_thesis，并至少给 1-2 个相邻/市场/新兴高上限方向。" : "覆盖全部 5 条召回通道；transferable_adjacent、market_pull、emerging 各至少 1-2 个。"}
- 若存在前沿/新兴信号，必须据此召回对应的“新型复合岗位”作为 emerging 候选（按用户所在领域泛化，不要只会写 AI）。
- 必须包含用户明确想要的方向（user_desired=true，recall_source=user_thesis），即使证据弱。`;

  const { value, model } = await getLlm().complete({
    system: fast ? FAST_SYSTEM : SYSTEM,
    userText,
    schema: RoleListSchema,
    schemaName: "RoleList",
    model: fast ? workerModels.synthesizeRolesFast! : workerModels.synthesizeRoles!,
    effort: fast ? "medium" : "high",
    maxTokens: fast ? 9000 : undefined,
  });

  const roles: RoleArchetype[] = value.roles.map((r) => ({
    ...r,
    origin: SEED_IDS.has(r.role_id) ? "seed" : r.user_desired ? "recall" : "synthesized",
  }));
  return { value: roles, model };
}
