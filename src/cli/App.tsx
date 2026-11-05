
import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

import {
    getConfigPath,
    getCredentialsPath,
    loadConfig,
    loadCredentials,
    resolveApiKey,
    saveConfig,
    saveCredentials
} from "../configs/config";

import { needsApiKey } from "../configs/catalog";

import {
    ActiveProvider,
    AppConfig,
    Credentials
} from "../interfaces/type";

import { BootScreen } from "./components/BootScreen";
import { Setup, SetupResult } from "./components/Setup";

import { ChatScreen } from "./components/ChatScreen";
import { theme } from "./theme";
import { useChat } from "./useChat";
import { errorMessage } from "./utils";

interface SetupRequest {
  initialProviderId?: string;
  canCancel: boolean;
}

// Resolve the configured provider and its saved preferences.
function resolveActiveProvider(
  config: AppConfig,
  credentials: Credentials
): ActiveProvider | null {
  const providerId = config.defaultProvider;

  const orderedIds =
    providerId && config.providers[providerId]
      ? [providerId]
      : Object.keys(config.providers);

  for (const id of orderedIds) {
    const provider = config.providers[id];

    if (!provider || provider.enabled === false) {
      continue;
    }

    const apiKey = resolveApiKey(
      id,
      provider,
      credentials
    );

    if (needsApiKey(provider) && !apiKey) {
      continue;
    }

    const model =
      (id === config.defaultProvider
        ? config.defaultModel
        : undefined) ?? provider.defaultModel;

    if (!model) {
      continue;
    }

    return {
      id,
      provider,
      apiKey,
      model,
      variant:
        id === config.defaultProvider
          ? config.defaultVariant
          : undefined
    };
  }

  return null;
}

function preferredProviderId(
  config: AppConfig
): string | undefined {
  if (
    config.defaultProvider &&
    config.providers[config.defaultProvider]
  ) {
    return config.defaultProvider;
  }

  return Object.keys(config.providers)[0];
}

