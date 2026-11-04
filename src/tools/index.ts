import { exec, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createTwoFilesPatch } from "diff";
import {
  ToolCall,
  ToolDefinition,
  JsonSchema
} from "../interfaces/type";
import { recordBackup } from "./journal";
import {
  ToolError,
  capOutput,
  formatLineRange,
  getWorkspaceRoot,
  readTextFile,
  resolveWorkspacePath,
  splitLines,
  walkWorkspace,
  writeTextFile
} from "./workspace";

export interface ToolRuntime {
  root: string;
  signal: AbortSignal;
}

export interface ToolExecution {
  ok: boolean;
  content: string;
  cancelled?: boolean;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
}

export interface ToolImplementation extends ToolDefinition {
  summarize: (args: Record<string, unknown>) => string;
  preview?: (
    args: Record<string, unknown>,
    root: string
  ) => Promise<string> | string;
  execute: (
    args: Record<string, unknown>,
    context: ToolRuntime
  ) => Promise<string | ToolOutput>;
}

const EMPTY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
};

function schema(
  properties: Record<string, JsonSchema>,
  required: string[] = []
): JsonSchema {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

function requireString(
  args: Record<string, unknown>,
  key: string
): string {
  const value = args[key];

  if (typeof value !== "string" || !value.trim()) {
    throw new ToolError(`"${key}" must be a non-empty string.`);
  }

  return value;
}

function rawString(
  args: Record<string, unknown>,
  key: string
): string {
  const value = args[key];

  if (typeof value !== "string") {
    throw new ToolError(`"${key}" must be a string.`);
  }

  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string
): string | undefined {
  const value = args[key];

  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new ToolError(`"${key}" must be a string.`);
  }

  return value;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string
): number | undefined {
  const value = args[key];

  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolError(`"${key}" must be a number.`);
  }

  return value;
}

function optionalBoolean(
  args: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = args[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new ToolError(`"${key}" must be a boolean.`);
  }

  return value;
}

function clampInteger(
  value: number,
  minimum: number,
  maximum: number
): number {
  return Math.min(
    maximum,
    Math.max(minimum, Math.trunc(value))
  );
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    const error = new Error("Cancelled");
    error.name = "AbortError";
    throw error;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  return haystack.split(needle).length - 1;
}

function truncateInline(value: string, maximum = 110): string {
  const singleLine = value.replace(/\s+/g, " ").trim();

  if (singleLine.length <= maximum) {
    return singleLine;
  }

  return `${singleLine.slice(0, maximum - 1)}…`;
}

function linesOf(content: string): number {
  return splitLines(content).length;
}

async function readMaybe(
  absolute: string,
  relative: string
): Promise<string | null> {
  try {
    return await readTextFile(absolute, relative);
  } catch {
    return null;
  }
}

function patchPreview(
  relative: string,
  before: string,
  after: string,
  existed = true
): string {
  const patch = createTwoFilesPatch(
    existed ? relative : "/dev/null",
    relative,
    before,
    after,
    existed ? "before" : "",
    "after",
    { context: 3 }
  );

  return capOutput(patch, 8_000);
}

function plusPreview(content: string, label: string): string {
  const lines = splitLines(content);
  const shown = lines.slice(0, 40).map((line) => `+${line}`);

  if (lines.length > shown.length) {
    shown.push(`+… ${lines.length - shown.length} more lines`);
  }

  return capOutput([label, "", ...shown].join("\n"), 8_000);
}

async function gitResult(
  args: string[],
  context: ToolRuntime,
  timeout = 15_000
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: context.root,
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        signal: context.signal,
        encoding: "utf8"
      },
      (error, stdout, stderr) => {
        if (error && error.name === "AbortError") {
          reject(error);
          return;
        }

        if (
          error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          reject(
            new ToolError(
              "git is not installed or is not available on PATH."
            )
          );
          return;
        }

        const code =
          error && typeof error.code === "number"
            ? error.code
            : error
              ? 1
              : 0;

        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code
        });
      }
    );
  });
}

