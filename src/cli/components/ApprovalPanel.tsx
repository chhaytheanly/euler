import { Box, Text, useInput } from "ink";
import { theme } from "../theme";
import type { PendingApproval } from "../useChat";
import { truncate, truncateLines } from "../utils";

function previewColor(line: string): string | undefined {
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

export function ApprovalPanel({
  approval,
  width = 80,
  onResolve
}: {
  approval: PendingApproval;
  width?: number;
  onResolve: (approved: boolean) => void;
}) {
  useInput((input, key) => {
    if (key.escape) {
      onResolve(false);
      return;
    }

    if (input.toLowerCase() === "y") {
      onResolve(true);
      return;
    }

    if (input.toLowerCase() === "n") {
      onResolve(false);
      return;
    }

    if (key.return) {
      onResolve(true);
    }
  });

  const maximum = Math.max(20, width - 6);
  const preview = approval.preview
    ? truncateLines(approval.preview, 28)
    : approval.summary;
  const lines = preview.split("\n");

  return (
    <Box
      borderStyle="round"
      borderColor={theme.warn}
      paddingX={1}
      marginBottom={1}
      width={width}
      flexDirection="column"
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.warn}>
          ⚠ approval required
        </Text>
        <Text dimColor>{approval.name}</Text>
      </Box>

      <Box marginTop={0}>
        <Text wrap="truncate">{truncate(approval.summary, maximum)}</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {lines.map((line, index) => (
          <Text
            key={`${approval.callId}-${index}`}
            color={previewColor(line)}
            dimColor={!previewColor(line)}
            wrap="truncate"
          >
            {truncate(line, maximum) || " "}
          </Text>
        ))}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          y approve · n deny · esc deny
        </Text>
      </Box>
    </Box>
  );
}
