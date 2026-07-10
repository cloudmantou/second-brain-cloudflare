/**
 * OpenAI-compatible HTTP clients for chat + embeddings.
 * Works with DeepSeek, MiniMax, MiMo, OpenAI, and most gateways.
 */

import type { ChatMessage, ChatOptions, LLMProvider } from "./llm";
import type { EmbedOptions, EmbeddingProvider } from "./embedding";
import { logModelCall } from "../telemetry/queue";

export interface OpenAICompatibleConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  /** Optional default request body extras (e.g. disable thinking). */
  defaultExtraBody?: Record<string, unknown>;
}

export interface OpenAICompatibleEmbeddingConfig extends OpenAICompatibleConfig {
  /** Expected output dimensions; validated on response. */
  dimensions?: number;
  /** Only send body.dimensions when the provider supports it (e.g. OpenAI, not SiliconFlow BGE). */
  sendDimensionsParameter?: boolean;
}

function normalizeBaseURL(baseURL: string): string {
  return baseURL.replace(/\/+$/, "");
}

function normalizeApiKey(apiKey: string): string {
  let k = String(apiKey ?? "").trim().replace(/^Bearer\s+/i, "").trim();
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1).trim();
  }
  return k;
}

/** Enrich provider 401/2049 messages with region/key-type hints (esp. MiniMax). */
function enrichLlmHttpError(status: number, errBody: string, baseURL: string): string {
  const body = errBody.slice(0, 300);
  let msg = `LLM error ${status}: ${body}`;
  const lower = `${baseURL} ${body}`.toLowerCase();
  const isMiniMax =
    lower.includes("minimax") ||
    lower.includes("authorized_error") ||
    body.includes("2049") ||
    body.includes("无效的 API");
  if (status === 401 || body.includes("2049")) {
    if (isMiniMax || baseURL.includes("minimax")) {
      const isIo = baseURL.includes("minimax.io");
      const isCn = baseURL.includes("minimaxi.com");
      const regionHint = isIo
        ? "当前 Base URL 是国际站 api.minimax.io；若密钥来自国内 platform.minimaxi.com，请改用 https://api.minimaxi.com/v1"
        : isCn
          ? "当前 Base URL 是国内站 api.minimaxi.com；若密钥来自国际 platform.minimax.io，请改用 https://api.minimax.io/v1"
          : "请确认密钥与 Base URL 区域一致（国内 minimaxi.com / 国际 minimax.io）";
      msg += ` | 提示: MiniMax 401/2049=密钥无效或区域不匹配。${regionHint}。密钥需在开放平台「接口密钥」创建，不要混用 Coding Plan 订阅 Key 与按量 API Key。`;
    }
  }
  return msg;
}

