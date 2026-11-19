#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    chromium,
    type BrowserContext,
    type Locator,
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
const HOST = process.env.QWEN_BRIDGE_HOST ?? "127.0.0.1";
const TARGET_URL =
  process.env.QWEN_BRIDGE_URL ?? "https://chat.qwen.ai/";
const PROFILE =
  process.env.QWEN_BRIDGE_PROFILE ??
  join(homedir(), ".config", "euler", "qwen-web");
const PROFILE_DIR = process.env.QWEN_BRIDGE_PROFILE_DIR?.trim();
const TIMEOUT = Number(
  process.env.QWEN_BRIDGE_TIMEOUT_MS ?? 120_000
);
const POLL = Number(process.env.QWEN_BRIDGE_POLL_MS ?? 250);
const LOGIN = process.argv.includes("--login");
const HEADLESS =
  process.env.QWEN_BRIDGE_HEADLESS === "0"
    ? false
    : process.env.QWEN_BRIDGE_HEADLESS === "1"
      ? true
      : !LOGIN;

const COMPOSER =
  process.env.QWEN_BRIDGE_COMPOSER ??
  'textarea, [contenteditable="true"], [data-testid="chat-input"]';
const ANSWER =
  process.env.QWEN_BRIDGE_ANSWER ??
  [
    ".phase-answer",
    ".response-message-content",
    '[data-role="assistant"]',
    ".assistant-message",
    '[class*="assistant-message"]'
  ].join(", ");
const THINKING =
  process.env.QWEN_BRIDGE_THINKING ??
  [
    '[class*="thinking-content"]',
    '[class*="reasoning-content"]',
    '[data-role="thinking"]'
  ].join(", ");
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
    "/usr/bin/google-chrome-stable",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/brave-browser",
    "/usr/bin/brave-browser-stable",
    "/opt/brave.com/brave/brave",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ];

  return candidates.find(existsSync);
}

async function resolveProfileDir(): Promise<string | undefined> {
  if (!PROFILE_DIR) {
    return undefined;
  }

  try {
    const state = JSON.parse(
      readFileSync(join(PROFILE, "Local State"), "utf8")
    ) as {
      profile?: {
        info_cache?: Record<string, { name?: string }>;
      };
    };
    const cache = state.profile?.info_cache ?? {};
    if (Object.prototype.hasOwnProperty.call(cache, PROFILE_DIR)) {
      return PROFILE_DIR;
    }

    const wanted = PROFILE_DIR.toLowerCase();
    for (const [directory, info] of Object.entries(cache)) {
      if (info.name?.toLowerCase() === wanted) {
        return directory;
      }
    }
  } catch {
  }

  return PROFILE_DIR;
}

async function launch(): Promise<BrowserContext> {
  const executablePath = chromePath();

  if (!executablePath) {
    throw new Error(
      "No Chrome/Brave found. Install one or set QWEN_BRIDGE_CHROME to its executable path."
    );
  }

  const directory = await resolveProfileDir();

  return chromium.launchPersistentContext(PROFILE, {
    headless: HEADLESS,
    executablePath,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      ...(directory ? [`--profile-directory=${directory}`] : [])
    ]
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function debug(message: string): void {
  if (process.env.QWEN_BRIDGE_DEBUG === "1") {
    console.error(`[qwen-web] ${message}`);
  }
}

/** Open the chat with a retry, so a slow first load is not fatal. */
async function navigate(page: Page): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(TARGET_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000
      });
      return;
    } catch (error) {
      lastError = error;
      debug(`navigation attempt ${attempt} failed: ${errorMessage(error)}`);
    }
  }

  throw new Error(`Could not open ${TARGET_URL}: ${errorMessage(lastError)}`);
}

/** Read an element's text, but skip the slow timeout when it is absent. */
async function readText(
  page: Page,
  selector: string,
  last: boolean
): Promise<string> {
  try {
    const locator = page.locator(selector);
    const count = await locator.count();

    if (count === 0) {
      return "";
    }

    const target = last ? locator.nth(count - 1) : locator.first();

    return (await target.innerText({ timeout: 500 })) ?? "";
  } catch (error) {
    debug(`readText(${selector}) failed: ${errorMessage(error)}`);
    return "";
  }
}

/** Put the prompt in the composer and verify it actually landed there. */
async function fillComposer(
  page: Page,
  composer: Locator,
  prompt: string
): Promise<void> {
  try {
    await composer.fill(prompt);
  } catch (error) {
    debug(`composer fill failed, using keyboard: ${errorMessage(error)}`);
    await composer.click();
    await page.keyboard.insertText(prompt);
  }

  const value = await composer.evaluate((element) => {
    const field = element as { value?: unknown; textContent?: unknown };

    if (typeof field.value === "string") {
      return field.value;
    }

    return typeof field.textContent === "string" ? field.textContent : "";
  });

  if (!value.includes(prompt.slice(0, 32))) {
    throw new Error(
      "The prompt could not be entered in the chat input. Check QWEN_BRIDGE_COMPOSER."
    );
  }
}

async function dismissAgeGate(page: Page): Promise<boolean> {
  const modal = page.locator(".age-confirmation-modal");

  try {
    await modal.waitFor({ state: "visible", timeout: 4000 });
  } catch {
    return false;
  }

  try {
    await modal.getByText("Continue", { exact: true }).first().click({
      timeout: 3000
    });
    await modal
      .waitFor({ state: "hidden", timeout: 3000 })
      .catch(() => undefined);
    debug("dismissed Qwen age confirmation");
    return true;
  } catch (error) {
    debug(`could not dismiss age confirmation: ${errorMessage(error)}`);
    return false;
  }
}

