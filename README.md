# Career Engine · 职业画像报告引擎

Career Engine 是一个轻量的职业规划小工具：用户上传简历截图，补充一点求职偏好，系统会生成一份中文职业画像报告，帮助用户看清自己当前更像哪类候选人、可以优先冲哪些方向、简历里还缺哪些证据，以及下一步怎么补。

它适合三类人：

- **正在找工作的人**：想快速知道自己的简历更适合投哪些岗位。
- **学生或转型者**：还不确定方向，希望看到几个可比较的职业路径。
- **开发者/产品同学**：想参考一个不依赖数据库、可本地跑、可部署到 Cloudflare Workers 或 Serverless 的 LLM 应用样例。

典型体验流程：

1. 打开网页，上传 1-4 张简历截图。
2. 填写目标城市/国家、想尝试或想避开的方向、学校专业、年级或工作年限等可选信息。
3. 选择版本，微信扫码自觉付款后，点击“我已支付，开始生成”。
4. 快速版通常约 2 分钟，完整报告通常约 4-6 分钟。
4. 页面直接返回报告：推荐路径、备选路径、不建议路径、证据解释、风险提醒和补强建议。

这个项目不会创建账号，不依赖数据库，不保存简历文件。一次请求结束后，报告只存在于当前页面响应里；刷新页面后需要重新生成。

---

## 功能一览

- **简历截图识别**：从截图里提取教育、项目、实习、技能、成果等职业信息。
- **证据强度评估**：把“会 Python”“做过项目”“拿到结果”区分开，减少只按关键词判断的误差。
- **职业方向生成**：不是只匹配固定岗位名，而是根据用户证据临时合成候选职业画像。
- **路径排序与解释**：给出主路径、备选路径、暂不建议路径，并说明为什么。
- **对抗审查**：检查报告中是否有证据不足、过度推断或不适合直接展示的结论。
- **输入不足保护**：如果截图太少、太糊或证据信号太弱，会提示信息不足，而不是硬编一份报告。
- **自愿付费展示**：报告底部可展示收款码；没有支付校验，也不影响查看。

更完整的算法路线可以看 [docs/algorithm-architecture-zh.md](docs/algorithm-architecture-zh.md)。

---

## 本地运行

需要先安装 Node.js 20+。

```bash
npm install
cp .env.example .env
npm start
```

启动后访问：

```text
http://localhost:3000
```

常用命令：

```bash
npm start          # 启动本地服务
npm run dev        # watch 模式，适合开发
npm run eval       # 用 mock 数据跑完整流水线和断言
npm run typecheck  # TypeScript 类型检查
```

### Mock 模式：不用 API key 也能跑

`.env.example` 默认是：

```env
LLM_PROVIDER=mock
```

这个模式会使用项目里的假数据跑通完整流程，不会调用任何外部模型，也不会消耗 API 额度。它适合：

- 第一次体验项目是否能启动；
- 调整页面样式；
- 检查报告渲染；
- 给别人演示整体流程。

Mock 模式的结果不是根据你上传的真实简历生成的，所以不要用它判断实际职业方向。

### 真实 OpenAI 兼容 API 模式

