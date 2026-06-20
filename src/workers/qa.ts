// 自动 QA：发布前的确定性检查清单（plan §11.1）。不是引入新结论，只验证证据链/合规/完整性。
import { BANNED_PHRASES } from "../core/rubric.js";
import type { EvidenceItem, RoleScore, Strategy } from "../types.js";

export function runQa(
  strategy: Strategy,
  scores: RoleScore[],
  evidence: EvidenceItem[],
): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  const validIds = new Set(evidence.map((e) => e.evidence_id));
  const blob = JSON.stringify(strategy);

  // 1) 3 条路径
  if (strategy.paths.length < 3) issues.push(`路径数量不足 3（当前 ${strategy.paths.length}）`);

  // 2) 至少 1 条不建议路径
  if (strategy.not_recommended.length < 1) issues.push("缺少‘暂不建议优先’的方向");

  // 3) near_term / high_ceiling 路径必须有证据支撑
  for (const p of strategy.paths) {
    if ((p.label === "near_term" || p.label === "high_ceiling") && p.supporting_evidence_ids.length === 0) {
      issues.push(`路径「${p.display_name}」(${p.label}) 缺少证据引用`);
    }
  }

  // 4) 禁止过度承诺
  for (const phrase of BANNED_PHRASES) {
    if (blob.includes(phrase)) issues.push(`出现违规过度承诺表达：${phrase}`);
  }

  // 5) 引用的 evidence_id 必须真实存在（防幻觉/防引用用户没有的信息）
  const referenced = [
    ...strategy.paths.flatMap((p) => p.supporting_evidence_ids),
    ...strategy.claims.flatMap((c) => [...c.supporting_evidence_ids, ...c.counter_evidence_ids]),
    ...strategy.adjacent_upside.supporting_evidence_ids,
    ...strategy.gap_map.flatMap((g) => g.supporting_evidence_ids ?? []),
  ];
  for (const id of referenced) {
    if (!validIds.has(id)) issues.push(`引用了不存在的证据 id：${id}`);
  }

  // 8) 高上限相邻路径必须有证据支撑“证据可迁移”的论断，且不能与三条主路径重复
  const u = strategy.adjacent_upside;
  if (u.display_name) {
    if (u.supporting_evidence_ids.length === 0) issues.push("高上限相邻路径缺少证据支撑（无法佐证‘证据可迁移’）");
    if (strategy.paths.some((p) => p.role_id === u.role_id)) issues.push(`高上限相邻路径与主路径重复：${u.display_name}`);
  }

  // 6) 近期主路径不得存在未满足硬门槛
  const gateMap = new Map(scores.map((s) => [s.role_id, s.unmet_blocking_gates]));
  for (const p of strategy.paths) {
    if (p.label === "near_term") {
      const gates = (gateMap.get(p.role_id) ?? []).filter((g) => g.can_be_acquired !== "short");
      if (gates.length) issues.push(`近期主路径「${p.display_name}」仍存在未满足硬门槛`);
    }
  }

  // 7) 核心要素完整
  if (!strategy.one_liner.trim()) issues.push("缺少一句话职业画像");
  if (!strategy.strategy_card.main_path.trim()) issues.push("战略卡缺少主路径");

  // 9) 多通道完整性：有前沿信号，但【最终进入报告】(三路径+相邻路径)的全是传统方向 → 漏检（检查报告产出，而非仅候选池）
  const hasFrontier = evidence.some((e) => e.frontier_signals.length > 0);
  const srcMap = new Map(scores.map((s) => [s.role_id, s.recall_source]));
  const reportRoleIds = [...strategy.paths.map((p) => p.role_id), strategy.adjacent_upside.role_id].filter(Boolean);
  const reportHasEmerging = reportRoleIds.some((id) => {
    const rs = srcMap.get(id);
    return rs === "emerging" || rs === "transferable_adjacent" || rs === "market_pull";
  });
  if (hasFrontier && !reportHasEmerging) issues.push("存在前沿信号但主路径/相邻路径都是传统方向，疑似漏检高上限/新兴方向");

  return { passed: issues.length === 0, issues };
}
