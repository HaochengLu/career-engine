// 证据强度 rubric 与能力维度——以文本形式注入到 worker prompt，保证全流程对“证据值多少”有统一标准。
import capDims from "../data/capability_dimensions.json" with { type: "json" };

export const CAPABILITY_DIMENSIONS = capDims.dimensions;

export const CAPABILITY_LIST_TEXT = CAPABILITY_DIMENSIONS.map(
  (d) => `- ${d.id}：${d.name_zh}（${d.desc}）`,
).join("\n");

export const CAPABILITY_IDS = CAPABILITY_DIMENSIONS.map((d) => d.id);

export const EVIDENCE_STRENGTH_RUBRIC = `证据强度 0-5（统一标准，务必严格）：
0 无证据：简历没有任何支持。
1 自称：写了技能/兴趣/课程名，但没有产物。
2 学习经历：课程、训练营、证书、读书笔记。
3 项目或任务：做过项目、实习任务、课堂项目、社团任务。
4 可展示产物：有作品集、代码、报告、demo、论文、案例。
5 外部验证结果：真实业务指标、发表、获奖、生产环境、客户、收入、录用、推荐信。

判定原则：
- 不能把“写了技能”当成强证据（≤1）。
- 不能把课程项目等同真实业务（课程项目≈3，真实业务结果≈4-5）。
- 有结果但没有上下文/无法核实，要降置信（confidence 下调）。
- 外部可验证背书权重最高。
- 宁可保守，不要把兴趣误判成能力。`;

// 报告中禁止出现的过度承诺表达（QA 用）
export const BANNED_PHRASES = [
  "保证",
  "一定能",
  "一定可以",
  "必然",
  "必拿",
  "稳拿",
  "包拿offer",
  "包offer",
  "100%",
  "百分百",
  "绝对适合",
  "绝对不适合",
  "guaranteed",
];
