# Career Engine 算法架构说明

本文说明 Career Engine 的产品功能、算法路线、核心流水线、每个环节的模型选择建议，以及上线部署时需要注意的安全边界。

更新时间：2026-06-21

## 1. 产品做什么

Career Engine 是一个“基于职业证据”的职业画像报告引擎。

用户上传简历截图，并补充目标地点、想去/不想去的方向、学校专业、约束和职业目标后，系统同步生成一份中文职业策略报告。报告回答四个问题：

1. 用户现在最像哪类候选人。
2. 近期最现实、未来最有上限、挑战型路径分别是什么。
3. 每条路径缺什么证据，最短怎么补。
4. 哪些方向暂不建议优先，以及为什么。

当前产品是轻量内测形态：

- 不做账号系统。
- 不存简历、不落数据库。
- 提供微信支付二维码、完整报告 Markdown 下载和邮件反馈入口。
- 一个请求内同步跑完整条流水线，可部署到 Cloudflare Workers、Vercel Serverless Function，或普通 Node 服务。

## 2. 第一性原理

系统的最小判断单元不是 skill，也不是岗位名，而是 evidence。

传统“简历关键词匹配岗位”的问题是：只要简历里出现“数据分析、AI、增长、产品”等词，就容易把兴趣、课程、技能罗列误判成真实能力。Career Engine 反过来做：

1. 先把简历拆成可独立判断的证据项。
2. 每条证据按统一 rubric 评级。
3. 再把证据映射到能力向量。
4. 然后为候选职业生成“证据契约”。
5. 最后用代码计算证据覆盖度，而不是让模型直接拍脑袋排序。

证据强度分为 0-5：

| 强度 | 含义 | 例子 |
| --- | --- | --- |
| 0 | 无证据 | 简历完全没有支持 |
| 1 | 自称 | 写了技能、兴趣、课程名，但没有产物 |
| 2 | 学习经历 | 课程、训练营、证书、读书笔记 |
| 3 | 项目或任务 | 课堂项目、实习任务、社团任务 |
| 4 | 可展示产物 | 作品集、代码、报告、demo、论文、案例 |
| 5 | 外部验证结果 | 业务指标、发表、获奖、生产环境、客户、收入、录用、推荐信 |

这套分层的作用是防止“弱证据堆量”撑出高置信结论。系统宁可保守，也不把兴趣误判成能力。

## 3. 总体流水线

完整链路如下：

```text
上传图片/用户补充信息
  -> parseResume 简历解析
  -> extractEvidence 证据抽取与评级
  -> capabilityVector 能力向量
  -> sufficiency 输入充分性闸门
  -> marketSignal 可选联网市场信号
  -> synthesizeRoles 多通道职业本体召回
  -> opportunityScout 漏检审查
  -> scoreRoles 确定性评分
  -> strategy 职业策略报告草稿
  -> redTeam 对抗审查与证据蕴含检查
  -> arbitrate 确定性仲裁
  -> qa 发布前 QA
  -> render HTML 报告
```

其中 LLM 只负责三类事情：

- 看图、理解非结构化简历文本。
- 生成开放世界的职业本体与策略表达。
- 做对抗审查和证据蕴含判断。

代码负责所有必须可复现、可解释、可审计的环节：

- evidence_id 分配。
- 能力向量聚合。
- 输入不足判断。
- 职业覆盖度计算。
- 硬门槛 veto。
- 用户 avoid 方向 veto。
- Red Team 发现后的仲裁。
- evidence_id 清洗。
- 报告 QA。

## 4. 核心模块

### 4.1 parseResume：简历解析

入口：`src/workers/parseResume.ts`

输入：

- 用户上传的 1-4 张简历截图。
- 用户补充信息。

输出：

- 教育经历、项目、实习、技能、证书、行业、时间线、量化结果。
- `ocr_confidence`。
- 低置信或缺失字段。

关键原则：

- 只提取图片和用户输入里真实存在的信息。
- 图片模糊时降低 `ocr_confidence`，不猜。
- 用户补充信息只能作为背景，不当作简历证据。

### 4.2 extractEvidence：证据抽取与评级

入口：`src/workers/extractEvidence.ts`

输入：

- 已解析简历。
- 用户补充信息。
- 能力维度列表。
- 证据强度 rubric。

输出：

- 一组 EvidenceItem。
- 每条证据包含 claim、action、artifact、domain、capabilities、frontier_signals、strength、confidence、limitations。

关键原则：

