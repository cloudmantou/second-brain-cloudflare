/**
 * Control-plane model configuration: presets, merge rules, secret masking.
 * Stored settings override process/env bindings at runtime (no restart).
 */

export interface LlmSettings {
  /** Preset id: deepseek | minimax | mimo | openai | custom | workers | none */
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface EmbeddingSettings {
  /** local | openai | custom | workers | none */
  provider: string;
  baseURL: string;
  apiKey: string;
  model: string;
  dimensions: number;
}

export interface ModelSettings {
  llm: LlmSettings;
  embedding: EmbeddingSettings;
  updatedAt?: number;
}

export interface PublicModelSettings {
  llm: Omit<LlmSettings, "apiKey"> & {
    apiKey: string; // masked or empty
    hasApiKey: boolean;
  };
  embedding: Omit<EmbeddingSettings, "apiKey"> & {
    apiKey: string;
    hasApiKey: boolean;
  };
  updatedAt?: number;
  /** Effective runtime status for the UI */
  status: {
    llm: "openai-compatible" | "workers-ai" | "unconfigured";
    embedding: "openai-compatible" | "local" | "workers-ai" | "unconfigured";
    source: "control-plane" | "env" | "mixed" | "default";
  };
  presets: {
    llm: { id: string; label: string; baseURL: string; model: string }[];
    embedding: { id: string; label: string; baseURL: string; model: string; dimensions: number }[];
  };
}

export const LLM_PRESETS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  {
    id: "minimax",
    label: "MiniMax",
    baseURL: "https://api.minimax.chat/v1",
    model: "MiniMax-Text-01",
  },
  {
    id: "mimo",
    label: "MiMo (OpenAI-compatible)",
    baseURL: "",
    model: "",
  },
  {
    id: "openai",
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    baseURL: "",
    model: "",
  },
] as const;

export const EMBEDDING_PRESETS = [
  {
    id: "local",
    label: "Local hash (built-in, dev quality)",
    baseURL: "",
    model: "local-hash",
    dimensions: 384,
  },
  {
    id: "openai",
    label: "OpenAI embeddings",
    baseURL: "https://api.openai.com/v1",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    baseURL: "",
    model: "",
    dimensions: 384,
  },
] as const;

export function emptyModelSettings(): ModelSettings {
  return {
    llm: { provider: "none", baseURL: "", apiKey: "", model: "" },
    // provider "none" means "not set in control plane" → fall back to env / Workers AI / self-host local
    embedding: {
      provider: "none",
      baseURL: "",
      apiKey: "",
      model: "",
      dimensions: 384,
    },
  };
}

export function maskSecret(secret: string | undefined | null): string {
  if (!secret) return "";
  if (secret.length <= 8) return "••••••••";
  return `${secret.slice(0, 3)}••••${secret.slice(-4)}`;
}

export function isMaskedSecret(value: string | undefined): boolean {
  return Boolean(value && value.includes("••"));
}

/** Env surface used when resolving effective provider config. */
export interface SettingsEnvInput {
  SELFHOST?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_PROVIDER?: string;
  EMBEDDING_DIM?: string;
  AI?: unknown;
}

/**
 * Merge stored control-plane settings with env fallbacks.
 * Stored non-empty fields win; empty stored apiKey falls back to env.
 */
export function mergeModelSettings(
  stored: ModelSettings | null | undefined,
  env: SettingsEnvInput
): ModelSettings {
  const base = emptyModelSettings();
  const s = stored ?? emptyModelSettings();

  const isSelfhost = env.SELFHOST === "1" || env.SELFHOST === "true";

  const llmProvider =
    s.llm.provider && s.llm.provider !== "none"
      ? s.llm.provider
      : env.LLM_BASE_URL && env.LLM_API_KEY
        ? "custom"
        : env.AI && !isSelfhost
          ? "workers"
          : "none";

  const embProvider =
    s.embedding.provider && s.embedding.provider !== "none"
      ? s.embedding.provider
      : env.EMBEDDING_BASE_URL && env.EMBEDDING_API_KEY
        ? "custom"
        : env.EMBEDDING_PROVIDER === "local" || isSelfhost
          ? "local"
          : env.AI
            ? "workers"
            : "none";

  return {
    llm: {
      provider: llmProvider,
      baseURL: s.llm.baseURL || env.LLM_BASE_URL || "",
      apiKey: s.llm.apiKey || env.LLM_API_KEY || "",
      model: s.llm.model || env.LLM_MODEL || "",
    },
    embedding: {
      provider: embProvider,
      baseURL: s.embedding.baseURL || env.EMBEDDING_BASE_URL || "",
      apiKey: s.embedding.apiKey || env.EMBEDDING_API_KEY || "",
      model: s.embedding.model || env.EMBEDDING_MODEL || "",
      dimensions:
        s.embedding.dimensions ||
        parseInt(env.EMBEDDING_DIM || "384", 10) ||
        384,
    },
    updatedAt: s.updatedAt,
  };
}