function composeCommandOutput(
  command: string,
  stdout: string,
  stderr: string,
  code: number,
  timedOut: boolean
): string {
  const sections = [`$ ${command}`];

  if (timedOut) {
    sections.push("… command timed out …");
  } else {
    sections.push(`… exit code ${code} …`);
  }

  const output = [stdout.trimEnd(), stderr.trimEnd()]
    .filter(Boolean)
    .join("\n");

  sections.push(output || "(no output)");

  return capOutput(sections.join("\n\n"));
}

function commandSeconds(
  args: Record<string, unknown>,
  key: string,
  fallback: number
): number {
  const value = optionalNumber(args, key);

  return value === undefined
    ? fallback
    : clampInteger(value, 1, 600);
}

const listFiles: ToolImplementation = {
  name: "list_files",
  description:
    "List files and directories inside the workspace. Use this to understand the project layout. Hidden, secret, dependency, and build directories are skipped.",
  inputSchema: schema({
    path: {
      type: "string",
      description:
        "Directory or file to inspect, relative to the workspace root. Defaults to the root."
    },
    depth: {
      type: "integer",
      description:
        "How many directory levels to show, from 1 to 5. Defaults to 2.",
      minimum: 1,
      maximum: 5
    }
  }),
  approval: "always",
  summarize(args) {
    const path = optionalString(args, "path") ?? ".";
    const depth = optionalNumber(args, "depth") ?? 2;
    return truncateInline(`${path} · depth ${depth}`);
  },
  async execute(args, context) {
    assertNotAborted(context.signal);

    const path = optionalString(args, "path") ?? ".";
    const depth = clampInteger(
      optionalNumber(args, "depth") ?? 2,
      1,
      5
    );
    const resolved = await resolveWorkspacePath(path);
    const { entries, truncated } = await walkWorkspace(
      resolved,
      { maxDepth: depth, maxEntries: 400 }
    );

    if (entries.length === 0) {
      return `No files found under ${resolved.relative}.`;
    }

    const lines = entries.map((entry) =>
      entry.type === "directory"
        ? `${entry.relative}/`
        : entry.relative
    );

    if (truncated) {
      lines.push(
        "… truncated; narrow the path or reduce depth to see more …"
      );
    }

    return capOutput(lines.join("\n"));
  }
};

const readFileTool: ToolImplementation = {
  name: "read_file",
  description:
    "Read a UTF-8 text file from the workspace with line numbers. Use startLine/endLine for large files. Binary files and secret files are blocked.",
  inputSchema: schema(
    {
      path: {
        type: "string",
        description:
          "File path relative to the workspace root."
      },
      startLine: {
        type: "integer",
        description:
          "First line to return, starting at 1. Defaults to 1.",
        minimum: 1
      },
      endLine: {
        type: "integer",
        description:
          "Last line to return. Defaults to the end of the file.",
        minimum: 1
      }
    },
    ["path"]
  ),
  approval: "always",
  summarize(args) {
    const path = optionalString(args, "path") ?? "?";
    const start = optionalNumber(args, "startLine");
    const end = optionalNumber(args, "endLine");

    if (start !== undefined || end !== undefined) {
      return truncateInline(
        `${path} · lines ${start ?? 1}-${end ?? "end"}`
      );
    }

    return truncateInline(path);
  },
  async execute(args, context) {
    assertNotAborted(context.signal);

    const path = requireString(args, "path");
    const resolved = await resolveWorkspacePath(path);
    const content = await readTextFile(
      resolved.absolute,
      resolved.relative
    );
    const lines = splitLines(content);
    const total = lines.length;
    const requestedStart = optionalNumber(args, "startLine");

    if (requestedStart !== undefined && requestedStart > total) {
      return `${resolved.relative} has ${total} line(s); startLine ${Math.trunc(
        requestedStart
      )} is beyond the end of the file.`;
    }

    const start = clampInteger(
      requestedStart ?? 1,
      1,
      Math.max(1, total)
    );
    const requestedEnd = optionalNumber(args, "endLine");
    const end = Math.min(
      total,
      requestedEnd === undefined
        ? total
        : clampInteger(requestedEnd, start, total)
    );
    const maximumLines = 400;
    const visibleEnd = Math.min(end, start + maximumLines - 1);
    const width = String(visibleEnd).length;
    const numbered = lines
      .slice(start - 1, visibleEnd)
      .map(
        (line, index) =>
          `${String(start + index).padStart(width)} | ${line}`
      );

    const output = [
      `${resolved.relative} · ${formatLineRange(
        start,
        visibleEnd,
        total
      )}`,
      ...numbered
    ];

    if (visibleEnd < end) {
      output.push(
        `… ${end - visibleEnd} more lines; call read_file with startLine=${
          visibleEnd + 1
        } …`
      );
    }

    return capOutput(output.join("\n"));
  }
};

