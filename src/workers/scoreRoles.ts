// 确定性评分：把“证据 × 职业证据契约”算成可解释的分数。
// 立场：分数来自【证据覆盖度】，不是关键词命中；所有系数/阈值来自 scoring_weights.json（显式先验，可校准）。
// 这套公式对任何 synthesizeRoles 即时生成的契约一视同仁——泛化来自统一算法，而非给每个岗位写规则。
import { WEIGHTS } from "../config.js";
import { combine, evidenceContribution, strengthValue, recencyFactor } from "./capabilityVector.js";
import type {
  CoverageDetail,
  EvidenceItem,
  HardGate,
  RequiredEvidenceItem,
  RoleArchetype,
  RoleScore,
  UserInputs,
} from "../types.js";

const ACQUISITION_COST: Record<HardGate["can_be_acquired"], number> = {
  short: 0.15,
  medium: 0.45,
  long: 0.85,
  no: 1.0,
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// 把门槛/约束标签拆成可比对的关键词（≥2 字），用于结构化判定而非整串 includes。
function keywords(label: string): string[] {
  return label
    .split(/[/、，,；;（）()\s|]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

// 覆盖度质量门：covered 不仅看数量(combine)，还要看最强证据质量，防止弱证据堆量撑高覆盖度。
function qualityGate(covered: number, maxStrength: number, strict: boolean): number {
  const g = WEIGHTS.coverage_quality_gate;
  if (maxStrength <= 1) return Math.min(covered, g.weak_cap);
  if (maxStrength < g.medium_min_strength) return Math.min(covered, g.weak_cap);
  // 受监管职业(执照/学历/资格)：没有可展示/外部验证级证据，覆盖度封到 weak——这类岗位对证据要求本就更高。
  if (strict && maxStrength < g.strong_min_strength) return Math.min(covered, g.weak_cap);
  if (maxStrength < g.strong_min_strength) return Math.min(covered, g.mid_cap);
  return covered;
}

function coverItem(item: RequiredEvidenceItem, evidence: EvidenceItem[], strict: boolean): CoverageDetail {
  const matches = evidence.filter(
    (e) => e.capabilities.includes(item.capability) && e.evidence_strength >= item.min_strength,
  );
  const maxStrength = matches.reduce((m, e) => Math.max(m, e.evidence_strength), 0);
  const raw = combine(matches.map(evidenceContribution));
  return {
    key: item.key,
    label_zh: item.label_zh,
    covered: qualityGate(raw, maxStrength, strict),
    matched_evidence_ids: matches.map((e) => e.evidence_id),
  };
}

function tierMean(details: CoverageDetail[]): number {
  if (details.length === 0) return 1;
  return details.reduce((s, d) => s + d.covered, 0) / details.length;
}

function tierBottleneck(details: CoverageDetail[]): number {
  if (details.length === 0) return 1;
  const eps = 0.02;
  const logSum = details.reduce((s, d) => s + Math.log(Math.max(eps, d.covered)), 0);
  return Math.exp(logSum / details.length);
}

// 硬门槛是否已满足：只有“可展示/外部验证级(≥require_strength)且文本对得上”的证据，或事实性输入字段明确写明，
// 才算已具备资质。仅“提及/想做”(低强度或写在 desired/avoid 里)不算——宁可把门槛显式暴露，也不误判已满足。
// 公平性：绝不把名校/名企背书(credible_endorsement)当作满足执照/学历门槛。
function gateMet(gate: HardGate, evidence: EvidenceItem[], inputs: UserInputs): boolean {
  const kws = keywords(gate.label_zh);
  if (kws.length === 0) return false;
  const minS = WEIGHTS.gate.require_strength;
  const strongText = evidence
    .filter((e) => e.evidence_strength >= minS)
    .map((e) => `${e.claim} ${e.source_ref}`)
    .join(" ")
    .toLowerCase();
  // 事实性输入字段（学校/专业/补充说明/约束）——不含 desired/avoid（那是目标而非已具备）
  const factual = [inputs.school, inputs.major, inputs.grade_or_years, inputs.notes, ...(inputs.constraints ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return kws.some((k) => strongText.includes(k.toLowerCase()) || factual.includes(k.toLowerCase()));
}

function constraintFit(role: RoleArchetype, inputs: UserInputs): { value: number; avoided: boolean } {
  const c = WEIGHTS.constraint_fit;
  const name = (role.display_name + " " + role.role_family + " " + role.target_titles.join(" ")).toLowerCase();
  const fam = role.role_family.toLowerCase();
  const hit = (terms: string[]) => terms.some((t) => t && (name.includes(t) || fam.includes(t)));
  const avoid = (inputs.avoid_roles ?? []).map((s) => s.toLowerCase());
  const desired = (inputs.desired_roles ?? []).map((s) => s.toLowerCase());
  // 用户明确想要 > 避免：若同时命中 desired 与 avoid，以 desired 为准。
  if (role.user_desired || hit(desired)) return { value: c.desired, avoided: false };
  if (hit(avoid)) return { value: c.avoid, avoided: true };
  return { value: c.neutral, avoided: false };
}

function marketPotential(): { value: number; confidence: number } {
  // 诚实：系统无法可信预测市场潜力。固定中性 + 低置信，不做任何方向性偏移。
  // 真正的市场拉动通过 synthesizeRoles 的 market_pull/emerging 召回通道与 adjacent_upside 体现。
  return { value: WEIGHTS.market_potential_default.neutral, confidence: WEIGHTS.market_potential_default.confidence };
}

export function scoreRoles(
  roles: RoleArchetype[],
  evidence: EvidenceItem[],
  inputs: UserInputs,
): RoleScore[] {
  const profiles = WEIGHTS.order_profiles as unknown as Record<string, Record<string, number>>;
  const goal = inputs.declared_goal ?? "balance";
  const w = profiles[goal] ?? profiles.balance!;
  const cf = WEIGHTS.current_fit;
  const et = WEIGHTS.evidence_trust;
  const recallBoost = WEIGHTS.differentiation.recall_source_boost as unknown as Record<string, number>;

  const scored = roles.map((role) => {
    // 受监管职业（执照/学历/资格门槛）对证据要求更高，覆盖度质量门更严。
    const strict = role.hard_gates.some((g) => g.type === "license" || g.type === "credential" || g.type === "degree");
    const must = role.required_evidence.must_have.map((i) => coverItem(i, evidence, strict));
    const should = role.required_evidence.should_have.map((i) => coverItem(i, evidence, strict));
    const nice = role.required_evidence.nice_to_have.map((i) => coverItem(i, evidence, strict));

    // 全部匹配证据（含 nice），用于整体置信度 baseConf。
    const matchedIds = new Set([...must, ...should, ...nice].flatMap((d) => d.matched_evidence_ids));
    const matchedEvidence = evidence.filter((e) => matchedIds.has(e.evidence_id));

    // 因子1：当前匹配度。只在【存在要求】的档位间按权重归一化——空档位不当作“自动满足=1”，
    // 避免没有 must/should/nice 要求时虚高（修 tier 空数组返回 1 的膨胀问题）。
    const tiers = [
      { w: cf.must_have, v: tierBottleneck(must), n: must.length },
      { w: cf.should_have, v: tierMean(should), n: should.length },
      { w: cf.nice_to_have, v: tierMean(nice), n: nice.length },
    ].filter((t) => t.n > 0);
    const wsum = tiers.reduce((s, t) => s + t.w, 0);
    const current_fit = wsum ? clamp01(tiers.reduce((s, t) => s + t.w * t.v, 0) / wsum) : 0;

    // 因子2：证据可信度 = 以【必需/加分档(must+should)】证据为主（reflect 真正支撑该角色的证据质量），
    // 仅当完全没有 must/should 证据时才回退到 nice（避免 0.05 断崖）。以最强为主 + 少量印证 + 时效折扣。
    const primaryIds = new Set([...must, ...should].flatMap((d) => d.matched_evidence_ids));
    let trustEv = evidence.filter((e) => primaryIds.has(e.evidence_id));
    if (trustEv.length === 0) {
      const niceIds = new Set(nice.flatMap((d) => d.matched_evidence_ids));
      trustEv = evidence.filter((e) => niceIds.has(e.evidence_id));
    }
    const sv = trustEv.map((e) => strengthValue(e.evidence_strength) * recencyFactor(e.recency_months));
    const evidence_trust = sv.length
      ? clamp01(et.max_weight * Math.max(...sv) + et.mean_weight * (sv.reduce((a, b) => a + b, 0) / sv.length))
      : et.no_evidence;

    // 因子3：入门可行性 = 硬门槛驱动（与 current_fit 正交，不再混入 must 缺口=gap_cost，避免双重计算）。
    // gatePenalty 已经用 ACQUISITION_COST 编码了取得门槛的难度(short..no=0.15..1.0)，所以只算一次即可，
    // 不再额外乘 hard_block_penalty（那是对同一维度的二次惩罚）。
    const unmet_blocking_gates = role.hard_gates.filter((g) => g.blocking && !gateMet(g, evidence, inputs));
    const ef = WEIGHTS.entry_feasibility;
    const gatePenalty = unmet_blocking_gates.length
      ? Math.max(...unmet_blocking_gates.map((g) => ACQUISITION_COST[g.can_be_acquired]))
      : ef.gate_penalty_floor;
    const entry_feasibility = clamp01(1 - gatePenalty);

    // 因子4：差异化 = 稀缺性，role-specific 前沿匹配 + 召回通道；不混 should
    const dw = WEIGHTS.differentiation;
    const roleCaps = new Set([...role.required_evidence.must_have, ...role.required_evidence.should_have].map((i) => i.capability));
    const roleFrontier = evidence.some((e) => e.frontier_signals.length > 0 && e.capabilities.some((c) => roleCaps.has(c)));
    const differentiation = clamp01(
      dw.base + (roleFrontier ? dw.frontier_boost : 0) + (role.recall_source ? recallBoost[role.recall_source] ?? 0 : 0),
    );

    // 因子5：约束适配
    const cfr = constraintFit(role, inputs);
    const constraint_fit = cfr.value;

    // 决策分 = 5 个正交因子加权（权重和=1，天然 0-1，无需归一化技巧）
    let decision_score = clamp01(
      (w.current_fit ?? 0) * current_fit +
        (w.evidence_trust ?? 0) * evidence_trust +
        (w.entry_feasibility ?? 0) * entry_feasibility +
        (w.differentiation ?? 0) * differentiation +
        (w.constraint_fit ?? 0) * constraint_fit,
    );
    // 硬门槛否决：存在短期内无法取得的阻塞门槛(long/no)的方向，无论证据多匹配都不应排到前列——
    // 硬约束是 veto，不是可被高 current_fit 淹没的软加权。封顶到 veto_ceiling。
    const hardBlock = unmet_blocking_gates.some((g) => g.can_be_acquired === "long" || g.can_be_acquired === "no");
    if (hardBlock) decision_score = Math.min(decision_score, WEIGHTS.gate.veto_ceiling);
    // 用户明确不想要的方向：veto 封顶，可靠地踢出推荐（尊重“我不想做 AI/某方向”）。
    if (cfr.avoided) decision_score = Math.min(decision_score, WEIGHTS.constraint_fit.avoid_veto_ceiling);

    // 信息项（仅供报告解释，不进决策分）
    const gc = WEIGHTS.gap_cost;
    const uncoveredMust = must.filter((d) => d.covered < gc.uncovered_must_threshold).length;
    const mustFraction = must.length ? uncoveredMust / must.length : 0;
    const gap_cost = clamp01(gc.must_weight * mustFraction + gc.gate_weight * gatePenalty);
    const mp = marketPotential();

    const baseConf = matchedEvidence.length
      ? matchedEvidence.reduce((s, e) => s + e.confidence, 0) / matchedEvidence.length
      : WEIGHTS.no_evidence_base_confidence;
    const cc = WEIGHTS.confidence_calculation;
    const confidence = clamp01(baseConf * (cc.base_floor + cc.must_bottleneck_weight * tierBottleneck(must)));

    const notes: string[] = [];
    if (unmet_blocking_gates.length) {
      notes.push(`存在未满足的硬门槛：${unmet_blocking_gates.map((g) => g.label_zh).join("；")}`);
    }
    if (current_fit < 0.4 && role.user_desired) {
      notes.push("用户明确想要，但当前证据明显不足，属于挑战/长期路径。");
    }

    return {
      role_id: role.role_id,
      display_name: role.display_name,
      recall_source: role.recall_source,
      current_fit,
      evidence_trust,
      entry_feasibility,
      market_potential: mp.value,
      market_potential_confidence: mp.confidence,
      differentiation,
      constraint_fit,
      gap_cost,
      gate_risk: gatePenalty,
      decision_score,
      confidence,
      coverage: { must_have: must, should_have: should, nice_to_have: nice },
      unmet_blocking_gates,
      notes,
    } satisfies RoleScore;
  });

  return scored.sort((a, b) => b.decision_score - a.decision_score);
}
