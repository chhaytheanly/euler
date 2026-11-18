import { ApiKeySource } from "../configs/config";
import { Credentials, ProviderAdapter, ProviderConfig } from "./type";

export interface ProviderAuthStatus {
  providerId: string;
  providerName: string;
  usesKey: boolean;
  requiresKey: boolean;
  source: ApiKeySource;
  maskedKey?: string;
  keyUrl?: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export interface LoginInput {
  providerId: string;
  provider: ProviderConfig;
  apiKey: string;
  /** Verify the key with the provider before persisting it. Default: true. */
  validate?: boolean;
  signal?: AbortSignal;
}

export interface LoginResult {
  status: ProviderAuthStatus;
  credentials: Credentials;
  validated: boolean;
}

export interface LogoutInput {
  providerId: string;
  provider: ProviderConfig;
}

export interface LogoutResult {
  /** Whether a locally stored key was actually removed. */
  removed: boolean;
  /** True when an environment variable still supplies a key after logout. */
  environmentFallback: boolean;
  status: ProviderAuthStatus;
  credentials: Credentials;
}

/** Injectable dependencies keep the service independent of disk and network. */
export interface AuthDependencies {
  loadCredentials: () => Promise<Credentials>;
  saveCredentials: (credentials: Credentials) => Promise<void>;
  createAdapter: (
    providerId: string,
    provider: ProviderConfig,
    apiKey?: string
  ) => ProviderAdapter;
}