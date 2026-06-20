import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import OpenAI from "openai";
import { z, type ZodType } from "zod";
import { config } from "../config.js";
import { MOCK } from "./mock.js";

export interface ImageInput {
  media_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string; // base64
}

export interface LlmRequest<T> {
  system?: string;
  userText: string;
  images?: ImageInput[];
  schema: ZodType<T>;
  schemaName: string; // 同时用于 mock 路由
  model: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}

export interface LlmProvider {
  complete<T>(req: LlmRequest<T>): Promise<{ value: T; model: string }>;
}

class AnthropicProvider implements LlmProvider {
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete<T>(req: LlmRequest<T>): Promise<{ value: T; model: string }> {
    const content: Anthropic.ContentBlockParam[] = [];
    for (const img of req.images ?? []) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.media_type, data: img.data },
      });
    }
    content.push({ type: "text", text: req.userText });

    const response = await this.client.messages.parse({
      model: req.model,
      max_tokens: req.maxTokens ?? 16000,
      thinking: { type: "adaptive" },
      ...(req.system ? { system: req.system } : {}),
      output_config: {
        format: zodOutputFormat(req.schema),
        effort: req.effort ?? "high",
      },
      messages: [{ role: "user", content }],
    });

    const parsed = response.parsed_output as T | null;
    if (parsed == null) {
      throw new Error(`结构化输出解析失败（${req.schemaName}），stop_reason=${response.stop_reason}`);
    }
    return { value: parsed, model: response.model };
  }
}

function extractJson(raw: string): unknown | undefined {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fallthrough */
  }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {
      /* give up */
    }
  }
  return undefined;
}

// OpenAI 协议兼容 provider：可指向官方 OpenAI 或任意 OpenAI 协议代理（newapi/oneapi 等）。
// 结构化输出走 json_object + schema 注入 + zod 校验 + 一次纠错重试，最大化跨代理/跨模型兼容性。
class OpenAICompatProvider implements LlmProvider {
  private clients: { client: OpenAI; inFlight: number; label: string }[];
  private model: string;
  private perKeyConcurrency: number;
  constructor(apiKeys: string[], baseURL: string, model: string, perKeyConcurrency: number) {
    this.clients = apiKeys.map((apiKey, i) => ({
      client: new OpenAI({ apiKey, baseURL, maxRetries: 0 }),
      inFlight: 0,
      label: `key${i + 1}`,
    }));
    this.model = model;
    this.perKeyConcurrency = Math.max(1, Math.floor(perKeyConcurrency || 1));
  }

  async complete<T>(req: LlmRequest<T>): Promise<{ value: T; model: string }> {
    const jsonSchema = z.toJSONSchema(req.schema as z.ZodType, { unrepresentable: "any" });
    const sys = `${req.system ?? ""}\n\n【输出格式（必须严格遵守）】只输出一个 JSON 对象，必须严格符合下面的 JSON Schema；不要输出任何解释、思考、前后缀或 markdown 代码块：\n${JSON.stringify(jsonSchema)}`;

    const userContent: Array<Record<string, unknown>> = [];
    for (const img of req.images ?? []) {
      userContent.push({ type: "image_url", image_url: { url: `data:${img.media_type};base64,${img.data}` } });
    }
    userContent.push({ type: "text", text: req.userText });

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: sys },
      { role: "user", content: userContent },
    ];
    const model = req.model || this.model;

    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await this.create(messages, req.maxTokens ?? 16000, model);
      const raw = resp.choices?.[0]?.message?.content ?? "";
      const parsed = extractJson(raw);
      if (parsed !== undefined) {
        const r = req.schema.safeParse(parsed);
        if (r.success) return { value: r.data, model: resp.model ?? model };
        lastErr = r.error.message;
      } else {
        lastErr = "返回不是合法 JSON";
      }
      messages.push({ role: "assistant", content: raw.slice(0, 2000) });
      messages.push({
        role: "user",
        content: `上一次输出不符合要求（${lastErr.slice(0, 400)}）。请只输出严格符合上述 JSON Schema 的单个 JSON 对象。`,
      });
    }
    throw new Error(`OpenAI 结构化输出失败（${req.schemaName}）：${lastErr}`);
  }

  private async create(messages: Array<Record<string, unknown>>, maxTokens: number, model: string) {
    const base: Record<string, unknown> = {
      model,
      messages,
      response_format: { type: "json_object" },
      max_completion_tokens: maxTokens,
    };
    const slot = await this.acquireClient();
    try {
      return await slot.client.chat.completions.create(base as never);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 代理/模型不认某些参数时逐项降级
      if (/response_format|json_object/i.test(msg)) {
        const { response_format, ...rest } = base;
        void response_format;
        return await slot.client.chat.completions.create(rest as never);
      }
      if (/max_completion_tokens/i.test(msg)) {
        const { max_completion_tokens, ...rest } = base;
        void max_completion_tokens;
        return await slot.client.chat.completions.create({ ...rest, max_tokens: maxTokens } as never);
      }
      throw e;
    } finally {
      slot.inFlight = Math.max(0, slot.inFlight - 1);
    }
  }

  private async acquireClient(): Promise<{ client: OpenAI; inFlight: number; label: string }> {
    while (true) {
      const slot = [...this.clients].sort((a, b) => a.inFlight - b.inFlight)[0];
      if (!slot) throw new Error("未配置 OpenAI API key");
      if (slot.inFlight < this.perKeyConcurrency) {
        slot.inFlight += 1;
        return slot;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  }
}

class MockProvider implements LlmProvider {
  async complete<T>(req: LlmRequest<T>): Promise<{ value: T; model: string }> {
    const data = MOCK[req.schemaName];
    if (data === undefined) {
      throw new Error(`mock 缺少 ${req.schemaName} 的假数据`);
    }
    // 模拟少量延迟，体感更接近真实流水线
    await new Promise((r) => setTimeout(r, 120));
    return { value: data as T, model: "mock" };
  }
}

let _provider: LlmProvider | null = null;
export function getLlm(): LlmProvider {
  if (_provider) return _provider;
  if (config.provider === "anthropic") {
    if (!config.anthropicApiKey) {
      throw new Error("LLM_PROVIDER=anthropic 但未设置 ANTHROPIC_API_KEY");
    }
    _provider = new AnthropicProvider(config.anthropicApiKey);
  } else if (config.provider === "openai") {
    const apiKeys = config.openai.apiKeys.length ? config.openai.apiKeys : config.openai.apiKey ? [config.openai.apiKey] : [];
    if (apiKeys.length === 0) {
      throw new Error("LLM_PROVIDER=openai 但未设置 OPENAI_API_KEY 或 OPENAI_API_KEYS");
    }
    _provider = new OpenAICompatProvider(apiKeys, config.openai.baseURL, config.openai.model, config.openai.perKeyConcurrency);
  } else {
    _provider = new MockProvider();
  }
  return _provider;
}
