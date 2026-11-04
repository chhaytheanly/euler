import { randomUUID } from "node:crypto";
import { useRef, useState } from "react";
import {
  ActiveProvider,
  ChatMessage,
  ToolCall,
  ToolDefinition
} from "../interfaces/type";
import { buildSystemPrompt } from "../agent/systemPrompt";
import { createProviderAdapter } from "../providers/registry";
import {
  TOOL_SPECS,
  executeToolCall,
  findTool,
  previewToolCall,
  summarizeToolCall
} from "../tools";
import { undoLastBackup } from "../tools/journal";
import { WORKSPACE_ROOT } from "../tools/workspace";
import {
  errorMessage,
  estimateTokens,
  isAbortError
} from "./utils";

export const MAX_AGENT_ITERATIONS = 8;

export type DisplayRole =
  | "user"
  | "assistant"
  | "system"
  | "error"
  | "tool";

export type ToolActivityStatus =
  | "running"
  | "waiting"
  | "success"
  | "error"
  | "denied"
  | "cancelled";

export interface ToolActivity {
  callId: string;
  name: string;
  arguments: string;
  summary: string;
  status: ToolActivityStatus;
  output?: string;
  startedAt: number;
  finishedAt?: number;
  elapsedMs?: number;
}

export interface DisplayMessage {
  id: string;
  role: DisplayRole;
  content: string;
  reasoning?: string;
  createdAt: number;
  model?: string;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimated?: boolean;
  cancelled?: boolean;
  tool?: ToolActivity;
}

export interface StreamState {
  content: string;
  reasoning: string;
  startedAt: number;
  model: string;
}

export interface TokenUsage {
  input: number;
  output: number;
}

export interface PendingApproval {
  callId: string;
  name: string;
  summary: string;
  arguments: string;
  preview: string;
}

export interface ChatController {
  messages: DisplayMessage[];
  streaming: StreamState | null;
  usage: TokenUsage;
  sessionKey: number;
  busy: boolean;
  toolActivities: ToolActivity[];
  pendingApproval: PendingApproval | null;
  tools: ToolDefinition[];
  send: (text: string) => Promise<void>;
  cancel: () => void;
  reset: () => void;
  addNotice: (content: string) => void;
  addError: (content: string) => void;
  resolveApproval: (approved: boolean) => void;
  undo: () => Promise<void>;
}

interface AssistantTurn {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  inputTokens?: number;
  outputTokens?: number;
  estimatedInput: number;
  elapsedMs: number;
  cancelled: boolean;
  failure?: unknown;
}

interface ToolRunResult {
  content: string;
  toolError: boolean;
  cancelled: boolean;
}

