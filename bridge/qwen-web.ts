#!/usr/bin/env node
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  type BrowserContext,
  type Page
} from "playwright-core";
import { ToolDefinition } from "../src/interfaces/type";
import {
  BridgeMessage,
  buildPrompt,
  buildToolInstructions,
  chatChunk,
  extractToolCalls,
  sse,
  SSE_DONE,
  toolCallChunk
} from "./protocol";

const PORT = Number(process.env.QWEN_BRIDGE_PORT ?? 8787);
const TARGET_URL =
  process.env.QWEN_BRIDGE_URL ?? "https://chat.qwen.ai/";
const PROFILE =
  process.env.QWEN_BRIDGE_PROFILE ??
  join(homedir(), ".config", "euler", "qwen-web-profile");
const TIMEOUT = Number(
  process.env.QWEN_BRIDGE_TIMEOUT_MS ?? 120_000
);
const POLL = Number(process.env.QWEN_BRIDGE_POLL_MS ?? 250);
const HEADLESS = process.env.QWEN_BRIDGE_HEADLESS !== "0";

const COMPOSER =
  process.env.QWEN_BRIDGE_COMPOSER ??
  'textarea, [contenteditable="true"], [data-testid="chat-input"]';
const ANSWER =
  process.env.QWEN_BRIDGE_ANSWER ??
  '[data-role="assistant"], .assistant-message, [class*="assistant-message"]';
const THINKING =
  process.env.QWEN_BRIDGE_THINKING ??
  '[class*="thinking"], [data-role="thinking"]';
const STOP =
  process.env.QWEN_BRIDGE_STOP ??
  'button[aria-label*="Stop"], button[title*="Stop"], [data-testid="stop"]';
const NEW_CHAT =
  process.env.QWEN_BRIDGE_NEW_CHAT ??
  'button[aria-label*="New chat"], [data-testid="new-chat"]';

function chromePath(): string | undefined {
  if (process.env.QWEN_BRIDGE_CHROME) {
    return process.env.QWEN_BRIDGE_CHROME;
  }

  const candidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/brave-browser",
    "/opt/brave.com/brave/brave",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ];

  return candidates.find(existsSync);
}

async function launch(): Promise<BrowserContext> {
  const executablePath = chromePath();

  if (!executablePath) {
    throw new Error(
      "No Chrome/Brave found. Install one or set QWEN_BRIDGE_CHROME to its executable path."
    );
  }

  return chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    executablePath,
    args: ["--no-first-run", "--no-default-browser-check"]
  });
}

async function readText(page: Page, selector: string, last: boolean): Promise<string> {
  try {
    const locator = page.locator(selector);
    const target = last ? locator.last() : locator.first();

    return (await target.innerText({ timeout: 1000 })) ?? "";
  } catch {
    return "";
  }
}

async function stopGeneration(page: Page): Promise<void> {
  try {
    await page.locator(STOP).first().click({ timeout: 1000 });
  } catch {
    // Generation may already have finished.
  }
}

/**
 * Send one self-contained prompt to the web UI and stream the answer back
 * as text/reasoning deltas.
 */
async function sendPrompt(
  page: Page,
  prompt: string,
  signal: AbortSignal,
  onText: (delta: string) => void,
  onReasoning: (delta: string) => void
): Promise<string> {
  await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });

  try {
    await page.locator(NEW_CHAT).first().click({ timeout: 2000 });
  } catch {
    // A fresh navigation is enough for most UIs.
  }

  const composer = page.locator(COMPOSER).first();

  try {
    await composer.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    throw new Error(
      "Qwen chat input was not found. You may need to log in first " +
        "(npm run bridge:qwen:login) or update QWEN_BRIDGE_COMPOSER."
    );
  }

  await composer.fill(prompt);
  await composer.press("Enter");

  let text = "";
  let reasoning = "";
  let stable = 0;
  const started = Date.now();

  while (Date.now() - started < TIMEOUT) {
    if (signal.aborted) {
      await stopGeneration(page);
      throw new DOMException("Bridge request aborted", "AbortError");
    }

    const nextText = await readText(page, ANSWER, true);
    const nextReasoning = await readText(page, THINKING, false);

    if (nextText.length > text.length) {
      onText(nextText.slice(text.length));
      text = nextText;
      stable = 0;
    } else {
      stable += 1;
    }

    if (nextReasoning.length > reasoning.length) {
      onReasoning(nextReasoning.slice(reasoning.length));
      reasoning = nextReasoning;
    }

    const generating = (await page.locator(STOP).count()) > 0;

    if (!generating && stable >= 3 && text.length > 0) {
      break;
    }

    await page.waitForTimeout(POLL);
  }

  if (text.length === 0) {
    throw new Error(
      "No answer appeared in the web UI. Check QWEN_BRIDGE_ANSWER for this site."
    );
  }

  return text;
}

