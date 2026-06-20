import { getLlm } from "../providers/llm.js";
import { EvidenceListSchema } from "../schemas.js";
import { workerModels } from "../config.js";
import { CAPABILITY_LIST_TEXT, EVIDENCE_STRENGTH_RUBRIC } from "../core/rubric.js";
import type { EvidenceItem, ParsedResume, UserInputs } from "../types.js";

const SYSTEM = `你是“证据抽取 + 证据评级”一体的 worker。把简历拆成最小单元 EvidenceItem，并按统一 rubric 给每条证据打强度与置信。
铁律：
- 一条证据 = 一件可独立判断的事，不要把一段经历笼统塞成一条。
- 证据强度严格按 rubric；宁可保守，绝不把“写了技能/有兴趣”当强证据。
- 不发明任何材料里没有的经历；不确定就在 limitations 写清并降 confidence。
- capabilities 只能取给定维度 id。
- frontier_signals：识别“前沿/新兴信号”并打标签，避免新兴证据被埋没成普通传统岗位证据。不是只为 AI 设的，按这几类（snake_case）：
  · AI/数据（最常见）：ai_gtm（用 AI 做素材/投放看 ROI）、ai_search_visibility（大模型搜索/GEO）、commercial_ai_adoption（把 AI 用进商业化）、ai_content_ops、ai_data_analysis。
  · 制造/运营：smart_manufacturing、industry_40、new_energy_ops（光伏/储能运维）、supply_chain_digitization。
  · 医疗/生科：clinical_informatics（临床信息化）、telehealth、health_data_compliance。
  · 法律/财务/供应链：regtech_compliance（合规科技）、fpna_automation（财务自动化）、carbon_accounting（碳核算）、cross_border_growth（跨境新渠道）。
  按证据真实情况命名；没有就给空数组，不要硬凑。
- 领域语境：用用户补充信息里的 industries/major/notes 作为行业语境去理解专业术语（如制造、医疗、法律、能源的行话），不要因为不熟悉就低估证据强度。
- 隐私：若简历里出现手机号/邮箱/身份证号/护照号等个人敏感信息，在 claim 与 source_ref 里一律用「[已隐藏]」代替，绝不原样写出。
全程使用中文。`;

export async function extractEvidence(
  parsed: ParsedResume,
  inputs: UserInputs,
): Promise<{ value: EvidenceItem[]; model: string }> {
  const userText = `下面是已解析的简历结构与用户补充信息。请抽取证据项并逐条评级。

能力维度（capabilities 只能用这些 id）：
${CAPABILITY_LIST_TEXT}

${EVIDENCE_STRENGTH_RUBRIC}

已解析简历：
${JSON.stringify(parsed, null, 2)}

用户补充信息：
${JSON.stringify(inputs, null, 2)}

要求：输出一组 EvidenceItem。recency_months 未知填 -1。`;

  const { value, model } = await getLlm().complete({
    system: SYSTEM,
    userText,
    schema: EvidenceListSchema,
    schemaName: "EvidenceList",
    model: workerModels.extractEvidence!,
    effort: "high",
  });

  const items: EvidenceItem[] = value.items.map((it, i) => ({
    evidence_id: `ev_${String(i + 1).padStart(3, "0")}`,
    source_ref: it.source_ref,
    claim: it.claim,
    action: it.action || undefined,
    artifact: it.artifact || undefined,
    domain: it.domain,
    capabilities: it.capabilities,
    frontier_signals: it.frontier_signals ?? [],
    evidence_strength: clamp(it.evidence_strength, 0, 5),
    recency_months: it.recency_months >= 0 ? it.recency_months : undefined,
    confidence: clamp(it.confidence, 0, 1),
    limitations: it.limitations,
  }));
  return { value: items, model };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
