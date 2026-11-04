export type ProviderProtocol =
  | "openai-compatible"
  | "anthropic"
  | "ollama";

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
  requiresKey?: boolean;
  keyUrl?: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  provider: string;
  ownedBy?: string;
  contextWindow?: number;
  description?: string;
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

  listModels(): Promise<ModelInfo[]>;
  validate(): Promise<boolean>;
  streamChat(
    messages: ChatMessage[],
    options: ChatOptions
  ): AsyncIterable<ChatStreamEvent>;
}

export interface AppConfig {
  defaultProvider?: string;
  defaultModel?: string;
  providers: Record<string, ProviderConfig>;
}

export type Credentials = Record<string, string>;

export interface ActiveProvider {
  id: string;
  provider: ProviderConfig;
  apiKey?: string;
  model: string;
}