export function useChat(
  active: ActiveProvider | null
): ChatController {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState<StreamState | null>(
    null
  );
  const [usage, setUsage] = useState<TokenUsage>({
    input: 0,
    output: 0
  });
  const [sessionKey, setSessionKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toolActivities, setToolActivities] = useState<
    ToolActivity[]
  >([]);
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);

  const conversationRef = useRef<ChatMessage[]>([]);
  const streamRef = useRef<StreamState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const runIdRef = useRef(0);
  const approvalRef = useRef<
    ((approved: boolean) => void) | null
  >(null);
  const toolActivitiesRef = useRef<ToolActivity[]>([]);

  function updateStream(
    update: (current: StreamState) => StreamState
  ): void {
    const current = streamRef.current;

    if (!current) {
      return;
    }

    const next = update(current);
    streamRef.current = next;
    setStreaming(next);
  }

  function setActivities(
    update: (current: ToolActivity[]) => ToolActivity[]
  ): void {
    const next = update(toolActivitiesRef.current);
    toolActivitiesRef.current = next;
    setToolActivities(next);
  }

  function updateActivity(
    callId: string,
    update: (current: ToolActivity) => ToolActivity
  ): void {
    setActivities((current) =>
      current.map((activity) =>
        activity.callId === callId
          ? update(activity)
          : activity
      )
    );
  }

  function addNotice(content: string): void {
    setMessages((current) => [
      ...current,
      {
        id: randomUUID(),
        role: "system",
        content,
        createdAt: Date.now()
      }
    ]);
  }

  function addError(content: string): void {
    setMessages((current) => [
      ...current,
      {
        id: randomUUID(),
        role: "error",
        content,
        createdAt: Date.now()
      }
    ]);
  }

  function resolveApproval(approved: boolean): void {
    const resolve = approvalRef.current;
    approvalRef.current = null;
    setPendingApproval(null);
    resolve?.(approved);
  }

  function requestMessages(): ChatMessage[] {
    return [
      {
        role: "system",
        content: buildSystemPrompt()
      },
      ...conversationRef.current
    ];
  }

  async function streamAssistant(
    adapter: ReturnType<typeof createProviderAdapter>,
    provider: ActiveProvider,
    signal: AbortSignal,
    runId: number
  ): Promise<AssistantTurn> {
    const startedAt = Date.now();
    const initialStream: StreamState = {
      content: "",
      reasoning: "",
      startedAt,
      model: provider.model
    };
    const request = requestMessages();
    const estimatedInput = estimateTokens(
      request.map((message) => message.content).join("\n")
    );

    streamRef.current = initialStream;
    setStreaming(initialStream);

    let content = "";
    let reasoning = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let cancelled = false;
    let failure: unknown;
    const toolCalls: ToolCall[] = [];
    const seenCalls = new Set<string>();

    try {
      for await (const event of adapter.streamChat(request, {
        model: provider.model,
        signal,
        tools: TOOL_SPECS
      })) {
        if (runId !== runIdRef.current) {
          break;
        }

        if (event.type === "text") {
          content += event.text;
          updateStream((current) => ({
            ...current,
            content
          }));
        } else if (event.type === "reasoning") {
          reasoning += event.text;
          updateStream((current) => ({
            ...current,
            reasoning
          }));
        } else if (event.type === "usage") {
          inputTokens = event.inputTokens ?? inputTokens;
          outputTokens = event.outputTokens ?? outputTokens;
        } else if (event.type === "tool_call") {
          const key = `${event.id}:${event.name}`;

          if (!seenCalls.has(key)) {
            seenCalls.add(key);
            toolCalls.push({
              id: event.id,
              name: event.name,
              arguments: event.arguments
            });
          }
        }
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        cancelled = true;
      } else {
        failure = error;
      }
    }

    return {
      content,
      reasoning,
      toolCalls,
      inputTokens,
      outputTokens,
      estimatedInput,
      elapsedMs: Date.now() - startedAt,
      cancelled,
      failure
    };
  }

  function finalizeAssistant(
    turn: AssistantTurn,
    provider: ActiveProvider,
    runId: number
  ): void {
    if (runId !== runIdRef.current) {
      return;
    }

    const estimatedInput =
      turn.inputTokens ?? turn.estimatedInput;
    const estimatedOutput =
      turn.outputTokens ?? estimateTokens(turn.content);

    setUsage((current) => ({
      input: current.input + estimatedInput,
      output: current.output + estimatedOutput
    }));

    if (turn.content || turn.reasoning || turn.cancelled) {
      setMessages((current) => [
        ...current,
        {
          id: randomUUID(),
          role: "assistant",
          content: turn.content,
          reasoning: turn.reasoning || undefined,
          createdAt: Date.now(),
          model: provider.model,
          elapsedMs: turn.elapsedMs,
          inputTokens: estimatedInput,
          outputTokens: estimatedOutput,
          estimated:
            turn.inputTokens === undefined ||
            turn.outputTokens === undefined,
          cancelled: turn.cancelled
        }
      ]);
    }

    streamRef.current = null;
    setStreaming(null);
  }

  function finishTool(
    activity: ToolActivity,
    status: ToolActivityStatus,
    output: string,
    runId: number
  ): void {
    if (runId !== runIdRef.current) {
      return;
    }

    const finishedAt = Date.now();
    const finalActivity: ToolActivity = {
      ...activity,
      status,
      output,
      finishedAt,
      elapsedMs: finishedAt - activity.startedAt
    };

    updateActivity(activity.callId, () => finalActivity);

    setMessages((current) => [
      ...current,
      {
        id: randomUUID(),
        role: "tool",
        content: output,
        createdAt: finishedAt,
        tool: finalActivity
      }
    ]);

    setActivities((current) =>
      current.filter(
        (item) => item.callId !== activity.callId
      )
    );
  }

  async function runToolCall(
    call: ToolCall,
    runId: number,
    signal: AbortSignal
  ): Promise<ToolRunResult> {
    const startedAt = Date.now();
    const summary = summarizeToolCall(call);
    const activity: ToolActivity = {
      callId: call.id,
      name: call.name,
      arguments: call.arguments,
      summary,
      status: "running",
      startedAt
    };

    if (runId !== runIdRef.current) {
      return {
        content: "Cancelled by the user.",
        toolError: true,
        cancelled: true
      };
    }

    setActivities((current) => [...current, activity]);

    const implementation = findTool(call.name);

    if (!implementation) {
      const content = `Unknown tool "${call.name}".`;
      finishTool(activity, "error", content, runId);

      return {
        content,
        toolError: true,
        cancelled: false
      };
    }

    if (implementation.approval === "ask") {
      updateActivity(call.id, (current) => ({
        ...current,
        status: "waiting"
      }));

      const preview = await previewToolCall(call).catch(() =>
        summarizeToolCall(call)
      );

      if (runId !== runIdRef.current) {
        return {
          content: "Cancelled by the user.",
          toolError: true,
          cancelled: true
        };
      }

      if (signal.aborted) {
        const content = "Cancelled by the user.";
        finishTool(activity, "cancelled", content, runId);

        return {
          content,
          toolError: true,
          cancelled: true
        };
      }

      const approved = await new Promise<boolean>((resolve) => {
        approvalRef.current = resolve;
        setPendingApproval({
          callId: call.id,
          name: call.name,
          summary,
          arguments: call.arguments,
          preview
        });
      });

      if (!approved) {
        const aborted = signal.aborted;
        const content = aborted
          ? "Cancelled by the user."
          : `The user denied permission to run ${call.name}.`;
        finishTool(
          activity,
          aborted ? "cancelled" : "denied",
          content,
          runId
        );

        return {
          content,
          toolError: true,
          cancelled: aborted
        };
      }

      updateActivity(call.id, (current) => ({
        ...current,
        status: "running"
      }));
    }

    if (signal.aborted || runId !== runIdRef.current) {
      const content = "Cancelled by the user.";
      finishTool(activity, "cancelled", content, runId);

      return {
        content,
        toolError: true,
        cancelled: true
      };
    }

    const execution = await executeToolCall(call, {
      root: WORKSPACE_ROOT,
      signal
    });

    if (runId !== runIdRef.current) {
      return {
        content: execution.content,
        toolError: !execution.ok,
        cancelled: true
      };
    }

    const status: ToolActivityStatus = execution.cancelled
      ? "cancelled"
      : execution.ok
        ? "success"
        : "error";

    finishTool(activity, status, execution.content, runId);

    return {
      content: execution.content,
      toolError: !execution.ok,
      cancelled: Boolean(execution.cancelled)
    };
  }

  async function send(text: string): Promise<void> {
    const trimmed = text.trim();

    if (!trimmed || !active || busyRef.current) {
      return;
    }

    const provider = active;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    busyRef.current = true;
    setBusy(true);
    toolActivitiesRef.current = [];
    setToolActivities([]);
    setPendingApproval(null);
    approvalRef.current = null;

    const now = Date.now();

    setMessages((current) => [
      ...current,
      {
        id: randomUUID(),
        role: "user",
        content: trimmed,
        createdAt: now
      }
    ]);

    conversationRef.current = [
      ...conversationRef.current,
      { role: "user", content: trimmed }
    ];

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const adapter = createProviderAdapter(
        provider.id,
        provider.provider,
        provider.apiKey
      );

      for (
        let iteration = 0;
        iteration < MAX_AGENT_ITERATIONS;
        iteration += 1
      ) {
        if (runId !== runIdRef.current) {
          return;
        }

        const turn = await streamAssistant(
          adapter,
          provider,
          controller.signal,
          runId
        );

        if (runId !== runIdRef.current) {
          return;
        }

        finalizeAssistant(turn, provider, runId);

        if (turn.failure) {
          addError(errorMessage(turn.failure));
          break;
        }

        if (turn.cancelled || controller.signal.aborted) {
          break;
        }

        if (turn.toolCalls.length === 0) {
          if (!turn.content && !turn.reasoning) {
            addNotice("The model returned an empty response.");
          }
          break;
        }

        conversationRef.current.push({
          role: "assistant",
          content: turn.content,
          toolCalls: turn.toolCalls
        });

        let cancelled = false;

        for (const call of turn.toolCalls) {
          if (runId !== runIdRef.current) {
            return;
          }

          if (controller.signal.aborted) {
            conversationRef.current.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content: "Cancelled by the user.",
              toolError: true
            });
            cancelled = true;
            continue;
          }

          const result = await runToolCall(
            call,
            runId,
            controller.signal
          );

          if (runId !== runIdRef.current) {
            return;
          }

          conversationRef.current.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: result.content,
            ...(result.toolError ? { toolError: true } : {})
          });

          if (result.cancelled) {
            cancelled = true;
          }
        }

        if (cancelled) {
          break;
        }

        if (iteration === MAX_AGENT_ITERATIONS - 1) {
          addNotice(
            `Stopped after ${MAX_AGENT_ITERATIONS} agent iterations. Ask me to continue when you are ready.`
          );
        }
      }
    } catch (error) {
      if (
        runId === runIdRef.current &&
        !isAbortError(error)
      ) {
        addError(errorMessage(error));
      }
    } finally {
      if (runId === runIdRef.current) {
        busyRef.current = false;
        setBusy(false);
        streamRef.current = null;
        setStreaming(null);
        abortRef.current = null;
        toolActivitiesRef.current = [];
        setToolActivities([]);
        setPendingApproval(null);
        approvalRef.current = null;
      }
    }
  }

  function cancel(): void {
    resolveApproval(false);
    abortRef.current?.abort();
  }

  function reset(): void {
    runIdRef.current += 1;
    resolveApproval(false);
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    conversationRef.current = [];
    streamRef.current = null;
    toolActivitiesRef.current = [];
    approvalRef.current = null;
    setStreaming(null);
    setBusy(false);
    setMessages([]);
    setUsage({ input: 0, output: 0 });
    setToolActivities([]);
    setPendingApproval(null);
    setSessionKey((current) => current + 1);
  }

  async function undo(): Promise<void> {
    if (busyRef.current) {
      addError(
        "Cancel the current agent run before undoing a file change."
      );
      return;
    }

    try {
      const result = await undoLastBackup();

      addNotice(
        result ??
          "Nothing to undo. Only writes and edits made in this session can be undone."
      );
    } catch (error) {
      addError(errorMessage(error));
    }
  }

  return {
    messages,
    streaming,
    usage,
    sessionKey,
    busy,
    toolActivities,
    pendingApproval,
    tools: TOOL_SPECS,
    send,
    cancel,
    reset,
    addNotice,
    addError,
    resolveApproval,
    undo
  };
}
