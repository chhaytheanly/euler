import { Box, Static, Text, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  ActiveProvider,
  ModelInfo
} from "../../interfaces/type";
import { createProviderAdapter } from "../../providers/registry";
import { isReasoningEffort } from "../../providers/model-capabilities";
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
import { SelectList, SelectItem } from "./SelectList";
import { StatusBar } from "./StatusBar";
import { TextPrompt } from "./TextPrompt";
import { ToolCard } from "./ToolCard";

type Modal =
  | "help"
  | "models"
  | "key"
  | "variants"
  | null;

interface ModelState {
  status: "loading" | "ready" | "error";
  models: ModelInfo[];
  error?: string;
}

interface ChatScreenProps {
  active: ActiveProvider;
  chat: ChatController;
  configPath: string;
  credentialsPath: string;
  apiKeySource: "stored" | "environment" | "none";
  variant?: string;
  onSwitchProvider: () => void;
  onSaveKey: (key: string) => Promise<void> | void;
  onSelectModel: (
    model: string
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
  configPath,
  credentialsPath,
  apiKeySource,
  variant,
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
    // The welcome notice is only for the first mount of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const busy = chat.busy;
  const suggestions =
    modal === null ? suggestCommands(input) : [];
  const completions = suggestions.map(
    (command) => `/${command.name}`
  );

  async function openModelPicker(): Promise<void> {
    setModal("models");
    setModelState({ status: "loading", models: [] });

    const attempt = modelAttempt.current + 1;
    modelAttempt.current = attempt;

    try {
      const adapter = createProviderAdapter(
        active.id,
        active.provider,
        active.apiKey
      );
      const models = await adapter.listModels();

      if (attempt !== modelAttempt.current) {
        return;
      }

      setModelState({
        status: "ready",
        models
      });
    } catch (error) {
      if (attempt !== modelAttempt.current) {
        return;
      }

      setModelState({
        status: "error",
        models: [],
        error: errorMessage(error)
      });
    }
  }

  async function switchModel(model: string): Promise<void> {
    try {
      await onSelectModel(model);
      setModal(null);
      chat.addNotice(`Model switched to ${model}.`);

      const target = modelState?.models.find(
        (candidate) => candidate.id === model
      );

      setVariantSource(model);
      setVariantList(
        target?.variants?.map((variant) => ({
          value: variant.id,
          label: variant.name,
          description: variant.description
        })) ?? []
      );

      if ((target?.variants?.length ?? 0) > 0) {
        setModal("variants");
      } else {
        setModal(null);
        chat.addNotice(
          `${model} does not expose reasoning variants.`
        );
      }
    } catch (error) {
      chat.addError(errorMessage(error));
    }
  }

  async function openVariantPicker(
    modelId: string
  ): Promise<void> {
    setModal("variants");
    setVariantSource(modelId);

    try {
      const adapter = createProviderAdapter(
        active.id,
        active.provider,
        active.apiKey
      );
      const models = await adapter.listModels();
      const target = models.find(
        (candidate) => candidate.id === modelId
      );

      setVariantList(
        target?.variants?.map((variant) => ({
          value: variant.id,
          label: variant.name,
          description: variant.description
        })) ?? []
      );
    } catch {
      setVariantList([]);
    }
  }

  async function handleVariantSelect(
    variantId: string
  ): Promise<void> {
    const selected = variantList.find(
      (item) => item.value === variantId
    );

    await onSelectVariant?.(variantId);
    setModal(null);
    chat.addNotice(
      selected
        ? `Reasoning for ${active.model} set to ${selected.label}.`
        : `Reasoning for ${active.model} disabled.`
    );
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

    if (definition.name === "quit") {
      onExit();
      return;
    }

    if (definition.name === "help") {
      setModal("help");
      return;
    }

    if (definition.name === "reasoning") {
      if (busy) {
        chat.addError(
          "Cancel the current response first (esc), then update reasoning."
        );
        return;
      }

      const effort = argument.trim().toLowerCase();

      if (effort) {
        const known =
          variantList.some((item) => item.value === effort) ||
          isReasoningEffort(effort);

        if (!known) {
          chat.addError(
            `Unknown reasoning effort "${effort}".`
          );
          return;
        }

        setModal(null);
        await onSelectVariant?.(effort);
        chat.addNotice(`Reasoning set to ${effort}.`);
        return;
      }

      void openVariantPicker(active.model);
      return;
    }

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

      if (definition.name === "model" && argument) {
        void switchModel(argument);
      } else {
        void openModelPicker();
      }
      return;
    }

    if (
      definition.name === "new" ||
      definition.name === "clear"
    ) {
      chat.reset();
      setModal(null);
      setInput("");
      setHistory([]);
      chat.addNotice("Started a new conversation.");
      return;
    }

    if (definition.name === "config") {
      chat.addNotice(
        [
          `provider     ${active.provider.name} (${active.id})`,
          `endpoint     ${active.provider.baseUrl}`,
          `model        ${active.model}`,
          `api key      ${apiKeySource}`,
          `config       ${configPath}`,
          `credentials  ${credentialsPath}`
        ].join("\n")
      );
      return;
    }

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

    if (definition.name === "tools") {
      chat.addNotice(
        [
          "Agent tools",
          ...chat.tools.map((tool) => {
            const policy =
              tool.approval === "ask" ? "ask" : "auto";
            const summary = truncate(
              tool.description.replace(/\s+/g, " "),
              72
            );

            return `  ${tool.name.padEnd(14)} ${policy.padEnd(
              5
            )} ${summary}`;
          }),
          "",
          "auto runs immediately · ask requires y/n approval"
        ].join("\n")
      );
      return;
    }

    if (definition.name === "undo") {
      void chat.undo();
      return;
    }

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
    setHistory((current) => [
      trimmed,
      ...current.filter((item) => item !== trimmed)
    ].slice(0, 100));

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
          ...modelState.models.map((model) => ({
            value: model.id,
            label: model.name ?? model.id,
            description:
              model.contextWindow !== undefined
                ? `${formatTokens(model.contextWindow)} ctx`
                : model.description
          })),
          {
            value: "__refresh__",
            label: "Refresh model list…",
            description: "fetch again from the provider"
          }
        ]
      : [];

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
            : undefined;