- 一条证据只描述一件可独立判断的事情。
- `capabilities` 只能取系统定义的能力维度。
- `frontier_signals` 用开放词表识别前沿/新兴信号，例如 AI GTM、临床信息化、合规科技、FP&A 自动化、碳核算、新能源运维等。
- 出现手机号、邮箱、身份证、护照等隐私信息时，用「[已隐藏]」替代。

### 4.3 capabilityVector：能力向量

入口：`src/workers/capabilityVector.ts`

这是确定性代码，不调用模型。

计算逻辑：

```text
单条证据贡献 = strength_value × recency_factor × confidence
多条证据合成 = 1 - Π(1 - contribution_i)
```

系统还加了质量门：

- 强能力必须至少有一条强度 >= 4 的证据。
- 中能力必须至少有一条强度 >= 3 的证据。
- 只有自称/技能罗列时，无论数量多少都只能是弱。

### 4.4 sufficiency：输入充分性闸门

入口：`src/core/pipeline.ts`

这是确定性代码，不调用模型。

如果出现以下情况，系统返回 `insufficient_input`，不硬生成报告：

- 可识别证据少于阈值。
- 没有任何达到“学习经历”及以上的证据。
- OCR 置信很低且证据很少。
- 总体证据信号弱于阈值。

这一步的价值是防止模型在信息不足时编一份看起来完整但没有根据的报告。

### 4.5 marketSignal：可选联网市场信号

入口：`src/workers/marketSignal.ts` 和 `src/providers/search.ts`

默认关闭。

开启条件：

- `ENABLE_WEB_SEARCH=true`
- `LLM_PROVIDER=openai`
- 配置了 OpenAI API key

作用：

- 给 `market_pull` 和 `emerging` 召回通道提供实时市场上下文。
- 检索失败时返回空字符串，不影响主流程。

注意：当前系统不会把市场信号直接变成排序分数。市场潜力默认中性低置信，避免把实时搜索噪声误当成职业结论。

### 4.6 synthesizeRoles：多通道职业本体召回

入口：`src/workers/synthesizeRoles.ts`

这是系统最核心的泛化模块。

传统做法是维护几千个岗位名，然后匹配用户最像哪一个。这里不这样做。Career Engine 用少量 seed ontology 作为 few-shot 锚点，然后按用户证据即时生成 12-18 个候选职业原型。

候选必须覆盖五条召回通道：

| 通道 | 含义 |
| --- | --- |
| evidence_near | 当前证据最接近的方向 |
| transferable_adjacent | 现有能力加一点补强可迁移过去的相邻方向 |
| market_pull | 市场正在拉动、需求或上限更高的方向 |
| user_thesis | 用户明确想去的方向，即使证据弱也纳入 |
| emerging | 新兴/前沿复合方向 |

每个职业原型不是简单岗位名，而是一份“证据契约”：

- 必备证据 must_have。
- 应有证据 should_have。
- 加分证据 nice_to_have。
- 硬门槛 hard_gates。
- 常见误判 common_false_positives。
- 缺口项目 gap_projects。
- 市场说明 market_notes。

这让系统可以泛化到没见过的岗位，而不需要给每个岗位写规则。

### 4.7 opportunityScout：漏检审查

入口：`src/workers/opportunityScout.ts`

Red Team 是防过度乐观，opportunityScout 是防过度保守。

它检查 `synthesizeRoles` 是否漏掉了高上限相邻/新兴方向，尤其是：

- 现有证据可迁移，但原列表没召回。
- 用户有前沿信号，但报告仍只给传统路径。
- 市场拉动方向被忽略。

系统只在必要时触发它，以减少一次昂贵调用：

- 有前沿信号。
- 相邻/市场/新兴候选太少。
- 召回通道不完整。
- 候选名单偏小。

### 4.8 scoreRoles：确定性评分

入口：`src/workers/scoreRoles.ts`

这是职业排序的核心，不调用模型。

每个候选角色会算出：

- `current_fit`：当前证据覆盖度。
- `evidence_trust`：支撑证据可信度。
- `entry_feasibility`：硬门槛进入可行性。
- `differentiation`：稀缺性和前沿性。
- `constraint_fit`：用户目标与避免方向适配。
- `decision_score`：最终排序分。
- `confidence`：角色判断置信。

决策分按用户目标切换权重：

| 用户目标 | 取向 |
| --- | --- |
| stable | 更看重入门可行性和证据稳健 |
| upside | 更看重差异化和高上限 |
| balance | 当前默认，平衡匹配度、证据可信和可行性 |

