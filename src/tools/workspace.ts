import { mkdirSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import {
  dirname,
  join,
  relative,
  resolve,
  sep
} from "node:path";

export const WORKSPACE_ROOT = process.cwd();
export const MAX_READ_BYTES = 1_000_000;

// Same limits OpenCode uses for tool output. Overridable via env vars.
export const MAX_LINES = Number(
  process.env.EULER_TOOL_MAX_LINES ?? 2_000
);
export const MAX_BYTES = Number(
  process.env.EULER_TOOL_MAX_BYTES ?? 50 * 1024
);
// Full output is retained here so the model can read the parts that were cut.
export const TOOL_OUTPUT_DIR = ".euler/tool-output";

const IGNORED_DIRECTORIES = new Set([
  ".euler",
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  ".turbo",
  ".parcel-cache",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".idea",
  ".vscode"
]);

const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)credentials\.json$/i,
  /(^|\/)secrets?\.(json|ya?ml|toml|ini)$/i,
  /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/i,
  /(^|\/)\.env\.local$/i
];

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

let rootPromise: Promise<string> | null = null;

/**
 * The real workspace root. Using realpath means a symlinked checkout still
 * compares consistently against resolved tool paths.
 */
export function getWorkspaceRoot(): Promise<string> {
  rootPromise ??= realpath(WORKSPACE_ROOT).catch(() =>
    resolve(WORKSPACE_ROOT)
  );

  return rootPromise;
}

function isInside(root: string, candidate: string): boolean {
  return (
    candidate === root ||
    candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
  );
}

function normalizeRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

function isSensitiveRelative(relativePath: string): boolean {
  if (!relativePath) {
    return false;
  }

  if (
    /(^|\/)\.env(\.[^/]+)?$/i.test(relativePath) &&
    !/\.(example|sample|template)$/i.test(relativePath)
  ) {
    return true;
  }

  return SENSITIVE_PATTERNS.some((pattern) =>
    pattern.test(relativePath)
  );
}

export interface ResolvedPath {
  root: string;
  absolute: string;
  relative: string;
}

/**
 * Resolve a user/model supplied path and guarantee it stays inside the
 * workspace. Read paths resolve symlinks; write paths reject them.
 */
export async function resolveWorkspacePath(
  input: string,
  options: { forWrite?: boolean } = {}
): Promise<ResolvedPath> {
  const value = input.trim();

  if (!value) {
    throw new ToolError("A path is required.");
  }

  const root = await getWorkspaceRoot();
  const absolute = resolve(root, value);

  if (!isInside(root, absolute)) {
    throw new ToolError(
      `Path "${input}" is outside the workspace (${root}).`
    );
  }

  const relativePath = normalizeRelative(root, absolute);

  if (!relativePath) {
    if (options.forWrite) {
      throw new ToolError("The workspace root itself is not a file.");
    }

    return { root, absolute: root, relative: "." };
  }

  if (isSensitiveRelative(relativePath)) {
    throw new ToolError(
      `Access to "${relativePath}" is blocked because it looks like a secret or repository metadata.`
    );
  }

  if (options.forWrite) {
    let existing = absolute;
    let info = null;

    try {
      info = await lstat(existing);
    } catch {
      info = null;
    }

    if (info?.isSymbolicLink()) {
      throw new ToolError(
        `Refusing to write through the symlink "${relativePath}".`
      );
    }

    if (info?.isDirectory()) {
      throw new ToolError(`"${relativePath}" is a directory.`);
    }

    let ancestor = dirname(absolute);

    while (true) {
      try {
        const realAncestor = await realpath(ancestor);

        if (!isInside(root, realAncestor)) {
          throw new ToolError(
            `Path "${input}" escapes the workspace through a symlink.`
          );
        }

        break;
      } catch (error) {
        if (error instanceof ToolError) {
          throw error;
        }

        if (ancestor === root) {
          break;
        }

        const parent = dirname(ancestor);

        if (parent === ancestor) {
          break;
        }

        ancestor = parent;
      }
    }

    return { root, absolute, relative: relativePath };
  }

  let real = absolute;

  try {
    real = await realpath(absolute);
  } catch {
    throw new ToolError(`"${relativePath}" does not exist.`);
  }

  if (!isInside(root, real)) {
    throw new ToolError(
      `Path "${input}" escapes the workspace through a symlink.`
    );
  }

  const realRelative = normalizeRelative(root, real);

  if (isSensitiveRelative(realRelative)) {
    throw new ToolError(
      `Access to "${realRelative}" is blocked because it looks like a secret or repository metadata.`
    );
  }

  return { root, absolute: real, relative: realRelative || "." };
}

