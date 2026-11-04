import { randomUUID } from "node:crypto";
import {
    ChatMessage,
    ChatOptions,
    ChatStreamEvent,
    ModelInfo,
    ProviderAdapter,
    ProviderConfig
} from "../interfaces/type";
import {
    buildHeaders,
    joinUrl,
    responseError,
    sseData
} from "./http";
import { getModelVariants } from "./model-capabilities";
import { applyVariant } from "./variant-translators";

interface AnthropicModel {
  id?: string;
  display_name?: string;
  owned_by?: string;
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  message?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

type AnthropicContent =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

function parseToolInput(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || "{}");

    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export class AnthropicProvider implements ProviderAdapter {
  readonly id: string;
  readonly name: string;

  constructor(
    id: string,
    private readonly config: ProviderConfig,
    private readonly apiKey?: string
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
      this.config.chatPath ?? "/messages"
    );
  }

  async validate(): Promise<boolean> {
    await this.listModels();
    return true;
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(
      `${this.modelsUrl()}?limit=1000`,
      {
        method: "GET",
        headers: this.headers()
      }
    );

    if (!response.ok) {
      throw await responseError(response, this.name);
    }

    const payload = (await response.json()) as {
      data?: AnthropicModel[];
    };

    return (payload.data ?? [])
      .flatMap<ModelInfo>((model) => {
        if (!model.id) {
          return [];
        }

        return [
          {
            id: model.id,
            name: model.display_name ?? model.id,
            provider: this.name,
            ownedBy: model.owned_by,
            variants: getModelVariants(model.id) || undefined
          }
        ];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async *streamChat(
    messages: ChatMessage[],
    options: ChatOptions
  ): AsyncIterable<ChatStreamEvent> {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const conversation: Array<{
      role: "user" | "assistant";
      content: AnthropicContent[];
    }> = [];

    function pushTurn(
      role: "user" | "assistant",
      blocks: AnthropicContent[]
    ): void {
      if (blocks.length === 0) {
        return;
      }

      const previous = conversation[conversation.length - 1];

      if (previous && previous.role === role) {
        // Anthropic expects alternating roles. Merge consecutive turns
        // (for example, after a failed request and a retry).
        previous.content.push(...blocks);
      } else {
        conversation.push({ role, content: blocks });
      }
    }

    for (const message of messages) {
      if (message.role === "system") {
        continue;
      }

      if (message.role === "tool") {
        pushTurn("user", [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId ?? "",
            content: message.content || "(no output)",
            ...(message.toolError ? { is_error: true } : {})
          }
        ]);
        continue;
      }

      if (message.role === "assistant") {
        const blocks: AnthropicContent[] = [];

        if (message.content) {
          blocks.push({ type: "text", text: message.content });
        }

        for (const call of message.toolCalls ?? []) {
          blocks.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: parseToolInput(call.arguments)
          });
        }

        if (blocks.length === 0) {
          blocks.push({ type: "text", text: "(no text response)" });
        }

        pushTurn("assistant", blocks);
        continue;
      }

      pushTurn("user", [
        {
          type: "text",
          text: message.content || "(empty message)"
        }
      ]);
    }

    const body: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: conversation,
      stream: true
    };

    if (system) {
      body.system = system;
    }

    if (options.tools?.length) {
      body.tools = options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      }));
    }

    if (typeof options.temperature === "number") {
      body.temperature = options.temperature;
    }

    const requestBody = applyVariant(
      body,
      options,
      this.config,
      getModelVariants(options.model)
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

    let stopReason: string | undefined;
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const data of sseData(response.body)) {
      let event: AnthropicEvent;

      try {
        event = JSON.parse(data) as AnthropicEvent;
      } catch {
        continue;
      }

      if (event.type === "error") {
        throw new Error(
          `${this.name}: ${event.error?.message ?? "stream error"}`
        );
      }

      if (event.type === "message_start" && event.message?.usage) {
        yield {
          type: "usage",
          inputTokens: event.message.usage.input_tokens,
          outputTokens: event.message.usage.output_tokens
        };
      }

      if (
        event.type === "content_block_start" &&
        event.content_block?.type === "tool_use"
      ) {
        const index = event.index ?? pendingToolCalls.size;
        const input = event.content_block.input;
        const hasInput =
          typeof input === "object" &&
          input !== null &&
          Object.keys(input as Record<string, unknown>).length > 0;

        pendingToolCalls.set(index, {
          id:
            event.content_block.id ??
            `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          name: event.content_block.name ?? "",
          arguments: hasInput ? JSON.stringify(input) : ""
        });
      }

      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          yield { type: "text", text: event.delta.text };
        } else if (
          event.delta?.type === "thinking_delta" &&
          event.delta.thinking
        ) {
          yield {
            type: "reasoning",
            text: event.delta.thinking
          };
        } else if (
          event.delta?.type === "input_json_delta" &&
          event.delta.partial_json !== undefined
        ) {
          const index = event.index ?? 0;
          const pending = pendingToolCalls.get(index);

          if (pending) {
            pending.arguments += event.delta.partial_json;
          }
        }
      }

      if (event.type === "content_block_stop") {
        const index = event.index ?? 0;
        const pending = pendingToolCalls.get(index);

        if (pending) {
          pendingToolCalls.delete(index);

          if (pending.name) {
            yield {
              type: "tool_call",
              id: pending.id,
              name: pending.name,
              arguments: pending.arguments || "{}"
            };
          }
        }
      }

      if (event.type === "message_delta") {
        if (event.delta?.stop_reason) {
          stopReason = event.delta.stop_reason;
        }

        if (event.usage) {
          yield {
            type: "usage",
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens
          };
        }
      }

      if (event.type === "message_stop") {
        break;
      }
    }

    yield { type: "done", reason: stopReason };
  }
}
