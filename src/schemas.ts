import { z } from "zod";
import { CAPABILITY_IDS } from "./core/rubric.js";

const capabilityEnum = z.enum(CAPABILITY_IDS as [string, ...string[]]);

// ---- parseResume ----
export const ParseResumeSchema = z.object({
  education: z.array(z.string()),
  experience: z.array(z.string()),
  projects: z.array(z.string()),
  skills: z.array(z.string()),
  certs_awards: z.array(z.string()),
  publications_links: z.array(z.string()),
  industries: z.array(z.string()),
  timeline_note: z.string(),
  quantified_results: z.array(z.string()),
  missing_or_low_confidence: z.array(z.string()),
  ocr_confidence: z.number().describe("0-1，OCR/识别清晰度；图片模糊或信息少要给低值"),
});

// ---- extractEvidence（不含 evidence_id，由代码分配）----
const EvidenceItemSchema = z.object({
  source_ref: z.string().describe("原文片段或来源描述"),
  claim: z.string().describe("这条证据说明用户做过/具备什么"),
  action: z.string().describe("核心动作，没有则空串"),
  artifact: z.string().describe("产物类型，没有则空串"),
  domain: z.array(z.string()),
  capabilities: z.array(capabilityEnum).describe("命中的能力维度 id"),
  frontier_signals: z
    .array(z.string())
    .describe(
      "前沿/新兴信号标签（开放词表，没有就给空数组）。用于召回相邻高上限/新型复合岗位。当下 AI 相关最常见（如 ai_gtm、ai_search_visibility、commercial_ai_adoption、ai_content_ops），也可是任何行业的新兴信号；按证据自行命名，snake_case",
    ),
  evidence_strength: z.number().int().describe("0-5，严格按 rubric"),
  recency_months: z.number().int().describe("距今月份；未知填 -1"),
  confidence: z.number().describe("0-1，对该证据真实性/可核实性的置信"),
  limitations: z.array(z.string()),
});
export const EvidenceListSchema = z.object({ items: z.array(EvidenceItemSchema) });

// ---- synthesizeRoles ----
const RequiredEvidenceSchema = z.object({
  key: z.string(),
  label_zh: z.string(),
  capability: capabilityEnum,
  min_strength: z.number().int().describe("0-5"),
});
const HardGateSchema = z.object({
  key: z.string(),
  label_zh: z.string(),
  type: z.enum(["credential", "license", "degree", "experience", "visa", "physical", "portfolio", "other"]),
  blocking: z.boolean(),
  can_be_acquired: z.enum(["short", "medium", "long", "no"]),
});
const RoleSchema = z.object({
  role_id: z.string().describe("形如 family.archetype 的稳定标识"),
  role_family: z.string(),
  display_name: z.string(),
  target_titles: z.array(z.string()),
  required_evidence: z.object({
    must_have: z.array(RequiredEvidenceSchema),
    should_have: z.array(RequiredEvidenceSchema),
    nice_to_have: z.array(RequiredEvidenceSchema),
  }),
  hard_gates: z.array(HardGateSchema),
  transferable_sources: z.array(z.string()),
  common_false_positives: z.array(z.string()),
  gap_projects: z.array(z.string()),
  market_notes: z.object({
    time_horizon: z.enum(["short", "medium", "long"]),
    automation_exposure: z.enum(["augmented", "resilient", "exposed", "unknown"]),
    entry_risk: z.enum(["low", "medium", "high"]),
  }),
  user_desired: z.boolean().describe("是否来自用户明确想要的方向"),
  recall_source: z
    .enum(["evidence_near", "transferable_adjacent", "market_pull", "user_thesis", "emerging"])
    .describe("该候选通过哪条召回通道进来"),
});
export const RoleListSchema = z.object({ roles: z.array(RoleSchema) });

