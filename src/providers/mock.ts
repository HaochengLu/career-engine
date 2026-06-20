// 离线假数据：让整条流水线在没有 API key 时也能端到端跑起来（给朋友玩 / 本地自测 / 渲染调样）。
// 注意：parse / evidence / roles / strategy / redTeam 是 mock 的；capabilityVector 与 scoreRoles 是
// 真实确定性代码，会基于这里的 mock evidence + roles 真算一遍。
import seed from "../data/seed_ontology.json" with { type: "json" };

const pick = (id: string) => {
  const a = seed.archetypes.find((x) => x.role_id === id);
  if (!a) throw new Error(`mock seed missing ${id}`);
  return { ...a, user_desired: false };
};

export const MOCK: Record<string, unknown> = {
  ParseResume: {
    education: ["某大学 计算机/商科双背景 本科 2026 届"],
    experience: ["某创业公司 增长实习生 2025-06 至 2025-09：负责留存分析与内容投放"],
    projects: [
      "用 SQL + Excel 搭建留存分析 dashboard",
      "一个 AI 工具竞品调研（无 PRD）",
      "校园活动运营，自称带来增长（无量化）",
    ],
    skills: ["SQL", "Python（基础）", "Excel", "AI 工具使用", "文案"],
    certs_awards: [],
    publications_links: [],
    industries: ["互联网", "订阅业务"],
    timeline_note: "应届，1 段实习 + 数个课程/个人项目",
    quantified_results: ["留存分析（无明确业务数字）"],
    missing_or_low_confidence: ["缺少可量化业务结果", "缺少标准化作品集", "AI 相关只有工具使用记录"],
    ocr_confidence: 0.9,
  },

  EvidenceList: {
    items: [
      {
        source_ref: "Built a SQL dashboard to analyze retention…",
        claim: "做过留存分析 dashboard",
        action: "built_dashboard",
        artifact: "dashboard",
        domain: ["growth", "subscription"],
        capabilities: ["data_quant", "communication_content"],
        evidence_strength: 3,
        recency_months: 8,
        confidence: 0.8,
        limitations: ["没有明确业务结果", "没有外部链接"],
      },
      {
        source_ref: "增长实习生，内容投放",
        claim: "有真实增长/投放执行经历",
        action: "ran_growth",
        artifact: "",
        domain: ["growth"],
        capabilities: ["business_judgment", "user_client"],
        evidence_strength: 3,
        recency_months: 8,
        confidence: 0.7,
        limitations: ["无量化转化数据"],
      },
      {
        source_ref: "AI 工具竞品调研",
        claim: "对 AI 工具有调研与理解",
        action: "researched",
        artifact: "",
        domain: ["ai"],
        capabilities: ["technical_delivery", "business_judgment"],
        evidence_strength: 2,
        recency_months: 4,
        confidence: 0.55,
        limitations: ["停留在工具使用，没有产品判断/PRD"],
      },
      {
        source_ref: "校园活动运营",
        claim: "组织过活动、有执行力",
        action: "organized",
        artifact: "",
        domain: ["community"],
        capabilities: ["execution_pm", "interpersonal_influence"],
        evidence_strength: 3,
        recency_months: 14,
        confidence: 0.6,
        limitations: ["自称增长但无数据"],
      },
      {
        source_ref: "SQL / Python / Excel / 文案",
        claim: "具备基础数据与表达技能",
        action: "",
        artifact: "",
        domain: [],
        capabilities: ["data_quant", "communication_content", "technical_delivery"],
        evidence_strength: 1,
        recency_months: 2,
        confidence: 0.5,
        limitations: ["技能罗列，缺产物佐证"],
      },
    ],
  },

  RoleList: {
    roles: [
      { ...pick("product.ai_application_pm"), user_desired: true },
      { ...pick("data.business_analyst"), user_desired: false },
      { ...pick("growth.marketing"), user_desired: false },
      { ...pick("consulting.strategy"), user_desired: false },
    ],
  },

  Strategy: {
    one_liner:
      "你目前不是纯技术/纯算法候选人，而是“AI 应用型产品 / 增长候选人”：有数据理解、内容表达与项目执行，但缺可量化业务结果与标准化作品集。现阶段最适合主攻 AI 应用产品/运营，用一个可展示的 AI 产品 case 打开更高上限。",
    paths: [
      {
        rank: 1,
        role_id: "growth.marketing",
        display_name: "增长 / 数据驱动运营",
        label: "near_term",
        recommendation: "主攻",
        why_fit: "你有真实增长实习 + 留存分析，证据链在这条路上最完整。",
        have_evidence: "增长实习、留存分析 dashboard、活动运营执行。",
        missing_evidence: "可量化的增长结果、一份完整的数据复盘作品。",
        target_titles: ["Growth Associate", "Data-driven Operations", "Marketing Analyst"],
        not_recommended_when: "如果你完全不想碰投放/运营杂活。",
        top_project: "一个真实小预算增长实验 + 数据复盘报告。",
        current_fit_band: "强",
        future_band: "中",
        entry_difficulty: "低",
        confidence_band: "高",
        supporting_evidence_ids: ["ev_001", "ev_002", "ev_004"],
      },
      {
        rank: 2,
        role_id: "product.ai_application_pm",
        display_name: "AI 应用产品 / 产品运营",
        label: "high_ceiling",
        recommendation: "补强后主攻",
        why_fit: "你有技术素养 + 增长 + AI 调研，是典型 AI 应用产品的迁移来源；上限更高。",
        have_evidence: "AI 工具调研、数据理解、增长执行。",
        missing_evidence: "可展示的产品产物（PRD / 竞品分析 / demo），目前只有工具使用。",
        target_titles: ["AI Product Associate", "Product Analyst"],
        not_recommended_when: "短期想立刻拿 offer 且不愿先补作品。",
        top_project: "某行业 AI agent 应用 demo + 产品说明书 + 竞品分析。",
        current_fit_band: "中",
        future_band: "强",
        entry_difficulty: "中",
        confidence_band: "中",
        supporting_evidence_ids: ["ev_003", "ev_001"],
      },
      {
        rank: 3,
        role_id: "data.business_analyst",
        display_name: "商业 / 数据分析",
        label: "challenge",
        recommendation: "可作为备选",
        why_fit: "数据基础可迁移，但分析深度与作品尚不足。",
        have_evidence: "SQL、留存分析。",
        missing_evidence: "成体系的分析作品与统计深度。",
        target_titles: ["Data Analyst", "Business Analyst"],
        not_recommended_when: "如果不喜欢长期与数据/口径打交道。",
        top_project: "一个含业务问题+口径+SQL+决策建议的 dashboard case。",
        current_fit_band: "中",
        future_band: "中",
        entry_difficulty: "中",
        confidence_band: "中",
        supporting_evidence_ids: ["ev_001", "ev_005"],
      },
    ],
    not_recommended: [
      {
        direction: "纯咨询 / 战略",
        reasons: ["缺少结构化案例产出", "缺少强学校/公司背书", "短期投入产出比低"],
        better_strategy: "先在增长/产品建立可量化证据，再决定是否转向咨询。",
      },
    ],
    gap_map: [
      {
        gap: "缺少可量化业务结果",
        why_it_matters: "增长/商业岗看结果，不只看参与。",
        shortest_fix: "把实习经历改造成 3 个带指标的故事。",
        estimated_cost: "1-2 天",
        supporting_evidence_ids: ["ev_002"],
      },
      {
        gap: "缺少标准化作品集",
        why_it_matters: "产品/数据方向需要可展示产物。",
        shortest_fix: "做一个可公开的 case study。",
        estimated_cost: "1-2 周",
        supporting_evidence_ids: ["ev_005"],
      },
      {
        gap: "AI 只停留在工具使用",
        why_it_matters: "会被判定为兴趣而非产品能力。",
        shortest_fix: "做一个 AI 应用 demo + 产品说明书。",
        estimated_cost: "1-2 周",
        supporting_evidence_ids: ["ev_003"],
      },
    ],
    projects: [
      {
        name: "AI 应用 demo + 产品说明书",
        target_role: "AI 应用产品 / 增长",
        proves: "产品判断 + 技术素养 + 用户场景",
        deliverable: "可点开的 demo + 1 页 PRD + 竞品分析",
        min_bar: "能讲清要解决谁的什么问题、为什么这么做",
        bonus_bar: "有真实用户试用反馈",
        resume_bullet: "独立设计并实现某行业 AI 助手 demo，输出 PRD 与竞品分析。",
        interview_pitch: "从用户问题出发，讲清场景、取舍与指标。",
      },
    ],
    narrative_rewrite: [
      "把“做过留存分析”改成“通过留存分析定位 X 问题并提出 Y 改进，对应指标 Z（如有）”。",
      "把“使用 AI 工具”升级为“基于 AI 工具完成了某产品判断/竞品结论”。",
    ],
    thirty_day_plan: [
      "第 1 周：把实习经历重写成 3 个带指标的故事。",
      "第 2-3 周：做 AI 应用 demo + PRD。",
      "第 4 周：整理 case study，投增长/AI 产品岗。",
    ],
    adjacent_upside: {
      role_id: "growth.ai_gtm",
      display_name: "AI GTM / AI 增长营销",
      why: "你已有增长执行 + 数据理解 + AI 工具调研，迁移到“用 AI 驱动获客增长/商业化”的天花板明显高于传统数字营销。",
      what_to_build: "做一个用 AI 工具完成的获客/内容增长实验，量化 ROI，形成可展示 case。",
      supporting_evidence_ids: ["ev_002", "ev_003"],
    },
    strategy_card: {
      main_path: "增长 / 数据驱动运营",
      secondary_path: "AI 应用产品 / 运营",
      challenge_path: "商业 / 数据分析",
      not_recommended: "纯咨询 / 战略",
      core_selling_point: "技术素养 + 增长执行 + AI 理解的复合背景",
      biggest_gap: "缺可量化结果与标准化作品",
      most_important_30d: "做出 1 个可展示的 AI 产品 case 并量化实习结果",
    },
    claims: [
      {
        claim_id: "claim_001",
        text: "你更像 AI 应用型产品/增长候选人，而不是纯算法候选人。",
        supporting_evidence_ids: ["ev_001", "ev_002", "ev_003"],
        counter_evidence_ids: ["ev_005"],
        confidence: 0.76,
        risk: "AI 相关证据偏弱，不能把工具使用误判成算法能力。",
      },
    ],
  },

  RoleListScout: {
    // mock 下假设主召回已覆盖，不额外补；真实 provider 会按需补漏。
    roles: [],
  },

  RedTeam: {
    claim_entailment: [{ claim_id: "claim_001", supported: true, note: "" }],
    findings: [
      {
        finding: "AI 应用产品被列为补强后主攻，但用户目前只有 AI 工具使用记录，没有任何产品 artifact。",
        severity: "medium",
        affected_role_id: "product.ai_application_pm",
        evidence_ids: ["ev_003"],
        recommendation: "保持为 high_ceiling 而非近期主攻；补一个 PRD/demo 后再升级。",
        must_fix: false,
      },
    ],
  },
};
