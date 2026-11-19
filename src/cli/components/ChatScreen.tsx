
import { Box, Static, Text, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  applyUrlVariables,
  makeCatalogProvider
} from "../../configs/catalog";
import {
  maskApiKey
} from "../../configs/config";
import {
  ActiveProvider,
  AppConfig,
  Credentials,
  ModelInfo
} from "../../interfaces/type";
import {
  fetchAllModels,
  fetchModelsForProvider,
  getVariants
} from "../../providers/model-service";
import {
    CommandDefinition,
    findCommand,
    suggestCommands
} from "../commands";
import { theme } from "../theme";
import {
    ChatController,
    DisplayMessage
} from "../useChat";
import {
    errorMessage,
    formatTokens,
    truncate
} from "../utils";
import { ApprovalPanel } from "./ApprovalPanel";
import { HelpPanel } from "./HelpPanel";
import { MessageView } from "./MessageView";
import { PromptInput } from "./PromptInput";
import { SelectItem, SelectList } from "./SelectList";
import { StatusBar } from "./StatusBar";
import { TextPrompt } from "./TextPrompt";
import { ToolCard } from "./ToolCard";

type Modal =
  | "help"
  | "models"
  | "key"
  | "logout"
  | "variants"
  | "sessions"
  | null;

type SessionPickerMode = "resume" | "delete";

interface ModelState {
  status: "loading" | "ready" | "error";
  models: ModelInfo[];
  all: boolean;
  error?: string;
}

const PROVIDER_MODEL_SEPARATOR = "\u0000";

function encodeModelValue(
  providerId: string,
  modelId: string
): string {
  return `${providerId}${PROVIDER_MODEL_SEPARATOR}${modelId}`;
}

function decodeModelValue(
  value: string
): { providerId: string; modelId: string } | undefined {
  const index = value.indexOf(PROVIDER_MODEL_SEPARATOR);

  if (index < 0) {
    return undefined;
  }

  return {
    providerId: value.slice(0, index),
    modelId: value.slice(index + 1)
  };
}

interface ChatScreenProps {
  active: ActiveProvider;
  chat: ChatController;
  config: AppConfig;
  credentials: Credentials;
  configPath: string;
  credentialsPath: string;
  apiKeySource: "stored" | "environment" | "none";
  variant?: string;
  onLogin: () => void;
  onLogout: (providerId: string) => Promise<void> | void;
  onValidate: () => Promise<void> | void;
  onSwitchProvider: () => void;
  onSaveKey: (key: string) => Promise<void> | void;
  onSelectModel: (
    model: string,
    providerId?: string
  ) => Promise<void> | void;
  onSelectVariant?: (
    variantId: string | undefined
  ) => Promise<void> | void;
  onExit: () => void;
}

function CommandHints({
  suggestions
}: {
  suggestions: CommandDefinition[];
}) {
  const shown = suggestions.slice(0, 6);
  const remaining = suggestions.length - shown.length;

  return (
    <Box
      flexDirection="column"
      width="100%"
      paddingX={1}
      marginBottom={0}
    >
      {shown.map((command) => (
        <Box key={command.name}>
          <Box width={14}>
            <Text color={theme.accent}>
              /{command.name}
            </Text>
          </Box>

          <Box flexGrow={1}>
            <Text dimColor wrap="truncate">
              {command.description}
            </Text>
          </Box>
        </Box>
      ))}

      <Text dimColor>
        {remaining > 0
          ? `${remaining} more · type to filter · tab completes`
          : "tab completes · esc clears"}
      </Text>
    </Box>
  );
}