const searchCode: ToolImplementation = {
  name: "search_code",
  description:
    "Search text files in the workspace for a literal string. Returns matching paths, line numbers, and the matching line. Use this to find symbols and usages before editing.",
  inputSchema: schema(
    {
      query: {
        type: "string",
        description: "Literal text to search for."
      },
      path: {
        type: "string",
        description:
          "Directory to search, relative to the workspace root. Defaults to the root."
      },
      maxResults: {
        type: "integer",
        description:
          "Maximum matching lines to return, from 1 to 200. Defaults to 60.",
        minimum: 1,
        maximum: 200
      },
      caseSensitive: {
        type: "boolean",
        description:
          "Match case exactly. Defaults to false."
      }
    },
    ["query"]
  ),
  approval: "always",
  summarize(args) {
    const query = optionalString(args, "query") ?? "?";
    const path = optionalString(args, "path") ?? ".";

    return truncateInline(`"${query}" in ${path}`);
  },
  async execute(args, context) {
    assertNotAborted(context.signal);

    const query = requireString(args, "query");
    const path = optionalString(args, "path") ?? ".";
    const maxResults = clampInteger(
      optionalNumber(args, "maxResults") ?? 60,
      1,
      200
    );
    const caseSensitive =
      optionalBoolean(args, "caseSensitive") ?? false;
    const needle = caseSensitive ? query : query.toLowerCase();
    const resolved = await resolveWorkspacePath(path);
    const { entries } = await walkWorkspace(resolved, {
      maxDepth: 20,
      maxEntries: 4_000,
      filesOnly: true
    });
    const results: string[] = [];
    let scanned = 0;
    let truncated = false;

    for (const entry of entries) {
      if (results.length >= maxResults) {
        truncated = true;
        break;
      }

      if (context.signal.aborted) {
        assertNotAborted(context.signal);
      }

      let info;

      try {
        info = await stat(entry.absolute);
      } catch {
        continue;
      }

      if (!info.isFile() || info.size > 512 * 1024) {
        continue;
      }

      let buffer;

      try {
        buffer = await readFile(entry.absolute);
      } catch {
        continue;
      }

      if (buffer.includes(0)) {
        continue;
      }

      scanned += 1;

      const lines = buffer.toString("utf8").split("\n");

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const haystack = caseSensitive ? line : line.toLowerCase();

        if (haystack.includes(needle)) {
          results.push(
            `${entry.relative}:${index + 1}: ${truncateInline(
              line.trim(),
              240
            )}`
          );

          if (results.length >= maxResults) {
            truncated = true;
            break;
          }
        }
      }
    }

    if (results.length === 0) {
      return `No matches for ${JSON.stringify(
        query
      )} in ${resolved.relative} (${scanned} files scanned).`;
    }

    const output = [
      ...results,
      `… ${results.length} match(es) across ${scanned} files${
        truncated ? " · results truncated" : ""
      } …`
    ];

    return capOutput(output.join("\n"));
  }
};

const gitStatus: ToolImplementation = {
  name: "git_status",
  description:
    "Show the workspace Git status (branch and changed files). Requires the workspace to be a Git repository.",
  inputSchema: EMPTY_SCHEMA,
  approval: "always",
  summarize() {
    return "repository status";
  },
  async execute(args, context) {
    assertNotAborted(context.signal);

    const result = await gitResult(
      ["status", "--short", "--branch"],
      context
    );

    if (result.code !== 0) {
      return {
        content: capOutput(
          result.stderr.trim() || "git status failed."
        ),
        isError: true
      };
    }

    return capOutput(
      result.stdout.trim() || "Working tree clean."
    );
  }
};

