import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { theme } from "../theme";
import { maskSecret } from "../utils";

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  disabled?: boolean;
  placeholder?: string;
  password?: boolean;
  history?: string[];
  completions?: string[];
  disabledLabel?: string;
}

function cursorPosition(
  value: string,
  cursor: number
): { line: number; column: number } {
  const before = value.slice(0, cursor);
  const lines = before.split("\n");

  return {
    line: lines.length - 1,
    column: lines[lines.length - 1]?.length ?? 0
  };
}

function offsetForPosition(
  value: string,
  line: number,
  column: number
): number {
  const lines = value.split("\n");
  const targetLine = Math.max(0, Math.min(line, lines.length - 1));
  let offset = 0;

  for (let index = 0; index < targetLine; index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }

  return offset + Math.min(column, lines[targetLine]?.length ?? 0);
}

export function PromptInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  disabled = false,
  placeholder = "Type a message…",
  password = false,
  history = [],
  completions = [],
  disabledLabel = "Generating response… (esc to cancel)"
}: PromptInputProps) {
  const [cursor, setCursor] = useState(value.length);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setCursor((current) =>
      Math.max(0, Math.min(current, value.length))
    );

    if (!value) {
      setHistoryIndex(-1);
    }
  }, [value]);

  function applyValue(next: string, nextCursor = next.length): void {
    onChange(next);
    setCursor(nextCursor);
  }

  function insert(text: string): void {
    const next =
      value.slice(0, cursor) + text + value.slice(cursor);
    applyValue(next, cursor + text.length);
  }

  function removeBefore(count = 1): void {
    if (cursor === 0) {
      return;
    }

    const start = Math.max(0, cursor - count);
    applyValue(
      value.slice(0, start) + value.slice(cursor),
      start
    );
  }

  function removeAfter(count = 1): void {
    if (cursor >= value.length) {
      return;
    }

    applyValue(
      value.slice(0, cursor) +
        value.slice(Math.min(value.length, cursor + count)),
      cursor
    );
  }

  function moveVertically(direction: -1 | 1): void {
    const position = cursorPosition(value, cursor);
    const targetLine = position.line + direction;

    if (targetLine < 0) {
      if (!value.includes("\n") && history.length > 0) {
        if (historyIndex === -1) {
          setDraft(value);
        }

        const nextIndex = Math.min(
          history.length - 1,
          historyIndex + 1
        );
        const nextValue = history[nextIndex] ?? "";

        setHistoryIndex(nextIndex);
        applyValue(nextValue);
      }
      return;
    }

    if (targetLine > value.split("\n").length - 1) {
      if (historyIndex >= 0) {
        const nextIndex = historyIndex - 1;

        if (nextIndex < 0) {
          setHistoryIndex(-1);
          applyValue(draft);
        } else {
          setHistoryIndex(nextIndex);
          applyValue(history[nextIndex] ?? "");
        }
      }
      return;
    }

    setCursor(
      offsetForPosition(value, targetLine, position.column)
    );
  }

  function deleteWordBefore(): void {
    if (cursor === 0) {
      return;
    }

    let start = cursor;

    while (start > 0 && /\s/.test(value[start - 1] ?? "")) {
      start -= 1;
    }

    while (start > 0 && !/\s/.test(value[start - 1] ?? "")) {
      start -= 1;
    }

    applyValue(value.slice(0, start) + value.slice(cursor), start);
  }

  useInput(
    (input, key) => {
      if (disabled) {
        if (key.escape) {
          onCancel();
        }
        return;
      }

      const extended = key as typeof key & {
        home?: boolean;
        end?: boolean;
      };

      if (key.ctrl && input === "c") {
        return;
      }

      if (key.escape) {
        if (value) {
          applyValue("", 0);
        } else {
          onCancel();
        }
        return;
      }

      if (key.return || input === "\r") {
        if (key.ctrl || key.meta || key.shift) {
          insert("\n");
          return;
        }

        onSubmit(value);
        return;
      }

      if (input === "\n") {
        insert("\n");
        return;
      }

      if (key.tab && completions.length > 0) {
        applyValue(completions[0] ?? value);
        return;
      }

      if (key.backspace) {
        removeBefore();
        return;
      }

      if (key.delete) {
        removeAfter();
        return;
      }

      if (key.leftArrow) {
        if (key.ctrl || key.meta) {
          let next = cursor;

          while (next > 0 && /\s/.test(value[next - 1] ?? "")) {
            next -= 1;
          }

          while (next > 0 && !/\s/.test(value[next - 1] ?? "")) {
            next -= 1;
          }

          setCursor(next);
        } else {
          setCursor((current) => Math.max(0, current - 1));
        }
        return;
      }

      if (key.rightArrow) {
        if (key.ctrl || key.meta) {
          let next = cursor;

          while (
            next < value.length &&
            /\s/.test(value[next] ?? "")
          ) {
            next += 1;
          }

          while (
            next < value.length &&
            !/\s/.test(value[next] ?? "")
          ) {
            next += 1;
          }

          setCursor(next);
        } else {
          setCursor((current) =>
            Math.min(value.length, current + 1)
          );
        }
        return;
      }

      if (key.upArrow) {
        moveVertically(-1);
        return;
      }

      if (key.downArrow) {
        moveVertically(1);
        return;
      }

      if (extended.home || (key.ctrl && input === "a")) {
        setCursor(0);
        return;
      }

      if (extended.end || (key.ctrl && input === "e")) {
        setCursor(value.length);
        return;
      }

      if (key.ctrl && input === "w") {
        deleteWordBefore();
        return;
      }

      if (key.ctrl && input === "u") {
        applyValue("", 0);
        return;
      }

      if (input) {
        const clean = input
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n");

        if (clean) {
          insert(clean);
        }
      }
    },
    { isActive: true }
  );

  const display = password ? maskSecret(value) : value;
  const safeCursor = Math.min(cursor, display.length);
  const before = display.slice(0, safeCursor);
  const at = display[safeCursor] ?? " ";
  const after = display.slice(safeCursor + 1);

  return (
    <Box flexDirection="column" width="100%">
      <Box
        borderStyle="round"
        borderColor={disabled ? theme.warn : theme.accent}
        paddingX={1}
        width="100%"
        flexDirection="column"
      >
        <Box>
          <Text color={theme.accent} bold>
            ›{" "}
          </Text>
          <Box flexGrow={1}>
            {value.length === 0 && !disabled ? (
              <Text>
                <Text inverse> </Text>
                <Text dimColor> {placeholder}</Text>
              </Text>
            ) : disabled ? (
              <Text dimColor>{disabledLabel}</Text>
            ) : at === "\n" ? (
              <Text wrap="wrap">
                {before}
                <Text inverse> </Text>
                {"\n"}
                {after}
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

        <Box marginTop={0}>
          <Text dimColor>
            {disabled
              ? "esc cancel  ·  ctrl+c exit"
              : value
                ? "enter send  ·  ctrl+j newline  ·  esc clear"
                : "enter send  ·  ctrl+j newline  ·  / commands  ·  ctrl+c exit"}
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