export async function readTextFile(
  absolute: string,
  label: string
): Promise<string> {
  const info = await stat(absolute);

  if (info.isDirectory()) {
    throw new ToolError(`"${label}" is a directory, not a file.`);
  }

  if (info.size > MAX_READ_BYTES) {
    throw new ToolError(
      `"${label}" is ${Math.round(
        info.size / 1024
      )} KB, larger than the ${Math.round(
        MAX_READ_BYTES / 1024
      )} KB read limit. Read a line range or search it instead.`
    );
  }

  const buffer = await readFile(absolute);

  if (buffer.includes(0)) {
    throw new ToolError(`"${label}" looks like a binary file.`);
  }

  return buffer.toString("utf8");
}

export async function writeTextFile(
  absolute: string,
  content: string,
  mode?: number
): Promise<void> {
  await mkdir(dirname(absolute), { recursive: true });

  let targetMode = mode;

  if (targetMode === undefined) {
    try {
      targetMode = (await stat(absolute)).mode & 0o777;
    } catch {
      targetMode = 0o644;
    }
  }

  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;

  try {
    await writeFile(temporary, content, { mode: targetMode });
    await rename(temporary, absolute);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch {
      // The temporary file may never have been created.
    }

    throw error;
  }
}

export interface WalkEntry {
  absolute: string;
  relative: string;
  type: "file" | "directory";
  size?: number;
}

export interface WalkOptions {
  maxDepth?: number;
  maxEntries?: number;
  filesOnly?: boolean;
  ignoredDirectories?: Set<string>;
}

export async function walkWorkspace(
  start: ResolvedPath,
  options: WalkOptions = {}
): Promise<{ entries: WalkEntry[]; truncated: boolean }> {
  const maxDepth = options.maxDepth ?? 2;
  const maxEntries = options.maxEntries ?? 400;
  const ignored = options.ignoredDirectories ?? IGNORED_DIRECTORIES;
  const entries: WalkEntry[] = [];

  let startInfo;

  try {
    startInfo = await stat(start.absolute);
  } catch {
    throw new ToolError(`"${start.relative}" does not exist.`);
  }

  if (startInfo.isFile()) {
    return {
      entries: [
        {
          absolute: start.absolute,
          relative: start.relative,
          type: "file",
          size: startInfo.size
        }
      ],
      truncated: false
    };
  }

  const stack: Array<{ directory: string; depth: number }> = [
    { directory: start.absolute, depth: 0 }
  ];

  while (stack.length > 0) {
    const current = stack.pop();

    if (!current) {
      break;
    }

    let dirents;

    try {
      dirents = await readdir(current.directory, {
        withFileTypes: true
      });
    } catch {
      continue;
    }

    dirents.sort((a, b) => a.name.localeCompare(b.name));

    for (const dirent of dirents) {
      const absolute = join(current.directory, dirent.name);
      const relativePath = normalizeRelative(start.root, absolute);

      if (!relativePath || isSensitiveRelative(relativePath)) {
        continue;
      }

      if (dirent.isSymbolicLink()) {
        continue;
      }

      if (dirent.isDirectory()) {
        if (ignored.has(dirent.name)) {
          continue;
        }

        if (!options.filesOnly) {
          entries.push({
            absolute,
            relative: relativePath,
            type: "directory"
          });
        }

        if (current.depth + 1 < maxDepth) {
          stack.push({
            directory: absolute,
            depth: current.depth + 1
          });
        }
      } else if (dirent.isFile()) {
        entries.push({
          absolute,
          relative: relativePath,
          type: "file"
        });
      }

      if (entries.length >= maxEntries) {
        entries.sort((a, b) =>
          a.relative.localeCompare(b.relative)
        );
        return { entries, truncated: true };
      }
    }
  }

  entries.sort((a, b) => a.relative.localeCompare(b.relative));

  return { entries, truncated: false };
}

export interface CapOptions {
  maxLines?: number;
  maxBytes?: number;
}

let outputCounter = 0;

/**
 * Retain the full text on disk so the model can read the part that was cut.
 * Returns a workspace-relative path (readable by read_file), or null on failure.
 */
