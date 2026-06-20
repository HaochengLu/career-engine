import type { ReportArtifacts, Tier, Strategy, CapabilityScore, ReportMeta } from "../types.js";
import { getPaymentInfo } from "../providers/payment.js";
import { maskPII } from "../core/pii.js";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PAGE_CSS = `
:root{--bg:#faf8f3;--card:#fff;--ink:#1f2328;--muted:#6b7280;--line:#e7e3da;--accent:#b4532a;--good:#2f7d4f;--warn:#b58900}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:24px 18px 60px}
h1{font-size:24px;margin:8px 0 4px}
h2{font-size:18px;margin:30px 0 10px;padding-bottom:6px;border-bottom:2px solid var(--line)}
.sub{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:14px 0;box-shadow:0 1px 2px rgba(0,0,0,.03)}
.oneliner{font-size:18px;line-height:1.7;background:#fff;border-left:4px solid var(--accent);border-radius:8px;padding:16px 18px}
table{width:100%;border-collapse:collapse;font-size:14px;margin:8px 0}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px}
.tag{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.b-强{color:var(--good);font-weight:600}.b-中{color:var(--warn);font-weight:600}.b-弱{color:var(--muted)}
.b-高{color:var(--good);font-weight:600}.b-低{color:var(--accent);font-weight:600}
.label-near_term{background:#eaf5ee;color:var(--good)}
.label-high_ceiling{background:#fdf1e7;color:var(--accent)}
.label-challenge{background:#fbf3d9;color:var(--warn)}
.path{border:1px solid var(--line);border-radius:10px;padding:14px;margin:10px 0}
.path h3{margin:0 0 6px;font-size:16px}
.muted{color:var(--muted)}.small{font-size:13px}
ul{margin:6px 0;padding-left:20px}li{margin:3px 0}
.card-strategy{background:#1f2328;color:#fff;border-radius:14px;padding:20px}
.card-strategy h2{color:#fff;border-color:#3a3f45}
.card-strategy .row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid #3a3f45;font-size:14px}
.card-strategy .k{color:#a6adb5}.card-strategy .v{text-align:right;font-weight:600}
.pay{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:18px;text-align:center}
.pay .qrs{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;margin-top:10px}
.pay .qrbox{font-size:13px;color:var(--muted)}
.qr{width:170px;height:auto;border:1px solid var(--line);border-radius:10px;display:block}
.notice{background:#fff7ed;border:1px solid #f3d8b6;border-radius:10px;padding:12px 14px;font-size:13px;color:#7a4a1d}
.foot{color:var(--muted);font-size:12px;margin-top:28px;line-height:1.7}
`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
}

export function renderFailed(meta: ReportMeta): string {
  return shell(
    "生成失败",
    `<h1>这次没能生成</h1><p class="sub">状态：${esc(meta.status)}</p>
     <div class="notice">${esc(meta.error ?? "出现了未知问题。")}</div>
     <p class="small muted">可以用更清晰的截图、或补充目标方向后重试。</p>`,
  );
}

export function renderInsufficient(artifacts: ReportArtifacts): string {
  return shell(
    "信息不足",
    `<h1>当前信息不足以给出高置信判断</h1>
     <div class="notice">${esc(artifacts.insufficient_reason ?? "可识别的职业证据太少。")}</div>
     <p>建议补充后重新生成：</p>
     <ul>
       <li>更清晰、完整的简历截图。</li>
       <li>你做过的具体项目 / 实习 / 作品（哪怕一两段也好）。</li>
       <li>你想冲的方向、目标城市/国家、硬约束。</li>
     </ul>
     <p class="small muted">这是刻意设计：宁可说“信息不足”，也不在没有证据时硬编一份看起来很确定的报告。</p>`,
  );
}

