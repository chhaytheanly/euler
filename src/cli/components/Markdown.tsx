import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { theme } from "../theme";

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/
  );

  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;

    if (!part) {
      return null;
    }

    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <Text key={key} color={theme.warn}>
          {part.slice(1, -1)}
        </Text>
      );
    }

    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <Text key={key} bold>
          {renderInline(part.slice(2, -2), key)}
        </Text>
      );
    }

    if (part.startsWith("*") && part.endsWith("*")) {
      return (
        <Text key={key} italic>
          {renderInline(part.slice(1, -1), key)}
        </Text>
      );
    }

    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);

    if (link) {
      return (
        <Text key={key}>
          <Text color={theme.accent} underline>
            {link[1]}
          </Text>
          <Text dimColor> ({link[2]})</Text>
        </Text>
      );
    }

    return <Text key={key}>{part}</Text>;
  });
}

function CodeBlock({
  code,
  language
}: {
  code: string;
  language: string;
}) {
  return (
    <Box flexDirection="column" marginY={0}>
      <Text dimColor>{language || "code"}</Text>
      <Box
        backgroundColor={theme.codeBackground}
        paddingX={1}
        flexDirection="column"
      >
        <Text wrap="wrap">{code || " "}</Text>
      </Box>
    </Box>
  );
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    const fence = line.match(/^\s*```([\w.+-]*)\s*$/);

    if (fence) {
      const language = fence[1] ?? "";
      const code: string[] = [];
      index += 1;

      while (
        index < lines.length &&
        !/^\s*```\s*$/.test(lines[index] ?? "")
      ) {
        code.push(lines[index] ?? "");
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push(
        <CodeBlock
          key={`code-${key++}`}
          code={code.join("\n")}
          language={language}
        />
      );
      continue;
    }

    if (!line.trim()) {
      const previous = blocks[blocks.length - 1];

      if (previous !== undefined) {
        blocks.push(
          <Box key={`space-${key++}`} height={1} />
        );
      }

      index += 1;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);

    if (heading) {
      const level = heading[1]?.length ?? 1;
      const content = heading[2] ?? "";

      blocks.push(
        <Box key={`heading-${key++}`} marginTop={level <= 2 ? 1 : 0}>
          <Text
            bold
            color={level <= 2 ? theme.accent : undefined}
            underline={level === 1}
          >
            {renderInline(content, `h-${key}`)}
          </Text>
        </Box>
      );
      index += 1;
      continue;
    }

    if (/^\s*(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(
        <Text key={`rule-${key++}`} dimColor>
          {"─".repeat(24)}
        </Text>
      );
      index += 1;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);

    if (bullet) {
      const indent = Math.min(
        8,
        Math.floor((bullet[1]?.length ?? 0) / 2) * 2
      );

      blocks.push(
        <Text key={`bullet-${key++}`} wrap="wrap">
          {" ".repeat(indent)}
          <Text color={theme.accent}>• </Text>
          {renderInline(bullet[2] ?? "", `b-${key}`)}
        </Text>
      );
      index += 1;
      continue;
    }

    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);

    if (numbered) {
      const indent = Math.min(
        8,
        Math.floor((numbered[1]?.length ?? 0) / 2) * 2
      );

      blocks.push(
        <Text key={`number-${key++}`} wrap="wrap">
          {" ".repeat(indent)}
          <Text color={theme.accent}>{numbered[2]}. </Text>
          {renderInline(numbered[3] ?? "", `n-${key}`)}
        </Text>
      );
      index += 1;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);

    if (quote) {
      blocks.push(
        <Text key={`quote-${key++}`} wrap="wrap">
          <Text color={theme.dim}>│ </Text>
          <Text dimColor italic>
            {renderInline(quote[1] ?? "", `q-${key}`)}
          </Text>
        </Text>
      );
      index += 1;
      continue;
    }

    blocks.push(
      <Text key={`line-${key++}`} wrap="wrap">
        {renderInline(line, `p-${key}`)}
      </Text>
    );
    index += 1;
  }

  return <Box flexDirection="column">{blocks}</Box>;
}
