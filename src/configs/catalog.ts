import { ProviderConfig } from "../interfaces/type";

const OPENAI_COMPATIBLE_DEFAULTS = {
  protocol: "openai-compatible" as const,
  modelsPath: "/models",
  chatPath: "/chat/completions",
  auth: { style: "bearer" as const },
  requiresKey: true
};


export const PROVIDER_CATALOG: Record<
  string,
  Omit<ProviderConfig, "enabled">
> = {
  openai: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "OpenAI",
    description: "GPT models · cloud",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys"
  },

  anthropic: {
    name: "Anthropic",
    description: "Claude models · cloud",
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "anthropic",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    modelsPath: "/models",
    chatPath: "/messages",
    auth: {
      style: "x-api-key",
      header: "x-api-key"
    },
    headers: {
      "anthropic-version": "2023-06-01"
    },
    requiresKey: true,
    keyUrl: "https://console.anthropic.com/settings/keys"
  },

  openrouter: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "OpenRouter",
    description: "One key, hundreds of models",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys"
  },

  google: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "Google Gemini",
    description: "Gemini via OpenAI compatibility",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/app/apikey"
  },

  deepseek: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "DeepSeek",
    description: "DeepSeek chat and reasoner",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com/api_keys"
  },

  qwen: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "Qwen (DashScope)",
    description: "Alibaba Qwen · OpenAI-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    keyUrl: "https://dashscope.console.aliyun.com/apiKey"
  },

  "qwen-web": {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "Qwen Web (bridge)",
    description: "Browser bridge · run npm run bridge:qwen",
    baseUrl: "http://127.0.0.1:8787/v1",
    auth: { style: "none" },
    requiresKey: false
  },

  zai: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "Z.ai (GLM)",
    description: "Zhipu GLM models · cloud",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    keyUrl: "https://z.ai/manage-apikey/apikey-list"
  },

  hunyuan: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "Tencent Hunyuan",
    description: "Tencent HY models · cloud",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    apiKeyEnv: "HUNYUAN_API_KEY",
    keyUrl: "https://hunyuan.cloud.tencent.com/#/app/apiKeyManage"
  },

  groq: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "Groq",
    description: "Fast hosted inference",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    keyUrl: "https://console.groq.com/keys"
  },

  mistral: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "Mistral",
    description: "Mistral hosted models",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    keyUrl: "https://console.mistral.ai/api-keys"
  },

  xai: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "xAI",
    description: "Grok models",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    keyUrl: "https://console.x.ai"
  },

  ollama: {
    name: "Ollama",
    description: "Local models · no key",
    baseUrl: "http://localhost:11434",
    protocol: "ollama",
    modelsPath: "/api/tags",
    chatPath: "/api/chat",
    auth: { style: "none" },
    requiresKey: false
  },

  lmstudio: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "LM Studio",
    description: "Local server · no key",
    baseUrl: "http://localhost:1234/v1",
    auth: { style: "none" },
    requiresKey: false
  },

  opencode: {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    name: "OpenCode Zen",
    description: "OpenCode hosted models",
    baseUrl: "https://opencode.ai/inference",
    modelsPath: "/v1/models",
    chatPath: "/openai/v1/chat/completions",
    apiKeyEnv: "OPENCODE_API_KEY",
    keyUrl: "https://opencode.ai/auth",
    auth: { style: "bearer" },
  },
};

export const PROVIDER_ORDER = [
  "openai",
  "anthropic",
  "openrouter",
  "google",
  "deepseek",
  "qwen",
  "qwen-web",
  "zai",
  "hunyuan",
  "groq",
  "mistral",
  "xai",
  "ollama",
  "lmstudio",
  "opencode"
];

export function getCatalogEntry(
  providerId: string
): Omit<ProviderConfig, "enabled"> | undefined {
  return PROVIDER_CATALOG[providerId];
}

export function makeCatalogProvider(
  providerId: string
): ProviderConfig | undefined {
  const entry = getCatalogEntry(providerId);

  if (!entry) {
    return undefined;
  }

  return {
    ...entry,
    enabled: true
  };
}

export function providerUsesKey(
  provider: ProviderConfig
): boolean {
  return (provider.auth?.style ?? "bearer") !== "none";
}

export function needsApiKey(provider: ProviderConfig): boolean {
  if (typeof provider.requiresKey === "boolean") {
    return provider.requiresKey;
  }

  return providerUsesKey(provider);
}