硬规则：

- 未满足且短期无法取得的硬门槛会把 `decision_score` 封顶。
- 用户明确 avoid 的方向也会被封顶。
- 名校/名企背书不能替代执照、学历、资格等硬门槛。
- 市场潜力不直接进入决策分，因为没有真实 outcome 数据时，市场判断容易制造伪精确。

### 4.9 strategy：职业策略报告草稿

入口：`src/workers/strategy.ts`

输入：

- 已排序候选角色。
- 证据列表。
- 用户目标与约束。

输出：

- 一句话职业画像。
- 三条主路径：近期最现实、未来最有上限、挑战型。
- 至少一条暂不建议优先方向。
- 缺口地图。
- 2-4 周可完成的项目建议。
- 30 天行动计划。
- 高上限相邻路径。
- 战略卡。
- claim ledger。

关键约束：

- 每条路径、每个 claim 都必须引用真实 evidence_id。
- 不得输出“保证、必拿、100%”等过度承诺。
- 有硬门槛的方向不能被包装成近期现实主路径。

### 4.10 redTeam：对抗审查

入口：`src/workers/redTeam.ts`

Red Team 逐项攻击报告：

- 是否关键词过拟合。
- 是否把兴趣误判成能力。
- 是否把课程项目当真实业务。
- 是否忽略执照/学历/资格门槛。
- 是否过度乐观。
- 是否推荐用户明确不想要的方向。
- claim 引用的证据是否真的支持该结论。
- 是否漏掉更高上限相邻/新兴方向。
- 被否定的方向是否其实被过度保守地误杀。

输出：

- findings。
- 每条 claim 的 entailment 判断。

### 4.11 arbitrate：确定性仲裁

入口：`src/workers/arbitrate.ts`

Red Team 不能只提意见，仲裁代码会真正改报告：

- 删除 Red Team 判定不被证据支持的 claim。
- 清除不存在的 evidence_id。
- 没有有效证据支撑的强结论直接删除。
- claim 置信不能高于支撑证据上限。
- 有强反证时进一步压低置信。
- 未满足硬门槛的 near_term 路径降级。
- 高危 must_fix 的路径降级或降置信。
- 如果所有近期路径都被降级，选择最可行且未被否决的路径作为低置信近期锚点。
- 重写战略卡，确保主路径、副路径、挑战路径不重复。

这一步让系统从“LLM 写报告”变成“LLM 写草稿，代码按规则发布”。

### 4.12 qa：发布前 QA

入口：`src/workers/qa.ts`

QA 检查：

- 是否有 3 条路径。
- 是否至少有 1 条不建议方向。
- near_term/high_ceiling 是否有证据引用。
- 是否出现过度承诺词。
- 是否引用不存在的 evidence_id。
- 高上限相邻路径是否有证据支撑且不与主路径重复。
- 近期主路径是否仍存在未满足硬门槛。
- 有前沿信号时，最终报告是否纳入 emerging/adjacent/market_pull 方向。

## 5. 为什么不是 hardcode

系统只 hardcode 三类东西：

1. 证据强度 rubric。
2. 能力维度。
3. 评分权重与安全阈值。

不 hardcode：

- 岗位全集。
- 每个岗位的固定关键词。
- 每个行业的固定路线。
- 职业结论。

职业本体由模型按用户证据即时合成，但评分由统一代码完成。这样既保留开放世界泛化能力，又避免模型直接决定排序带来的不可解释性。

## 6. 模型选择建议

本节是截至 2026-06-20 的建议。项目支持 OpenAI 官方 API，也支持符合 OpenAI 协议的私有网关。模型能力、价格和网关可用模型会变化，正式上线前建议用 30-50 份真实简历样本做小规模 A/B eval。

官方参考：

- OpenAI 模型说明：https://platform.openai.com/docs/models
- OpenAI GPT-5.5 迁移与提示建议：https://platform.openai.com/docs/guides/latest-model

### 6.1 生产默认配置

这套配置优先降低第三方 OpenAI 兼容代理的同步超时风险。默认把图片解析、证据抽取、策略生成、Red Team 都放到 `gpt-5.4-mini`，并在 524/504/408 这类上游超时时自动重试一次；如果仍超时，会自动降级到 `OPENAI_MODEL`（默认也是 `gpt-5.4-mini`）再试。