const gitDiff: ToolImplementation = {
  name: "git_diff",
  description:
    "Show the workspace Git diff. Use path to limit the diff to one file, or staged to inspect staged changes.",
  inputSchema: schema({
    path: {
      type: "string",
      description:
        "Optional file or directory to diff, relative to the workspace root."
    },
    staged: {
      type: "boolean",
      description:
        "Show staged changes instead of unstaged changes. Defaults to false."
    }
  }),
  approval: "always",
  summarize(args) {
    const path = optionalString(args, "path");
    const staged = optionalBoolean(args, "staged") ?? false;

    return truncateInline(
      `${staged ? "staged" : "unstaged"}${path ? ` · ${path}` : ""}`
    );
  },
  async execute(args, context) {
    assertNotAborted(context.signal);

    const path = optionalString(args, "path");
    const staged = optionalBoolean(args, "staged") ?? false;
    const gitArgs = ["diff", "--no-color"];

    if (staged) {
      gitArgs.push("--staged");
    }

    if (path) {
      const resolved = await resolveWorkspacePath(path);
      gitArgs.push("--", resolved.relative);
    }

    const result = await gitResult(gitArgs, context);

    if (result.code !== 0) {
      return {
        content: capOutput(
          result.stderr.trim() || "git diff failed."
        ),
        isError: true
      };
    }

    return capOutput(result.stdout.trim() || "No changes.");
  }
};

const writeFileTool: ToolImplementation = {
  name: "write_file",
  description:
    "Create a new file or completely overwrite an existing file. The previous contents are backed up for /undo. Prefer edit_file for small changes.",
  inputSchema: schema(
    {
      path: {
        type: "string",
        description:
          "File path relative to the workspace root."
      },
      content: {
        type: "string",
        description:
          "Complete new contents of the file."
      }
    },
    ["path", "content"]
  ),
  approval: "ask",
  summarize(args) {
    const path = optionalString(args, "path") ?? "?";
    const content = typeof args.content === "string" ? args.content : "";

    return truncateInline(
      `${path} · ${content.length} bytes · ${linesOf(
        content
      )} lines`
    );
  },
  async preview(args, root) {
    const path = requireString(args, "path");
    const content = rawString(args, "content");
    const resolved = await resolveWorkspacePath(path, {
      forWrite: true
    });
    const before = await readMaybe(
      resolved.absolute,
      resolved.relative
    );
    let exists = false;

    try {
      exists = (await stat(resolved.absolute)).isFile();
    } catch {
      exists = false;
    }

    if (!exists) {
      return plusPreview(
        content,
        `Create ${resolved.relative} in ${root}`
      );
    }

    if (before === null) {
      return [
        `Overwrite ${resolved.relative} in ${root}`,
        "",
        "The existing file could not be read as text, so a line diff is unavailable.",
        "",
        ...splitLines(content)
          .slice(0, 40)
          .map((line) => `+${line}`)
      ].join("\n");
    }

    return patchPreview(resolved.relative, before, content);
  },
  async execute(args, context) {
    assertNotAborted(context.signal);

    const path = requireString(args, "path");
    const content = rawString(args, "content");

    if (content.length > 2_000_000) {
      throw new ToolError(
        "The new file contents exceed the 2 MB write limit."
      );
    }

    const resolved = await resolveWorkspacePath(path, {
      forWrite: true
    });

    assertNotAborted(context.signal);
    await recordBackup(resolved.absolute, resolved.relative);
    await writeTextFile(resolved.absolute, content);

    return `Wrote ${content.length} bytes (${linesOf(
      content
    )} lines) to ${resolved.relative}.`;
  }
};

