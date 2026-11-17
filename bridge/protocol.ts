import { randomUUID } from "node:crypto";
import { ToolDefinition } from "../src/interfaces/type";

export interface BridgeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_calls?: Array<{
    function?: { name?: string; arguments?: string };
  }>;
}

export interface BridgeToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolExtraction {
  /** Text safe to show to the user (tool fences removed). */
  cleanText: string;
  toolCalls: BridgeToolCall[];
  /** Trailing partial fence that must not be emitted yet. */
  pending: string;
}

const FENCE_START = "```euler-tool";
const FENCE_END = "```";

function parseToolCall(json: string): BridgeToolCall | undefined {
  try {
    const parsed = JSON.parse(json) as {
      name?: unknown;
      arguments?: unknown;
    };

    if (typeof parsed.name !== "string" || !parsed.name.trim()) {
      return undefined;
    }

    const args =
      typeof parsed.arguments === "string"
        ? parsed.arguments
        : JSON.stringify(parsed.arguments ?? {});

    return {
      id: `call_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      name: parsed.name,
      arguments: args || "{}"
    };
  } catch {
    return undefined;
  }
}

function partialFence(text: string): string {
  // Only hold a clearly-started tool fence (at least "```e"). Holding a bare
  // "```" would swallow the closing fence of a normal Markdown code block.
  for (let length = Math.min(text.length, FENCE_START.length); length >= 4; length -= 1) {
    if (FENCE_START.startsWith(text.slice(text.length - length))) {
      return text.slice(text.length - length);
    }
  }

  return "";
}

/** Extract tool requests from a fenced block in the model's output. */
export function extractToolCalls(raw: string): ToolExtraction {
  const toolCalls: BridgeToolCall[] = [];
  let clean = "";
  let cursor = 0;

  while (cursor < raw.length) {
    const start = raw.indexOf(FENCE_START, cursor);

    if (start < 0) {
      const tail = raw.slice(cursor);
      const held = partialFence(tail);
      clean += held ? tail.slice(0, tail.length - held.length) : tail;
      return { cleanText: clean, toolCalls, pending: held };
    }

    clean += raw.slice(cursor, start);

    const bodyStart = start + FENCE_START.length;
    const end = raw.indexOf(FENCE_END, bodyStart);

    if (end < 0) {
      const tail = raw.slice(start);
      return { cleanText: clean, toolCalls, pending: tail };
    }

    const call = parseToolCall(raw.slice(bodyStart, end).trim());

    if (call) {
      toolCalls.push(call);
    }

    cursor = end + FENCE_END.length;
  }

  return { cleanText: clean, toolCalls, pending: "" };
}

/** Instructions that teach a web chatbot to emit euler-tool blocks. */
export function buildToolInstructions(tools: ToolDefinition[]): string {
  if (tools.length === 0) {
    return "";
  }

  const lines = tools.map((tool) => {
    const properties = Object.keys(tool.inputSchema.properties ?? {});
    const schema = properties.length
      ? `arguments: {${properties.join(", ")}}`
      : "arguments: {}";

    return `- ${tool.name}(${schema}) — ${tool.description.replace(/\s+/g, " ")}`;
  });

  return [
    "TOOL CALLING:",
    "You can ask the host to run tools. When you need one, output ONLY a fenced block like this:",
    "```euler-tool",
    '{"name":"tool_name","arguments":{"key":"value"}}',
    "```",
    "Never write tool results yourself; the host will run the tool and send the result in the next turn.",
    "Available tools:",
    ...lines
  ].join("\n");
}

/** Flatten an OpenAI-style conversation into one prompt for a web chatbot. */
export function buildPrompt(
  messages: BridgeMessage[],
  toolInstructions: string
): string {
  const lines: string[] = [];

  if (toolInstructions) {
    lines.push(toolInstructions, "");
  }

  lines.push("CONVERSATION:");

  for (const message of messages) {
    if (message.role === "system") {
      lines.push(`Instructions: ${message.content ?? ""}`);
      continue;
    }

    if (message.role === "tool") {
      lines.push(`Tool result (${message.name ?? "tool"}): ${message.content ?? ""}`);
      continue;
    }

    const calls = (message.tool_calls ?? []).map((call) => {
      const name = call.function?.name ?? "tool";
      const args = call.function?.arguments ?? "{}";
      return `${name}(${args})`;
    });

    const text = message.content ?? "";
    const body = [text, ...calls].filter(Boolean).join("\n");

    lines.push(
      `${message.role === "user" ? "User" : "Assistant"}: ${body || "(empty)"}`
    );
  }

  return lines.join("\n");
}

export function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

export function chatChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null = null
): string {
  return sse({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason
      }
    ]
  });
}

export function toolCallChunk(
  id: string,
  model: string,
  index: number,
  call: BridgeToolCall
): string {
  return chatChunk(id, model, {
    tool_calls: [
      {
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments }
      }
    ]
  });
}
