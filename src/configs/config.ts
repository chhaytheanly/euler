import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    AppConfig,
    Credentials,
    ProviderConfig
} from "../interfaces/type";

const CONFIG_DIR =
  process.env.EULER_CONFIG_DIR ??
  join(homedir(), ".config", "euler");

const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");

function defaultConfig(): AppConfig {
  return { providers: {} };
}

async function writePrivateFile(
  file: string,
  contents: string
): Promise<void> {
  await mkdir(CONFIG_DIR, {
    recursive: true,
    mode: 0o700
  });

  const temporary = `${file}.${process.pid}.tmp`;

  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export async function loadConfig(): Promise<AppConfig> {
  try {
    const content = await readFile(CONFIG_FILE, "utf-8");
    const parsed: unknown = JSON.parse(content);

    if (
      !isRecord(parsed) ||
      !isRecord(parsed.providers)
    ) {
      throw new Error("Invalid configuration structure");
    }

    return parsed as unknown as AppConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return defaultConfig();
  }
}

export async function saveConfig(
  config: AppConfig
): Promise<void> {
  await writePrivateFile(
    CONFIG_FILE,
    JSON.stringify(config, null, 2) + "\n"
  );
}

export async function loadCredentials(): Promise<Credentials> {
  try {
    const content = await readFile(CREDENTIALS_FILE, "utf-8");
    const parsed: unknown = JSON.parse(content);

    if (!isRecord(parsed)) {
      throw new Error("Invalid credentials structure");
    }

    const credentials: Credentials = {};

    for (const [providerId, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        credentials[providerId] = value.trim();
      }
    }

    return credentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return {};
  }
}

export async function saveCredentials(
  credentials: Credentials
): Promise<void> {
  await writePrivateFile(
    CREDENTIALS_FILE,
    JSON.stringify(credentials, null, 2) + "\n"
  );
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function getCredentialsPath(): string {
  return CREDENTIALS_FILE;
}

/**
 * A key pasted into the CLI wins over an environment variable. The env var is
 * used as a fallback so CI and shell-based workflows keep working.
 */
export function resolveApiKey(
  providerId: string,
  provider: ProviderConfig,
  credentials: Credentials
): string | undefined {
  if (
    provider.requiresKey === false &&
    (provider.auth?.style ?? "bearer") === "none"
  ) {
    return undefined;
  }

  const stored = credentials[providerId]?.trim();

  if (stored) {
    return stored;
  }

  if (!provider.apiKeyEnv) {
    return undefined;
  }

  const fromEnvironment = process.env[provider.apiKeyEnv]?.trim();
  return fromEnvironment || undefined;
}

export function maskApiKey(key: string | undefined): string {
  if (!key) {
    return "not set";
  }

  if (key.length <= 10) {
    return "••••••••";
  }

  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export type ApiKeySource = "stored" | "environment" | "none";

export function getApiKeySource(
  providerId: string,
  provider: ProviderConfig,
  credentials: Credentials
): ApiKeySource {
  if (credentials[providerId]?.trim()) {
    return "stored";
  }

  return resolveApiKey(providerId, provider, credentials)
    ? "environment"
    : "none";
}

export function putCredential(
  credentials: Credentials,
  providerId: string,
  apiKey: string
): Credentials {
  const key = apiKey.trim();
  const next = { ...credentials };

  if (key) {
    next[providerId] = key;
  } else {
    delete next[providerId];
  }

  return next;
}

/**
 * Remove a provider's stored key without mutating the input. `removed` tells
 * the caller whether there was anything to delete, so logout can be idempotent.
 */
export function dropCredential(
  credentials: Credentials,
  providerId: string
): { credentials: Credentials; removed: boolean } {
  if (!Object.prototype.hasOwnProperty.call(credentials, providerId)) {
    return { credentials, removed: false };
  }

  const next = { ...credentials };
  delete next[providerId];

  return { credentials: next, removed: true };
}