const editFileTool: ToolImplementation = {
  name: "edit_file",
  description:
    "Replace an exact block of text in an existing file. Include enough surrounding context to make the old text unique. Set replaceAll to replace every occurrence. The previous contents are backed up for /undo.",
  inputSchema: schema(
    {
      path: {
        type: "string",
        description:
          "File path relative to the workspace root."
      },
      oldText: {
        type: "string",
        description:
          "Exact text to replace, including indentation and line breaks."
      },
      newText: {
        type: "string",
        description:
          "Replacement text. Use an empty string to delete the block."
      },
      replaceAll: {
        type: "boolean",
        description:
          "Replace every occurrence instead of requiring a unique match. Defaults to false."
      }
    },
    ["path", "oldText", "newText"]
  ),
  approval: "ask",
  summarize(args) {
    const path = optionalString(args, "path") ?? "?";
    const oldText =
      typeof args.oldText === "string" ? args.oldText : "";
    const newText =
      typeof args.newText === "string" ? args.newText : "";

    return truncateInline(
      `${path} · -${linesOf(oldText)} +${linesOf(newText)} lines`
    );
  },
  async preview(args) {
    const path = requireString(args, "path");
    const oldText = requireString(args, "oldText");
    const newText = rawString(args, "newText");
    const replaceAll = optionalBoolean(args, "replaceAll") ?? false;
    const resolved = await resolveWorkspacePath(path);
    const original = await readTextFile(
      resolved.absolute,
      resolved.relative
    );
    const count = countOccurrences(original, oldText);

    if (count === 0) {
      return `Edit ${resolved.relative}\n\nThe old text was not found. This edit will fail unless the file has changed.`;
    }

    if (count > 1 && !replaceAll) {
      return `Edit ${resolved.relative}\n\nThe old text occurs ${count} times. Make it unique or set replaceAll to true.`;
    }

    const next = replaceAll
      ? original.split(oldText).join(newText)
      : original.replace(oldText, newText);

    return patchPreview(resolved.relative, original, next);
  },
  async execute(args, context) {
    assertNotAborted(context.signal);

    const path = requireString(args, "path");
    const oldText = requireString(args, "oldText");
    const newText = rawString(args, "newText");
    const replaceAll = optionalBoolean(args, "replaceAll") ?? false;
    const resolved = await resolveWorkspacePath(path, {
      forWrite: true
    });
    const original = await readTextFile(
      resolved.absolute,
      resolved.relative
    );

    if (oldText === newText) {
      return `No change: ${resolved.relative} already matches.`;
    }

    const count = countOccurrences(original, oldText);

    if (count === 0) {
      throw new ToolError(
        `The old text was not found in ${resolved.relative}. Read the file again and copy the exact block.`
      );
    }

    if (count > 1 && !replaceAll) {
      throw new ToolError(
        `The old text occurs ${count} times in ${resolved.relative}. Include more context or set replaceAll to true.`
      );
    }

    const next = replaceAll
      ? original.split(oldText).join(newText)
      : original.replace(oldText, newText);

    assertNotAborted(context.signal);
    await recordBackup(resolved.absolute, resolved.relative);
    await writeTextFile(resolved.absolute, next);

    const replaced = replaceAll ? count : 1;
    return `Edited ${resolved.relative}: replaced ${replaced} occurrence(s).`;
  }
};

