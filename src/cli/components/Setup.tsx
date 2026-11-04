import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  makeCatalogProvider,
  needsApiKey,
  providerUsesKey,
  PROVIDER_ORDER
} from "../../configs/catalog";
import { resolveApiKey } from "../../configs/config";
import {
  Credentials,
  ModelInfo,
  ProviderConfig
} from "../../interfaces/type";
import { createProviderAdapter } from "../../providers/registry";
import { theme } from "../theme";
import {
  errorMessage,
  formatTokens,
  truncate
} from "../utils";
import { SelectList, SelectItem } from "./SelectList";
import { Spinner } from "./Spinner";
import { TextPrompt } from "./TextPrompt";

const CUSTOM_PROVIDER_ID = "custom";
const CUSTOM_VALUE = "__custom__";

export interface SetupResult {
  providerId: string;
  provider: ProviderConfig;
  apiKey?: string;
  model: string;
  variant?: string;
}

interface SetupProps {
  providers: Record<string, ProviderConfig>;
  credentials: Credentials;
  initialProviderId?: string;
  canCancel?: boolean;
  onCancel?: () => void;
  onComplete: (result: SetupResult) => void | Promise<void>;
}

interface LoadInput {
  providerId: string;
  provider: ProviderConfig;
  apiKey?: string;
  saveKey: boolean;
}

type Step =
  | { kind: "providers" }
  | { kind: "custom-url" }
  | {
      kind: "custom-key";
      provider: ProviderConfig;
    }
  | {
      kind: "key";
      providerId: string;
      provider: ProviderConfig;
    }
  | ({
      kind: "loading";
    } & LoadInput)
  | ({
      kind: "models";
      models: ModelInfo[];
    } & LoadInput)
  | ({
      kind: "variants";
      models: ModelInfo[];
      model: string;
    } & LoadInput)
  | ({
      kind: "manual";
      models?: ModelInfo[];
    } & LoadInput)
  | ({
      kind: "error";
      message: string;
    } & LoadInput);

function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function providerDescription(provider: ProviderConfig): string {
  return provider.description ?? provider.baseUrl;
}

