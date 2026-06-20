// 对抗 review：一个 worker 推荐，另一个 worker 攻击。专门找过拟合、兴趣误判、门槛忽略、证据不支持等问题。
import { getLlm } from "../providers/llm.js";
import { RedTeamSchema } from "../schemas.js";
import { workerModels } from "../config.js";
import type { ClaimEntailment, EvidenceItem, ReviewFinding, RoleScore, Strategy } from "../types.js";

const SYSTEM = `你是 Red Team。任务不是夸奖，而是尽力反驳这份职业战略报告。从以下角度逐一攻击：
1) 是否只是关键词/经历过拟合？
2) 有没有把兴趣误判成能力？把课程项目误判成真实业务？
3) 有没有忽略硬性资格门槛？
4) 有没有给出过度乐观的主路径？有没有漏掉更现实的路径？
5) 有没有推荐用户明显不想要或约束不支持的方向？
6) 报告里说 A，但证据实际只支持 B？
7) 有没有“对谁都成立”的套话？
8) 有没有引用了不存在或不支持该结论的 evidence_id？
9) 防漏（重要）：有没有漏掉“现有证据能迁移过去、天花板更高”的相邻/新兴方向（含但不限于 AI 复合岗）？尤其是 high_ceiling / adjacent_upside 槽位是否被填得过于保守、只给了传统岗位？
10) 否定假阴性：被标为“暂不建议优先(not_recommended)”的方向，是否其实用户证据能支持、只是被刻板印象/过度保守否定了？
11) 证据蕴含：claim 引用的证据是否【真的支持】该结论（不只是 id 存在）——有没有“说 A 但引的证据其实只支持 B”。
对每个问题给出 finding、severity、是否 must_fix、受影响 role_id（无则空串）、相关 evidence_ids、以及修复建议。
默认严格：宁可多报，证据不足以支撑的主路径就标 must_fix。全程中文。`;

export async function redTeam(
  strategy: Strategy,
  scores: RoleScore[],
  evidence: EvidenceItem[],
): Promise<{ value: ReviewFinding[]; entailment: ClaimEntailment[]; model: string }> {
  const userText = `请审查以下战略报告草稿，并逐条判断 claim 的证据蕴含性。

战略草稿：
${JSON.stringify(
    {
      one_liner: strategy.one_liner,
      paths: strategy.paths,
      adjacent_upside: strategy.adjacent_upside,
      not_recommended: strategy.not_recommended,
      gap_map: strategy.gap_map,
      projects: strategy.projects,
      claims: strategy.claims,
    },
    null,
    2,
  )}

证据列表（真实存在的 id 及强度）：
${JSON.stringify(evidence.map((e) => ({ id: e.evidence_id, claim: e.claim, strength: e.evidence_strength, limitations: e.limitations })), null, 2)}

各角色未满足的硬门槛：
${JSON.stringify(scores.map((s) => ({ role_id: s.role_id, unmet: s.unmet_blocking_gates.map((g) => g.label_zh) })), null, 2)}

claim_entailment：对上面 claims 里的【每一条】判断 supported——它引用的证据是否【真的支持】该结论（不只是 id 存在）。若证据只支持更弱/不同的说法，supported=false 并在 note 写清证据实际只支持什么。`;

  const { value, model } = await getLlm().complete({
    system: SYSTEM,
    userText,
    schema: RedTeamSchema,
    schemaName: "RedTeam",
    model: workerModels.redTeam!,
    effort: "high",
  });

  const findings: ReviewFinding[] = value.findings.map((f, i) => ({
    review_id: `rt_${String(i + 1).padStart(3, "0")}`,
    reviewer: "red_team",
    finding: f.finding,
    severity: f.severity,
    affected_role_id: f.affected_role_id || undefined,
    evidence_ids: f.evidence_ids,
    recommendation: f.recommendation,
    must_fix: f.must_fix,
    resolved: false,
  }));
  const entailment: ClaimEntailment[] = (value.claim_entailment ?? []).map((e) => ({
    claim_id: e.claim_id,
    supported: e.supported,
    note: e.note,
  }));
  return { value: findings, entailment, model };
}
