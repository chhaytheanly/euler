import { randomUUID } from "node:crypto";
import { JsonSchema, ToolDefinition } from "../src/interfaces/type";

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
  cleanText: string;
  toolCalls: BridgeToolCall[];
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

/** Human-readable type label for a JSON schema value. */
function schemaType(schema: JsonSchema): string {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  }

  const raw: unknown = schema.type;
  const types = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : typeof raw === "string"
      ? [raw]
      : [];

  if (types.length === 0) {
    return schema.properties || schema.items ? "object" : "any";
  }

  const items = schema.items;

  return types
    .map((type) =>
      type === "array" && items ? `${schemaType(items)}[]` : type
    )
    .join(" | ");
}

const CONSTRAINT_LABELS: Array<[string, string]> = [
  ["minimum", "min"],
  ["maximum", "max"],
  ["exclusiveMinimum", ">"],
  ["exclusiveMaximum", "<"],
  ["minLength", "min length"],
  ["maxLength", "max length"],
  ["minItems", "min items"],
  ["maxItems", "max items"]
];

/** Render numeric bounds and defaults that constrain a parameter. */
function schemaConstraints(schema: JsonSchema): string {
  const parts: string[] = [];

  for (const [key, label] of CONSTRAINT_LABELS) {
    const value: unknown = schema[key];

    if (typeof value === "number" || typeof value === "string") {
      parts.push(`${label} ${value}`);
    }
  }

  if (schema.default !== undefined) {
    parts.push(`default ${JSON.stringify(schema.default)}`);
  }

  return parts.join(", ");
}

/** One parameter bullet, including type, requirement and constraints. */
function formatParameter(
  name: string,
  schema: JsonSchema,
  required: boolean
): string {
  const label = `- ${name} (${schemaType(schema)}, ${
    required ? "required" : "optional"
  })`;
  const description =
    typeof schema.description === "string"
      ? schema.description.replace(/\s+/g, " ").trim()
      : "";
  const constraints = schemaConstraints(schema);
  const details = [description, constraints ? `[${constraints}]` : ""]
    .filter(Boolean)
    .join(" ");

  return details ? `${label}: ${details}` : label;
}

/** Build a minimal, schema-shaped example for one tool call. */
function exampleValue(schema: JsonSchema): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }

  const raw: unknown = schema.type;
  const type = Array.isArray(raw) ? raw[0] : raw;

  switch (type) {
    case "integer":
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object": {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const value: Record<string, unknown> = {};

      for (const [name, child] of Object.entries(properties)) {
        if (required.has(name)) {
          value[name] = exampleValue(child);
        }
      }

      return value;
    }
    default:
      return "value";
  }
}

/** Instructions that teach a web chatbot to emit euler-tool blocks. */
export function buildToolInstructions(tools: ToolDefinition[]): string {
  if (tools.length === 0) {
    return "";
  }

  const sections = tools.map((tool) => {
    const schema = tool.inputSchema;
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const parameters = Object.entries(properties).map(([name, property]) =>
      formatParameter(name, property, required.has(name))
    );
    const example = JSON.stringify({
      name: tool.name,
      arguments: exampleValue(schema)
    });

    return [
      `### ${tool.name}`,
      tool.description.replace(/\s+/g, " ").trim(),
      "",
      "Parameters (JSON object):",
      ...(parameters.length > 0 ? parameters : ["- none"]),
      "",
      `Example: ${example}`
    ].join("\n");
  });

  return [
    "TOOL CALLING:",
    "You can ask the host to run tools. When you need one, output ONLY a fenced block like this:",
    "```euler-tool",
    '{"name":"tool_name","arguments":{"key":"value"}}',
    "```",
    "Rules:",
    "- Copy tool names and argument keys exactly as listed below.",
    '- "arguments" must be a JSON object containing every required parameter; omit optional ones you do not need.',
    "- Emit one block per tool call. You may include several blocks in one response.",
    "- Never write tool results yourself; the host runs the tool and sends the result in the next turn.",
    "",
    `Available tools (${tools.length}):`,
    "",
    sections.join("\n\n")
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