function textToCfSseStream(text: string): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`)
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** Disable thinking for models that enable it by default (DeepSeek V4, MiniMax M3). */
export function thinkingDisabledBody(): Record<string, unknown> {
  return { thinking: { type: "disabled" } };
}

export class OpenAICompatibleLLM implements LLMProvider {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private defaultExtraBody?: Record<string, unknown>;

  constructor(config: OpenAICompatibleConfig) {
    this.baseURL = normalizeBaseURL(config.baseURL);
    this.apiKey = normalizeApiKey(config.apiKey);
    this.model = config.model;
    this.defaultExtraBody = config.defaultExtraBody;
  }

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const started = Date.now();
    const inputPreview = messages.map((m) => m.content).join("\n").slice(0, 2000);
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.max_tokens,
      stream: false,
      ...(this.defaultExtraBody ?? {}),
      ...(options.extraBody ?? {}),
    };
    if (options.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    try {
      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(enrichLlmHttpError(response.status, errBody, this.baseURL));
      }

      const json = (await response.json()) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("LLM response missing choices[0].message.content");
      }
      logModelCall({
        call_type: "chat",
        provider: this.baseURL,
        model: this.model,
        duration_ms: Date.now() - started,
        status: "success",
        input_tokens: json.usage?.prompt_tokens ?? null,
        output_tokens: json.usage?.completion_tokens ?? null,
        total_tokens: json.usage?.total_tokens ?? null,
        input: inputPreview,
        output: content,
      });
      return content;
    } catch (e) {
      logModelCall({
        call_type: "chat",
        provider: this.baseURL,
        model: this.model,
        duration_ms: Date.now() - started,
        status: "error",
        input: inputPreview,
        error_message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  async chatAsCfSse(messages: ChatMessage[], options: ChatOptions = {}): Promise<ReadableStream> {
    const text = await this.chat(messages, options);
    return textToCfSseStream(text);
  }
}

/** MiniMax embedding (embo-01) uses native body/response, not OpenAI shape. */
function isMiniMaxEmbeddingHost(baseURL: string): boolean {
  const u = baseURL.toLowerCase();
  return (
    u.includes("minimax.io") ||
    u.includes("minimaxi.com") ||
    u.includes("minimax.chat")
  );
}

/**
 * Extract a single embedding vector from OpenAI-compatible or MiniMax-native responses.
 * OpenAI: { data: [{ embedding: number[] }] }
 * MiniMax: { vectors: number[][], base_resp: { status_code } }
 */
export function extractEmbeddingVector(
  json: Record<string, unknown>
): number[] | null {
  // MiniMax error envelope
  const baseResp = json.base_resp as
    | { status_code?: number; status_msg?: string }
    | undefined;
  if (baseResp && baseResp.status_code != null && baseResp.status_code !== 0) {
    throw new Error(
      `MiniMax embedding error ${baseResp.status_code}: ${baseResp.status_msg || "unknown"}`
    );
  }

  // OpenAI / SiliconFlow / Zhipu
  const data = json.data;
  if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
    const emb = (data[0] as { embedding?: unknown }).embedding;
    if (Array.isArray(emb) && emb.every((x) => typeof x === "number")) {
      return emb as number[];
    }
  }

  // MiniMax native: vectors: number[][]
  const vectors = json.vectors;
  if (Array.isArray(vectors) && Array.isArray(vectors[0])) {
    const emb = vectors[0] as unknown[];
    if (emb.every((x) => typeof x === "number")) return emb as number[];
  }

  // Rare: top-level embedding
  if (Array.isArray(json.embedding) && (json.embedding as unknown[]).every((x) => typeof x === "number")) {
    return json.embedding as number[];
  }

  return null;
}

export class OpenAICompatibleEmbedding implements EmbeddingProvider {
  private baseURL: string;
  private apiKey: string;
  private model: string;
  private dimensions?: number;
  private sendDimensionsParameter: boolean;
  private miniMax: boolean;

  constructor(config: OpenAICompatibleEmbeddingConfig) {
    this.baseURL = normalizeBaseURL(config.baseURL);
    this.apiKey = normalizeApiKey(config.apiKey);
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.sendDimensionsParameter = config.sendDimensionsParameter !== false;
    this.miniMax = isMiniMaxEmbeddingHost(this.baseURL);
  }

  async embed(text: string, options: EmbedOptions = {}): Promise<number[]> {
    const started = Date.now();
    // MiniMax embo-01: texts + type (db|query), not OpenAI input
    const body: Record<string, unknown> = this.miniMax
      ? {
          model: this.model || "embo-01",
          texts: [text],
          type: options.purpose === "query" ? "query" : "db",
        }
      : {
          model: this.model,
          input: text,
        };
    // Only OpenAI / some Qwen models support dimensions — SiliconFlow BGE rejects it.
    // MiniMax native API does not take dimensions.
    if (
      !this.miniMax &&
      this.sendDimensionsParameter &&
      this.dimensions != null &&
      this.dimensions > 0
    ) {
      body.dimensions = this.dimensions;
    }

    try {
      const response = await fetch(`${this.baseURL}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(`Embedding error ${response.status}: ${errBody.slice(0, 280)}`);
      }

      const json = (await response.json()) as Record<string, unknown> & {
        usage?: { prompt_tokens?: number; total_tokens?: number };
      };
      const embedding = extractEmbeddingVector(json);
      if (!Array.isArray(embedding)) {
        const keys = Object.keys(json).slice(0, 12).join(",");
        throw new Error(
          `Embedding response missing vector (expected data[0].embedding or vectors[0]; keys=${keys}). ` +
            (this.miniMax
              ? "MiniMax 需用原生格式 texts/type；若仍失败请改用硅基流动 BGE。"
              : "检查模型是否支持 /embeddings。")
        );
      }
      if (this.dimensions != null && embedding.length !== this.dimensions) {
        throw new Error(
          `Embedding dimension mismatch: expected ${this.dimensions}, got ${embedding.length}`
        );
      }
      logModelCall({
        call_type: "embedding",
        provider: this.baseURL,
        model: this.model,
        duration_ms: Date.now() - started,
        status: "success",
        input_tokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? null,
        total_tokens: json.usage?.total_tokens ?? null,
        input: text,
      });
      return embedding;
    } catch (e) {
      logModelCall({
        call_type: "embedding",
        provider: this.baseURL,
        model: this.model,
        duration_ms: Date.now() - started,
        status: "error",
        input: text,
        error_message: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
}
