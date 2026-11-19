import type { ProviderConfig } from "../interfaces/type";

const PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

type UrlVariableProvider = Pick<
  ProviderConfig,
  "baseUrl" | "headers" | "urlVariableValues"
>;

export function urlVariables(provider: UrlVariableProvider): string[] {
  const found = new Set<string>();
  const collect = (value: string | undefined): void => {
    if (!value) {
      return;
    }
    for (const match of value.matchAll(PATTERN)) {
      found.add(match[1]);
    }
  };

  collect(provider.baseUrl);
  for (const value of Object.values(provider.headers ?? {})) {
    collect(value);
  }

  return [...found];
}

export function missingUrlVariables(
  provider: UrlVariableProvider
): string[] {
  const values = provider.urlVariableValues ?? {};
  const missing = new Set<string>();

  for (const name of urlVariables(provider)) {
    if (!values[name]?.trim() && !process.env[name]?.trim()) {
      missing.add(name);
    }
  }

  return [...missing];
}

export function applyUrlVariables<T extends UrlVariableProvider>(
  provider: T,
  values: Record<string, string> = provider.urlVariableValues ?? {}
): T {
  const substitute = (value: string | undefined): string | undefined =>
    value?.replace(
      PATTERN,
      (match, name: string) =>
        values[name]?.trim() || process.env[name]?.trim() || match
    );

  const headers = provider.headers
    ? Object.fromEntries(
        Object.entries(provider.headers).map(([name, value]) => [
          name,
          substitute(value) ?? value
        ])
      )
    : undefined;

  return {
    ...provider,
    baseUrl: substitute(provider.baseUrl) ?? provider.baseUrl,
    ...(headers ? { headers } : {})
  } as T;
}