| 环节 | 默认模型 | 原因 |
| --- | --- | --- |
| parseResume | `gpt-5.4-mini` | 需要读图片和结构化简历内容；该环节以提取为主，用最快模型降低图片解析超时风险 |
| extractEvidence | `gpt-5.4-mini` | 证据拆分和强度评级是全链路地基，但也是长输出高风险环节；默认先控时延 |
| synthesizeRoles | `gpt-5.5` | 需要开放世界职业本体合成、多通道召回、硬门槛意识 |
| opportunityScout | `gpt-5.4` | 条件触发的查漏环节，重点是补高上限相邻方向，用 `gpt-5.4` 控制时延 |
| strategy | `gpt-5.4-mini` | 最终报告长输出容易触发代理 524；默认先保证能返回 |
| redTeam | `gpt-5.4-mini` | 审查环节默认使用快模型；代理稳定时可升到 `gpt-5.4` 或 `gpt-5.5` |
| marketSignal | `gpt-5.4-mini` 或关闭 | 只提供市场上下文，失败会自动降级；默认不让市场搜索影响主流程稳定性 |
| capabilityVector / scoreRoles / arbitrate / qa | 代码 | 必须确定性、可复现、可审计 |

对应环境变量：

```env
LLM_PROVIDER=openai
OPENAI_BASE_URL=
OPENAI_MODEL=gpt-5.4-mini
WORKER_MODEL_PARSE_RESUME=gpt-5.4-mini
WORKER_MODEL_EXTRACT_EVIDENCE=gpt-5.4-mini
WORKER_MODEL_SYNTHESIZE_ROLES=gpt-5.5
WORKER_MODEL_OPPORTUNITY_SCOUT=gpt-5.4
WORKER_MODEL_STRATEGY=gpt-5.4-mini
WORKER_MODEL_RED_TEAM=gpt-5.4-mini
```

如果使用官方 OpenAI 或第三方/自建兼容网关，只在 `.env`、Cloudflare Secrets、Vercel Environment Variables 或服务器 secret manager 里填写真实 base URL；公开文档和 GitHub 提交里不要写私有网关域名。

### 6.2 低成本配置

适合：演示、低频试用、Hobby 项目、第三方代理容易超时，或者先验证产品需求。

| 环节 | 推荐模型 | 风险 |
| --- | --- | --- |
| parseResume | `gpt-5.4-mini` | 模糊图和复杂排版可能漏信息 |
| extractEvidence | `gpt-5.4-mini` | 质量低于大模型，但更不容易触发 524 |
| synthesizeRoles | `gpt-5.4` | 基本可用，但新兴/跨行业方向可能变保守 |
| opportunityScout | `gpt-5.4-mini` 或跳过 | 可能漏高上限相邻方向 |
| strategy | `gpt-5.4-mini` | 报告质量低于 `gpt-5.5`，但更稳 |
| redTeam | `gpt-5.4-mini` | 审查深度低于大模型 |

如果代理稳定、用户更看重质量，可以优先把这三个环节升回更强模型：

- `extractEvidence` 升到 `gpt-5.4` 或 `gpt-5.5`。
- `strategy` 升到 `gpt-5.4` 或 `gpt-5.5`。
- `redTeam` 升到 `gpt-5.4` 或 `gpt-5.5`。

### 6.3 不同环节为什么需要不同模型

| 环节 | 主要难点 | 模型能力优先级 |
| --- | --- | --- |
| parseResume | 视觉 OCR、简历结构化、低置信识别 | 视觉、多语言、保守抽取 |
| extractEvidence | 拆证据、评级、隐私脱敏 | 严格指令、结构化输出、细粒度判断 |
| synthesizeRoles | 开放世界职业本体、跨行业迁移 | 长上下文、创造性、职业知识、硬门槛意识 |
| opportunityScout | 查漏、识别高上限相邻方向 | 反事实思考、市场敏感度 |
| strategy | 取舍、表达、行动建议 | 推理、中文表达、产品感 |
| redTeam | 反驳、证据蕴含、安全保守 | 逻辑严谨、反幻觉、审查能力 |
| score/arbitrate/qa | 可复现规则 | 不应用模型 |

## 7. 当前代码模型配置方式

模型配置集中在 `src/config.ts`。本地 Node 从 `process.env` 读取，Cloudflare Worker 会在请求进入时把 Worker bindings 注入同一套配置读取函数，所以业务 worker 不需要关心部署平台：

