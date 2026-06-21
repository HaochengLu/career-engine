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
  private clientPromise: Promise<unknown>;
  constructor(apiKey: string) {
    this.clientPromise = (async () => {
      const sdkName = "@anthropic-ai/sdk";
      const mod = (await import(sdkName)) as { default: new (args: { apiKey: string }) => unknown };
      return new mod.default({ apiKey });
    })();
  }

  async complete<T>(req: LlmRequest<T>): Promise<{ value: T; model: string }> {
    const client = (await this.clientPromise) as {
      messages: {
        parse(args: Record<string, unknown>): Promise<{ parsed_output: unknown; stop_reason?: string; model: string }>;
      };
    };
    const helperName = "@anthropic-ai/sdk/helpers/zod";
    const { zodOutputFormat } = (await import(helperName)) as { zodOutputFormat(schema: ZodType<unknown>): unknown };
    const content: Array<Record<string, unknown>> = [];
    for (const img of req.images ?? []) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.media_type, data: img.data },
      });
    }
    content.push({ type: "text", text: req.userText });

    const response = await client.messages.parse({
      model: req.model,
      max_tokens: req.maxTokens ?? 16000,
      thinking: { type: "adaptive" },
      ...(req.system ? { system: req.system } : {}),
      output_config: {
        format: zodOutputFormat(req.schema as ZodType<unknown>),
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

class OpenAICompatError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "OpenAICompatError";
  }
}

function isUpstreamTimeout(error: unknown): boolean {
  return error instanceof OpenAICompatError && (error.status === 524 || error.status === 408 || error.status === 504);
}

function uniqueModels(primary: string, fallback: string): string[] {
  return [primary, fallback].map((m) => m.trim()).filter((m, i, arr) => Boolean(m) && arr.indexOf(m) === i);
}

// OpenAI 协议兼容 provider：可指向官方 OpenAI 或任意 OpenAI 协议代理（newapi/oneapi 等）。
// 结构化输出走 json_object + schema 注入 + zod 校验 + 一次纠错重试，最大化跨代理/跨模型兼容性。
class OpenAICompatProvider implements LlmProvider {
  private clients: { apiKey: string; inFlight: number; label: string }[];
  private baseURL: string;
  private model: string;
  private perKeyConcurrency: number;
  constructor(apiKeys: string[], baseURL: string, model: string, perKeyConcurrency: number) {
    this.clients = apiKeys.map((apiKey, i) => ({
      apiKey,
      inFlight: 0,
      label: `key${i + 1}`,
    }));
    this.baseURL = baseURL.replace(/\/+$/, "");
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
      const resp = await this.create(messages, req.maxTokens ?? 16000, model, req.schemaName);
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

  private async create(messages: Array<Record<string, unknown>>, maxTokens: number, model: string, schemaName: string) {
    const models = uniqueModels(model, this.model);
    let lastTimeout: unknown;
    for (const candidate of models) {
      try {
        return await this.createWithRetry(messages, maxTokens, candidate);
      } catch (error) {
        if (!isUpstreamTimeout(error)) throw error;
        lastTimeout = error;
        if (candidate !== this.model) {
          console.warn(`[llm:timeout] ${schemaName} model=${candidate} fallback=${this.model}`);
        }
      }
    }
    const last = lastTimeout instanceof OpenAICompatError ? `HTTP ${lastTimeout.status}` : "timeout";
    throw new Error(`上游模型服务超时（${last}）。系统已自动重试并切换到更快模型，但仍未成功，请稍后重试或减少图片。`);
  }

  private async createWithRetry(messages: Array<Record<string, unknown>>, maxTokens: number, model: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.createOnce(messages, maxTokens, model);
      } catch (error) {
        if (!isUpstreamTimeout(error)) throw error;
        lastError = error;
        if (attempt === 0) {
          console.warn(`[llm:retry] upstream timeout model=${model}`);
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
      }
    }
    throw lastError;
  }

  private async createOnce(messages: Array<Record<string, unknown>>, maxTokens: number, model: string) {
    const base: Record<string, unknown> = {
      model,
      messages,
      response_format: { type: "json_object" },
      max_completion_tokens: maxTokens,
    };
    const slot = await this.acquireClient();
    try {
      return await this.postWithParameterFallback(slot.apiKey, base, maxTokens);
    } finally {
      slot.inFlight = Math.max(0, slot.inFlight - 1);
    }
  }

  private async postWithParameterFallback(apiKey: string, base: Record<string, unknown>, maxTokens: number) {
    try {
      return await this.postChatCompletion(apiKey, base);
    } catch (e) {
      if (isUpstreamTimeout(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      // 代理/模型不认某些参数时逐项降级
      if (/response_format|json_object/i.test(msg)) {
        const { response_format, ...rest } = base;
        void response_format;
        return await this.postChatCompletion(apiKey, rest);
      }
      if (/max_completion_tokens/i.test(msg)) {
        const { max_completion_tokens, ...rest } = base;
        void max_completion_tokens;
        return await this.postChatCompletion(apiKey, { ...rest, max_tokens: maxTokens });
      }
      throw e;
    }
  }

  private async postChatCompletion(apiKey: string, body: Record<string, unknown>): Promise<{ choices?: Array<{ message?: { content?: string } }>; model?: string }> {
    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new OpenAICompatError(`OpenAI compatible API failed: ${res.status} ${text.slice(0, 800)}`, res.status, text);
    }
    try {
      return JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }>; model?: string };
    } catch {
      throw new Error(`OpenAI compatible API returned non-JSON response: ${text.slice(0, 800)}`);
    }
  }

  private async acquireClient(): Promise<{ apiKey: string; inFlight: number; label: string }> {
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
