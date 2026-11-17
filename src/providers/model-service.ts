import { needsApiKey } from "../configs/catalog";
import { resolveApiKey } from "../configs/config";
import {
    AppConfig,
    Credentials,
    ModelInfo,
    ModelVariant,
    ProviderAdapter,
    ProviderConfig,
    ReasoningEffort
} from "../interfaces/type";
import { resolveModelVariants } from "./model-capabilities";
import { createProviderAdapter } from "./registry";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20_000;

type AdapterFactory = typeof createProviderAdapter;

interface CacheEntry {
  at: number;
  models: ModelInfo[];
}

interface FetchOptions {
  force?: boolean;
  ttlMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  factory?: AdapterFactory;
}

export interface ProviderModels {
  id: string;
  name: string;
  models: ModelInfo[];
  error?: string;
}

export interface AllModelsResult {
  providers: ProviderModels[];
  models: ModelInfo[];
}

const modelCache = new Map<string, CacheEntry>();
const variantCache = new Map<string, ModelVariant[]>();
let overrides: Record<string, ReasoningEffort[]> = {};

export function variantKey(
  providerId: string,
  modelId: string
): string {
  return `${providerId}/${modelId}`;
}

export function configureModelVariants(
  config: Pick<AppConfig, "variantOverrides">
): void {
  const next = config.variantOverrides ?? {};

  if (JSON.stringify(next) === JSON.stringify(overrides)) {
    return;
  }

  overrides = { ...next };
  variantCache.clear();
  modelCache.clear();
}

export function clearModelCache(): void {
  modelCache.clear();
  variantCache.clear();
}

export function getVariants(
  providerId: string,
  modelId: string,
  metadata?: Parameters<typeof resolveModelVariants>[2]
): ModelVariant[] {
  const key = variantKey(providerId, modelId);
  const cached = variantCache.get(key);

  if (cached) {
    return cached;
  }

  const variants = resolveModelVariants(
    modelId,
    providerId,
    metadata,
    overrides
  );
  variantCache.set(key, variants);
  return variants;
}

export function rememberVariants(
  providerId: string,
  modelId: string,
  variants: ModelVariant[]
): void {
  variantCache.set(variantKey(providerId, modelId), variants);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestSignal(options: FetchOptions): AbortSignal {
  const timeout = AbortSignal.timeout(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  return options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
}

export async function fetchModelsForProvider(
  providerId: string,
  provider: ProviderConfig,
  apiKey: string | undefined,
  options: FetchOptions = {}
): Promise<ModelInfo[]> {
  const cacheKey = `${providerId}:${provider.baseUrl}`;
  const cached = modelCache.get(cacheKey);

  if (
    !options.force &&
    cached &&
    Date.now() - cached.at < (options.ttlMs ?? DEFAULT_TTL_MS)
  ) {
    return cached.models;
  }

  const factory = options.factory ?? createProviderAdapter;
  const adapter: ProviderAdapter = factory(
    providerId,
    provider,
    apiKey
  );

  try {
    const models = await adapter.listModels(
      requestSignal(options)
    );

    for (const model of models) {
      rememberVariants(
        providerId,
        model.id,
        model.variants ?? getVariants(providerId, model.id)
      );
    }

    modelCache.set(cacheKey, {
      at: Date.now(),
      models
    });
    return models;
  } catch (error) {
    modelCache.delete(cacheKey);
    throw error;
  }
}

/**
 * Fetch every configured provider in parallel. A failing provider is reported
 * in its own result instead of aborting the whole aggregation.
 */
export async function fetchAllModels(
  config: AppConfig,
  credentials: Credentials,
  options: FetchOptions = {}
): Promise<AllModelsResult> {
  const targets = Object.entries(config.providers)
    .filter(([, provider]) => provider.enabled !== false)
    .map(([id, provider]) => ({
      id,
      provider,
      apiKey: resolveApiKey(id, provider, credentials)
    }))
    .filter(
      ({ provider, apiKey }) => !needsApiKey(provider) || apiKey
    );

  const settled = await Promise.allSettled(
    targets.map(async ({ id, provider, apiKey }) => ({
      id,
      name: provider.name,
      models: await fetchModelsForProvider(
        id,
        provider,
        apiKey,
        options
      )
    }))
  );

  const providers: ProviderModels[] = settled.map(
    (result, index) => {
      const target = targets[index];

      if (result.status === "fulfilled") {
        return result.value;
      }

      return {
        id: target.id,
        name: target.provider.name,
        models: [],
        error: errorText(result.reason)
      };
    }
  );

  return {
    providers,
    models: providers.flatMap((provider) => provider.models)
  };
}
