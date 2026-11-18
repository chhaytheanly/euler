import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  AuthStyle,
  ProviderAuth,
  ProviderConfig,
  ProviderProtocol
} from "../interfaces/type";
import { getProvidersFileOverride, getProvidersYamlPath } from "./config";

type CatalogEntry = Omit<ProviderConfig, "enabled">;

const KNOWN_PROTOCOLS = new Set<ProviderProtocol>([
  "openai-compatible",
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
  "ollama"
]);

const KNOWN_AUTH_STYLES = new Set<AuthStyle>([
  "bearer",
  "x-api-key",
  "none"
]);

const OPENAI_COMPATIBLE_DEFAULTS: Partial<CatalogEntry> = {
  protocol: "openai-compatible",
  modelsPath: "/models",
  chatPath: "/chat/completions",
  auth: { style: "bearer" },
  requiresKey: true
};

const PROTOCOL_DEFAULTS: Record<
  ProviderProtocol,
  Partial<CatalogEntry>
> = {
  "openai-compatible": OPENAI_COMPATIBLE_DEFAULTS,
  "openai-chat": { ...OPENAI_COMPATIBLE_DEFAULTS, protocol: "openai-chat" },
  "openai-responses": {
    ...OPENAI_COMPATIBLE_DEFAULTS,
    protocol: "openai-responses",
    chatPath: "/responses"
  },
  anthropic: {
    protocol: "anthropic",
    modelsPath: "/models",
    chatPath: "/messages",
    auth: { style: "x-api-key", header: "x-api-key" },
    requiresKey: true
  },
  gemini: { ...OPENAI_COMPATIBLE_DEFAULTS, protocol: "gemini" },
  ollama: {
    protocol: "ollama",
    modelsPath: "/api/tags",
    chatPath: "/api/chat",
    auth: { style: "none" },
    requiresKey: false
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function warn(message: string): void {
  console.warn(`[catalog] ${message}`);
}

function findBundledCatalog(): string | undefined {
  const candidates = [
    fileURLToPath(new URL("config.yaml", import.meta.url)),
    join(process.cwd(), "src", "configs", "config.yaml"),
    join(process.cwd(), "config.yaml")
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

function readYaml(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = parse(readFileSync(path, "utf8"));

    if (!isRecord(parsed)) {
      warn(`${path}: expected a mapping of provider ids to entries`);
      return undefined;
    }

    // A file may wrap its entries under a `providers` key.
    if (isRecord(parsed.providers)) {
      return parsed.providers;
    }

    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      warn(`${path}: ${(error as Error).message}`);
    }
    return undefined;
  }
}

function normalizeAuth(value: unknown): ProviderAuth | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    warn(`invalid auth block, using defaults`);
    return { style: "bearer" };
  }

  const style = value.style;
  if (typeof style !== "string" || !KNOWN_AUTH_STYLES.has(style as AuthStyle)) {
    warn(`unknown auth style "${String(style)}", using "bearer"`);
    return { style: "bearer" };
  }

  const auth: ProviderAuth = { style: style as AuthStyle };
  if (typeof value.header === "string") {
    auth.header = value.header;
  }
  if (typeof value.prefix === "string") {
    auth.prefix = value.prefix;
  }
  return auth;
}

