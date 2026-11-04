import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { theme } from "../theme";
import { maskSecret } from "../utils";

interface TextPromptProps {
  title: string;
  description?: string;
  placeholder?: string;
  password?: boolean;
  required?: boolean;
  initialValue?: string;
  submitLabel?: string;
  onCancel?: () => void;
  validate?: (value: string) => string | undefined;
  onSubmit: (value: string) => void;
}

export function TextPrompt({
  title,
  description,
  placeholder,
  password = false,
  required = true,
  initialValue = "",
  submitLabel = "continue",
  onCancel,
  validate,
  onSubmit
}: TextPromptProps) {
  const [value, setValue] = useState(initialValue);
  const [cursor, setCursor] = useState(initialValue.length);
  const [error, setError] = useState("");

  function commit(next: string, nextCursor = next.length): void {
    setValue(next);
    setCursor(nextCursor);
    setError("");
  }

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }

    if (key.return || input === "\r") {
      const trimmed = value.trim();

      if (required && !trimmed) {
        setError(
          password
            ? "An API key is required."
            : "This value is required."
        );
        return;
      }

      const validationError = validate?.(trimmed);

      if (validationError) {
        setError(validationError);
        return;
      }

      onSubmit(trimmed);
      return;
    }

    if (key.backspace) {
      if (cursor === 0) {
        return;
      }

      const next =
        value.slice(0, cursor - 1) + value.slice(cursor);
      commit(next, cursor - 1);
      return;
    }

    if (key.delete) {
      commit(
        value.slice(0, cursor) + value.slice(cursor + 1),
        cursor
      );
      return;
    }

    if (key.leftArrow) {
      setCursor((current) => Math.max(0, current - 1));
      return;
    }

    if (key.rightArrow) {
      setCursor((current) =>
        Math.min(value.length, current + 1)
      );
      return;
    }

    const extended = key as typeof key & {
      home?: boolean;
      end?: boolean;
    };

    if (extended.home || (key.ctrl && input === "a")) {
      setCursor(0);
      return;
    }

    if (extended.end || (key.ctrl && input === "e")) {
      setCursor(value.length);
      return;
    }

    if (key.ctrl && input === "u") {
      commit("", 0);
      return;
    }

    if (key.ctrl && input === "c") {
      return;
    }

    if (input) {
      const clean = input.replace(/[\r\n]+/g, "");

      if (clean) {
        const next =
          value.slice(0, cursor) +
          clean +
          value.slice(cursor);
        commit(next, cursor + clean.length);
      }
    }
  });

  const display = password ? maskSecret(value) : value;
  const safeCursor = Math.min(cursor, display.length);
  const before = display.slice(0, safeCursor);
  const at = display[safeCursor] ?? " ";
  const after = display.slice(safeCursor + 1);

  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor={theme.accent}
      paddingX={1}
      paddingY={0}
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.accent}>
          {title}
        </Text>
        <Text dimColor>setup</Text>
      </Box>

      {description ? (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap">
            {description}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.accent} bold>
          ›{" "}
        </Text>
        <Box flexGrow={1}>
          {value.length === 0 ? (
            <Text>
              <Text inverse> </Text>
              <Text dimColor>
                {" "}
                {placeholder ?? "Type a value…"}
              </Text>
            </Text>
          ) : (
            <Text wrap="wrap">
              {before}
              <Text inverse>{at}</Text>
              {after}
            </Text>
          )}
        </Box>
      </Box>

      {error ? (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          enter {submitLabel}
          {onCancel ? "  ·  esc back" : ""} · ctrl+c exit
        </Text>
      </Box>
    </Box>
  );
}
