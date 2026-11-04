import { randomUUID } from "node:crypto";
import {
    ChatMessage,
    ChatOptions,
    ChatStreamEvent,
    ModelInfo,
    ModelMetadata,
    ModelVariant,
    ProviderAdapter,
    ProviderConfig
} from "../interfaces/type";
import {
    buildHeaders,
    joinUrl,
    lineStream,
    responseError
} from "./http";
import { getModelVariants } from "./model-capabilities";
import { applyVariant } from "./variant-translators";

interface OpenAIModel {
  id?: string;
  name?: string;
  display_name?: string;
  owned_by?: string;

  context_window?: number;
  context_length?: number;

  top_provider?: {
    context_length?: number;
  };

  capabilities?: ModelMetadata["capabilities"];
  reasoning?: ModelMetadata["reasoning"];
  reasoning_options?: ModelMetadata["reasoning_options"];
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
}

interface OpenAIChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAIToolCallDelta[];
    };
    message?: {
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

function toolArguments(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined || value === null) {
    return "{}";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function appendNameFragment(current: string, fragment?: string): string {
  if (!fragment) {
    return current;
  }

  // Some OpenAI-compatible servers repeat the full name on every chunk.
  if (current === fragment || current.endsWith(fragment)) {
    return current;
  }

  return current + fragment;
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  private readonly modelVariants = new Map<string, ModelVariant[] >();
  
  constructor(
    id: string,
    private readonly config: ProviderConfig,
    private readonly apiKey?: string,
  ) {
    this.id = id;
    this.name = config.name;
  }

  private headers(): Record<string, string> {
    return buildHeaders(this.config, this.apiKey);
  }

  private modelsUrl(): string {
    return joinUrl(
      this.config.baseUrl,
      this.config.modelsPath ?? "/models"
    );
  }

  private chatUrl(): string {
    return joinUrl(
      this.config.baseUrl,
      this.config.chatPath ?? "/chat/completions"
    );
  }

  async validate(): Promise<boolean> {
    await this.listModels();
    return true;
  }
async listModels(): Promise<ModelInfo[]> {
  const response = await fetch(this.modelsUrl(), {
    method: "GET",
    headers: this.headers()
  });

  if (!response.ok) {
    throw await responseError(response, this.name);
  }

  const payload = (await response.json()) as
    | OpenAIModel[]
    | {
        data?: OpenAIModel[];
        models?: OpenAIModel[];
      };

  const rows = Array.isArray(payload)
    ? payload
    : payload.data ?? payload.models ?? [];

  this.modelVariants.clear();

  return rows
    .flatMap<ModelInfo>((model) => {
      const id = model.id ?? model.name;

      if (!id) {
        return [];
      }

      const metadata: ModelMetadata = {
        capabilities: model.capabilities,
        reasoning: model.reasoning,
        reasoning_options: model.reasoning_options
      };

      const variants = getModelVariants(id, metadata);

      // Preserve the exact metadata-derived variants
      // for use when sending requests.
      this.modelVariants.set(id, variants);

      return [{
        id,
        name: model.display_name ?? model.name ?? id,
        provider: this.name,
        ownedBy: model.owned_by,
        contextWindow:
          model.context_window ??
          model.context_length ??
          model.top_provider?.context_length,
        description: model.owned_by,
        variants
      }];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

  async *streamChat(
    messages: ChatMessage[],
    options: ChatOptions
  ): AsyncIterable<ChatStreamEvent> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: messages.map((message) => {
        const mapped: Record<string, unknown> = {
          role: message.role,
          content:
            message.role === "assistant" &&
            message.toolCalls?.length &&
            !message.content
              ? null
              : message.content,
          ...(message.name ? { name: message.name } : {}),
          ...(message.toolCallId
            ? { tool_call_id: message.toolCallId }
            : {})
        };

        if (message.toolCalls?.length) {
          mapped.tool_calls = message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.arguments
            }
          }));
        }

        return mapped;
      }),
      stream: true
    };

    if (options.tools?.length) {
      body.tools = options.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      }));
      body.tool_choice = "auto";
    }

    if (typeof options.temperature === "number") {
      body.temperature = options.temperature;
    }

    if (typeof options.maxTokens === "number") {
      body.max_tokens = options.maxTokens;
    }

    const variants =
      this.modelVariants.get(options.model) ??
      getModelVariants(options.model);

    const requestBody = applyVariant(
      body,
      options,
      this.config,
      variants
    );

    const response = await fetch(this.chatUrl(), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(requestBody),
      signal: options.signal
    });

    if (!response.ok) {
      throw await responseError(response, this.name);
    }

    if (!response.body) {
      throw new Error(`${this.name} returned an empty response body.`);
    }

    const contentType = response.headers.get("content-type") ?? "";

    // Some OpenAI-compatible servers ignore `stream: true`.
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            reasoning?: string | null;
            reasoning_content?: string | null;
            tool_calls?: OpenAIToolCall[];
          };
          finish_reason?: string;
        }>;
        usage?: OpenAIChunk["usage"];
      };

      const message = payload.choices?.[0]?.message;
      const reasoning =
        message?.reasoning_content ?? message?.reasoning;

      if (reasoning) {
        yield { type: "reasoning", text: reasoning };
      }

      if (message?.content) {
        yield { type: "text", text: message.content };
      }

      for (const [index, call] of (
        message?.tool_calls ?? []
      ).entries()) {
        const name = call.function?.name;

        if (!name) {
          continue;
        }

        yield {
          type: "tool_call",
          id:
            call.id ??
            `call_${randomUUID().replace(/-/g, "").slice(0, 12)}_${index}`,
          name,
          arguments: toolArguments(call.function?.arguments)
        };
      }

      if (payload.usage) {
        yield {
          type: "usage",
          inputTokens: payload.usage.prompt_tokens,
          outputTokens: payload.usage.completion_tokens
        };
      }

      yield {
        type: "done",
        reason: payload.choices?.[0]?.finish_reason ?? undefined
      };
      return;
    }

    let finishReason: string | undefined;
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const line of lineStream(response.body)) {
      if (!line.startsWith("data:")) {
        continue;
      }

      const data = line.slice(5).trim();

      if (!data) {
        continue;
      }

      if (data === "[DONE]") {
        break;
      }

      let chunk: OpenAIChunk;

      try {
        chunk = JSON.parse(data) as OpenAIChunk;
      } catch {
        continue;
      }

      if (chunk.error?.message) {
        throw new Error(`${this.name}: ${chunk.error.message}`);
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      const reasoning =
        delta?.reasoning_content ?? delta?.reasoning;

      if (reasoning) {
        yield { type: "reasoning", text: reasoning };
      }

      if (delta?.content) {
        yield { type: "text", text: delta.content };
      }

      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = pendingToolCalls.get(index) ?? {
          id: "",
          name: "",
          arguments: ""
        };

        if (call.id) {
          current.id = call.id;
        }

        current.name = appendNameFragment(
          current.name,
          call.function?.name
        );

        if (call.function?.arguments) {
          current.arguments += call.function.arguments;
        }

        pendingToolCalls.set(index, current);
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }

      if (chunk.usage) {
        yield {
          type: "usage",
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens
        };
      }
    }

    for (const [index, call] of [...pendingToolCalls.entries()].sort(
      (a, b) => a[0] - b[0]
    )) {
      if (!call.name) {
        continue;
      }

      yield {
        type: "tool_call",
        id:
          call.id ||
          `call_${randomUUID().replace(/-/g, "").slice(0, 12)}_${index}`,
        name: call.name,
        arguments: call.arguments || "{}"
      };
    }

    yield { type: "done", reason: finishReason };
  }
}