export function App({
  forceSetup = false
}: {
  forceSetup?: boolean;
}) {
  const { exit } = useApp();

  // Application state
  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(
    null
  );

  const [config, setConfig] = useState<AppConfig>({
    providers: {}
  });

  const [credentials, setCredentials] =
    useState<Credentials>({});

  const [active, setActive] =
    useState<ActiveProvider | null>(null);

  const [setup, setSetup] =
    useState<SetupRequest | null>(null);

  const lastCtrlC = useRef(0);

  // Active provider is the single source of truth.
  const chat = useChat(active);

  // --------------------------------------------------
  // Boot
  // --------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function boot(): Promise<void> {
      try {
        const [loadedConfig, loadedCredentials] =
          await Promise.all([
            loadConfig(),
            loadCredentials()
          ]);

        if (cancelled) return;

        const resolved = resolveActiveProvider(
          loadedConfig,
          loadedCredentials
        );

        setConfig(loadedConfig);
        setCredentials(loadedCredentials);

        if (resolved) {
          setActive(resolved);
        }

        if (!resolved || forceSetup) {
          setSetup({
            initialProviderId: resolved
              ? resolved.id
              : preferredProviderId(loadedConfig),
            canCancel: Boolean(resolved)
          });
        }
      } catch (error) {
        if (!cancelled) {
          setBootError(errorMessage(error));
        }
      } finally {
        if (!cancelled) {
          setBooted(true);
        }
      }
    }

    void boot();

    return () => {
      cancelled = true;
    };
  }, [forceSetup]);

  // --------------------------------------------------
  // Configuration persistence
  // --------------------------------------------------

  async function persistConfig(
    nextConfig: AppConfig
  ): Promise<void> {
    await saveConfig(nextConfig);
    setConfig(nextConfig);
  }

  async function persistCredentials(
    nextCredentials: Credentials
  ): Promise<void> {
    await saveCredentials(nextCredentials);
    setCredentials(nextCredentials);
  }

  function reportError(error: unknown): void {
    chat.addNotice(
      `Error: ${errorMessage(error)}`
    );
  }

  // --------------------------------------------------
  // Keyboard shortcuts
  // --------------------------------------------------

  useInput((input, key) => {
    if (key.ctrl && input === "d") {
      exit();
      return;
    }

    if (!(key.ctrl && input === "c")) {
      return;
    }

    if (chat.busy) {
      chat.cancel();
      return;
    }

    // Allow Ctrl+C to cancel setup when possible.
    if (setup) {
      if (setup.canCancel) {
        setSetup(null);
      } else {
        exit();
      }
      return;
    }

    if (!active) {
      exit();
      return;
    }

    const now = Date.now();

    if (now - lastCtrlC.current < 2000) {
      exit();
      return;
    }

    lastCtrlC.current = now;

    chat.addNotice(
      "Press Ctrl+C again to exit."
    );
  });

  // --------------------------------------------------
  // Provider setup / switching
  // --------------------------------------------------

  async function handleSetupComplete(
    result: SetupResult
  ): Promise<void> {
    try {
      const provider = {
        ...result.provider,
        enabled: true,
        defaultModel: result.model
      };

      const nextCredentials: Credentials =
        result.apiKey !== undefined
          ? {
              ...credentials,
              [result.providerId]: result.apiKey
            }
          : credentials;

      const nextConfig: AppConfig = {
        ...config,
        defaultProvider: result.providerId,
        defaultModel: result.model,
        defaultVariant: result.variant,
        providers: {
          ...config.providers,
          [result.providerId]: provider
        }
      };

      // Persist before changing the active session.
      await saveConfig(nextConfig);

      if (result.apiKey !== undefined) {
        await saveCredentials(nextCredentials);
      }

      const apiKey = resolveApiKey(
        result.providerId,
        provider,
        nextCredentials
      );

      const nextActive: ActiveProvider = {
        id: result.providerId,
        provider,
        apiKey,
        model: result.model,
        variant: result.variant
      };

      setConfig(nextConfig);
      setCredentials(nextCredentials);
      setActive(nextActive);
      setSetup(null);

      if (active) {
        chat.addNotice(
          `Switched to ${provider.name} · ${result.model}` +
          (result.variant ? ` · ${result.variant}` : "")
        );
      }
    } catch (error) {
      reportError(error);
    }
  }

  function openProviderSetup(): void {
    setSetup({
      initialProviderId: active?.id,
      canCancel: Boolean(active)
    });
  }

  // --------------------------------------------------
  // Model selection
  // --------------------------------------------------

  async function handleSelectModel(
    model: string
  ): Promise<void> {
    if (!active || active.model === model) {
      return;
    }

    try {
      const provider = {
        ...active.provider,
        defaultModel: model
      };

      const nextConfig: AppConfig = {
        ...config,
        defaultModel: model,
        defaultVariant: undefined,
        providers: {
          ...config.providers,
          [active.id]: provider
        }
      };

      await persistConfig(nextConfig);

      setActive({
        ...active,
        provider,
        model,
        variant: undefined
      });

      chat.addNotice(
        `Model changed to ${model}. Reasoning reset to default.`
      );
    } catch (error) {
      reportError(error);
    }
  }

  // --------------------------------------------------
  // Reasoning variant selection
  // --------------------------------------------------

  async function handleSelectVariant(
    variantId: string | undefined
  ): Promise<void> {
    if (!active || active.variant === variantId) {
      return;
    }

    try {
      const nextConfig: AppConfig = {
        ...config,
        defaultVariant: variantId
      };

      await persistConfig(nextConfig);

      setActive({
        ...active,
        variant: variantId
      });

      chat.addNotice(
        `Reasoning changed to ${variantId ?? "Default"}.`
      );
    } catch (error) {
      reportError(error);
    }
  }

  // --------------------------------------------------
  // API key management
  // --------------------------------------------------

  async function handleSaveKey(
    key: string
  ): Promise<void> {
    if (!active) return;

    try {
      const nextCredentials: Credentials = {
        ...credentials,
        [active.id]: key
      };

      await persistCredentials(nextCredentials);

      setActive({
        ...active,
        apiKey: key
      });

      chat.addNotice("API key saved successfully.");
    } catch (error) {
      reportError(error);
    }
  }

  // --------------------------------------------------
  // Rendering
  // --------------------------------------------------

  if (!booted) {
    return <BootScreen />;
  }

  if (bootError) {
    return (
      <Box
        flexDirection="column"
        width="100%"
        paddingX={1}
        paddingY={1}
      >
        <Text bold color={theme.error}>
          Could not start Euler
        </Text>

        <Box marginTop={1}>
          <Text color={theme.error} wrap="wrap">
            {bootError}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            Check your configuration directory.
            {" "}Ctrl+C exits.
          </Text>
        </Box>
      </Box>
    );
  }

  if (setup || !active) {
    return (
      <Setup
        providers={config.providers}
        credentials={credentials}
        initialProviderId={setup?.initialProviderId}
        canCancel={setup?.canCancel ?? false}
        onCancel={() => setSetup(null)}
        onComplete={handleSetupComplete}
      />
    );
  }

  const apiKeySource = !active.apiKey
    ? "none"
    : credentials[active.id]
      ? "stored"
      : "environment";

  return (
    <ChatScreen
      active={active}
      chat={chat}
      configPath={getConfigPath()}
      credentialsPath={getCredentialsPath()}
      apiKeySource={apiKeySource}
      variant={active.variant}
      onSwitchProvider={openProviderSetup}
      onSaveKey={handleSaveKey}
      onSelectModel={handleSelectModel}
      onSelectVariant={handleSelectVariant}
      onExit={exit}
    />
  );
}