export function ChatScreen({
  active,
  chat,
  config,
  credentials,
  configPath,
  credentialsPath,
  apiKeySource,
  variant,
  onLogin,
  onLogout,
  onValidate,
  onSwitchProvider,
  onSaveKey,
  onSelectModel,
  onSelectVariant,
  onExit
}: ChatScreenProps) {
  const { stdout } = useStdout();
  const stream = stdout as NodeJS.WriteStream;

  const [width, setWidth] = useState(() => {
    const columns = stream.columns;

    return typeof columns === "number" && columns > 0
      ? columns
      : 80;
  });

  useEffect(() => {
    const updateWidth = () => {
      const columns = stream.columns;

      setWidth(
        typeof columns === "number" && columns > 0
          ? columns
          : 80
      );
    };

    updateWidth();

    if (typeof stream.on === "function") {
      stream.on("resize", updateWidth);

      return () => {
        stream.off("resize", updateWidth);
      };
    }

    return undefined;
  }, [stream]);

  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [logoutTarget, setLogoutTarget] = useState<
    string | null
  >(null);
  const [sessionMode, setSessionMode] =
    useState<SessionPickerMode>("resume");

  const [modelState, setModelState] =
    useState<ModelState | null>(null);

  const [variantList, setVariantList] = useState<SelectItem[]>(
    []
  );

  const [variantSource, setVariantSource] = useState<
    string | null
  >(null);

  const modelAttempt = useRef(0);
  const didWelcome = useRef(false);

  useEffect(() => {
    if (didWelcome.current) {
      return;
    }

    didWelcome.current = true;

    if (chat.messages.length === 0) {
      chat.addNotice(
        `Connected to ${active.provider.name} · ${active.model}\n` +
          "Type a message, or /help for commands."
      );
    }

  }, []);

  const busy = chat.busy;

  const suggestions =
    modal === null ? suggestCommands(input) : [];

  const completions = suggestions.map(
    (command) => `/${command.name}`
  );

  async function openSessions(
    mode: SessionPickerMode
  ): Promise<void> {
    if (busy) {
      chat.addError(
        "Cancel the current response first (esc), then manage sessions."
      );
      return;
    }

    setSessionMode(mode);
    await chat.refreshSessions();
    setModal("sessions");
  }

  async function selectSession(id: string): Promise<void> {
    const ok = await chat.switchSession(id);
    setModal(null);
    setInput("");
    setHistory([]);

    if (ok) {
      chat.addNotice("Resumed saved session.");
    } else {
      chat.addError("That session could not be loaded.");
    }
  }

  async function openModelPicker(
    all = false,
    force = false
  ): Promise<void> {
    setModal("models");
    setModelState({
      status: "loading",
      models: [],
      all
    });

    const attempt = ++modelAttempt.current;

    try {
      if (all) {
        const result = await fetchAllModels(
          config,
          credentials,
          { force }
        );
        const failed = result.providers.filter(
          (provider) => provider.error
        );

        if (attempt !== modelAttempt.current) {
          return;
        }

        if (result.models.length === 0) {
          throw new Error(
            failed.length > 0
              ? failed
                  .map(
                    (provider) =>
                      `${provider.name}: ${provider.error}`
                  )
                  .join("\n")
              : "No configured providers have models available."
          );
        }

        setModelState({
          status: "ready",
          models: result.models,
          all
        });

        if (failed.length > 0) {
          chat.addNotice(
            `Some providers could not be reached:\n${failed
              .map(
                (provider) =>
                  `${provider.name}: ${provider.error}`
              )
              .join("\n")}`
          );
        }
      } else {
        const models = await fetchModelsForProvider(
          active.id,
          active.provider,
          active.apiKey,
          { force }
        );

        if (attempt !== modelAttempt.current) {
          return;
        }

        setModelState({
          status: "ready",
          models,
          all
        });
      }
    } catch (error) {
      if (attempt !== modelAttempt.current) {
        return;
      }

      setModelState({
        status: "error",
        models: [],
        all,
        error: errorMessage(error)
      });
    }
  }

  function getVariantItems(
    modelId: string,
    providerId = active.id
  ): SelectItem[] {
    return [
      {
        value: "__default__",
        label: "Default",
        description:
          "Use the model's default reasoning behavior"
      },

      ...getVariants(providerId, modelId).map((item) => ({
        value: item.id,
        label: item.name,
        description: item.description
      }))
    ];
  }

  function openVariantPicker(
    modelId: string,
    providerId = active.id
  ): void {
    setVariantSource(modelId);
    setVariantList(getVariantItems(modelId, providerId));
    setModal("variants");
  }

  async function handleVariantSelect(
    selectedValue: string
  ): Promise<void> {
    const isDefault =
      selectedValue === "__default__";

    const selected = variantList.find(
      (item) => item.value === selectedValue
    );

    try {
      if (!onSelectVariant) {
        throw new Error(
          "Reasoning selection is not connected to the application."
        );
      }

      await onSelectVariant(
        isDefault ? undefined : selectedValue
      );

      setModal(null);

      chat.addNotice(
        isDefault
          ? `Reasoning for ${active.model} reset to default.`
          : `Reasoning for ${active.model} set to ${
              selected?.label ?? selectedValue
            }.`
      );
    } catch (error) {
      chat.addError(errorMessage(error));
    }
  }

  async function switchModel(
    model: string,
    providerId?: string
  ): Promise<void> {
    try {
      await onSelectModel(model, providerId);

      openVariantPicker(
        model,
        providerId ?? active.id
      );
    } catch (error) {
      setModal(null);
      chat.addError(errorMessage(error));
    }
  }

  async function handleCommand(
    command: string
  ): Promise<void> {
    const [name = "", ...rest] = command
      .slice(1)
      .trim()
      .split(/\s+/);

    const definition = findCommand(name);

    if (!definition) {
      chat.addError(
        `Unknown command /${name}. Type /help to see available commands.`
      );

      return;
    }

    const argument = rest.join(" ").trim();

    // Quit
    if (definition.name === "quit") {
      onExit();
      return;
    }

    // Help
    if (definition.name === "help") {
      setModal("help");
      return;
    }

    // Reasoning
    if (definition.name === "reasoning") {
      if (busy) {
        chat.addError(
          "Cancel the current response first (esc), then update reasoning."
        );

        return;
      }

      const effort = argument.toLowerCase();

      // Open interactive reasoning selector.
      if (!effort) {
        await openVariantPicker(active.model);
        return;
      }

      // Reset to default.
      if (effort === "default") {
        try {
          if (!onSelectVariant) {
            throw new Error(
              "Reasoning selection is not connected to the application."
            );
          }

          await onSelectVariant(undefined);

          chat.addNotice(
            "Reasoning reset to default."
          );
        } catch (error) {
          chat.addError(errorMessage(error));
        }

        return;
      }

      // Validate against the resolved capabilities of the active model.
      try {
        const items = getVariantItems(active.model);

        const selected = items.find(
          (item) =>
            item.value !== "__default__" &&
            item.value.toLowerCase() === effort
        );

        if (!selected) {
          chat.addError(
            `Reasoning "${effort}" is not supported by ${active.model}.`
          );

          return;
        }

        if (!onSelectVariant) {
          throw new Error(
            "Reasoning selection is not connected to the application."
          );
        }

        await onSelectVariant(selected.value);

        chat.addNotice(
          `Reasoning set to ${selected.label}.`
        );
      } catch (error) {
        chat.addError(
          `Could not update reasoning: ${errorMessage(error)}`
        );
      }

      return;
    }

    // API key
    if (definition.name === "key") {
      if (busy) {
        chat.addError(
          "Cancel the current response first (esc), then update the key."
        );

        return;
      }

      setModal("key");
      return;
    }

    // Provider
    if (definition.name === "provider") {
      if (busy) {
        chat.addError(
          "Cancel the current response first (esc), then switch providers."
        );

        return;
      }

      onSwitchProvider();
      return;
    }

    // Login
    if (definition.name === "login") {
      if (busy) {
        chat.addError(
          "Cancel the current response first (esc), then log in."
        );

        return;
      }

      onLogin();
      return;
    }

    // Logout / revoke a stored key
    if (definition.name === "logout") {
      if (busy) {
        chat.addError(
          "Cancel the current response first (esc), then log out."
        );

        return;
      }

      const hasStoredKey = Object.values(credentials).some(
        (key) => key.trim()
      );

      if (!hasStoredKey) {
        chat.addNotice(
          "No saved API keys to remove. Keys supplied by environment variables " +
            "cannot be deleted here — unset the variable in your shell."
        );
        return;
      }

      setLogoutTarget(null);
      setModal("logout");
      return;
    }

    // Validate the active provider's key
    if (definition.name === "validate") {
      if (busy) {
        chat.addError(
          "Cancel the current response first (esc), then validate the key."
        );

        return;
      }

      try {
        await onValidate();
      } catch (error) {
        chat.addError(errorMessage(error));
      }

      return;
    }

    // Model
    if (
      definition.name === "model" ||
      definition.name === "models"
    ) {
      if (busy) {
        chat.addError(
          "Cancel the current response first (esc), then switch models."
        );

        return;
      }

      if (
        definition.name === "model" &&
        argument &&
        argument.toLowerCase() !== "all"
      ) {
        await switchModel(argument);
      } else {
        await openModelPicker(
          argument.toLowerCase() === "all"
        );
      }

      return;
    }

    // New conversation
    if (
      definition.name === "new" ||
      definition.name === "clear"
    ) {
      chat.reset();

      setModal(null);
      setInput("");
      setHistory([]);

      chat.addNotice(
        "Started a new conversation."
      );

      return;
    }

    // Sessions
    if (definition.name === "sessions") {
      await openSessions("resume");
      return;
    }

    if (name === "resume") {
      if (argument) {
        await selectSession(argument);
      } else {
        await openSessions("resume");
      }
      return;
    }

    if (definition.name === "delete") {
      if (argument) {
        await chat.deleteSession(argument);
        chat.addNotice("Session deleted.");
      } else {
        await openSessions("delete");
      }
      return;
    }

    if (definition.name === "rename") {
      if (!argument) {
        chat.addError("Usage: /rename <title>");
      } else {
        await chat.renameSession(argument);
        chat.addNotice("Session renamed.");
      }
      return;
    }

    if (definition.name === "fork") {
      await chat.forkSession();
      chat.addNotice("Forked the current session.");
      return;
    }

    // Config
    if (definition.name === "config") {
      chat.addNotice(
        [
          `provider     ${active.provider.name} (${active.id})`,
          `endpoint     ${applyUrlVariables(active.provider).baseUrl}`,
          `model        ${active.model}`,
          `api key      ${apiKeySource}`,
          `config       ${configPath}`,
          `credentials  ${credentialsPath}`
        ].join("\n")
      );

      return;
    }

    // Status
    if (definition.name === "status") {
      chat.addNotice(
        [
          `session      ${chat.messages.length} messages`,
          `tokens       ↑${formatTokens(
            chat.usage.input
          )} ↓${formatTokens(chat.usage.output)}`,
          `state        ${
            chat.pendingApproval
              ? "waiting for approval"
              : chat.toolActivities.length > 0
                ? "running tools"
                : busy
                  ? "streaming"
                  : "ready"
          }`,
          `workspace    ${process.cwd()}`
        ].join("\n")
      );

      return;
    }

    // Tools
    if (definition.name === "tools") {
      chat.addNotice(
        [
          "Agent tools",

          ...chat.tools.map((tool) => {
            const policy =
              tool.approval === "ask"
                ? "ask"
                : "auto";

            const summary = truncate(
              tool.description.replace(/\s+/g, " "),
              72
            );

            return `  ${tool.name.padEnd(
              14
            )} ${policy.padEnd(5)} ${summary}`;
          }),

          "",
          "auto runs immediately · ask requires y/n approval"
        ].join("\n")
      );

      return;
    }

    // Undo
    if (definition.name === "undo") {
      void chat.undo();
      return;
    }

    // About
    if (definition.name === "about") {
      chat.addNotice(
        "euler 0.1.0 · a provider-agnostic coding agent.\n" +
          "Bring your own key. Keys are stored locally with 600 permissions."
      );

      return;
    }
  }

  function submit(value: string): void {
    const trimmed = value.trim();

    if (!trimmed) {
      return;
    }

    setInput("");

    setHistory((current) =>
      [
        trimmed,
        ...current.filter(
          (item) => item !== trimmed
        )
      ].slice(0, 100)
    );

    if (trimmed.startsWith("/")) {
      void handleCommand(trimmed);
      return;
    }

    void chat.send(trimmed);
  }

  const streamingMessage: DisplayMessage | null =
    chat.streaming
      ? {
          id: "streaming",
          role: "assistant",
          content: chat.streaming.content,
          reasoning: chat.streaming.reasoning,
          createdAt: chat.streaming.startedAt,
          model: chat.streaming.model
        }
      : null;

  const modelItems: SelectItem[] =
    modelState?.status === "ready"
      ? [
          ...modelState.models.map((model) => {
            const description = [
              modelState.all ? model.provider : undefined,
              model.contextWindow !== undefined
                ? `${formatTokens(model.contextWindow)} ctx`
                : undefined,
              model.description
            ]
              .filter(Boolean)
              .join(" · ");

            return {
              value:
                modelState.all && model.providerId
                  ? encodeModelValue(
                      model.providerId,
                      model.id
                    )
                  : model.id,
              label: model.name ?? model.id,
              description: description || undefined
            };
          }),

          {
            value: "__scope__",
            label: modelState.all
              ? "Show current provider only"
              : "Browse all providers…",
            description: modelState.all
              ? active.provider.name
              : "fetch models from every configured provider"
          },

          {
            value: "__refresh__",
            label: "Refresh model list…",
            description: "fetch again from the provider"
          }
        ]
      : [];

  const logoutItems: SelectItem[] = Object.keys(credentials)
    .filter((providerId) => credentials[providerId]?.trim())
    .flatMap((providerId) => {
      const provider =
        config.providers[providerId] ??
        makeCatalogProvider(providerId);

      if (!provider) {
        return [];
      }

      return [
        {
          value: providerId,
          label: provider.name,
          description: `${providerId} · ${maskApiKey(
            credentials[providerId]
          )}`
        }
      ];
    });

  const logoutTargetName = logoutTarget
    ? ((config.providers[logoutTarget] ??
        makeCatalogProvider(logoutTarget))?.name ??
      logoutTarget)
    : "";

  const statusHint =
    modal === "help"
      ? "esc close"
      : modal === "models"
        ? modelState?.status === "loading"
          ? "loading models…"
          : modelState?.status === "error"
            ? "r retry · esc close"
            : "↑↓ choose · enter select · esc close"
        : modal === "variants"
          ? "↑↓ choose · enter select · esc close"
          : modal === "key"
            ? "enter save · esc close"
            : modal === "logout"
              ? logoutTarget
                ? "enter confirm · esc back"
                : "↑↓ choose · enter select · esc close"
              : modal === "sessions"
                ? "↑↓ choose · enter select · esc close"
                : undefined;

  return (
    <Box flexDirection="column" width="100%">
      <Static
        key={chat.sessionKey}
        items={chat.messages}
      >
        {(message) => (
          <MessageView
            key={message.id}
            message={message}
            width={width}
          />
        )}
      </Static>

      {streamingMessage ? (
        <MessageView
          key="streaming"
          message={streamingMessage}
          streaming
          width={width}
        />
      ) : null}

      {chat.toolActivities.map((activity) => (
        <ToolCard
          key={activity.callId}
          activity={activity}
          width={width}
          live
        />
      ))}

      {/* Sessions */}
      {modal === "sessions" ? (
        <Box marginBottom={1}>
          <SelectList
            title={
              sessionMode === "resume"
                ? "Sessions"
                : "Delete a session"
            }
            subtitle={`${chat.sessions.length} saved in this workspace · newest first`}
            items={chat.sessions.map((meta) => ({
              value: meta.id,
              label: meta.title,
              description: new Date(
                meta.updatedAt
              ).toLocaleString(),
              badge:
                meta.id === chat.sessionId
                  ? "current"
                  : undefined,
              badgeColor: theme.accent
            }))}
            searchable
            maxVisible={11}
            onSelect={(item) => {
              if (sessionMode === "delete") {
                void (async () => {
                  await chat.deleteSession(item.value);
                  await chat.refreshSessions();
                  setModal(null);
                  chat.addNotice("Session deleted.");
                })();
              } else {
                void selectSession(item.value);
              }
            }}
            onCancel={() => setModal(null)}
            emptyText="No saved sessions yet."
            footer="↑↓ move · enter select · esc close · type to fuzzy find"
          />
        </Box>
      ) : null}

      {/* Help */}
      {modal === "help" ? (
        <Box marginBottom={1}>
          <HelpPanel
            onClose={() => setModal(null)}
          />
        </Box>
      ) : null}

      {/* Model picker */}
      {modal === "models" ? (
        <Box marginBottom={1}>
          {modelState?.status === "loading" ? (
            <SelectList
              title="Choose a model"
              subtitle={
                modelState.all
                  ? "all providers"
                  : active.provider.name
              }
              items={[]}
              loading
              onCancel={() => setModal(null)}
            />
          ) : modelState?.status === "error" ? (
            <SelectList
              title="Choose a model"
              subtitle={
                modelState.all
                  ? "all providers"
                  : active.provider.name
              }
              items={[]}
              error={truncate(
                modelState.error ??
                  "Could not load models.",
                500
              )}
              onRetry={() =>
                void openModelPicker(modelState.all)
              }
              onCancel={() => setModal(null)}
            />
          ) : (
            <SelectList
              title="Choose a model"
              subtitle={
                modelState?.all
                  ? `all providers · ${
                      modelState.models.length
                    } models`
                  : `${active.provider.name} · ${
                      modelState?.models.length ?? 0
                    } available`
              }
              items={modelItems}
              searchable
              maxVisible={11}
              onSelect={(item) => {
                if (item.value === "__refresh__") {
                  void openModelPicker(
                    modelState?.all ?? false,
                    true
                  );
                } else if (item.value === "__scope__") {
                  void openModelPicker(
                    !(modelState?.all ?? false)
                  );
                } else {
                  const decoded = decodeModelValue(
                    item.value
                  );

                  if (decoded) {
                    void switchModel(
                      decoded.modelId,
                      decoded.providerId
                    );
                  } else {
                    void switchModel(item.value);
                  }
                }
              }}
              onCancel={() => setModal(null)}
              emptyText="No matching models."
              footer="↑↓ move · enter select · esc close · type to fuzzy find"
            />
          )}
        </Box>
      ) : null}

      {/* Reasoning selector */}
      {modal === "variants" ? (
        <Box marginBottom={1}>
          <SelectList
            title={
              variantSource
                ? `Reasoning · ${variantSource}`
                : "Reasoning"
            }
            subtitle={
              variantList.length <= 1
                ? `${active.provider.name} · Default only`
                : `${active.provider.name} · ${
                    variantList.length - 1
                  } reasoning options`
            }
            items={variantList}
            searchable
            maxVisible={11}
            onSelect={(item) => {
              void handleVariantSelect(item.value);
            }}
            onCancel={() => setModal(null)}
            emptyText="No reasoning options available."
            footer="↑↓ move · enter select · esc close · type to fuzzy find"
          />
        </Box>
      ) : null}

      {/* API key */}
      {modal === "key" ? (
        <Box marginBottom={1}>
          <TextPrompt
            title={`${active.provider.name} API key`}
            description="Paste a new key. It replaces the saved key for this provider and is stored locally with 600 permissions."
            placeholder="sk-…"
            password
            submitLabel="save key"
            onCancel={() => setModal(null)}
            onSubmit={(key) => {
              void (async () => {
                try {
                  await onSaveKey(key);

                  setModal(null);

                  chat.addNotice(
                    `API key updated for ${active.provider.name}.`
                  );
                } catch (error) {
                  chat.addError(
                    errorMessage(error)
                  );
                }
              })();
            }}
          />
        </Box>
      ) : null}

      {/* Logout / revoke a stored key */}
      {modal === "logout" ? (
        <Box marginBottom={1}>
          {logoutTarget ? (
            <SelectList
              title={`Log out of ${logoutTargetName}`}
              subtitle="deletes the saved key on this machine only"
              items={[
                {
                  value: "confirm",
                  label: "Yes, delete the saved key",
                  description:
                    "revoke at the provider console to invalidate it remotely"
                },
                {
                  value: "back",
                  label: "Cancel",
                  description: "keep the saved key"
                }
              ]}
              onSelect={(item) => {
                const target = logoutTarget;

                if (item.value === "back" || !target) {
                  setLogoutTarget(null);
                  return;
                }

                setLogoutTarget(null);
                setModal(null);

                void (async () => {
                  try {
                    await onLogout(target);
                  } catch (error) {
                    chat.addError(errorMessage(error));
                  }
                })();
              }}
              onCancel={() => setLogoutTarget(null)}
              footer="↑↓ move · enter select · esc back"
            />
          ) : (
            <SelectList
              title="Log out / revoke a key"
              subtitle="providers with a saved key"
              items={logoutItems}
              onSelect={(item) =>
                setLogoutTarget(item.value)
              }
              onCancel={() => setModal(null)}
              emptyText="No saved API keys."
              footer="↑↓ move · enter select · esc close"
            />
          )}
        </Box>
      ) : null}

      {/* Command suggestions */}
      {!modal && suggestions.length > 0 ? (
        <CommandHints
          suggestions={suggestions}
        />
      ) : null}

      {/* Approval */}
      {chat.pendingApproval ? (
        <ApprovalPanel
          approval={chat.pendingApproval}
          width={width}
          onResolve={chat.resolveApproval}
        />
      ) : null}

      {/* Input */}
      {!modal ? (
        <PromptInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          onCancel={() => {
            if (busy) {
              chat.cancel();
            }
          }}
          disabled={busy}
          disabledLabel={
            chat.pendingApproval
              ? "Waiting for approval… (y approve · n deny)"
              : chat.toolActivities.length > 0
                ? "Running tools… (esc to cancel)"
                : "Generating response… (esc to cancel)"
          }
          history={history}
          completions={completions}
        />
      ) : null}

      {/* Status bar */}
      <StatusBar
        active={active}
        streaming={chat.streaming}
        usage={chat.usage}
        hint={statusHint}
        busy={chat.busy}
        toolActivities={chat.toolActivities}
        pendingApproval={chat.pendingApproval}
        variant={variant}
      />
    </Box>
  );
}
