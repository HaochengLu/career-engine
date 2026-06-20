// 确定性代码：把证据图谱聚合成能力向量。无 LLM、可复现、可解释。
import { WEIGHTS } from "../config.js";
import { CAPABILITY_DIMENSIONS } from "../core/rubric.js";
import type { CapabilityScore, EvidenceItem } from "../types.js";

const STRENGTH_VALUE = WEIGHTS.evidence_strength_value as unknown as Record<string, number>;

export function strengthValue(strength: number): number {
  return STRENGTH_VALUE[String(Math.round(strength))] ?? 0;
}

export function recencyFactor(months?: number): number {
  if (months === undefined || months < 0) return 1;
  const { half_life_months, floor } = WEIGHTS.recency;
  return Math.max(floor, Math.pow(0.5, months / half_life_months));
}

// 单条证据对某能力的“贡献值” 0-1
export function evidenceContribution(e: EvidenceItem): number {
  return strengthValue(e.evidence_strength) * recencyFactor(e.recency_months) * e.confidence;
}

// 分档 = 数量(score) × 质量门(maxStrength)。根因修复：combine() 在证据多时会饱和，
// 若只看 score，任何被 3+ 条项目级证据碰到的维度都会变“强”。所以加质量门：
// 强必须有≥1条可展示产物/外部验证；中必须有≥1条项目级；仅自称(≤1)一律弱。
function band(score: number, maxStrength: number): "强" | "中" | "弱" {
  const b = WEIGHTS.bands;
  let r: "强" | "中" | "弱" = score >= b.strong ? "强" : score >= b.medium ? "中" : "弱";
  if (r === "强" && maxStrength < (b.strong_min_strength ?? 4)) r = "中";
  if (r === "中" && maxStrength < (b.medium_min_strength ?? 3)) r = "弱";
  if (maxStrength <= 1) r = "弱";
  return r;
}

// 多条证据合成：1 - Π(1 - v_i)。多条证据会累积，但单调封顶在 1，避免线性叠加爆表。
export function combine(values: number[]): number {
  let acc = 1;
  for (const v of values) {
    const x = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; // NaN/Infinity 防护
    acc *= 1 - x;
  }
  return 1 - acc;
}

export function buildCapabilityVector(evidence: EvidenceItem[]): CapabilityScore[] {
  return CAPABILITY_DIMENSIONS.map((dim) => {
    const matched = evidence.filter((e) => e.capabilities.includes(dim.id));
    const contributors = matched
      .map((e) => ({ id: e.evidence_id, v: evidenceContribution(e) }))
      .sort((a, b) => b.v - a.v);
    const score = combine(contributors.map((c) => c.v));
    const maxStrength = matched.reduce((m, e) => Math.max(m, e.evidence_strength), 0);
    return {
      capability: dim.id,
      name_zh: dim.name_zh,
      score,
      band: band(score, maxStrength),
      top_evidence_ids: contributors.slice(0, 3).map((c) => c.id),
    };
  });
}