export function Setup({
  providers,
  credentials,
  initialProviderId,
  canCancel = false,
  onCancel,
  onComplete
}: SetupProps) {
  const attemptRef = useRef(0);
  const [saving, setSaving] = useState(false);

  function providerForId(
    providerId: string
  ): ProviderConfig | undefined {
    return (
      providers[providerId] ??
      makeCatalogProvider(providerId)
    );
  }

  function buildInitialStep(): Step {
    if (!initialProviderId) {
      return { kind: "providers" };
    }

    const provider = providerForId(initialProviderId);

    if (!provider) {
      return { kind: "providers" };
    }

    const key = resolveApiKey(
      initialProviderId,
      provider,
      credentials
    );

    if (needsApiKey(provider) && !key) {
      return {
        kind: "key",
        providerId: initialProviderId,
        provider
      };
    }

    return {
      kind: "loading",
      providerId: initialProviderId,
      provider,
      apiKey: key,
      saveKey: false
    };
  }

  const [step, setStep] = useState<Step>(buildInitialStep);
  const initialStepRef = useRef(step);

  async function loadModels(input: LoadInput): Promise<void> {
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;

    setStep({ kind: "loading", ...input });

    try {
      const adapter = createProviderAdapter(
        input.providerId,
        input.provider,
        input.apiKey
      );
      const models = await adapter.listModels();

      if (attempt !== attemptRef.current) {
        return;
      }

      if (models.length === 0) {
        throw new Error(
          `${input.provider.name} returned an empty model list. ` +
            "The endpoint may not implement /models — enter a model ID manually."
        );
      }

      setStep({ kind: "models", ...input, models });
    } catch (error) {
      if (attempt !== attemptRef.current) {
        return;
      }

      setStep({
        kind: "error",
        ...input,
        message: errorMessage(error)
      });
    }
  }

  useEffect(() => {
    const first = initialStepRef.current;

    if (first.kind === "loading") {
      void loadModels(first);
    }
    // Run once for the provider preselected at boot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function finish(
    input: LoadInput,
    model: string,
    variant?: string
  ): Promise<void> {
    setSaving(true);

    try {
      await onComplete({
        providerId: input.providerId,
        provider: {
          ...input.provider,
          enabled: true,
          defaultModel: model
        },
        apiKey: input.saveKey ? input.apiKey : undefined,
        model,
        variant
      });
    } catch (error) {
      setSaving(false);
      setStep({
        kind: "error",
        ...input,
        message: `Could not save configuration: ${errorMessage(
          error
        )}`
      });
    }
  }

  function chooseProvider(providerId: string): void {
    if (providerId === CUSTOM_VALUE) {
      setStep({ kind: "custom-url" });
      return;
    }

    const provider = providerForId(providerId);

    if (!provider) {
      return;
    }

    const key = resolveApiKey(
      providerId,
      provider,
      credentials
    );

    if (needsApiKey(provider) && !key) {
      setStep({
        kind: "key",
        providerId,
        provider
      });
      return;
    }

    void loadModels({
      providerId,
      provider,
      apiKey: key,
      saveKey: false
    });
  }

  function backToProviders(): void {
    // Invalidate any in-flight model request so it cannot replace the
    // provider list after the user navigates back.
    attemptRef.current += 1;
    setStep({ kind: "providers" });
  }

  const allProviderIds = [
    ...PROVIDER_ORDER,
    ...Object.keys(providers).filter(
      (providerId) => !PROVIDER_ORDER.includes(providerId)
    )
  ];

  const providerItems: SelectItem[] = allProviderIds.flatMap<
    SelectItem
  >((providerId) => {
    const provider = providerForId(providerId);

    if (!provider) {
      return [];
    }

    const key = resolveApiKey(
      providerId,
      provider,
      credentials
    );
    const requiresKey = needsApiKey(provider);
    const usesKey = providerUsesKey(provider);
    const configured = Boolean(providers[providerId]);
    const keyBadge = !usesKey
      ? "local"
      : key
        ? "key"
        : requiresKey
          ? "needs key"
          : "optional key";
    const badges = [keyBadge];

    if (configured) {
      badges.push("saved");
    }

    return [
      {
        value: providerId,
        label: provider.name,
        description: providerDescription(provider),
        badge: badges.join(" · "),
        badgeColor:
          usesKey && !key && requiresKey
            ? theme.warn
            : usesKey && key
              ? theme.success
              : theme.dim
      }
    ];
  });

  providerItems.push({
    value: CUSTOM_VALUE,
    label: "Custom endpoint",
    description: "OpenAI-compatible · base URL + optional key",
    badge: "custom",
    badgeColor: theme.dim
  });

  if (saving) {
    return (
      <Box
        flexDirection="column"
        width="100%"
        paddingX={1}
        paddingY={1}
      >
        <Spinner label="Saving configuration…" />
      </Box>
    );
  }

  if (step.kind === "providers") {
    return (
      <Box
        flexDirection="column"
        width="100%"
        paddingX={1}
        paddingY={1}
      >
        <Box marginBottom={1}>
          <Text bold color={theme.accent}>
            euler
          </Text>
          <Text dimColor> · connect a provider</Text>
        </Box>
        <Text dimColor>
          Paste any API key. It stays on this machine.
        </Text>

        <Box marginTop={1}>
          <SelectList
            title="Choose a provider"
            subtitle={`${providerItems.length} options`}
            items={providerItems}
            searchable
            maxVisible={10}
            onSelect={(item) => chooseProvider(item.value)}
            onCancel={canCancel ? onCancel : undefined}
            emptyText="No matching providers."
            footer={`↑↓ move  ·  enter connect${
              canCancel ? "  ·  esc back" : ""
            }  ·  type to search`}
          />
        </Box>
      </Box>
    );
  }

  if (step.kind === "loading") {
    return (
      <Box
        flexDirection="column"
        width="100%"
        paddingX={1}
        paddingY={1}
      >
        <SelectList
          title={`Connecting to ${step.provider.name}`}
          subtitle={truncate(step.provider.baseUrl, 40)}
          items={[]}
          loading
          onCancel={backToProviders}
        />
      </Box>
    );
  }

  if (step.kind === "key") {
    const description = [
      `Paste your ${step.provider.name} API key. It is stored locally with 600 permissions.`,
      step.provider.apiKeyEnv
        ? `You can also set $${step.provider.apiKeyEnv}.`
        : "",
      step.provider.keyUrl ?? ""
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <Box
        flexDirection="column"
        width="100%"
        paddingX={1}
        paddingY={1}
      >
        <TextPrompt
          title={`${step.provider.name} API key`}
          description={description}
          placeholder="sk-…"
          password
          submitLabel="connect"
          onCancel={backToProviders}
          onSubmit={(key) => {
            void loadModels({
              providerId: step.providerId,
              provider: step.provider,
              apiKey: key,
              saveKey: true
            });
          }}
        />
      </Box>
    );
  }

  if (step.kind === "custom-url") {
    return (
      <Box
        flexDirection="column"
        width="100%"
        paddingX={1}
        paddingY={1}
      >
        <TextPrompt
          title="Custom endpoint"
          description="Base URL for an OpenAI-compatible API. Include the version path when the API expects one, for example https://api.example.com/v1."
          placeholder="https://api.example.com/v1"
          submitLabel="next"
          onCancel={backToProviders}
          validate={(value) =>
            isValidBaseUrl(value)
              ? undefined
              : "Enter a valid http:// or https:// URL."
          }
          onSubmit={(value) => {
            const normalized = value.replace(/\/+$/, "");
            const host = new URL(normalized).host;

            setStep({
              kind: "custom-key",
              provider: {
                name: `Custom (${host})`,
                description: "Custom OpenAI-compatible endpoint",
                baseUrl: normalized,
                protocol: "openai-compatible",
                modelsPath: "/models",
                chatPath: "/chat/completions",
                auth: { style: "bearer" },
                requiresKey: false,
                enabled: true
              }
            });
          }}
        />
      </Box>
    );
  }

  if (step.kind === "custom-key") {
    return (
      <Box
        flexDirection="column"
        width="100%"
        paddingX={1}
        paddingY={1}
      >
        <TextPrompt
          title="API key (optional)"
          description={`${step.provider.baseUrl} · leave blank if this endpoint does not require a key.`}
          placeholder="optional"
          password
          required={false}
          submitLabel="connect"
          onCancel={backToProviders}
          onSubmit={(key) => {
            void loadModels({
              providerId: CUSTOM_PROVIDER_ID,
              provider: step.provider,
              apiKey: key || undefined,
              saveKey: Boolean(key)
            });
          }}
        />
      </Box>
    );
  }

  if (step.kind === "models") {
    const items: SelectItem[] = step.models.map((model) => ({
      value: model.id,
      label: model.name ?? model.id,
      description:
        model.contextWindow !== undefined
          ? `${formatTokens(model.contextWindow)} ctx`
          : model.description
    }));

    items.push({
      value: "__manual__",
      label: "Enter model ID manually…",
      description: "when the list is incomplete"
    });

    return (
      <Box
        flexDirection="column"
        width="100%"
        paddingX={1}
        paddingY={1}
      >
        <SelectList
          title="Choose a model"
          subtitle={`${step.provider.name} · ${step.models.length} available`}
          items={items}
          searchable
          maxVisible={10}
          onSelect={(item) => {
            if (item.value === "__manual__") {
              setStep({
                kind: "manual",
                providerId: step.providerId,
                provider: step.provider,
                apiKey: step.apiKey,
                saveKey: step.saveKey,
                models: step.models
              });
              return;
            }

            const selectedModel = step.models.find(m => m.id === item.value);
            const variants = selectedModel?.variants ?? [];
            
            if (variants.length > 0) {
              setStep({
                kind: "variants",
                providerId: step.providerId,
                provider: step.provider,
                apiKey: step.apiKey,
                saveKey: step.saveKey,
                models: step.models,
                model: item.value
              });
            } else {
              void finish(step, item.value);
            }
          }}
          onCancel={backToProviders}
          emptyText="No matching models."
          footer="↑↓ move · enter select · esc back · type to search"
        />
      </Box>
    );
  }

  if (step.kind === "manual") {
    return (
      <Box
        flexDirection="column"
        width="100%"
        paddingX={1}
        paddingY={1}
      >
        <TextPrompt
          title="Model ID"
          description={`Enter the exact model identifier for ${step.provider.name}.`}
          placeholder="model-id"
          submitLabel="use model"
          onCancel={() => {
            if (step.models && step.models.length > 0) {
              setStep({
                kind: "models",
                providerId: step.providerId,
                provider: step.provider,
                apiKey: step.apiKey,
                saveKey: step.saveKey,
                models: step.models
              });
            } else {
              backToProviders();
            }
          }}
          onSubmit={(model) => {
            void finish(step, model);
          }}
        />
      </Box>
    );
  }

  if (step.kind === "variants") {
    const selectedModel = step.models.find(m => m.id === step.model);
    const variants = selectedModel?.variants ?? [];

    const variantItems: SelectItem[] = variants.map((variant) => ({
      value: variant.id,
      label: variant.name,
      description: variant.description
    }));

    // Add a "No variant / Default" option
    variantItems.unshift({
      value: "none",
      label: "No variant (default)",
      description: "Use the model's default behavior"
    });

    return (
      <Box
        flexDirection="column"
        width="100%"
        paddingX={1}
        paddingY={1}
      >
        <SelectList
          title={`Choose variant for ${selectedModel?.name ?? step.model}`}
          subtitle={`${step.provider.name} · ${variants.length} variant(s) available`}
          items={variantItems}
          searchable
          maxVisible={10}
          onSelect={(item) => {
            const variant = item.value === "none" ? undefined : item.value;
            void finish(step, step.model, variant);
          }}
          onCancel={() => {
            // Go back to model selection
            setStep({
              kind: "models",
              providerId: step.providerId,
              provider: step.provider,
              apiKey: step.apiKey,
              saveKey: step.saveKey,
              models: step.models
            });
          }}
          emptyText="No variants available."
          footer="↑↓ move · enter select · esc back to model list · type to search"
        />
      </Box>
    );
  }

  const actions: SelectItem[] = [
    {
      value: "retry",
      label: "Try again",
      description: "repeat the same request"
    }
  ];

  if (needsApiKey(step.provider)) {
    actions.push({
      value: "key",
      label: "Enter a different API key",
      description: "replace the key for this provider"
    });
  }

  actions.push(
    {
      value: "manual",
      label: "Enter a model ID manually",
      description: "connect even if /models failed"
    },
    {
      value: "providers",
      label: "Choose another provider",
      description: "go back to the provider list"
    }
  );

  return (
    <Box
      flexDirection="column"
      width="100%"
      paddingX={1}
      paddingY={1}
    >
      <Box marginBottom={1}>
        <Text bold color={theme.accent}>
          euler
        </Text>
        <Text dimColor> · connection failed</Text>
      </Box>

      <Box
        borderStyle="round"
        borderColor={theme.error}
        paddingX={1}
        marginBottom={1}
      >
        <Text color={theme.error} wrap="wrap">
          {truncate(step.message, 700)}
        </Text>
      </Box>

      <SelectList
        title="What next?"
        items={actions}
        onSelect={(item) => {
          if (item.value === "retry") {
            void loadModels(step);
          } else if (item.value === "key") {
            setStep({
              kind: "key",
              providerId: step.providerId,
              provider: step.provider
            });
          } else if (item.value === "manual") {
            setStep({
              kind: "manual",
              providerId: step.providerId,
              provider: step.provider,
              apiKey: step.apiKey,
              saveKey: step.saveKey
            });
          } else {
            backToProviders();
          }
        }}
        onCancel={backToProviders}
        footer="↑↓ move · enter select · esc back"
      />
    </Box>
  );
}

export { CUSTOM_PROVIDER_ID };
