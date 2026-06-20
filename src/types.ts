// 核心领域类型。所有 worker 的输入/输出都结构化，彼此可校验。

export type Tier = "trial" | "full";
export type Lang = "zh" | "en";

export type ReportStatus =
  | "submitted"
  | "assets_uploaded"
  | "parsed"
  | "evidence_extracted"
  | "roles_synthesized"
  | "roles_scored"
  | "strategy_drafted"
  | "red_team_reviewed"
  | "qa_passed"
  | "rendered"
  | "feedback_received"
  // 失败/兜底
  | "parse_failed"
  | "insufficient_input"
  | "review_failed"
  | "render_failed"
  | "failed";

export interface UserInputs {
  target_locations?: string[];
  target_countries?: string[];
  desired_roles?: string[];
  avoid_roles?: string[];
  school?: string;
  major?: string;
  grade_or_years?: string;
  constraints?: string[]; // 自由文本约束：签证/收入/是否读研/时间预算/是否接受转行等
  declared_goal?: "stable" | "upside" | "balance"; // 求稳 / 求上限 / 均衡——决定排序权重
  notes?: string;
}

// ---- 简历解析 ----
export interface ParsedResume {
  education: string[];
  experience: string[];
  projects: string[];
  skills: string[];
  certs_awards: string[];
  publications_links: string[];
  industries: string[];
  timeline_note: string;
  quantified_results: string[];
  missing_or_low_confidence: string[];
  ocr_confidence: number; // 0-1
}

// ---- 证据图谱 ----
export interface EvidenceItem {
  evidence_id: string;
  source_ref: string; // 原文片段或来源描述
  claim: string;
  action?: string;
  artifact?: string;
  domain?: string[];
  capabilities: string[]; // capability_dimensions 的 id
  // 前沿/新兴信号（开放词表，不写死）：用于召回“相邻高上限/新型复合岗位”，避免新兴证据被当成传统岗位证据。
  // 不限定领域：当下 AI 相关最常见（如 ai_gtm / ai_search_visibility / commercial_ai_adoption），
  // 但同样适用于任何行业的新兴信号（如 临床信息化、碳核算、跨境合规、新渠道增长 等）。由模型按证据自行命名。
  frontier_signals: string[];
  evidence_strength: number; // 0-5
  recency_months?: number; // 距今月份，未知则 undefined
  confidence: number; // 0-1
  limitations: string[];
}

export interface CapabilityScore {
  capability: string;
  name_zh: string;
  // 0-1，由证据 strength 加权聚合
  score: number;
  band: "强" | "中" | "弱";
  top_evidence_ids: string[];
}

// ---- 职业本体（按需合成 + 种子锚点共用同一结构）----
export interface RequiredEvidenceItem {
  key: string;
  label_zh: string;
  capability: string; // 必须是 capability_dimensions 的 id
  min_strength: number; // 0-5
}

export interface HardGate {
  key: string;
  label_zh: string;
  type: "credential" | "license" | "degree" | "experience" | "visa" | "physical" | "portfolio" | "other";
  blocking: boolean;
  can_be_acquired: "short" | "medium" | "long" | "no";
}

export interface RoleArchetype {
  role_id: string;
  role_family: string;
  display_name: string;
  target_titles: string[];
  required_evidence: {
    must_have: RequiredEvidenceItem[];
    should_have: RequiredEvidenceItem[];
    nice_to_have: RequiredEvidenceItem[];
  };
  hard_gates: HardGate[];
  transferable_sources: string[];
  common_false_positives: string[];
  gap_projects: string[];
  market_notes: {
    time_horizon: "short" | "medium" | "long";
    automation_exposure: "augmented" | "resilient" | "exposed" | "unknown";
    entry_risk: "low" | "medium" | "high";
  };
  traits?: Record<string, unknown>;
  // 合成来源：seed=种子锚点命中；synthesized=即时生成；recall=用户明确想要而反向召回
  origin: "seed" | "synthesized" | "recall";
  // 召回通道（多通道召回，避免只看“当前最像”而漏掉相邻高上限/新兴方向）：
  // evidence_near=证据最相近；transferable_adjacent=可迁移相邻跃迁；market_pull=市场拉动；
  // user_thesis=用户明确想要；emerging=新兴/前沿高上限
  recall_source?: "evidence_near" | "transferable_adjacent" | "market_pull" | "user_thesis" | "emerging";
  // 是否来自用户明确想要的方向
  user_desired?: boolean;
}

// ---- 评分 ----
export interface CoverageDetail {
  key: string;
  label_zh: string;
  covered: number; // 0-1，按证据 strength 加权
  matched_evidence_ids: string[];
}

