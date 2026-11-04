import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { ActiveProvider } from "../../interfaces/type";
import { theme } from "../theme";
import type {
  PendingApproval,
  StreamState,
  TokenUsage,
  ToolActivity
} from "../useChat";
import {
  estimateTokens,
  formatDuration,
  formatTokens
} from "../utils";
import { useSpinner } from "./Spinner";

export function StatusBar({
  active,
  streaming,
  usage,
  hint,
  busy,
  toolActivities,
  pendingApproval
}: {
  active: ActiveProvider;
  streaming: StreamState | null;
  usage: TokenUsage;
  hint?: string;
  busy: boolean;
  toolActivities: ToolActivity[];
  pendingApproval: PendingApproval | null;
}) {
  const [now, setNow] = useState(Date.now());
  const activeTool =
    toolActivities[toolActivities.length - 1] ?? null;
  const working =
    busy ||
    streaming !== null ||
    activeTool !== null ||
    pendingApproval !== null;
  const frame = useSpinner(working, 90);

  useEffect(() => {
    if (!working) {
      return;
    }

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 100);

    return () => clearInterval(timer);
  }, [working]);

  const elapsed = streaming
    ? formatDuration(now - streaming.startedAt)
    : activeTool
      ? formatDuration(now - activeTool.startedAt)
      : null;
  const liveTokens = streaming
    ? estimateTokens(streaming.content)
    : 0;

  return (
    <Box
      width="100%"
      paddingX={1}
      justifyContent="space-between"
    >
      <Box flexGrow={1}>
        <Text color={working ? theme.warn : theme.success}>
          ●
        </Text>
        <Text wrap="truncate">
          {" "}
          {active.provider.name}
          <Text dimColor> / </Text>
          {active.model}
        </Text>
      </Box>

      <Box>
        {pendingApproval ? (
          <Text color={theme.warn}>⚠ approval needed</Text>
        ) : streaming ? (
          <Text>
            <Text color={theme.warn}>{frame}</Text>
            <Text dimColor>
              {" "}
              {elapsed}
              {liveTokens > 0
                ? ` · ↓${formatTokens(liveTokens)}~`
                : ""}
            </Text>
          </Text>
        ) : activeTool ? (
          <Text>
            <Text color={theme.warn}>{frame}</Text>
            <Text dimColor>
              {" "}
              tool {activeTool.name}
              {elapsed ? ` · ${elapsed}` : ""}
            </Text>
          </Text>
        ) : hint ? (
          <Text dimColor>{hint}</Text>
        ) : (
          <Text dimColor>
            ↑{formatTokens(usage.input)} ↓
            {formatTokens(usage.output)}
          </Text>
        )}
      </Box>
    </Box>
  );
}
