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
  lineStream,
  requestSignal,
  responseError
} from "./http";
import { getVariants } from "./model-service";
import { applyVariant } from "./variant-translators";

interface OllamaTag {
  name?: string;
  model?: string;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
}

interface OllamaChunk {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function parseArguments(
  value: string | Record<string, unknown> | undefined
): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(value);

    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function argumentText(
  value: string | Record<string, unknown> | undefined
): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(parseArguments(value));
}

export class OllamaProvider implements ProviderAdapter {
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

  private modelsUrl(): string {
    return joinUrl(
      this.config.baseUrl,
      this.config.modelsPath ?? "/api/tags"
    );
  }

  private chatUrl(): string {
    return joinUrl(
      this.config.baseUrl,
      this.config.chatPath ?? "/api/chat"
    );
  }

  async validate(signal?: AbortSignal): Promise<boolean> {
    await this.listModels(signal);
    return true;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const response = await fetch(this.modelsUrl(), {
      headers: buildHeaders(this.config, this.apiKey),
      signal: requestSignal(signal)
    });

    if (!response.ok) {
      throw await responseError(response, this.name);
    }

    const result = (await response.json()) as {
      models?: OllamaTag[];
    };

    return (result.models ?? [])
      .flatMap<ModelInfo>((model) => {
        const id = model.name ?? model.model;

        if (!id) {
          return [];
        }

        return [
          {
            id,
            name: id,
            provider: this.name,
            providerId: this.id,
            ownedBy: "local",
            description: [
              model.details?.parameter_size,
              model.details?.quantization_level
            ]
              .filter(Boolean)
              .join(" · "),
            variants: getVariants(this.id, id)
          }
        ];
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
          content: message.content
        };

        if (message.role === "tool" && message.name) {
          mapped.tool_name = message.name;
        }

        if (message.toolCalls?.length) {
          mapped.tool_calls = message.toolCalls.map((call) => ({
            function: {
              name: call.name,
              arguments: parseArguments(call.arguments)
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
    }

    const ollamaOptions: Record<string, unknown> = {};

    if (typeof options.temperature === "number") {
      ollamaOptions.temperature = options.temperature;
    }

    if (typeof options.maxTokens === "number") {
      ollamaOptions.num_predict = options.maxTokens;
    }

    if (Object.keys(ollamaOptions).length > 0) {
      body.options = ollamaOptions;
    }

    const requestBody = applyVariant(
      body,
      options,
      this.config,
      getVariants(this.id, options.model)
    );

    const response = await fetch(this.chatUrl(), {
      method: "POST",
      headers: buildHeaders(this.config, this.apiKey),
      body: JSON.stringify(requestBody),
      signal: requestSignal(options.signal)
    });

    if (!response.ok) {
      throw await responseError(response, this.name);
    }

    if (!response.body) {
      throw new Error(`${this.name} returned an empty response body.`);
    }

    const seenToolCalls = new Set<string>();

    for await (const line of lineStream(response.body)) {
      if (!line.trim()) {
        continue;
      }

      let chunk: OllamaChunk;

      try {
        chunk = JSON.parse(line) as OllamaChunk;
      } catch {
        continue;
      }

      if (chunk.error) {
        throw new Error(`${this.name}: ${chunk.error}`);
      }

      if (chunk.message?.thinking) {
        yield { type: "reasoning", text: chunk.message.thinking };
      }

      if (chunk.message?.content) {
        yield { type: "text", text: chunk.message.content };
      }

      for (const call of chunk.message?.tool_calls ?? []) {
        const name = call.function?.name;

        if (!name) {
          continue;
        }

        const argumentsText = argumentText(
          call.function?.arguments
        );
        const key = `${name}:${argumentsText}`;

        if (seenToolCalls.has(key)) {
          continue;
        }

        seenToolCalls.add(key);

        yield {
          type: "tool_call",
          id: `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          name,
          arguments: argumentsText
        };
      }

      if (chunk.done) {
        if (
          typeof chunk.prompt_eval_count === "number" ||
          typeof chunk.eval_count === "number"
        ) {
          yield {
            type: "usage",
            inputTokens: chunk.prompt_eval_count,
            outputTokens: chunk.eval_count
          };
        }

        yield {
          type: "done",
          reason: chunk.done_reason
        };
        return;
      }
    }
  }
}
