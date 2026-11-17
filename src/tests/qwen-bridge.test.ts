import assert from "node:assert/strict";
import test from "node:test";

import { ToolDefinition } from "../../src/interfaces/type";
import {
  buildPrompt,
  buildToolInstructions,
  chatChunk,
  extractToolCalls,
  SSE_DONE,
  toolCallChunk
} from "../../bridge/protocol";

test("extractToolCalls parses a complete tool block", () => {
  const raw =
    'Let me check that.\n```euler-tool\n{"name":"read_file","arguments":{"path":"src/index.tsx"}}\n```\nDone.';
  const result = extractToolCalls(raw);

  assert.equal(result.cleanText, "Let me check that.\n\nDone.");
  assert.equal(result.pending, "");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "read_file");
  assert.equal(
    result.toolCalls[0].arguments,
    '{"path":"src/index.tsx"}'
  );
  assert.match(result.toolCalls[0].id, /^call_[a-f0-9]{12}$/);
});

test("extractToolCalls holds a partial fence as pending", () => {
  const result = extractToolCalls("Working…\n```euler-to");

  assert.equal(result.cleanText, "Working…\n");
  assert.equal(result.pending, "```euler-to");
  assert.equal(result.toolCalls.length, 0);
});

test("normal Markdown code fences are preserved", () => {
  const raw = "```ts\nconst x = 1;\n```";
  const result = extractToolCalls(raw);

  assert.equal(result.cleanText, raw);
  assert.equal(result.pending, "");
});

test("tool instructions list every available tool", () => {
  const tools: ToolDefinition[] = [
    {
      name: "read_file",
      description: "Read a text file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } }
      },
      approval: "always"
    }
  ];

  const instructions = buildToolInstructions(tools);

  assert.match(instructions, /```euler-tool/);
  assert.match(instructions, /### read_file/);
  assert.match(instructions, /- path \(string, optional\)/);
  assert.match(instructions, /Example: \{"name":"read_file","arguments":\{\}\}/);
  assert.equal(buildToolInstructions([]), "");
});

test("tool instructions render the full parameter schema", () => {
  const tools: ToolDefinition[] = [
    {
      name: "run_command",
      description: "Run a shell command\nin the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to run."
          },
          mode: {
            enum: ["safe", "full"],
            default: "safe",
            description: "Sandbox mode."
          },
          retries: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description: "Number of attempts."
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional labels."
          }
        },
        required: ["command"]
      },
      approval: "ask"
    }
  ];

  const instructions = buildToolInstructions(tools);

  assert.match(instructions, /Run a shell command in the workspace\./);
  assert.match(
    instructions,
    /- command \(string, required\): Shell command to run\./
  );
  assert.match(
    instructions,
    /- mode \("safe" \| "full", optional\): Sandbox mode\. \[default "safe"\]/
  );
  assert.match(
    instructions,
    /- retries \(integer, optional\): Number of attempts\. \[min 1, max 10\]/
  );
  assert.match(instructions, /- tags \(string\[\], optional\): Optional labels\./);
  assert.match(
    instructions,
    /Example: \{"name":"run_command","arguments":\{"command":"value"\}\}/
  );
});

test("buildPrompt includes conversation roles and tool results", () => {
  const prompt = buildPrompt(
    [
      { role: "system", content: "You are euler." },
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "read_file",
              arguments: '{"path":"a.ts"}'
            }
          }
        ]
      },
      { role: "tool", name: "read_file", content: "file body" }
    ],
    "TOOL CALLING:"
  );

  assert.match(prompt, /TOOL CALLING:/);
  assert.match(prompt, /User: Read the file/);
  assert.match(prompt, /read_file\(\{"path":"a\.ts"\}\)/);
  assert.match(prompt, /Tool result \(read_file\): file body/);
});

test("SSE chunks use the OpenAI-compatible shape", () => {
  const chunk = chatChunk("id-1", "qwen-web", { content: "hi" });

  assert.match(chunk, /^data: /);
  const payload = JSON.parse(chunk.slice(6).trim()) as {
    object: string;
    choices: Array<{ delta: { content?: string }; finish_reason: unknown }>;
  };

  assert.equal(payload.object, "chat.completion.chunk");
  assert.equal(payload.choices[0].delta.content, "hi");
  assert.equal(payload.choices[0].finish_reason, null);

  const toolChunk = toolCallChunk("id-1", "qwen-web", 0, {
    id: "call_1",
    name: "read_file",
    arguments: "{}"
  });
  assert.match(toolChunk, /tool_calls/);
  assert.equal(SSE_DONE, "data: [DONE]\n\n");
});
