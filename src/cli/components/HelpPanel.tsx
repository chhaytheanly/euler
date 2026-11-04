import { Box, Text, useInput } from "ink";
import { COMMANDS } from "../commands";
import { theme } from "../theme";

export function HelpPanel({
  onClose
}: {
  onClose: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || key.return || input === "\r") {
      onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.accent}>
          Commands
        </Text>
        <Text dimColor>esc close</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {COMMANDS.map((command) => (
          <Box key={command.name} width="100%">
            <Box width={22}>
              <Text color={theme.accent}>
                /{command.usage?.replace(/^\//, "") ?? command.name}
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor wrap="wrap">
                {command.description}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>Keyboard</Text>
        <Text dimColor>
          enter send · ctrl+j newline · esc clear/cancel
        </Text>
        <Text dimColor>
          ↑ history · ctrl+w delete word · ctrl+c exit
        </Text>
        <Text dimColor>
          tab complete a command · / opens commands
        </Text>
      </Box>
    </Box>
  );
}