function capRows(vec: CapabilityScore[]): string {
  return vec
    .filter((c) => c.capability !== "other" || c.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .map(
      (c) =>
        `<tr><td>${esc(c.name_zh)}</td><td><span class="b-${c.band}">${c.band}</span></td><td class="small muted">${esc(
          c.top_evidence_ids.join(", ") || "—",
        )}</td></tr>`,
    )
    .join("");
}

function pathBlock(s: Strategy): string {
  const labelZh: Record<string, string> = {
    near_term: "近期最现实",
    high_ceiling: "未来最有上限",
    challenge: "挑战型",
    transition: "过渡",
    not_recommended: "暂不建议",
  };
  return s.paths
    .map(
      (p) => `<div class="path">
      <h3>${esc(p.display_name)} <span class="tag label-${esc(p.label)}">${esc(labelZh[p.label] ?? p.label)}</span></h3>
      <p class="small">建议：<b>${esc(p.recommendation)}</b> ｜ 当前匹配 <span class="b-${p.current_fit_band}">${p.current_fit_band}</span> ｜ 未来上限 <span class="b-${p.future_band}">${p.future_band}</span> ｜ 入门 ${esc(p.entry_difficulty)} ｜ 置信 <span class="b-${p.confidence_band}">${p.confidence_band}</span></p>
      <p>${esc(p.why_fit)}</p>
      <p class="small"><b>已有证据：</b>${esc(p.have_evidence)}</p>
      <p class="small"><b>缺什么：</b>${esc(p.missing_evidence)}</p>
      <p class="small muted">投递关键词：${esc(p.target_titles.join("、"))}</p>
      <p class="small"><b>最该补：</b>${esc(p.top_project)}</p>
      <p class="small muted">不推荐情况：${esc(p.not_recommended_when)}</p>
    </div>`,
    )
    .join("");
}

function upsideBlock(s: Strategy): string {
  const u = s.adjacent_upside;
  if (!u || !u.display_name) return "";
  return `<div class="path" style="border-color:var(--accent);background:#fdf6f0">
    <h3>${esc(u.display_name)} <span class="tag label-high_ceiling">高上限相邻</span></h3>
    <p>${esc(u.why)}</p>
    <p class="small"><b>最该补（把它从“相邻”变成“可冲”）：</b>${esc(u.what_to_build)}</p>
    <p class="small muted">支撑证据：${esc(u.supporting_evidence_ids.join(", ") || "—")}</p>
  </div>`;
}

function strategyCard(s: Strategy): string {
  const c = s.strategy_card;
  const row = (k: string, v: string) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  return `<div class="card-strategy"><h2>职业战略卡</h2>
    ${row("主路径", c.main_path)}
    ${row("副路径", c.secondary_path)}
    ${row("挑战路径", c.challenge_path)}
    ${row("暂不主攻", c.not_recommended)}
    ${row("核心卖点", c.core_selling_point)}
    ${row("最大短板", c.biggest_gap)}
    ${row("30天最重要", c.most_important_30d)}
  </div>`;
}

// 全凭自觉付费：微信收款码。初版给 ¥1 码、完整给 ¥10 码，另附自定义金额码。
function paymentBlock(tier: Tier): string {
  const p = getPaymentInfo();
  const main = tier === "full" ? { src: p.qrFull, label: "完整报告 ¥10" } : { src: p.qrTrial, label: "初版 ¥1" };
  const box = (src: string, label: string) =>
    src ? `<div class="qrbox"><img class="qr" src="${esc(src)}" alt="${esc(label)}"><div>${esc(label)}</div></div>` : "";
  return `<div class="pay">
    <div class="small muted">这份报告免费给你看。如果判断对你有用、愿意支持，微信扫码自觉付款即可（不付也没关系）。</div>
    <div class="qrs">
      ${box(main.src, main.label)}
      ${box(p.qrCustom, "其它金额 / 随意打赏")}
    </div>
  </div>`;
}

const DISCLAIMER = `
<div class="foot">
  <b>怎么看这份报告：</b>这是基于你<u>当前提供的材料</u>得出的职业路径建议，不是人生结论。所有判断都尽量回到你材料里的证据；不确定的地方用“弱/中/低置信”表达，不假装精确。<br>
  系统能可信判断的是“你的证据现在最能说服哪类岗位、缺什么证据最值得补”；它<u>不</u>掌握实时岗位数据，对“市场前景/未来上限”的判断是带低置信的弱信号，请自行结合现实核对。<br>
  评分采用证据覆盖度计分，权重为公开、可校准的启发式先验（未经真实反馈标定，calibrated_on_samples=0），仅以弱/中/强分档展示；路径排序仅供参考，请结合“当前匹配”与“证据质量”自行判断。<br>
  <b>隐私：</b>本服务不存储你的简历与报告（生成完即丢，刷新就没了）；仍建议上传前对手机号/邮箱/证件号打码。
</div>`;

export function renderReport(meta: ReportMeta, artifacts: ReportArtifacts): string {
  const s = artifacts.strategy;
  if (!s) return renderFailed(meta);
  const tier: Tier = meta.tier;
  const vec = artifacts.capability_vector ?? [];
  const pay = paymentBlock(tier);

  const head = `<h1>职业画像报告</h1><p class="sub">${tier === "trial" ? "初版" : "完整报告"} ｜ ${esc(new Date(meta.createdAt).toLocaleDateString("zh-CN"))}</p>
    <div class="oneliner">${esc(s.one_liner)}</div>`;

  // 初版（trial）：精简钩子
  if (tier === "trial") {
    const topGaps = s.gap_map.slice(0, 3).map((g) => `<li><b>${esc(g.gap)}</b> — ${esc(g.shortest_fix)}（${esc(g.estimated_cost)}）</li>`).join("");
    const topCaps = [...vec].sort((a, b) => b.score - a.score).slice(0, 3).map((c) => `<li>${esc(c.name_zh)}：<span class="b-${c.band}">${c.band}</span></li>`).join("");
    const body = `${head}
      <h2>Top 3 职业路径</h2>${pathBlock({ ...s, paths: s.paths.slice(0, 3) } as Strategy)}
      <h2>高上限相邻路径（你可能没想到，但天花板更高）</h2>${upsideBlock(s)}
      <h2>你当前最强的能力证据</h2><ul>${topCaps}</ul>
      <h2>你当前最该补的缺口</h2><ul>${topGaps}</ul>
      ${strategyCard(s)}
      <div class="notice">这是 <b>初版</b>。完整报告（¥10）还包含：能力资产全表、不建议方向、完整 Gap Map、作品集/项目模板、简历叙事重构、30 天行动计划。重新选“完整报告”再生成即可。</div>
      ${DISCLAIMER}${pay}`;
    return shell("职业画像报告（初版）", maskPII(body));
  }

  // 完整报告（full）
  const notRec = s.not_recommended
    .map(
      (n) => `<div class="card"><b>暂不建议优先冲：${esc(n.direction)}</b>
      <ul>${n.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      <p class="small">更好的策略：${esc(n.better_strategy)}</p></div>`,
    )
    .join("");
  const gapRows = s.gap_map
    .map((g) => `<tr><td>${esc(g.gap)}</td><td class="small">${esc(g.why_it_matters)}</td><td class="small">${esc(g.shortest_fix)}</td><td class="small muted">${esc(g.estimated_cost)}</td></tr>`)
    .join("");
  const projects = s.projects
    .map(
      (p) => `<div class="card"><b>${esc(p.name)}</b> <span class="tag">${esc(p.target_role)}</span>
      <p class="small"><b>证明：</b>${esc(p.proves)}</p>
      <p class="small"><b>交付物：</b>${esc(p.deliverable)}</p>
      <p class="small"><b>最低标准：</b>${esc(p.min_bar)} ｜ <b>加分：</b>${esc(p.bonus_bar)}</p>
      <p class="small muted"><b>简历 bullet：</b>${esc(p.resume_bullet)}</p>
      <p class="small muted"><b>面试讲法：</b>${esc(p.interview_pitch)}</p></div>`,
    )
    .join("");

  const body = `${head}
    <h2>你手上有什么牌（能力资产表）</h2>
    <table><thead><tr><th>能力资产</th><th>强度</th><th>来源证据</th></tr></thead><tbody>${capRows(vec)}</tbody></table>
    <h2>最适合的方向（Top 3）</h2>${pathBlock(s)}
    <h2>高上限相邻路径（你可能没想到，但天花板更高）</h2>${upsideBlock(s)}
    <h2>暂不建议优先走的方向</h2>${notRec || '<p class="muted small">（无）</p>'}
    <h2>Gap Map（证据缺口）</h2>
    <table><thead><tr><th>缺口</th><th>为什么重要</th><th>最短补法</th><th>成本</th></tr></thead><tbody>${gapRows}</tbody></table>
    <h2>作品集 / 项目建议</h2>${projects}
    <h2>简历叙事重构</h2><ul>${s.narrative_rewrite.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    <h2>30 天行动计划</h2><ul>${s.thirty_day_plan.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    ${strategyCard(s)}
    ${DISCLAIMER}${pay}`;
  return shell("职业画像报告", maskPII(body));
}
