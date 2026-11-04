import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { theme } from "../theme";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function useSpinner(active: boolean, interval = 80): string {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) {
      setFrame(0);
      return;
    }

    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
    }, interval);

    return () => clearInterval(timer);
  }, [active, interval]);

  return FRAMES[frame] ?? FRAMES[0];
}

export function Spinner({
  label,
  color = theme.accent
}: {
  label?: string;
  color?: string;
}) {
  const frame = useSpinner(true);

  return (
    <Box>
      <Text color={color}>{frame}</Text>
      {label ? <Text dimColor> {label}</Text> : null}
    </Box>
  );
}
