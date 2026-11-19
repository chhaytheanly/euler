import {
  missingUrlVariables,
  needsApiKey,
  providerUsesKey
} from "../configs/catalog";
import {
    dropCredential,
    getApiKeySource,
    loadCredentials,
    maskApiKey,
    putCredential,
    resolveApiKey,
    saveCredentials
} from "../configs/config";
import { AuthDependencies, LoginInput, LoginResult, LogoutInput, LogoutResult, ProviderAuthStatus, ValidationResult } from "../interfaces/auth";
import {
    Credentials,
    ProviderConfig
} from "../interfaces/type";
import { createProviderAdapter } from "./registry";

/** Raised when a login or validation cannot be completed. */
export class AuthError extends Error {
  readonly name = "AuthError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}


const defaultDependencies: AuthDependencies = {
  loadCredentials,
  saveCredentials,
  createAdapter: createProviderAdapter
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the provider credential lifecycle: login (validate + store),
 * logout (remove the locally stored key), and validation.
 *
 * "Revoke" is intentionally local: this tool cannot invalidate a key with the
 * provider itself. `ProviderAuthStatus.keyUrl` points to the provider console
 * where a key can be revoked server-side.
 */
export class ProviderAuthService {
  constructor(
    private readonly dependencies: AuthDependencies = defaultDependencies
  ) {}

  status(
    providerId: string,
    provider: ProviderConfig,
    credentials: Credentials
  ): ProviderAuthStatus {
    const source = getApiKeySource(
      providerId,
      provider,
      credentials
    );
    const key = resolveApiKey(providerId, provider, credentials);

    return {
      providerId,
      providerName: provider.name,
      usesKey: providerUsesKey(provider),
      requiresKey: needsApiKey(provider),
      source,
      maskedKey: key ? maskApiKey(key) : undefined,
      keyUrl: provider.keyUrl
    };
  }

  async validate(
    providerId: string,
    provider: ProviderConfig,
    apiKey: string | undefined,
    signal?: AbortSignal
  ): Promise<ValidationResult> {
    if (!apiKey && needsApiKey(provider)) {
      return {
        valid: false,
        error: `${provider.name} needs an API key.`
      };
    }

    const missing = missingUrlVariables(provider);
    if (missing.length) {
      return {
        valid: false,
        error:
          `Set ${missing.map((name) => `$${name}`).join(", ")} ` +
          `before using ${provider.name}.`
      };
    }

    try {
      const adapter = this.dependencies.createAdapter(
        providerId,
        provider,
        apiKey
      );
      const valid = await adapter.validate(signal);

      return valid
        ? { valid: true }
        : {
            valid: false,
            error: `${provider.name} rejected the credentials.`
          };
    } catch (error) {
      return { valid: false, error: errorMessage(error) };
    }
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const apiKey = input.apiKey.trim();
    const usesKey = providerUsesKey(input.provider);

    if (needsApiKey(input.provider) && !apiKey) {
      throw new AuthError(
        `${input.provider.name} requires an API key.`
      );
    }

    let validated = false;

    if (input.validate !== false) {
      const result = await this.validate(
        input.providerId,
        input.provider,
        usesKey ? apiKey || undefined : undefined,
        input.signal
      );

      if (!result.valid) {
        throw new AuthError(
          `Could not verify ${input.provider.name}: ${
            result.error ?? "unknown error"
          }`
        );
      }

      validated = true;
    }

    const credentials = await this.dependencies.loadCredentials();
    // Local providers (auth style "none") have no key to store.
    const next = usesKey
      ? putCredential(credentials, input.providerId, apiKey)
      : credentials;

    if (JSON.stringify(next) !== JSON.stringify(credentials)) {
      await this.dependencies.saveCredentials(next);
    }

    return {
      status: this.status(
        input.providerId,
        input.provider,
        next
      ),
      credentials: next,
      validated
    };
  }

  async logout(input: LogoutInput): Promise<LogoutResult> {
    const credentials = await this.dependencies.loadCredentials();
    const { credentials: next, removed } = dropCredential(
      credentials,
      input.providerId
    );

    if (removed) {
      await this.dependencies.saveCredentials(next);
    }

    const status = this.status(
      input.providerId,
      input.provider,
      next
    );

    return {
      removed,
      environmentFallback: status.source === "environment",
      status,
      credentials: next
    };
  }
}