function saveToolOutput(text: string): string | null {
  try {
    const directory = join(WORKSPACE_ROOT, TOOL_OUTPUT_DIR);
    mkdirSync(directory, { recursive: true });
    const name = `tool_${Date.now().toString(16)}_${outputCounter++}.txt`;
    const file = join(directory, name);
    writeFileSync(file, text, "utf-8");
    return relative(WORKSPACE_ROOT, file);
  } catch {
    return null;
  }
}

/** Byte and line counts for a piece of text, used in tool summaries. */
export function textStats(content: string): {
  bytes: number;
  lines: number;
} {
  return {
    bytes: Buffer.byteLength(content, "utf8"),
    lines: Math.max(1, countLines(content))
  };
}

/**
 * Find the block in `original` that most closely resembles a failed edit.
 * This is only a diagnostic to help the model retry with the exact text; it
 * never changes a file on its own.
 */
export function suggestBlock(
  original: string,
  needle: string,
  maximum = 12
): string | null {
  const wanted = needle
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);

  if (wanted.length === 0) {
    return null;
  }

  const lines = original.split("\n");
  const window = Math.min(Math.max(wanted.length, 3), maximum);
  let bestStart = -1;
  let bestScore = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const slice = lines
      .slice(index, index + window)
      .map((line) => line.trim().toLowerCase());
    let score = 0;

    for (const target of wanted) {
      if (slice.some((line) => line === target)) {
        score += 2;
      } else if (
        slice.some(
          (line) => line.includes(target) || target.includes(line)
        )
      ) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestStart = index;
    }
  }

  if (bestStart < 0 || bestScore === 0) {
    return null;
  }

  const start = bestStart;
  return lines
    .slice(start, start + window)
    .map((line, offset) => `${start + offset + 1} | ${line}`)
    .join("\n");
}

/** How many lines `text` has, not counting an empty one after a final line break. */
function countLines(text: string): number {
  if (text === "") return 0;
  let count = 1;
  for (
    let index = text.indexOf("\n");
    index !== -1 && index < text.length - 1;
    index = text.indexOf("\n", index + 1)
  ) {
    count++;
  }
  return count;
}

/** Where the line after the first `count` lines starts, or the end of `text`. */
function afterLines(text: string, count: number): number {
  let index = 0;
  for (let line = 0; line < count; line++) {
    const next = text.indexOf("\n", index);
    if (next === -1) return text.length;
    index = next + 1;
  }
  return index;
}

/** Longest start of `text` that fits in `budget` UTF-8 bytes. */
function byteBoundary(text: string, budget: number): number {
  if (Buffer.byteLength(text, "utf-8") <= budget) return text.length;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf-8") <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  // Do not split a surrogate pair.
  if (
    low > 0 &&
    low < text.length &&
    text.charCodeAt(low - 1) >= 0xd800 &&
    text.charCodeAt(low - 1) <= 0xdbff &&
    text.charCodeAt(low) >= 0xdc00 &&
    text.charCodeAt(low) <= 0xdfff
  ) {
    low--;
  }
  return low;
}

/**
 * OpenCode-style tool output cap: keep the head, cut at the first limit reached
 * (lines or bytes), retain the full text, and tell the model where to read it.
 * A numeric second argument is treated as a byte limit (legacy call sites).
 */
export function capOutput(
  text: string,
  options: number | CapOptions = {}
): string {
  const maxBytes =
    typeof options === "number" ? options : (options.maxBytes ?? MAX_BYTES);
  const maxLines =
    typeof options === "number" ? MAX_LINES : (options.maxLines ?? MAX_LINES);

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const totalLines = countLines(normalized);
  const totalBytes = Buffer.byteLength(normalized, "utf-8");

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return normalized;
  }

  // Cut once, at the line or byte limit, whichever comes first.
  const end = Math.min(
    afterLines(normalized, maxLines),
    byteBoundary(normalized, maxBytes)
  );
  const shown = normalized
    .slice(0, end)
    .replace(/\n$/, "");
  const shownLines = countLines(normalized.slice(0, end));

  const saved = saveToolOutput(normalized);
  const marker = [
    `[showing lines 1-${shownLines} of ${totalLines}`,
    `${totalBytes} bytes total;`,
    saved
      ? `full output saved to ${saved}]`
      : "full output could not be saved]",
  ].join(" ");

  return `${shown}\n${marker}`;
}

export function formatLineRange(
  startLine: number,
  endLine: number,
  totalLines: number
): string {
  return `lines ${startLine}-${Math.min(
    endLine,
    totalLines
  )} of ${totalLines}`;
}

export function splitLines(content: string): string[] {
  return content.split("\n");
}
