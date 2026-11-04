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
import { ChatScreen } from "./components/ChatScreen";
import {
  Setup,
  SetupResult
} from "./components/Setup";
import { theme } from "./theme";
import { useChat } from "./useChat";
import { errorMessage } from "./utils";

interface SetupRequest {
  initialProviderId?: string;
  canCancel: boolean;
}

function resolveActiveProvider(
  config: AppConfig,
  credentials: Credentials
): ActiveProvider | null {
  // If a default provider is configured, respect it. If it is not usable,
  // open setup for it rather than silently switching to another provider.
  const orderedIds =
    config.defaultProvider &&
    config.providers[config.defaultProvider]
      ? [config.defaultProvider]
      : Object.keys(config.providers);

  for (const providerId of orderedIds) {
    const provider = config.providers[providerId];

    if (!provider || provider.enabled === false) {
      continue;
    }

    const apiKey = resolveApiKey(
      providerId,
      provider,
      credentials
    );

    if (needsApiKey(provider) && !apiKey) {
      continue;
    }

    const model =
      (providerId === config.defaultProvider
        ? config.defaultModel
        : undefined) ?? provider.defaultModel;

    if (!model) {
      continue;
    }

    return {
      id: providerId,
      provider,
      apiKey,
      model
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

  const [booted, setBooted] = useState(false);
  const [bootError, setBootError] = useState<string | null>(
    null
  );
  const [config, setConfig] = useState<AppConfig>({
    providers: {}
  });
  const [credentials, setCredentials] = useState<Credentials>(
    {}
  );
  const [active, setActive] = useState<ActiveProvider | null>(
    null
  );
  const [setup, setSetup] = useState<SetupRequest | null>(
    null
  );

  const chat = useChat(active);
  const lastCtrlC = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function boot(): Promise<void> {
      try {
        const [loadedConfig, loadedCredentials] =
          await Promise.all([
            loadConfig(),
            loadCredentials()
          ]);

        if (cancelled) {
          return;
        }

        setConfig(loadedConfig);
        setCredentials(loadedCredentials);

        const resolved = resolveActiveProvider(
          loadedConfig,
          loadedCredentials
        );

        if (resolved && !forceSetup) {
          setActive(resolved);
        } else {
          setSetup({
            initialProviderId: resolved
              ? undefined
              : preferredProviderId(loadedConfig),
            canCancel: Boolean(resolved)
          });

          if (resolved) {
            setActive(resolved);
          }
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

    if (!active || setup) {
      exit();
      return;
    }

    const now = Date.now();

    if (now - lastCtrlC.current < 2000) {
      exit();
      return;
    }

    lastCtrlC.current = now;
    chat.addNotice("Press ctrl+c again to exit.");
  });

  async function handleSetupComplete(
    result: SetupResult
  ): Promise<void> {
    const provider = {
      ...result.provider,
      enabled: true,
      defaultModel: result.model
    };

    let nextCredentials = credentials;

    if (result.apiKey !== undefined) {
      nextCredentials = {
        ...credentials,
        [result.providerId]: result.apiKey
      };
    }

    const nextConfig: AppConfig = {
      ...config,
      defaultProvider: result.providerId,
      defaultModel: result.model,
      providers: {
        ...config.providers,
        [result.providerId]: provider
      }
    };

    await saveConfig(nextConfig);

    if (result.apiKey !== undefined) {
      await saveCredentials(nextCredentials);
    }

    const apiKey = resolveApiKey(
      result.providerId,
      provider,
      nextCredentials
    );

    setConfig(nextConfig);
    setCredentials(nextCredentials);
    setActive({
      id: result.providerId,
      provider,
      apiKey,
      model: result.model
    });
    setSetup(null);

    if (active) {
      chat.addNotice(
        `Switched to ${provider.name} · ${result.model}.`
      );
    }
  }

  async function handleSelectModel(model: string): Promise<void> {
    if (!active) {
      return;
    }

    const provider = {
      ...active.provider,
      defaultModel: model
    };

    const nextConfig: AppConfig = {
      ...config,
      defaultModel: model,
      providers: {
        ...config.providers,
        [active.id]: provider
      }
    };

    await saveConfig(nextConfig);

    setConfig(nextConfig);
    setActive({
      ...active,
      provider,
      model
    });
  }

  async function handleSaveKey(key: string): Promise<void> {
    if (!active) {
      return;
    }

    const nextCredentials = {
      ...credentials,
      [active.id]: key
    };

    await saveCredentials(nextCredentials);

    setCredentials(nextCredentials);
    setActive({
      ...active,
      apiKey: key
    });
  }

  function openProviderSetup(): void {
    setSetup({
      canCancel: Boolean(active)
    });
  }

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
          Could not start euler
        </Text>
        <Box marginTop={1}>
          <Text color={theme.error} wrap="wrap">
            {bootError}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            Check your config directory, then try again. ctrl+c
            exits.
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
      onSwitchProvider={openProviderSetup}
      onSaveKey={handleSaveKey}
      onSelectModel={handleSelectModel}
      onExit={exit}
    />
  );
}