export function toPublicModelSettings(
  effective: ModelSettings,
  opts: { hasStored: boolean; hasEnvLlm: boolean; hasEnvEmbed: boolean }
): PublicModelSettings {
  let source: PublicModelSettings["status"]["source"] = "default";
  if (opts.hasStored && (opts.hasEnvLlm || opts.hasEnvEmbed)) source = "mixed";
  else if (opts.hasStored) source = "control-plane";
  else if (opts.hasEnvLlm || opts.hasEnvEmbed) source = "env";

  const llmStatus: PublicModelSettings["status"]["llm"] =
    effective.llm.baseURL && effective.llm.apiKey
      ? "openai-compatible"
      : effective.llm.provider === "workers"
        ? "workers-ai"
        : "unconfigured";

  const embStatus: PublicModelSettings["status"]["embedding"] =
    effective.embedding.provider === "local"
      ? "local"
      : effective.embedding.baseURL && effective.embedding.apiKey
        ? "openai-compatible"
        : effective.embedding.provider === "workers"
          ? "workers-ai"
          : "unconfigured";

  return {
    llm: {
      provider: effective.llm.provider,
      baseURL: effective.llm.baseURL,
      model: effective.llm.model,
      apiKey: maskSecret(effective.llm.apiKey),
      hasApiKey: Boolean(effective.llm.apiKey),
    },
    embedding: {
      provider: effective.embedding.provider,
      baseURL: effective.embedding.baseURL,
      model: effective.embedding.model,
      dimensions: effective.embedding.dimensions,
      apiKey: maskSecret(effective.embedding.apiKey),
      hasApiKey: Boolean(effective.embedding.apiKey),
    },
    updatedAt: effective.updatedAt,
    status: { llm: llmStatus, embedding: embStatus, source },
    presets: {
      llm: LLM_PRESETS.map((p) => ({ ...p })),
      embedding: EMBEDDING_PRESETS.map((p) => ({ ...p })),
    },
  };
}

/**
 * Apply a partial PUT body onto previous stored settings.
 * Masked or empty apiKey keeps the previous key.
 */
export function applyModelSettingsPatch(
  previous: ModelSettings,
  body: {
    llm?: Partial<LlmSettings>;
    embedding?: Partial<EmbeddingSettings>;
  }
): ModelSettings {
  const next = structuredClone(previous);

  if (body.llm) {
    if (body.llm.provider != null) next.llm.provider = String(body.llm.provider);
    if (body.llm.baseURL != null) next.llm.baseURL = String(body.llm.baseURL).trim();
    if (body.llm.model != null) next.llm.model = String(body.llm.model).trim();
    if (body.llm.apiKey != null) {
      const k = String(body.llm.apiKey);
      if (k && !isMaskedSecret(k)) next.llm.apiKey = k.trim();
    }
    // Apply preset defaults when switching provider if fields empty
    const preset = LLM_PRESETS.find((p) => p.id === next.llm.provider);
    if (preset) {
      if (!next.llm.baseURL && preset.baseURL) next.llm.baseURL = preset.baseURL;
      if (!next.llm.model && preset.model) next.llm.model = preset.model;
    }
  }

  if (body.embedding) {
    if (body.embedding.provider != null)
      next.embedding.provider = String(body.embedding.provider);
    if (body.embedding.baseURL != null)
      next.embedding.baseURL = String(body.embedding.baseURL).trim();
    if (body.embedding.model != null)
      next.embedding.model = String(body.embedding.model).trim();
    if (body.embedding.dimensions != null) {
      const d = Number(body.embedding.dimensions);
      if (Number.isFinite(d) && d > 0) next.embedding.dimensions = Math.floor(d);
    }
    if (body.embedding.apiKey != null) {
      const k = String(body.embedding.apiKey);
      if (k && !isMaskedSecret(k)) next.embedding.apiKey = k.trim();
    }
    const preset = EMBEDDING_PRESETS.find((p) => p.id === next.embedding.provider);
    if (preset) {
      if (next.embedding.provider === "local") {
        next.embedding.baseURL = "";
        next.embedding.model = preset.model;
        next.embedding.dimensions = preset.dimensions;
      } else {
        if (!next.embedding.baseURL && preset.baseURL) next.embedding.baseURL = preset.baseURL;
        if (!next.embedding.model && preset.model) next.embedding.model = preset.model;
        if (!next.embedding.dimensions) next.embedding.dimensions = preset.dimensions;
      }
    }
  }

  next.updatedAt = Date.now();
  return next;
}