export interface RoleScore {
  role_id: string;
  display_name: string;
  recall_source?: RoleArchetype["recall_source"];
  // 所有分数 0-1（内部使用，不向用户展示两位数）
  current_fit: number;
  evidence_trust: number;
  entry_feasibility: number;
  market_potential: number;
  market_potential_confidence: number;
  differentiation: number;
  constraint_fit: number;
  gap_cost: number; // 信息项（缺口说明用），不进决策分
  gate_risk: number; // 信息项
  decision_score: number;
  confidence: number;
  // 可解释性
  coverage: {
    must_have: CoverageDetail[];
    should_have: CoverageDetail[];
    nice_to_have: CoverageDetail[];
  };
  unmet_blocking_gates: HardGate[];
  notes: string[];
}

// ---- 战略与缺口 ----
export type PathLabel = "near_term" | "high_ceiling" | "challenge" | "transition" | "not_recommended";

export interface ReportClaim {
  claim_id: string;
  text: string;
  supporting_evidence_ids: string[];
  counter_evidence_ids: string[];
  confidence: number;
  risk?: string;
}

export interface GapMapItem {
  gap: string;
  why_it_matters: string;
  shortest_fix: string;
  estimated_cost: string;
  supporting_evidence_ids: string[]; // 哪些证据说明这个缺口存在（可为空=由硬门槛/缺失推断）
}

export interface ProjectSuggestion {
  name: string;
  target_role: string;
  proves: string;
  deliverable: string;
  min_bar: string;
  bonus_bar: string;
  resume_bullet: string;
  interview_pitch: string;
}

export interface PathEntry {
  rank: number;
  role_id: string;
  display_name: string;
  label: PathLabel;
  recommendation: string; // 主攻/补强后主攻/不作为近期主线 等
  why_fit: string;
  have_evidence: string;
  missing_evidence: string;
  target_titles: string[];
  not_recommended_when: string;
  top_project: string;
  current_fit_band: "强" | "中" | "弱";
  future_band: "强" | "中" | "弱";
  entry_difficulty: "低" | "中" | "高";
  confidence_band: "高" | "中" | "低";
  supporting_evidence_ids: string[];
}

export interface Strategy {
  one_liner: string; // 一句话职业画像
  paths: PathEntry[];
  not_recommended: {
    direction: string;
    reasons: string[];
    better_strategy: string;
  }[];
  gap_map: GapMapItem[];
  projects: ProjectSuggestion[];
  narrative_rewrite: string[];
  thirty_day_plan: string[];
  // 高上限相邻路径（不是近期最现实，但证据 + 市场拉动支持其成为更高天花板的方向）。
  // 通用槽位：对不同背景的人，这里可能是 AI 复合岗、也可能是其它新兴/相邻高上限方向。
  adjacent_upside: {
    role_id: string;
    display_name: string;
    why: string;
    what_to_build: string;
    supporting_evidence_ids: string[];
  };
  strategy_card: {
    main_path: string;
    secondary_path: string;
    challenge_path: string;
    not_recommended: string;
    core_selling_point: string;
    biggest_gap: string;
    most_important_30d: string;
  };
  claims: ReportClaim[];
}

// ---- 对抗 review ----
export interface ReviewFinding {
  review_id: string;
  reviewer: "red_team" | "qa" | "human";
  finding: string;
  severity: "low" | "medium" | "high";
  affected_role_id?: string;
  evidence_ids: string[];
  recommendation: string;
  must_fix: boolean;
  resolved?: boolean;
}

export interface ClaimEntailment {
  claim_id: string;
  supported: boolean;
  note: string;
}

// ---- worker 元数据（可复盘/回归）----
export interface WorkerMeta {
  worker_name: string;
  worker_version: string;
  model: string;
  created_at: string;
  confidence?: number;
}

// 渲染所需的轻量元信息（同步流程，不依赖任何存储）
export interface ReportMeta {
  tier: Tier;
  createdAt: string;
  status: ReportStatus;
  error?: string;
}

// ---- 全流程产物（渲染用）----
export interface ReportArtifacts {
  user_inputs: UserInputs;
  parsed?: ParsedResume;
  evidence?: EvidenceItem[];
  capability_vector?: CapabilityScore[];
  roles?: RoleArchetype[];
  scores?: RoleScore[];
  strategy?: Strategy;
  findings?: ReviewFinding[];
  qa?: { passed: boolean; issues: string[] };
  insufficient_reason?: string;
  overall_confidence?: number; // 证据平均置信，整体可信度的粗略指标
  worker_log: WorkerMeta[];
}
