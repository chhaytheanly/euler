import { Box, Text } from "ink";
import { theme } from "../theme";
import { Spinner } from "./Spinner";

export function BootScreen() {
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text bold color={theme.accent}>
          euler
        </Text>
        <Text dimColor> · provider-agnostic AI terminal</Text>
      </Box>

      <Box marginTop={1}>
        <Spinner label="Loading configuration…" />
      </Box>
    </Box>
  );
}
