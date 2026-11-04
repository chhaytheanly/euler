import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { theme } from "../theme";
import { Spinner } from "./Spinner";

export interface SelectItem {
  value: string;
  label: string;
  description?: string;
  badge?: string;
  badgeColor?: string;
}

interface SelectListProps {
  title: string;
  subtitle?: string;
  items: SelectItem[];
  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  searchable?: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  emptyText?: string;
  maxVisible?: number;
  footer?: string;
}

export function SelectList({
  title,
  subtitle,
  items,
  onSelect,
  onCancel,
  searchable = false,
  loading = false,
  error,
  onRetry,
  emptyText = "Nothing to show.",
  maxVisible = 9,
  footer
}: SelectListProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    setSelected((current) =>
      Math.min(current, Math.max(0, items.length - 1))
    );
  }, [items.length]);

  const normalized = query.trim().toLowerCase();

  const filtered = normalized
    ? items.filter((item) =>
        [item.label, item.value, item.description, item.badge]
          .filter(Boolean)
          .some((value) =>
            String(value).toLowerCase().includes(normalized)
          )
      )
    : items;

  const safeSelected = Math.min(
    selected,
    Math.max(0, filtered.length - 1)
  );

  useInput((input, key) => {
    if (key.escape) {
      onCancel?.();
      return;
    }

    if (loading) {
      return;
    }

    if (error) {
      if (input === "r") {
        onRetry?.();
      }
      return;
    }

    if (key.upArrow) {
      setSelected((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow) {
      setSelected((current) =>
        Math.min(filtered.length - 1, current + 1)
      );
      return;
    }

    if (key.return || input === "\r") {
      const item = filtered[safeSelected];

      if (item) {
        onSelect?.(item);
      }
      return;
    }

    if (!searchable) {
      return;
    }

    if (key.backspace || key.delete) {
      setQuery((current) => current.slice(0, -1));
      return;
    }

    if (key.ctrl || key.meta || key.tab) {
      return;
    }

    if (input) {
      const text = input.replace(/[\r\n]+/g, " ");

      if (text) {
        setQuery((current) => current + text);
      }
    }
  });

  let start = 0;

  if (filtered.length > maxVisible) {
    start = Math.max(
      0,
      Math.min(
        safeSelected - Math.floor(maxVisible / 2),
        filtered.length - maxVisible
      )
    );
  }

  const visible = filtered.slice(start, start + maxVisible);

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
        {subtitle ? <Text dimColor>{subtitle}</Text> : null}
      </Box>

      {loading ? (
        <Box marginY={1}>
          <Spinner label="Loading…" />
        </Box>
      ) : error ? (
        <Box flexDirection="column" marginY={1}>
          <Text color={theme.error} wrap="wrap">
            {error}
          </Text>
        </Box>
      ) : (
        <>
          {searchable ? (
            <Box marginTop={1}>
              <Text dimColor>search </Text>
              <Text>{query}</Text>
              <Text inverse> </Text>
            </Box>
          ) : (
            <Box height={1} />
          )}

          <Box flexDirection="column" marginTop={1}>
            {visible.length === 0 ? (
              <Text dimColor>{emptyText}</Text>
            ) : (
              visible.map((item, index) => {
                const actualIndex = start + index;
                const isSelected = actualIndex === safeSelected;

                return (
                  <Box
                    key={`${item.value}-${actualIndex}`}
                    width="100%"
                    paddingX={1}
                    backgroundColor={
                      isSelected
                        ? theme.selectedBackground
                        : undefined
                    }
                  >
                    <Box flexGrow={1}>
                      <Text
                        color={
                          isSelected
                            ? theme.selectedForeground
                            : undefined
                        }
                        bold={isSelected}
                      >
                        {isSelected ? "▸ " : "  "}
                        {item.label}
                        {item.badge ? (
                          <Text
                            color={
                              isSelected
                                ? theme.selectedForeground
                                : item.badgeColor ?? theme.success
                            }
                          >
                            {" "}
                            {item.badge}
                          </Text>
                        ) : null}
                      </Text>
                    </Box>
                    {item.description ? (
                      <Text
                        color={
                          isSelected
                            ? theme.selectedForeground
                            : undefined
                        }
                        dimColor={!isSelected}
                      >
                        {item.description}
                      </Text>
                    ) : null}
                  </Box>
                );
              })
            )}
          </Box>

          {filtered.length > maxVisible ? (
            <Text dimColor>
              {safeSelected + 1} of {filtered.length}
            </Text>
          ) : null}
        </>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          {error
            ? `r retry${onCancel ? "  ·  esc back" : ""}`
            : loading
              ? "esc cancel"
              : footer ??
                `↑↓ move  ·  enter select${
                  onCancel ? "  ·  esc back" : ""
                }`}
        </Text>
      </Box>
    </Box>
  );
}
