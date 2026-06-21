// 最小自测：用 mock provider 跑完整条流水线，对‘算法/框架’做基本断言。
// 用法：npm run eval   （强制走 mock，不消耗 API）
// 注意：必须先设 env 再【动态】import——否则 ESM 会先加载 config（读到 .env 的真实 provider）。
process.env.LLM_PROVIDER = "mock";

import type { UserInputs } from "../src/types.js";

const { generateReport } = await import("../src/core/pipeline.js");
const { renderReport } = await import("../src/render/report.js");
const { nowIso } = await import("../src/util.js");
const { BANNED_PHRASES } = await import("../src/core/rubric.js");

const inputs: UserInputs = {
  desired_roles: ["AI产品"],
  avoid_roles: ["纯销售"],
  declared_goal: "balance",
  target_locations: ["上海"],
};

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("✗ " + msg);
    process.exitCode = 1;
  } else {
    console.log("✓ " + msg);
  }
}

const r = await generateReport([], inputs);
console.log("status =", r.status);
assert(r.status === "rendered", "流水线跑通并产出报告");

const a = r.artifacts;
assert((a.evidence?.length ?? 0) > 0, "抽取到证据");
assert((a.capability_vector?.length ?? 0) > 0, "生成能力向量");
assert((a.scores?.length ?? 0) > 0, "完成职业打分");
assert((a.strategy?.paths.length ?? 0) >= 3, "至少 3 条路径");
assert((a.strategy?.not_recommended.length ?? 0) >= 1, "至少 1 条不建议方向");
assert(!!a.strategy?.adjacent_upside?.display_name, "包含高上限相邻路径(adjacent_upside)");
assert(a.strategy?.paths.some((p) => p.label === "near_term"), "至少保留一条近期锚点(near_term)");

const ok01 = (a.scores ?? []).every((s) => s.current_fit >= 0 && s.current_fit <= 1 && s.confidence >= 0 && s.confidence <= 1);
assert(ok01, "分数均归一到 [0,1]");

const ds = (a.scores ?? []).map((s) => s.decision_score);
assert(ds.every((v, i) => i === 0 || ds[i - 1]! >= v), "按 decision_score 降序");

const validIds = new Set((a.evidence ?? []).map((e) => e.evidence_id));
const refIds = [
  ...(a.strategy?.paths.flatMap((p) => p.supporting_evidence_ids) ?? []),
  ...(a.strategy?.claims.flatMap((c) => [...c.supporting_evidence_ids, ...c.counter_evidence_ids]) ?? []),
  ...(a.strategy?.adjacent_upside.supporting_evidence_ids ?? []),
];
assert(refIds.every((id) => validIds.has(id)), "报告引用的证据 id 全部真实存在（无幻觉）");

const html = renderReport({ tier: "full", createdAt: nowIso(), status: "rendered" }, a);
assert(html.includes("职业战略卡"), "完整报告渲染出战略卡");
assert(html.includes("高上限相邻路径"), "完整报告渲染出高上限相邻路径");
assert(html.includes("下载完整报告 MD"), "完整报告提供 Markdown 下载");
assert(html.includes("# 职业画像报告"), "下载内容包含 Markdown 报告正文");
assert(html.includes("Comment / Feedback"), "完整报告提供反馈入口");
const contentBlob = JSON.stringify(a.strategy);
assert(!BANNED_PHRASES.some((p) => contentBlob.includes(p)), "报告内容不含过度承诺表达");

console.log("\nQA:", a.qa);
console.log(process.exitCode ? "\n❌ 有断言失败" : "\n✅ 全部通过");