如果要用真实模型生成报告，把 `.env` 改成下面这样。这里全部是占位写法，请填你自己的 key，不要把 `.env` 提交到 Git。

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.4-mini
OPENAI_PER_KEY_CONCURRENCY=8
ENABLE_WEB_SEARCH=false
```

如果你有多个 OpenAI 兼容 API key，用 `OPENAI_API_KEYS` 分摊并发。这个变量优先级高于 `OPENAI_API_KEY`：

```env
OPENAI_API_KEYS=key_1,key_2,key_3
OPENAI_PER_KEY_CONCURRENCY=8
```

`OPENAI_PER_KEY_CONCURRENCY=8` 表示单个 key 同时最多跑 8 个模型请求。多个 key 会在同一个运行实例内自动选当前 in-flight 最少的 key。注意：这不是全局分布式限流；如果平台同时启动多个实例，每个实例都会各自做一份本地 key 池调度。

如果你使用的是 OpenAI 协议兼容服务，例如 newapi、oneapi 或公司内部代理，替换这两项即可：

```env
OPENAI_BASE_URL=https://your-openai-compatible-endpoint/v1
OPENAI_MODEL=your-supported-model-name
```

`OPENAI_BASE_URL` 如果只填到域名，项目会自动补 `/v1`；为了减少歧义，文档里仍建议直接写完整 `/v1` 地址。

注意：

- API key 只放在后端环境变量里，不会写进前端页面。
- `.env` 已在 `.gitignore` 中，不应被提交。
- 兼容端点需要支持 Chat Completions 风格请求、图片输入和 JSON 输出；如果某个代理不支持这些能力，生成可能会失败。
- `ENABLE_WEB_SEARCH=true` 只适合支持 OpenAI Responses API web search 工具的端点；不确定时先保持 `false`。

### Anthropic 模式

项目也保留了 Anthropic provider。如果你想用 Claude，可以在 `.env` 中配置：

```env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=
DEFAULT_MODEL=claude-opus-4-8
```

普通用户或新部署建议先使用 `mock` 或 `openai`，路径更容易理解。

---

## 推荐模型选择

当前 OpenAI 兼容实现支持每个 worker 单独选择模型。默认配置偏质量优先：

| 环节 | 做什么 | 默认模型 |
| --- | --- | --- |
| `parseResume` | 读简历截图，提取结构化信息 | `gpt-5.4-mini` |
| `extractEvidence` | 把经历拆成证据，并判断强度 | `gpt-5.5` |
| `synthesizeRoles` | 根据证据合成候选职业画像 | `gpt-5.5` |
| `opportunityScout` | 补充相邻/新兴/市场拉动方向 | `gpt-5.4` |
| `strategy` | 生成主路径、备选路径和行动建议 | `gpt-5.5` |
| `redTeam` | 检查幻觉、过度承诺和证据不足 | `gpt-5.5` |
| `marketSignal` | 可选联网检索市场信号 | `OPENAI_MODEL`，默认 `gpt-5.4-mini` |

如果你更在意成本和速度，可以把 `gpt-5.5` 降到 `gpt-5.4`，或把非关键环节降到 `gpt-5.4-mini`。不建议把 `extractEvidence`、`strategy`、`redTeam` 降得太低，因为它们直接影响证据质量、报告表达和安全审查。

模型选择没有固定答案，最好用你自己的样例简历做小规模评估：看报告是否引用了真实证据、是否过度推断、是否能给出具体可执行建议，再决定是否降级到更便宜的模型。

---

## 部署方式

这个项目不强制依赖 Vercel。它可以完整部署到 Cloudflare Workers，也可以作为普通 Node.js + Express 应用运行。前端静态文件在 `public/`，生成接口统一是 `/api/report/generate`。

你可以选择：

- 本地直接运行；
- 完整部署到 Cloudflare Workers；
- 部署到 Vercel；
- 部署到任何能运行 Node.js 服务的机器或平台。

### 部署到 Cloudflare Workers

Cloudflare 部署由一个 Worker 同时承载：

- `public/` 静态页面和收款码图片；
- `/api/report/generate` 报告生成接口；
- `QUOTA_DO` Durable Object 每日完整报告额度计数；
- `/healthz` 与 `/cloudflare-healthz` 健康检查。

准备工作：

```bash
npm install
npm run typecheck
npm run cf:build
```

首次部署前登录 Wrangler：

```bash
npx wrangler login
```

然后设置生产环境变量。真实 key 只写到 Cloudflare secret，不要写进 GitHub：

```bash
npx wrangler secret put OPENAI_API_KEYS
npx wrangler secret put OPENAI_BASE_URL
```

普通配置可以放在 Cloudflare Dashboard 的 Worker Variables，或按需用 Wrangler 配置：

```text
LLM_PROVIDER=openai
OPENAI_MODEL=gpt-5.4-mini
OPENAI_PER_KEY_CONCURRENCY=8
WORKER_MODEL_PARSE_RESUME=gpt-5.4-mini
WORKER_MODEL_EXTRACT_EVIDENCE=gpt-5.5
WORKER_MODEL_SYNTHESIZE_ROLES_FAST=gpt-5.4-mini
WORKER_MODEL_SYNTHESIZE_ROLES=gpt-5.5
WORKER_MODEL_OPPORTUNITY_SCOUT=gpt-5.4
WORKER_MODEL_STRATEGY_FAST=gpt-5.4-mini
WORKER_MODEL_STRATEGY=gpt-5.5
WORKER_MODEL_RED_TEAM=gpt-5.5
ENABLE_WEB_SEARCH=false
GEN_TIMEOUT_MS=760000
QUOTA_DAILY_LIMIT=100
QUOTA_TIME_ZONE=Asia/Shanghai
```

部署：

```bash
npm run cf:deploy
```

相关文件：

- `cloudflare/worker.ts`：Cloudflare 原生 Worker 入口；
- `wrangler.toml`：Worker、Static Assets、Durable Object 配置；
- `dist/cloudflare-worker.js`：API 直传部署时使用的编译产物，可由 `npm run cf:build` 重新生成。

Cloudflare 上的每日 100 次生成请求限制由 Durable Object 计数，比单机内存计数更适合线上使用。仍然建议根据真实访问量观察日志和模型账单。

### 部署到 Vercel

1. 把仓库导入 Vercel。
2. Project Root 选择仓库根目录。
3. 在 Vercel 项目的 Environment Variables 里添加变量。

OpenAI 兼容 API 的推荐配置：

```text
LLM_PROVIDER=openai
OPENAI_API_KEY=你的 API key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.4-mini
OPENAI_PER_KEY_CONCURRENCY=8
WORKER_MODEL_PARSE_RESUME=gpt-5.4-mini
WORKER_MODEL_EXTRACT_EVIDENCE=gpt-5.5
WORKER_MODEL_SYNTHESIZE_ROLES=gpt-5.5
WORKER_MODEL_OPPORTUNITY_SCOUT=gpt-5.4
WORKER_MODEL_STRATEGY=gpt-5.5
WORKER_MODEL_RED_TEAM=gpt-5.5
ENABLE_WEB_SEARCH=false
```

如果使用 OpenAI 兼容代理，把 `OPENAI_BASE_URL` 和 `OPENAI_MODEL` 换成该服务实际支持的值。多 key 时，把 `OPENAI_API_KEY` 换成：

```text
OPENAI_API_KEYS=key_1,key_2,key_3
```

不要把真实 key 写进 GitHub。Vercel 上应在 Environment Variables 里配置。

所有报告生成请求默认每天最多 100 次：

```text
QUOTA_DAILY_LIMIT=100
QUOTA_TIME_ZONE=Asia/Shanghai
```

如果部署在 Vercel 并且可能有多个实例，必须配置一个共享计数存储，推荐 Upstash Redis REST：

```text
QUOTA_REDIS_REST_URL=你的 Upstash Redis REST URL
QUOTA_REDIS_REST_TOKEN=你的 Upstash Redis REST token
```

不配置 Redis 时，系统会降级为内存计数，只适合本地开发或单实例测试；在 Vercel 多实例下不能准确限制全站每日次数。

可选变量：

```text
PORT=3000
PAY_QR_TRIAL=/pay-1.png
PAY_QR_FULL=/pay-10.png
PAY_QR_CUSTOM=/pay-custom.png
```

Vercel 相关文件已经准备好：

- `api/index.ts`：Vercel Serverless Function 入口；
- `vercel.json`：把请求改写到 API，并设置较长函数运行时间；
- `public/`：静态页面和收款码图片。

生成一次报告会串联多次 LLM 调用，快速版通常约 2 分钟，完整报告通常约 4-6 分钟。部署时建议选择支持较长函数运行时间的配置；如果经常超时，可以换更快的模型、减少图片数量，或把部分环节改成异步任务。

### 部署到普通 Node 服务

在服务器上安装依赖后运行：

```bash
npm install
npm start
```

生产环境建议用你熟悉的进程管理方式托管，例如 systemd、PM2、Docker 或平台自带的 Node.js 运行环境。只要环境变量配置正确，不需要数据库迁移，也不需要初始化存储。

---

## 数据和隐私说明

- 不依赖数据库。
- 不保存上传的简历截图。
- 不保存生成后的报告。
- 上传图片使用内存处理，单文件大小限制为 2MB，最多 4 张。
- API key 只应放在 `.env` 或部署平台的环境变量里。
- 如果你把项目公开到 GitHub，请不要提交 `.env`、`.vercel/` 或任何真实密钥。

如果你替换了 `public/pay-1.png`、`public/pay-10.png`、`public/pay-custom.png`，这些图片会随静态资源公开访问。

---

## 代码结构

```text
public/                  # 前端页面和静态图片
api/index.ts             # Vercel 入口
cloudflare/worker.ts     # Cloudflare Worker 入口
src/app.ts               # Express app、上传和生成接口
src/core/pipeline.ts     # 报告生成主流程
src/workers/             # 各个 LLM/规则 worker
src/providers/           # LLM、搜索、支付展示等 provider
src/data/                # 权重、能力维度、种子职业本体
evals/run.ts             # mock 模式评估入口
docs/                    # 算法架构说明
```

主流程大致是：

```text
简历解析 -> 证据抽取 -> 能力向量 -> 职业候选生成 -> 覆盖度打分 -> 策略生成 -> 对抗审查 -> 仲裁 -> QA -> 报告渲染
```

其中一部分环节由 LLM 完成，一部分环节是确定性代码。这样做的目的，是让模型负责理解和表达，让代码负责阈值、排序、硬规则和最终检查。

---

## 项目取舍

这个项目刻意保持轻量：

- 没有账号系统；
- 没有数据库；
- 没有后台任务队列；
- 没有支付回调；
- 没有长期保存用户数据；
- 没有把职业建议包装成确定结论。

它更像一个可以公开体验的职业画像生成器，也可以作为开发者学习“LLM 多步骤流水线 + 确定性规则 + Serverless 部署”的参考项目。
