// 仲裁（确定性）：Red Team 不只是提意见——这里把硬规则真正落地。
// 1) 删掉幻觉 evidence_id；2) 未满足硬门槛的近期主路径必须降级；3) 高危 must_fix 的主路径降级/降置信。
import { WEIGHTS } from "../config.js";
import type { ClaimEntailment, EvidenceItem, ReviewFinding, RoleScore, Strategy } from "../types.js";

const lowerBand = (b: "高" | "中" | "低"): "高" | "中" | "低" => (b === "高" ? "中" : "低");

export function arbitrate(
  strategy: Strategy,
  findings: ReviewFinding[],
  scores: RoleScore[],
  evidence: EvidenceItem[],
  entailment: ClaimEntailment[] = [],
): { strategy: Strategy; findings: ReviewFinding[]; actions: string[] } {
  const actions: string[] = [];
  const s: Strategy = structuredClone(strategy);

  // 蕴含强制：Red Team 判定“证据不支持”的 claim 直接删除——兑现“证据必须蕴含结论”，而非 id 存在即可。
  if (entailment.length) {
    const unsupported = new Set(entailment.filter((e) => !e.supported).map((e) => e.claim_id));
    if (unsupported.size) {
      const before = s.claims.length;
      s.claims = s.claims.filter((c) => !unsupported.has(c.claim_id));
      if (s.claims.length < before) actions.push(`删除 ${before - s.claims.length} 条未通过证据蕴含检查的判断`);
    }
  }
  const validIds = new Set(evidence.map((e) => e.evidence_id));
  const gateMap = new Map(scores.map((x) => [x.role_id, x.unmet_blocking_gates] as const));
  const scoreMap = new Map(scores.map((x) => [x.role_id, x] as const));
  const downgraded = new Set<string>(); // 被降级/否决的 role，不能再被选作近期锚点

  // 1) 清除幻觉 evidence_id（硬规则：报告里的证据引用必须真实存在）
  const cleanIds = (ids: string[]): string[] => ids.filter((id) => validIds.has(id));
  for (const p of s.paths) {
    const before = p.supporting_evidence_ids.length;
    p.supporting_evidence_ids = cleanIds(p.supporting_evidence_ids);
    if (p.supporting_evidence_ids.length < before) {
      actions.push(`路径「${p.display_name}」清除了 ${before - p.supporting_evidence_ids.length} 个不存在的证据引用`);
    }
  }
  for (const c of s.claims) {
    c.supporting_evidence_ids = cleanIds(c.supporting_evidence_ids);
    c.counter_evidence_ids = cleanIds(c.counter_evidence_ids);
  }
  s.adjacent_upside.supporting_evidence_ids = cleanIds(s.adjacent_upside.supporting_evidence_ids);
  for (const g of s.gap_map) g.supporting_evidence_ids = cleanIds(g.supporting_evidence_ids ?? []);

  // 置信传播（确定性硬规则）：一条结论的置信，不得高于其支撑证据所能给的上限；
  // 完全没有证据支撑的强结论必须删除——兑现“没有证据 id 不允许输出强结论”。
  const evMap = new Map(evidence.map((e) => [e.evidence_id, e]));
  const keptClaims = [];
  for (const c of s.claims) {
    const supp = c.supporting_evidence_ids.map((id) => evMap.get(id)).filter((e): e is EvidenceItem => !!e);
    if (supp.length === 0) {
      // 清理后无真实支撑证据 → 删除（兼顾“引用了不存在 id”导致 supp 为空的情况，避免 Math.max(...[])=-Infinity）。
      actions.push(`删除无有效证据支撑的判断：${c.text.slice(0, 30)}…`);
      continue;
    }
    let cap = Math.max(...supp.map((e) => e.confidence));
    // 反证处理：若存在较强反证(counter_evidence)，进一步压低该结论置信（敢于否定要双向）。
    const counter = c.counter_evidence_ids.map((id) => evMap.get(id)).filter((e): e is EvidenceItem => !!e);
    const maxCounter = counter.length ? Math.max(...counter.map((e) => e.confidence)) : 0;
    if (maxCounter > 0) cap = cap * (1 - 0.7 * maxCounter);
    if (c.confidence > cap) {
      c.confidence = cap;
      actions.push(`判断「${c.text.slice(0, 20)}…」置信被压到 ${cap.toFixed(2)}${maxCounter ? "（含反证扣减）" : ""}`);
    }
    keptClaims.push(c);
  }
  s.claims = keptClaims;

  // 2) 未满足硬门槛的近期主路径 → 降级为挑战路径
  for (const p of s.paths) {
    const gates = gateMap.get(p.role_id) ?? [];
    const blockingNonShort = gates.filter((g) => g.can_be_acquired !== "short");
    if (p.label === "near_term" && blockingNonShort.length) {
      p.label = "challenge";
      p.recommendation = "不作为近期主线（存在硬门槛）";
      p.entry_difficulty = "高";
      p.confidence_band = lowerBand(p.confidence_band);
      p.not_recommended_when = `未取得：${blockingNonShort.map((g) => g.label_zh).join("、")} 之前`;
      downgraded.add(p.role_id);
      actions.push(
        `路径「${p.display_name}」因未满足硬门槛(${blockingNonShort.map((g) => g.label_zh).join("、")})被降级为挑战路径`,
      );
    }
  }

  // 3) 高危 must_fix → 主路径降级/降置信
  for (const f of findings) {
    if (!f.must_fix || !f.affected_role_id) continue;
    const p = s.paths.find((x) => x.role_id === f.affected_role_id);
    if (!p) {
      f.resolved = false;
      continue;
    }
    if (f.severity === "high") {
      if (p.label === "near_term") {
        p.label = "high_ceiling";
        p.recommendation = "补强后再主攻";
      }
      p.confidence_band = "低";
      p.not_recommended_when = p.not_recommended_when || "在补齐核心证据之前";
      downgraded.add(p.role_id);
      actions.push(`路径「${p.display_name}」因高危问题被降级/降置信：${f.finding.slice(0, 40)}…`);
    } else {
      p.confidence_band = lowerBand(p.confidence_band);
    }
    f.resolved = true;
  }

  // 4) 保留近期锚点：若降级后没有任何 near_term，把最可行且未被降级的路径提升为近期锚点，
  //    避免“全部变成未来/挑战、没有可立即投递的现实主路径”。
  if (!s.paths.some((p) => p.label === "near_term")) {
    const eligible = s.paths
      .filter((p) => {
        if (downgraded.has(p.role_id)) return false;
        const blocked = (gateMap.get(p.role_id) ?? []).some((g) => g.can_be_acquired !== "short");
        return !blocked && p.entry_difficulty !== "高";
      })
      .sort((a, b) => (scoreMap.get(b.role_id)?.decision_score ?? 0) - (scoreMap.get(a.role_id)?.decision_score ?? 0));
    const anchor = eligible[0];
    if (anchor) {
      anchor.label = "near_term";
      // 证据质量门：若锚点本身证据偏弱(evidence_trust 低)，诚实标低置信并提示补强，不假装它很稳。
      const trust = scoreMap.get(anchor.role_id)?.evidence_trust ?? 0;
      if (trust < WEIGHTS.near_term_min_evidence_trust) {
        anchor.confidence_band = "低";
        anchor.recommendation = "近期可切入，但证据相对薄弱，需同步补强";
      } else {
        anchor.recommendation = "近期可切入（同时按缺口补强）";
      }
      actions.push(`保留近期锚点：「${anchor.display_name}」设为近期最现实路径${trust < 0.4 ? "（证据偏弱，已标低置信）" : ""}`);
    }
  }

  // 5) 同步战略卡：三槽位必须是【互不重复】的真实路径，且标签如实（无 near_term 时不谎称“近期最现实”）。
  const labelText: Record<string, string> = { near_term: "近期最现实", high_ceiling: "未来最有上限", challenge: "挑战型", transition: "过渡" };
  const used = new Set<string>();
  const pick = (prefer: string): (typeof s.paths)[number] | undefined => {
    let p = s.paths.find((x) => x.label === prefer && !used.has(x.role_id));
    if (!p) p = s.paths.find((x) => !used.has(x.role_id)); // 该 label 没有，就拿一条未用过的
    if (p) used.add(p.role_id);
    return p;
  };
  const mainP = pick("near_term");
  const secP = pick("high_ceiling");
  const chP = pick("challenge");
  if (mainP) s.strategy_card.main_path = `${mainP.display_name}（${labelText[mainP.label] ?? "主路径"}）`;
  if (secP) s.strategy_card.secondary_path = `${secP.display_name}（${labelText[secP.label] ?? "副路径"}）`;
  else if (
    s.adjacent_upside.display_name &&
    s.adjacent_upside.role_id &&
    s.adjacent_upside.supporting_evidence_ids.length > 0 &&
    !used.has(s.adjacent_upside.role_id) // 非空且不能与已占用的主/挑战槽位重复
  )
    s.strategy_card.secondary_path = `${s.adjacent_upside.display_name}（高上限相邻）`;
  if (chP) s.strategy_card.challenge_path = `${chP.display_name}（${labelText[chP.label] ?? "挑战型"}）`;
  if (s.not_recommended[0]) s.strategy_card.not_recommended = s.not_recommended[0].direction;

  return { strategy: s, findings, actions };
}
