import { Box, Text } from "ink";
import { theme } from "../theme";
import type { ToolActivity } from "../useChat";
import {
  formatDuration,
  truncate,
  truncateLines
} from "../utils";
import { useSpinner } from "./Spinner";

const STATUS: Record<
  ToolActivity["status"],
  { label: string; color: string }
> = {
  running: { label: "running", color: theme.accent },
  waiting: { label: "awaiting approval", color: theme.warn },
  success: { label: "done", color: theme.success },
  error: { label: "failed", color: theme.error },
  denied: { label: "denied", color: theme.error },
  cancelled: { label: "cancelled", color: theme.dim }
};

function outputColor(line: string): string | undefined {
  if (line.startsWith("@@")) {
    return theme.accent;
  }

  if (line.startsWith("+")) {
    return theme.success;
  }

  if (line.startsWith("-")) {
    return theme.error;
  }

  return undefined;
}

export function ToolCard({
  activity,
  width = 80,
  live = false
}: {
  activity: ToolActivity;
  width?: number;
  live?: boolean;
}) {
  const active =
    activity.status === "running" ||
    activity.status === "waiting";
  const frame = useSpinner(active && live, 90);
  const status = STATUS[activity.status];
  const output = activity.output
    ? truncateLines(activity.output, 12)
    : "";
  const outputLines = output ? output.split("\n") : [];
  const maximum = Math.max(20, width - 6);
  const meta =
    activity.elapsedMs !== undefined
      ? `${status.label} · ${formatDuration(activity.elapsedMs)}`
      : status.label;

  return (
    <Box
      borderStyle="round"
      borderColor={status.color}
      paddingX={1}
      marginBottom={1}
      width={width}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Box>
          {active && live ? (
            <Text color={status.color}>{frame} </Text>
          ) : (
            <Text color={status.color}>⚙ </Text>
          )}
          <Text bold color={status.color}>
            {activity.name}
          </Text>
          <Text dimColor> {truncate(activity.summary, maximum)}</Text>
        </Box>
        <Text color={status.color}>{meta}</Text>
      </Box>

      {outputLines.length > 0 ? (
        <Box flexDirection="column" marginTop={0}>
          {outputLines.map((line, index) => (
            <Text
              key={`${activity.callId}-${index}`}
              color={outputColor(line)}
              dimColor={!outputColor(line)}
              wrap="truncate"
            >
              {truncate(line, maximum) || " "}
            </Text>
          ))}
        </Box>
      ) : (
        <Text dimColor>
          {activity.status === "waiting"
            ? "waiting for approval…"
            : active
              ? "running…"
              : "(no output)"}
        </Text>
      )}
    </Box>
  );
}
