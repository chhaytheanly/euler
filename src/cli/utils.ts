export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "0.0s";
  }

  if (milliseconds < 1000) {
    return `${Math.round(milliseconds)}ms`;
  }

  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);

  return `${minutes}m ${seconds}s`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return String(tokens);
  }

  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  }

  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

export function maskSecret(value: string): string {
  return "•".repeat(Math.max(1, value.length));
}

export function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

export function truncateLines(value: string, maximum: number): string {
  const lines = value.split("\n");

  if (lines.length <= maximum) {
    return value;
  }

  return `${lines.slice(0, maximum).join("\n")}\n…`;
}

export function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

export function clamp(
  value: number,
  minimum: number,
  maximum: number
): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function clearTerminal(): void {
  process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
}