async function stopGeneration(page: Page): Promise<void> {
  try {
    await page.locator(STOP).first().click({ timeout: 1000 });
  } catch {
    // Generation may already have finished.
  }
}

async function sendPrompt(
  page: Page,
  prompt: string,
  signal: AbortSignal,
  onText: (delta: string) => void,
  onReasoning: (delta: string) => void
): Promise<string> {
  await navigate(page);
  await dismissAgeGate(page);

  try {
    await page.locator(NEW_CHAT).first().click({ timeout: 2000 });
  } catch {

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

  const baselineCount = await page.locator(ANSWER).count();
  const baselineText = await readText(page, ANSWER, true);

  debug(`sending ${prompt.length} chars; baseline answers=${baselineCount}`);
  await fillComposer(page, composer, prompt);
  await composer.press("Enter");

  if (await dismissAgeGate(page)) {
    await fillComposer(page, composer, prompt);
    await composer.press("Enter");
  }

  let text = "";
  let reasoning = "";
  let stable = 0;
  const started = Date.now();

  while (Date.now() - started < TIMEOUT) {
    if (signal.aborted) {
      await stopGeneration(page);
      throw new DOMException("Bridge request aborted", "AbortError");
    }

    const answerCount = await page.locator(ANSWER).count();
    const currentText = await readText(page, ANSWER, true);
    const isNew =
      answerCount > baselineCount || currentText !== baselineText;

    if (isNew && currentText.length > text.length) {
      onText(currentText.slice(text.length));
      text = currentText;
      stable = 0;
    } else {
      stable += 1;
    }

    const currentReasoning = await readText(page, THINKING, false);

    if (currentReasoning.length > reasoning.length) {
      onReasoning(currentReasoning.slice(reasoning.length));
      reasoning = currentReasoning;
    }

    const generating = (await page.locator(STOP).count()) > 0;

    if (!generating && stable >= 6 && text.length > 0) {
      break;
    }

    await page.waitForTimeout(POLL);
  }

  debug(`finished with ${text.length} chars of answer`);

  if (text.length === 0) {
    throw new Error(
      "No answer appeared in the web UI. Check QWEN_BRIDGE_ANSWER " +
        "(set QWEN_BRIDGE_DEBUG=1 to see what the bridge reads)."
    );
  }

  return text;
}

/** Snapshot of the live page, used to map DOM selectors when Qwen changes. */
async function domSnapshot(page: Page): Promise<unknown> {
  const selectors = ["COMPOSER", "ANSWER", "THINKING", "STOP", "NEW_CHAT"] as const;
  const selectorValues: Record<string, string> = {
    COMPOSER,
    ANSWER,
    THINKING,
    STOP,
    NEW_CHAT
  };
  const counts: Record<string, number> = {};

  for (const name of selectors) {
    counts[name] = await page.locator(selectorValues[name]).count().catch(() => 0);
  }

  const body = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");

  const elements = await page.evaluate(() => {
    interface N {
      tagName: string;
      className: unknown;
      textContent: string | null;
      getAttribute: (name: string) => string | null;
    }
    const root = (globalThis as unknown as {
      document: { querySelectorAll: (s: string) => ArrayLike<N> };
    }).document;

    return Array.from(root.querySelectorAll("div, article, section, p, span"))
      .filter((node) => {
        const cls = typeof node.className === "string" ? node.className : "";
        const role =
          node.getAttribute("data-role") ??
          node.getAttribute("data-message-role") ??
          node.getAttribute("role") ??
          "";
        const testid = node.getAttribute("data-testid") ?? "";
        return /message|assistant|answer|response|content|chat|thinking/i.test(
          `${cls} ${role} ${testid}`
        );
      })
      .slice(0, 120)
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        cls: (typeof node.className === "string" ? node.className : "").slice(0, 180),
        role: node.getAttribute("data-role"),
        msgRole: node.getAttribute("data-message-role"),
        testid: node.getAttribute("data-testid"),
        text: (node.textContent ?? "").trim().slice(0, 240)
      }));
  });

  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    counts,
    bodySample: body.slice(0, 2000),
    elements
  };
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
  if (LOGIN) {
    const context = await launch();
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(TARGET_URL);

    console.log(
      'A browser window is open. Sign in to Qwen (for example "Continue with Google"),\n' +
        "then press Enter here to save the session."
    );
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

    if (path === "/__debug") {
      void domSnapshot(page)
        .then((snapshot) => sendJson(response, 200, snapshot))
        .catch((error: unknown) =>
          sendJson(response, 500, { error: errorMessage(error) })
        );
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

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${PORT} is already in use. Stop the running bridge first:\n` +
          `  pkill -f 'bridge/qwen-web.ts'\n` +
          `or start on a different port:\n` +
          `  QWEN_BRIDGE_PORT=${
            PORT + 1
          } npm run bridge:qwen`
      );
    } else {
      console.error(`Bridge server error: ${error.message}`);
    }
    void context.close().finally(() => process.exit(1));
  });

  server.listen(PORT, HOST, () => {
    console.log(`Qwen web bridge listening on http://${HOST}:${PORT}/v1`);
    console.log(`Browser target: ${TARGET_URL}`);
    console.log(
      `Browser: ${chromePath() ?? "none"} · profile: ${PROFILE}${
        PROFILE_DIR ? ` [${PROFILE_DIR}]` : ""
      }`
    );
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
  const message = error instanceof Error ? error.message : String(error);

  if (/ProcessSingleton|profile directory|SingletonLock/i.test(message)) {
    console.error(
      "The Qwen browser profile is already in use by another bridge instance.\n" +
        "Stop it first with:  pkill -f 'bridge/qwen-web.ts'\n" +
        "Then start the bridge again."
    );
  } else {
    console.error(message);
  }

  process.exitCode = 1;
});
