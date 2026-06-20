// 市场信号（可选，联网）：让“市场拉动/新兴方向”召回基于实时信息而非纯模型记忆。
// 关闭联网时返回空串，下游召回自动只用模型知识——不破坏任何流程。
import { getSearch } from "../providers/search.js";
import type { CapabilityScore, EvidenceItem, UserInputs } from "../types.js";

export async function marketSignal(
  capabilityVector: CapabilityScore[],
  evidence: EvidenceItem[],
  inputs: UserInputs,
): Promise<string> {
  const search = getSearch();
  const topCaps = [...capabilityVector].sort((a, b) => b.score - a.score).slice(0, 5).map((c) => c.name_zh);
  const frontier = [...new Set(evidence.flatMap((e) => e.frontier_signals))];
  const region = [...(inputs.target_countries ?? []), ...(inputs.target_locations ?? [])].join("、") || "中国/北美";
  const desired = (inputs.desired_roles ?? []).join("、") || "未指定";

  const query = `面向具备[${topCaps.join("、")}]能力、前沿信号[${frontier.join("、") || "无"}]、目标地区[${region}]、想做[${desired}]的求职者：
列出当下正被市场拉动、需求增长、天花板更高的【新兴/相邻复合岗位】（含 AI 相关与非 AI 各举几例），每个一句话说明：岗位名、需求/趋势信号、最看重的核心证据。只给要点清单。`;

  // 联网检索单独限时，避免某次搜索卡住拖垮整条同步流程（Vercel 时延敏感）。
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(""), 30_000));
  try {
    return await Promise.race([search.search(query), timeout]);
  } catch {
    return "";
  }
}
