import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DisplayMessage } from "../cli/useChat";
import type {
    SessionMeta,
    StoredSession
} from "../interfaces/sessions";
import type { ChatMessage } from "../interfaces/type";
import { getConfigDir, writePrivateFile } from "./config";

export type { SessionMeta, StoredSession } from "../interfaces/sessions";

const SESSIONS_DIR_NAME = "sessions";
const SESSION_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function sessionsDir(): string {
  return join(getConfigDir(), SESSIONS_DIR_NAME);
}

function sessionPath(id: string): string {
  if (!SAFE_ID.test(id)) {
    throw new Error(`Invalid session id: ${id}`);
  }
  return join(sessionsDir(), `${id}.json`);
}

async function ensureSessionsDir(): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true, mode: 0o700 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSession(content: string): StoredSession | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  if (
    !isRecord(parsed) ||
    !isRecord(parsed.meta)
  ) {
    return undefined;
  }

  const meta = parsed.meta;
  const id = meta.id;
  const title = meta.title;
  const cwd = meta.cwd;

  if (
    typeof id !== "string" ||
    typeof title !== "string" ||
    typeof cwd !== "string" ||
    !Array.isArray(parsed.messages) ||
    !Array.isArray(parsed.conversation)
  ) {
    return undefined;
  }

  return {
    version:
      typeof parsed.version === "number" ? parsed.version : SESSION_VERSION,
    meta: {
      id,
      title,
      cwd,
      createdAt:
        typeof meta.createdAt === "number"
          ? meta.createdAt
          : Date.now(),
      updatedAt:
        typeof meta.updatedAt === "number"
          ? meta.updatedAt
          : Date.now(),
      ...(typeof meta.providerId === "string"
        ? { providerId: meta.providerId }
        : {}),
      ...(typeof meta.model === "string" ? { model: meta.model } : {})
    },
    messages: parsed.messages as DisplayMessage[],
    conversation: parsed.conversation as ChatMessage[],
    ...(isRecord(parsed.usage) &&
    typeof parsed.usage.input === "number" &&
    typeof parsed.usage.output === "number"
      ? {
          usage: {
            input: parsed.usage.input,
            output: parsed.usage.output
          }
        }
      : {})
  };
}

function titleFrom(text: string | undefined): string {
  const clean = text?.trim().replace(/\s+/g, " ") ?? "";
  if (!clean) {
    return "New session";
  }
  return clean.length > 60 ? `${clean.slice(0, 59)}…` : clean;
}

export function getSessionsDir(): string {
  return sessionsDir();
}

export async function createSession(
  cwd: string = process.cwd(),
  title?: string,
  providerId?: string,
  model?: string
): Promise<StoredSession> {
  const now = Date.now();
  const session: StoredSession = {
    version: SESSION_VERSION,
    meta: {
      id: randomUUID(),
      title: titleFrom(title),
      createdAt: now,
      updatedAt: now,
      cwd,
      ...(providerId ? { providerId } : {}),
      ...(model ? { model } : {})
    },
    messages: [],
    conversation: []
  };

  await saveSession(session);
  return session;
}

export async function saveSession(
  session: StoredSession
): Promise<void> {
  await ensureSessionsDir();

  const stored: StoredSession = {
    ...session,
    version: SESSION_VERSION,
    meta: { ...session.meta, updatedAt: Date.now() }
  };

  await writePrivateFile(
    sessionPath(session.meta.id),
    JSON.stringify(stored, null, 2) + "\n"
  );
}

export async function loadSession(
  id: string
): Promise<StoredSession | undefined> {
  try {
    const content = await readFile(sessionPath(id), "utf8");
    return parseSession(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** List session metadata, newest first, optionally scoped to a workspace. */
export async function listSessions(
  cwd?: string
): Promise<SessionMeta[]> {
  await ensureSessionsDir();

  const files = await readdir(sessionsDir());
  const sessions: SessionMeta[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }

    try {
      const content = await readFile(
        join(sessionsDir(), file),
        "utf8"
      );
      const session = parseSession(content);
      if (session && (!cwd || session.meta.cwd === cwd)) {
        sessions.push(session.meta);
      }
    } catch {
      // A broken session file should not hide the others.
    }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function updateSession(
  id: string,
  patch: {
    messages?: DisplayMessage[];
    conversation?: ChatMessage[];
    usage?: { input: number; output: number };
    title?: string;
    providerId?: string;
    model?: string;
  }
): Promise<StoredSession | undefined> {
  const session = await loadSession(id);
  if (!session) {
    return undefined;
  }

  if (patch.messages) {
    session.messages = patch.messages;
  }
  if (patch.conversation) {
    session.conversation = patch.conversation;
  }
  if (patch.usage) {
    session.usage = patch.usage;
  }
  if (patch.title !== undefined) {
    session.meta.title = titleFrom(patch.title);
  }
  if (patch.providerId !== undefined) {
    session.meta.providerId = patch.providerId;
  }
  if (patch.model !== undefined) {
    session.meta.model = patch.model;
  }

  await saveSession(session);
  return session;
}

export async function deleteSession(id: string): Promise<boolean> {
  try {
    await unlink(sessionPath(id));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function renameSession(
  id: string,
  title: string
): Promise<StoredSession | undefined> {
  const session = await loadSession(id);
  if (!session) {
    return undefined;
  }
  session.meta.title = titleFrom(title);
  await saveSession(session);
  return session;
}

export async function forkSession(
  id: string
): Promise<StoredSession | undefined> {
  const source = await loadSession(id);
  if (!source) {
    return undefined;
  }

  const now = Date.now();
  const fork: StoredSession = {
    version: SESSION_VERSION,
    meta: {
      ...source.meta,
      id: randomUUID(),
      title: `${source.meta.title} (fork)`,
      createdAt: now,
      updatedAt: now
    },
    messages: [...source.messages],
    conversation: [...source.conversation],
    ...(source.usage ? { usage: { ...source.usage } } : {})
  };

  await saveSession(fork);
  return fork;
}
