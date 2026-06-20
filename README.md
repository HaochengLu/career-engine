# Career Engine · 职业画像报告引擎

上传简历截图 → 生成「你现在最像哪类候选人、最该冲哪条路径、缺什么证据、最短怎么补」的职业画像报告。

产品形态很轻（给一小撮人玩、看完即走、全凭自觉付费），但**算法内核不轻**：基于职业证据、按需合成职业本体、确定性可解释打分、多 worker 对抗审查。

---

## 怎么跑

```bash
cd career-engine
npm install
cp .env.example .env        # 默认 LLM_PROVIDER=mock，可离线跑
npm start                   # http://localhost:3000
npm run eval                # 用 mock 跑完整条流水线 + 断言（不消耗 API）
npm run typecheck
```

- **离线 mock**：`LLM_PROVIDER=mock`，无需 API key，端到端跑通假数据，适合调样式/演示。
- **真实生成**：`.env` 里设 `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY=sk-...`，默认模型 `claude-opus-4-8`。

上传页在 `/`，点“生成”后会**同步**跑完流水线（约 1–3 分钟）并把报告 HTML 直接渲染到当前页。不存盘、不跳转、刷新即没。

---

## 部署到 Vercel

1. 把 `career-engine/` 作为项目根推到 Git，导入 Vercel。
2. 在 Vercel → Settings → Environment Variables 配置：`LLM_PROVIDER=anthropic`、`ANTHROPIC_API_KEY`、（可选）`DEFAULT_MODEL`。
3. 直接 Deploy。结构已就绪：
   - `public/index.html` + `public/pay-*.png` 由 Vercel 静态托管（`/`、`/pay-1.png` 等）。
   - `api/index.ts` 复用同一个 Express app 作为 serverless function；`vercel.json` 把其余路由改写到它。
   - `vercel.json` 已设 `maxDuration: 300`。**整条流水线有 4–5 次 Opus 调用，约 60–150s**，因此需要 **Vercel Pro（Fluid Compute，单函数可到 300s）**；Hobby 上限 60s 大概率不够。
     - 想在 Hobby 上跑：把 `src/config.ts` 里部分 `workerModels` 换成更快的模型（如 `claude-sonnet-4-6` / `claude-haiku-4-5`）以压低时延——这是配置项，不改业务逻辑。

> 不依赖任何数据库 / 磁盘 / 后台任务，天然契合 serverless。

---

## 收款（全凭自觉）

报告底部展示微信收款码：初版用 `public/pay-1.png`（¥1）、完整报告用 `public/pay-10.png`（¥10），另附 `public/pay-custom.png`（自定义金额）。不做任何门槛/校验/回调；不付也能看。换码改这三张图或用 `PAY_QR_*` 环境变量覆盖。

---

## 算法内核（为什么不是 hardcode）

整条链路：`解析简历 → 抽取&评级证据 → 能力向量 → 按需合成职业本体 → 覆盖度打分 → 战略组合 → 对抗 review → 仲裁 → QA → 渲染`

第一性原理落点：

- **最小单元是 evidence，不是 skill**：先把简历拆成可评级的证据项（0–5 强度 rubric），再判断“这条证据能不能说服招聘方”。
- **职业本体按需合成，不穷举岗位**：`synthesizeRoles` 用少量种子锚点（`data/seed_ontology.json`）做 few-shot，为**任何**没见过的职业即时生成同结构的“证据契约”，从而泛化到所有职业而非维护几千个岗位名。能力维度是开放分类（含 `craft_physical` 实操、`other` 兜底），不卡死蓝领/手艺/临床类。
- **打分来自证据覆盖度，不是关键词命中**：`scoreRoles` 是确定性代码——must_have 用几何平均做瓶颈、recency 乘性折扣、硬门槛单独 veto、市场潜力默认中性+低置信（系统不假装掌握实时岗位数据）。
- **权重是显式、可校准的先验，不是魔法数**：全部在 `data/scoring_weights.json`，标了 `calibration_status: heuristic_v0`、`calibrated_on_samples: 0`；排序权重按用户声明目标（求稳/求上限/均衡）选 profile；对外只展示弱/中/强分档与置信，不展示两位数伪精确。
- **敢于否定 + 抗幻觉**：`redTeam` 对抗审查，`arbitrate` 确定性落地硬规则（清除不存在的证据 id、未达硬门槛的近期主路径降级、claim 置信被支撑证据上限压制、无证据支撑的强结论删除），`qa` 发布前再查一遍（3 条路径、≥1 不建议、无过度承诺词、证据 id 真实）。
- **公平性**：不把名校/名企背书当作满足执照/学历门槛（避免“把出身当资格”）。
- **输入不足就不硬出**：`insufficiency()` 用证据数量/强度/识别置信客观判定，宁可返回“信息不足”。

可调而不改代码的地方：`data/scoring_weights.json`（权重/阈值）、`data/capability_dimensions.json`（能力维度）、`data/seed_ontology.json`（种子锚点）、`src/config.ts` 的 `workerModels`（每个 worker 用哪个模型）。

---

## 刻意没做（轻产品取舍）

- 不存盘：无数据库、不落磁盘，报告只活在请求里（隐私友好）。
- 不做账号/强鉴权、不做支付回调、不做后续反馈采集。

## 后续可增强（来自对抗评审，目前留作 TODO）

- 独立的 grounding/蕴含 worker（校验 claim 是否真被所引证据支持，而不只是 id 存在）。
- 职业本体接 O*NET/ESCO 机读锚点 + 相似度阈值分流（命中/合成/反向召回）。
- 公平性回归集（同成果挂名校 vs 普通，断言分数漂移阈值）+ 巴纳姆探针。
- 跨行业证据按时间/领域聚类，驱动 narrative_risk。
- 拿到真实 outcome 后，把权重校准从“拍脑袋”升级为“更新可解释规则/反例库”（而非小样本学权重）。
