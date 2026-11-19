import { Box, Text } from "ink";
import { theme } from "../theme";
import type { DisplayMessage } from "../useChat";
import {
    formatDuration,
    formatTokens,
    timeLabel,
    truncateLines
} from "../utils";
import { Markdown } from "./Markdown";
import { Spinner } from "./Spinner";
import { ToolCard } from "./ToolCard";

function Header({
  label,
  color,
  message,
  right,
  width
}: {
  label: string;
  color: string;
  message: DisplayMessage;
  right?: string;
  width: number;
}) {
  return (
    <Box paddingX={1} justifyContent="space-between" width={width}>
      <Box>
        <Text bold color={color}>
          {label}
        </Text>
        <Text dimColor> {timeLabel(message.createdAt)}</Text>
      </Box>
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  );
}

function AssistantMeta({
  message,
  streaming
}: {
  message: DisplayMessage;
  streaming: boolean;
}) {
  const pieces: string[] = [];

  if (message.model) {
    pieces.push(message.model);
  }

  if (streaming) {
    pieces.push("streaming");
  } else {
    if (message.elapsedMs !== undefined) {
      pieces.push(formatDuration(message.elapsedMs));
    }

    if (message.outputTokens !== undefined) {
      pieces.push(
        `↑${formatTokens(message.inputTokens ?? 0)} ↓${formatTokens(
          message.outputTokens
        )}${message.estimated ? "~" : ""}`
      );
    }

    if (message.cancelled) {
      pieces.push("cancelled");
    }
  }

  return pieces.join(" · ");
}

export function MessageView({
  message,
  streaming = false,
  width = 80
}: {
  message: DisplayMessage;
  streaming?: boolean;
  width?: number;
}) {
  if (message.role === "system") {
    return (
      <Box
        flexDirection="column"
        paddingX={1}
        marginBottom={0}
        width={width}
      >
        {message.content.split("\n").map((line, index) => (
          <Box key={`${message.id}-${index}`}>
            <Text color={theme.dim}>│ </Text>
            <Box flexGrow={1}>
              <Text dimColor wrap="wrap">
                {line || " "}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    );
  }

  if (message.role === "tool") {
    if (message.tool) {
      return (
        <Box width={width} flexDirection="column">
          <ToolCard activity={message.tool} width={width} />
        </Box>
      );
    }

    return (
      <Box
        flexDirection="column"
        paddingX={1}
        marginBottom={1}
        width={width}
      >
        <Text dimColor wrap="wrap">
          ⚙ {message.content}
        </Text>
      </Box>
    );
  }

  if (message.role === "error") {
    return (
      <Box
        flexDirection="column"
        width={width}
        marginBottom={1}
      >
        <Header
          label="! error"
          color={theme.error}
          message={message}
          width={width}
        />
        <Box
          borderStyle="round"
          borderColor={theme.error}
          paddingX={1}
          width={width}
        >
          <Text color={theme.error} wrap="wrap">
            {message.content}
          </Text>
        </Box>
      </Box>
    );
  }

  if (message.role === "user") {
    return (
      <Box
        flexDirection="column"
        width={width}
        marginBottom={1}
      >
        <Header
          label="› you"
          color={theme.user}
          message={message}
          width={width}
        />
        <Box
          borderStyle="round"
          borderColor={theme.user}
          paddingX={1}
          width={width}
        >
          <Text wrap="wrap">{message.content}</Text>
        </Box>
      </Box>
    );
  }

  const meta = AssistantMeta({ message, streaming });
  const reasoning = message.reasoning
    ? truncateLines(message.reasoning, 12)
    : "";

  return (
    <Box
      flexDirection="column"
      width={width}
      marginBottom={1}
    >
      <Header
        label="  Euler"
        color={theme.assistant}
        message={message}
        right={meta}
        width={width}
      />
      <Box
        borderStyle="round"
        borderColor={theme.assistant}
        paddingX={1}
        paddingY={0}
        width={width}
        flexDirection="column"
      >
        {reasoning ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor italic>
              thinking
            </Text>
            <Text dimColor wrap="wrap">
              {reasoning}
            </Text>
          </Box>
        ) : null}

        {message.content ? (
          <Markdown
            text={
              streaming
                ? `${message.content}▌`
                : message.content
            }
          />
        ) : streaming ? (
          <Spinner label="thinking…" color={theme.assistant} />
        ) : (
          <Text dimColor>(no text response)</Text>
        )}
      </Box>
      {message.cancelled ? (
        <Box paddingX={1}>
          <Text color={theme.warn} dimColor>
            response cancelled
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