  return (
    <Box flexDirection="column" width="100%">
      <Static key={chat.sessionKey} items={chat.messages}>
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

      {modal === "help" ? (
        <Box marginBottom={1}>
          <HelpPanel onClose={() => setModal(null)} />
        </Box>
      ) : null}

      {modal === "models" ? (
        <Box marginBottom={1}>
          {modelState?.status === "loading" ? (
            <SelectList
              title="Choose a model"
              subtitle={active.provider.name}
              items={[]}
              loading
              onCancel={() => setModal(null)}
            />
          ) : modelState?.status === "error" ? (
            <SelectList
              title="Choose a model"
              subtitle={active.provider.name}
              items={[]}
              error={truncate(
                modelState.error ?? "Could not load models.",
                500
              )}
              onRetry={() => void openModelPicker()}
              onCancel={() => setModal(null)}
            />
          ) : (
            <SelectList
              title="Choose a model"
              subtitle={`${active.provider.name} · ${
                modelState?.models.length ?? 0
              } available`}
              items={modelItems}
              searchable
              maxVisible={11}
              onSelect={(item) => {
                if (item.value === "__refresh__") {
                  void openModelPicker();
                } else {
                  void switchModel(item.value);
                }
              }}
              onCancel={() => setModal(null)}
              emptyText="No matching models."
              footer="↑↓ move · enter select · esc close · type to search"
            />
          )}
        </Box>
      ) : null}

      {modal === "variants" ? (
        <Box marginBottom={1}>
          <SelectList
            title={
              variantSource
                ? `Reasoning · ${variantSource}`
                : "Reasoning"
            }
            subtitle={active.provider.name}
            items={variantList}
            searchable
            maxVisible={11}
            onSelect={(item) => {
              void handleVariantSelect(item.value);
            }}
            onCancel={() => setModal(null)}
            emptyText="No reasoning variants available for this model."
            footer="↑↓ move · enter select · esc close · type to search"
          />
        </Box>
      ) : null}

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
                  chat.addError(errorMessage(error));
                }
              })();
            }}
          />
        </Box>
      ) : null}

      {!modal && suggestions.length > 0 ? (
        <CommandHints suggestions={suggestions} />
      ) : null}

      {chat.pendingApproval ? (
        <ApprovalPanel
          approval={chat.pendingApproval}
          width={width}
          onResolve={chat.resolveApproval}
        />
      ) : null}

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