```ts
WORKER_MODEL_PARSE_RESUME=gpt-5.4-mini
WORKER_MODEL_EXTRACT_EVIDENCE=gpt-5.4-mini
WORKER_MODEL_SYNTHESIZE_ROLES_FAST=gpt-5.4-mini
WORKER_MODEL_SYNTHESIZE_ROLES=gpt-5.5
WORKER_MODEL_OPPORTUNITY_SCOUT=gpt-5.4
WORKER_MODEL_STRATEGY_FAST=gpt-5.4-mini
WORKER_MODEL_STRATEGY=gpt-5.4-mini
WORKER_MODEL_RED_TEAM=gpt-5.4-mini
```

每个 worker 都可以通过环境变量独立换模型，不需要改业务逻辑。

运行时通过环境变量选择 provider：

```text
LLM_PROVIDER=mock | anthropic | openai
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
OPENAI_BASE_URL=...
OPENAI_MODEL=...
WORKER_MODEL_PARSE_RESUME=...
WORKER_MODEL_EXTRACT_EVIDENCE=...
WORKER_MODEL_SYNTHESIZE_ROLES=...
WORKER_MODEL_OPPORTUNITY_SCOUT=...
WORKER_MODEL_STRATEGY=...
WORKER_MODEL_RED_TEAM=...
ENABLE_WEB_SEARCH=false
```

注意：

- `.env` 只用于本地，不应提交。
- Cloudflare 上应使用 Worker Secrets；Vercel 上应使用 Dashboard 的 Environment Variables。
- `.env.example` 可以提交，因为它不包含真实 key。

## 8. 部署结构

项目适合直接把仓库根目录设为 `career-engine/`。当前推荐 Cloudflare Workers 部署：静态页面、API、每日额度计数都在 Cloudflare 上运行，不需要再反代 Vercel。

关键文件：

| 文件 | 作用 |
| --- | --- |
| `public/index.html` | 上传页 |
| `public/pay-*.png` | 支付二维码图片 |
| `src/app.ts` | Express app 和 API route |
| `cloudflare/worker.ts` | Cloudflare Worker 原生入口 |
| `wrangler.toml` | Cloudflare Static Assets、Durable Object、Worker 配置 |
| `api/index.ts` | Vercel Serverless 入口 |
| `vercel.json` | Vercel 函数时长和 rewrite |
| `src/core/pipeline.ts` | 主流水线 |
| `src/workers/*` | 各 worker |
| `src/data/*.json` | 能力维度、职业 seed、评分权重 |

Cloudflare 结构：

```text
public/*              -> Cloudflare Static Assets
cloudflare/worker.ts  -> /api/report/generate、/healthz
QUOTA_DO              -> Durable Object，每日完整报告额度计数
```

Vercel 结构：

```text
public/*         -> 静态资源
api/index.ts     -> serverless function
vercel.json      -> /(.*) rewrite 到 /api
```

函数时长：

- `vercel.json` 已设置 `maxDuration: 300`。
- 应用内部还有 `GEN_TIMEOUT_MS = 280_000`，会在 Vercel 强杀前主动返回友好失败。
- Cloudflare 部署建议把 `GEN_TIMEOUT_MS` 设为 `760000`，但第三方模型代理自身如果有 120 秒 read timeout，平台迁移不能消除这个上游限制，只能靠模型选择、图片压缩、并行 worker 和重试策略降低触发概率。

## 9. 安全与隐私边界

当前隐私策略：

- 简历图片只在请求内处理。
- 不写数据库。
- 不落磁盘。
- 刷新页面后报告消失。
- 证据抽取阶段会脱敏手机号、邮箱、身份证、护照等信息。

上线前必须确认：

- 不提交 `.env`。
- 不提交真实 API key。
- Cloudflare/Vercel/服务器环境变量只放在部署平台的 secret 或环境变量管理里。
- 如果仓库公开，`public/pay-*.png` 支付二维码图片会公开。
- 不要把用户真实简历样本放进仓库。

## 10. 后续可增强

1. 增加独立 grounding worker，专门做 claim 与 evidence 的蕴含验证。
2. 接入 O*NET / ESCO 作为职业本体锚点，减少完全靠模型合成的不确定性。
3. 做公平性回归集，例如同样成果挂名校和普通学校，分数漂移不能超过阈值。
4. 引入线上反馈，但不要直接训练黑箱权重；优先把失败样本转成可解释规则和反例集。
5. 把大模型调用改为流式或异步任务，降低同步请求超时风险。
6. 对模型配置做 A/B eval，按真实样本比较证据评级一致性、路径命中率、Red Team 召回率和用户满意度。
