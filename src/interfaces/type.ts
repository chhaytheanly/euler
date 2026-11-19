export type ProviderProtocol =
  | "openai-compatible"
  | "openai-chat"
  | "openai-responses"
  | "anthropic"
  | "gemini"
  | "ollama";

export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";


export interface ModelCapabilities {
  reasoning?: {
    supported: boolean;
    type?: "effort" | "budget" | "toggle";
    efforts?: ReasoningEffort[];
    minBudget?: number;
    maxBudget?: number;
  };
}

export interface ModelVariant {
  id: string;
  name: string;
  description?: string;

  settings?: {
    reasoningEffort?: ReasoningEffort;
    reasoningBudget?: number;
    temperature?: number;
    maxTokens?: number;
  };

  body?: Record<string, unknown>;
}

export type AuthStyle = "bearer" | "x-api-key" | "none";

export interface ProviderAuth {
  style: AuthStyle;
  header?: string;
  prefix?: string;
}

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  apiKeyEnv?: string;
  enabled: boolean;
  defaultModel?: string;
  modelsPath?: string;
  chatPath?: string;
  auth?: ProviderAuth;
  headers?: Record<string, string>;
  /** Values for ${VAR} placeholders in baseUrl/headers, collected in setup. */
  urlVariableValues?: Record<string, string>;
  requiresKey?: boolean;
  keyUrl?: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  providerId?: string;
  ownedBy?: string;
  contextWindow?: number;
  description?: string;
  capabilities?: ModelCapabilities;
  variants?: ModelVariant[];
}

export type JsonSchema = {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
};

export type ToolApproval = "always" | "ask" | "never";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  approval: ToolApproval;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON argument string as sent by the model. */
  arguments: string;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  /** Whether a tool result represents an error. */
  toolError?: boolean;
  /** Tool calls requested by an assistant turn. */
  toolCalls?: ToolCall[];
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  tools?: ToolDefinition[];
  variant?: string;
  reasoningEffort?: ReasoningEffort;
}

export type ChatStreamEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "done"; reason?: string };

export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;

  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  validate(signal?: AbortSignal): Promise<boolean>;
  streamChat(
    messages: ChatMessage[],
    options: ChatOptions
  ): AsyncIterable<ChatStreamEvent>;
}

export interface AppConfig {
  defaultProvider?: string;
  defaultModel?: string;
  /** @deprecated Kept so existing configs keep working; use variantsByModel. */
  defaultVariant?: string;
  /** Reasoning selection per `${providerId}/${modelId}`. */
  variantsByModel?: Record<string, string>;
  /** Extra efforts for `${providerId}/${modelId}` or bare model ids. */
  variantOverrides?: Record<string, ReasoningEffort[]>;
  providers: Record<string, ProviderConfig>;
}

export type Credentials = Record<string, string>;

export interface ActiveProvider {
  id: string;
  provider: ProviderConfig;
  apiKey?: string;
  model: string;
  variant?: string;
}


export interface ReasoningCapabilities {
    supported?: boolean;
    type?: "effort" | "budget" | "toggle";
    minBudget?: number;
    maxBudget?: number;
    toggle?: boolean;
    effort?: ReasoningEffort[];
}

export interface ReasoningOption {
    type?: string;
    values?: ReasoningEffort[];
    min?: number;
    max?: number;
}

export interface ModelMetadata {
    capabilities?: {
        reasoning?: ReasoningCapabilities;
    };
    reasoning?: boolean;
    reasoning_options?: ReasoningOption[];
}