const runCommandTool: ToolImplementation = {
  name: "run_command",
  description:
    "Run a shell command in the workspace root. Use it for builds, tests, and read-only inspection. Commands require user approval and are limited by a timeout.",
  inputSchema: schema(
    {
      command: {
        type: "string",
        description:
          "Shell command to run, for example \"npm test\"."
      },
      timeoutSeconds: {
        type: "integer",
        description:
          "Timeout in seconds, from 1 to 600. Defaults to 120.",
        minimum: 1,
        maximum: 600
      }
    },
    ["command"]
  ),
  approval: "ask",
  summarize(args) {
    const command = optionalString(args, "command") ?? "?";

    return truncateInline(`$ ${command}`);
  },
  preview(args, root) {
    const command = requireString(args, "command");
    const seconds = commandSeconds(args, "timeoutSeconds", 120);

    return [
      `$ ${command}`,
      "",
      `cwd: ${root}`,
      `timeout: ${seconds}s`,
      "",
      "Commands run with your user account and can affect files beyond the workspace. Review the command carefully."
    ].join("\n");
  },
  async execute(args, context) {
    assertNotAborted(context.signal);

    const command = requireString(args, "command");
    const timeoutMs =
      commandSeconds(args, "timeoutSeconds", 120) * 1000;

    return new Promise((resolve, reject) => {
      exec(
        command,
        {
          cwd: context.root,
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          signal: context.signal,
          encoding: "utf8",
          shell: existsSync("/bin/bash")
            ? "/bin/bash"
            : "/bin/sh"
        },
        (error, stdout, stderr) => {
          if (error && error.name === "AbortError") {
            reject(error);
            return;
          }

          const code =
            error && typeof error.code === "number"
              ? error.code
              : error
                ? 1
                : 0;
          const timedOut = Boolean(error?.killed);
          const content = composeCommandOutput(
            command,
            String(stdout ?? ""),
            String(stderr ?? ""),
            code,
            timedOut
          );

          resolve({
            content,
            isError: code !== 0 || timedOut
          });
        }
      );
    });
  }
};

const IMPLEMENTATIONS: ToolImplementation[] = [
  listFiles,
  readFileTool,
  searchCode,
  gitStatus,
  gitDiff,
  writeFileTool,
  editFileTool,
  runCommandTool
];

export const TOOL_SPECS: ToolDefinition[] = IMPLEMENTATIONS.map(
  ({ name, description, inputSchema, approval }) => ({
    name,
    description,
    inputSchema,
    approval
  })
);

export function findTool(
  name: string
): ToolImplementation | undefined {
  return IMPLEMENTATIONS.find((tool) => tool.name === name);
}

export function parseToolArguments(
  call: ToolCall
): Record<string, unknown> {
  const raw = call.arguments.trim();

  if (!raw) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ToolError(
      `Invalid JSON arguments for ${call.name}: ${errorText(error)}`
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new ToolError(
      `Arguments for ${call.name} must be a JSON object.`
    );
  }

  return parsed as Record<string, unknown>;
}

export function summarizeToolCall(call: ToolCall): string {
  const implementation = findTool(call.name);

  if (!implementation) {
    return truncateInline(call.arguments || "unknown tool");
  }

  try {
    return implementation.summarize(parseToolArguments(call));
  } catch {
    return truncateInline(call.arguments || call.name);
  }
}

export async function previewToolCall(call: ToolCall): Promise<string> {
  const implementation = findTool(call.name);

  if (!implementation) {
    return `Unknown tool: ${call.name}\n\n${call.arguments}`;
  }

  const root = await getWorkspaceRoot();

  try {
    const args = parseToolArguments(call);

    if (implementation.preview) {
      return capOutput(
        await implementation.preview(args, root),
        8_000
      );
    }

    return implementation.summarize(args);
  } catch (error) {
    return capOutput(
      [
        summarizeToolCall(call),
        "",
        `Preview unavailable: ${errorText(error)}`
      ].join("\n"),
      8_000
    );
  }
}

export async function executeToolCall(
  call: ToolCall,
  context: ToolRuntime
): Promise<ToolExecution> {
  const implementation = findTool(call.name);

  if (!implementation) {
    return {
      ok: false,
      content: `Unknown tool "${call.name}".`
    };
  }

  if (context.signal.aborted) {
    return {
      ok: false,
      cancelled: true,
      content: "Cancelled by the user."
    };
  }

  let args: Record<string, unknown>;

  try {
    args = parseToolArguments(call);
  } catch (error) {
    return {
      ok: false,
      content: errorText(error)
    };
  }

  try {
    const result = await implementation.execute(args, context);
    const normalized =
      typeof result === "string"
        ? { content: result }
        : result;

    return {
      ok: !normalized.isError,
      content: capOutput(normalized.content)
    };
  } catch (error) {
    if (isAbortError(error) || context.signal.aborted) {
      return {
        ok: false,
        cancelled: true,
        content: "Cancelled by the user."
      };
    }

    return {
      ok: false,
      content: `${implementation.name} failed: ${errorText(error)}`
    };
  }
}