interface CompletionRequest {
  model?: string;
  messages?: BridgeMessage[];
  stream?: boolean;
  tools?: Array<{
    type?: string;
    function?: {
      name?: string;
      description?: string;
      parameters?: Record<string, unknown>;
    };
  }>;
}

function readBody(request: IncomingMessage): Promise<CompletionRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? (JSON.parse(text) as CompletionRequest) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function normalizeTools(request: CompletionRequest): ToolDefinition[] {
  return (request.tools ?? [])
    .map((tool) => tool.function)
    .filter((tool): tool is NonNullable<typeof tool> => Boolean(tool?.name))
    .map((tool) => ({
      name: tool.name as string,
      description: tool.description ?? "",
      inputSchema: (tool.parameters ?? {}) as ToolDefinition["inputSchema"],
      approval: "ask" as const
    }));
}

async function main(): Promise<void> {
  if (process.argv.includes("--login")) {
    const context = await launch();
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(TARGET_URL);

    console.log("Log in to Qwen in the browser, then press Enter here to save the session.");
    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => resolve());
    });
    await context.close();
    console.log("Session saved.");
    return;
  }

  const context = await launch();
  const page = context.pages()[0] ?? (await context.newPage());
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async function handleCompletion(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const body = await readBody(request);

    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      sendJson(response, 400, {
        error: { message: "messages must be a non-empty array" }
      });
      return;
    }

    const model = body.model || "qwen-web";
    const id = `chatcmpl-${Date.now().toString(36)}`;
    const prompt = buildPrompt(
      body.messages,
      buildToolInstructions(normalizeTools(body))
    );
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) {
        controller.abort();
      }
    });

    await enqueue(async () => {
      const streaming = body.stream === true;

      if (streaming) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
      }

      let raw = "";
      let emitted = "";
      const calls: ReturnType<typeof extractToolCalls>["toolCalls"] = [];

      const collect = (delta: string) => {
        raw += delta;

        const extracted = extractToolCalls(raw);

        if (extracted.cleanText.length > emitted.length) {
          const textDelta = extracted.cleanText.slice(emitted.length);
          emitted = extracted.cleanText;

          if (streaming) {
            response.write(chatChunk(id, model, { content: textDelta }));
          }
        }

        for (const call of extracted.toolCalls) {
          if (calls.some((existing) => existing.id === call.id)) {
            continue;
          }

          calls.push(call);

          if (streaming) {
            response.write(
              toolCallChunk(id, model, calls.length - 1, call)
            );
          }
        }
      };

      try {
        await sendPrompt(page, prompt, controller.signal, collect, (delta) => {
          if (streaming) {
            response.write(
              chatChunk(id, model, { reasoning_content: delta })
            );
          }
        });

        // Catch a complete tool fence that arrived in the final delta.
        collect("");

        if (streaming) {
          response.write(
            chatChunk(
              id,
              model,
              {},
              calls.length > 0 ? "tool_calls" : "stop"
            )
          );
          response.end(SSE_DONE);
        } else {
          sendJson(response, 200, {
            id,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: emitted,
                  ...(calls.length > 0
                    ? {
                        tool_calls: calls.map((call) => ({
                          id: call.id,
                          type: "function",
                          function: {
                            name: call.name,
                            arguments: call.arguments
                          }
                        }))
                      }
                    : {})
                },
                finish_reason:
                  calls.length > 0 ? "tool_calls" : "stop"
              }
            ]
          });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);

        if (streaming && !response.writableEnded) {
          response.write(sse({ error: { message } }));
          response.end(SSE_DONE);
        } else if (!response.headersSent) {
          sendJson(response, 500, { error: { message } });
        }
      }
    });
  }

  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0] ?? "/";

    if (path === "/health") {
      sendJson(response, 200, { status: "ok", target: TARGET_URL });
      return;
    }

    if (path === "/v1/models" && request.method === "GET") {
      sendJson(response, 200, {
        object: "list",
        data: [
          {
            id: "qwen-web",
            object: "model",
            owned_by: "qwen-web-bridge"
          }
        ]
      });
      return;
    }

    if (
      path === "/v1/chat/completions" &&
      request.method === "POST"
    ) {
      void handleCompletion(request, response);
      return;
    }

    sendJson(response, 404, { error: { message: "Not found" } });
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Qwen web bridge listening on http://127.0.0.1:${PORT}/v1`);
    console.log(`Browser target: ${TARGET_URL}`);
    console.log("Press Ctrl+C to stop.");
  });

  const shutdown = () => {
    server.close();
    void context.close().finally(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