// ---- strategy ----
const bandZh = z.enum(["强", "中", "弱"]);
const PathEntrySchema = z.object({
  rank: z.number().int(),
  role_id: z.string(),
  display_name: z.string(),
  label: z.enum(["near_term", "high_ceiling", "challenge", "transition", "not_recommended"]),
  recommendation: z.string(),
  why_fit: z.string(),
  have_evidence: z.string(),
  missing_evidence: z.string(),
  target_titles: z.array(z.string()),
  not_recommended_when: z.string(),
  top_project: z.string(),
  current_fit_band: bandZh,
  future_band: bandZh,
  entry_difficulty: z.enum(["低", "中", "高"]),
  confidence_band: z.enum(["高", "中", "低"]),
  supporting_evidence_ids: z.array(z.string()),
});
export const StrategySchema = z.object({
  one_liner: z.string().describe("一句话职业画像"),
  paths: z.array(PathEntrySchema).describe("3 条主路径"),
  not_recommended: z.array(
    z.object({
      direction: z.string(),
      reasons: z.array(z.string()),
      better_strategy: z.string(),
    }),
  ),
  gap_map: z.array(
    z.object({
      gap: z.string(),
      why_it_matters: z.string(),
      shortest_fix: z.string(),
      estimated_cost: z.string(),
      supporting_evidence_ids: z.array(z.string()).describe("哪些证据表明该缺口存在；若是由硬门槛/完全缺失推断则可为空数组"),
    }),
  ),
  projects: z.array(
    z.object({
      name: z.string(),
      target_role: z.string(),
      proves: z.string(),
      deliverable: z.string(),
      min_bar: z.string(),
      bonus_bar: z.string(),
      resume_bullet: z.string(),
      interview_pitch: z.string(),
    }),
  ),
  narrative_rewrite: z.array(z.string()),
  thirty_day_plan: z.array(z.string()),
  adjacent_upside: z
    .object({
      role_id: z.string(),
      display_name: z.string(),
      why: z.string().describe("为什么这是高上限的相邻方向（结合证据 + 市场拉动）"),
      what_to_build: z.string().describe("把它从相邻变成可冲，最该补的一个证据/项目"),
      supporting_evidence_ids: z.array(z.string()),
    })
    .describe("高上限相邻路径：不一定是近期最现实，但天花板更高、且有证据可迁移过去"),
  strategy_card: z.object({
    main_path: z.string(),
    secondary_path: z.string(),
    challenge_path: z.string(),
    not_recommended: z.string(),
    core_selling_point: z.string(),
    biggest_gap: z.string(),
    most_important_30d: z.string(),
  }),
  claims: z.array(
    z.object({
      claim_id: z.string(),
      text: z.string(),
      supporting_evidence_ids: z.array(z.string()),
      counter_evidence_ids: z.array(z.string()),
      confidence: z.number(),
      risk: z.string(),
    }),
  ),
});

// ---- redTeam ----
export const RedTeamSchema = z.object({
  findings: z.array(
    z.object({
      finding: z.string(),
      severity: z.enum(["low", "medium", "high"]),
      affected_role_id: z.string().describe("无则空串"),
      evidence_ids: z.array(z.string()),
      recommendation: z.string(),
      must_fix: z.boolean(),
    }),
  ),
  // 逐条判断 claim 是否真被其引用证据【蕴含/支持】（不只是 id 存在）。
  claim_entailment: z.array(
    z.object({
      claim_id: z.string(),
      supported: z.boolean().describe("引用的证据是否真的支持该结论"),
      note: z.string().describe("不支持时说明：证据实际只支持什么"),
    }),
  ),
});

export type ParseResumeOut = z.infer<typeof ParseResumeSchema>;
export type EvidenceListOut = z.infer<typeof EvidenceListSchema>;
export type RoleListOut = z.infer<typeof RoleListSchema>;
export type StrategyOut = z.infer<typeof StrategySchema>;
export type RedTeamOut = z.infer<typeof RedTeamSchema>;
