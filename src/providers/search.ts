import OpenAI from "openai";
import { config } from "../config.js";

// 联网检索抽象：默认 Noop（用模型知识，零依赖）；开启后用 OpenAI Responses API 的 web_search 工具。
// 一切失败都降级为空字符串，绝不让检索拖垮主流程。
export interface SearchProvider {
  search(query: string): Promise<string>;
}

class NoopSearch implements SearchProvider {
  async search(): Promise<string> {
    return "";
  }
}

class OpenAIResponsesSearch implements SearchProvider {
  private client: OpenAI;
  private model: string;
  constructor(apiKey: string, baseURL: string, model: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.model = model;
  }
  async search(query: string): Promise<string> {
    try {
      const resp = await this.client.responses.create({
        model: this.model,
        tools: [{ type: "web_search" } as never],
        input: query,
        max_output_tokens: 800,
      } as never);
      const text = (resp as { output_text?: string }).output_text ?? "";
      return text.trim();
    } catch (e) {
      console.error("[webSearch] 检索失败，降级为无检索：", e instanceof Error ? e.message : e);
      return "";
    }
  }
}

let _search: SearchProvider | null = null;
export function getSearch(): SearchProvider {
  if (_search) return _search;
  if (config.enableWebSearch && config.provider === "openai" && config.openai.apiKey) {
    _search = new OpenAIResponsesSearch(config.openai.apiKey, config.openai.baseURL, config.openai.model);
  } else {
    _search = new NoopSearch();
  }
  return _search;
}