function normalizeEntry(
  providerId: string,
  raw: unknown
): CatalogEntry | undefined {
  if (!isRecord(raw)) {
    warn(`${providerId}: entry must be a mapping, skipping`);
    return undefined;
  }

  if (typeof raw.name !== "string" || !raw.name.trim()) {
    warn(`${providerId}: missing a non-empty "name", skipping`);
    return undefined;
  }
  if (typeof raw.baseUrl !== "string" || !raw.baseUrl.trim()) {
    warn(`${providerId}: missing a non-empty "baseUrl", skipping`);
    return undefined;
  }

  const requestedProtocol = raw.protocol;
  let protocol: ProviderProtocol = "openai-compatible";
  if (typeof requestedProtocol === "string") {
    if (KNOWN_PROTOCOLS.has(requestedProtocol as ProviderProtocol)) {
      protocol = requestedProtocol as ProviderProtocol;
    } else {
      warn(
        `${providerId}: unknown protocol "${requestedProtocol}", ` +
          `using "openai-compatible"`
      );
    }
  }

  const defaults = PROTOCOL_DEFAULTS[protocol];
  const entry: CatalogEntry = {
    ...defaults,
    protocol,
    name: raw.name.trim(),
    baseUrl: raw.baseUrl.trim()
  };

  for (const key of [
    "description",
    "apiKeyEnv",
    "keyUrl",
    "modelsPath",
    "chatPath",
    "defaultModel"
  ] as const) {
    const value = raw[key];
    if (typeof value === "string") {
      entry[key] = value;
    }
  }

  if (typeof raw.requiresKey === "boolean") {
    entry.requiresKey = raw.requiresKey;
  }

  const auth = normalizeAuth(raw.auth);
  if (auth) {
    entry.auth = auth;
  }

  if (isRecord(raw.headers)) {
    const headers: Record<string, string> = {};
    for (const [headerName, headerValue] of Object.entries(raw.headers)) {
      if (typeof headerValue === "string") {
        headers[headerName] = headerValue;
      }
    }
    entry.headers = headers;
  }

  return entry;
}

function mergeEntry(
  base: CatalogEntry,
  override: CatalogEntry
): CatalogEntry {
  const merged: CatalogEntry = { ...base, ...override };

  if (override.auth && base.auth) {
    merged.auth = { ...base.auth, ...override.auth };
  }
  if (override.headers && base.headers) {
    merged.headers = { ...base.headers, ...override.headers };
  }

  return merged;
}

interface CatalogState {
  catalog: Record<string, CatalogEntry>;
  order: string[];
}

function buildProviderCatalog(): CatalogState {
  const bundled = findBundledCatalog();
  if (!bundled) {
    throw new Error(
      "Euler provider catalog (config.yaml) was not found next to the " +
        "running module or in the current directory"
    );
  }

  const sources: string[] = [bundled];
  const userFile = getProvidersYamlPath();
  if (existsSync(userFile)) {
    sources.push(userFile);
  }
  const envFile = getProvidersFileOverride();
  if (envFile && existsSync(envFile)) {
    sources.push(envFile);
  }

  const catalog: Record<string, CatalogEntry> = {};
  const order: string[] = [];

  for (const source of sources) {
    const entries = readYaml(source);
    if (!entries) {
      continue;
    }

    for (const [providerId, raw] of Object.entries(entries)) {
      if (providerId === "providers") {
        continue;
      }

      const normalized = normalizeEntry(providerId, raw);
      if (!normalized) {
        continue;
      }

      if (catalog[providerId]) {
        catalog[providerId] = mergeEntry(catalog[providerId], normalized);
      } else {
        catalog[providerId] = normalized;
        order.push(providerId);
      }
    }
  }

  return { catalog, order };
}

let state = buildProviderCatalog();

export let PROVIDER_CATALOG: Readonly<Record<string, CatalogEntry>> =
  state.catalog;
export let PROVIDER_ORDER: string[] = state.order;

export function refreshProviderCatalog(): void {
  state = buildProviderCatalog();
  PROVIDER_CATALOG = state.catalog;
  PROVIDER_ORDER = state.order;
}

export function getCatalogEntry(
  providerId: string
): CatalogEntry | undefined {
  return state.catalog[providerId];
}

export function makeCatalogProvider(
  providerId: string
): ProviderConfig | undefined {
  const entry = getCatalogEntry(providerId);

  if (!entry) {
    return undefined;
  }

  return {
    ...entry,
    enabled: true
  };
}

export function providerUsesKey(provider: ProviderConfig): boolean {
  return (provider.auth?.style ?? "bearer") !== "none";
}

export function needsApiKey(provider: ProviderConfig): boolean {
  if (typeof provider.requiresKey === "boolean") {
    return provider.requiresKey;
  }

  return providerUsesKey(provider);
}
