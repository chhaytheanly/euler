import { ProviderConfig } from "../interfaces/type";

export function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;

  return `${base}${suffix}`;
}

export function buildHeaders(
  provider: ProviderConfig,
  apiKey: string | undefined
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...provider.headers
  };

  const auth = provider.auth ?? { style: "bearer" };

  if (apiKey && auth.style === "bearer") {
    headers[auth.header ?? "Authorization"] =
      `${auth.prefix ?? "Bearer "}${apiKey}`;
  } else if (apiKey && auth.style === "x-api-key") {
    headers[auth.header ?? "x-api-key"] =
      `${auth.prefix ?? ""}${apiKey}`;
  }

  return headers;
}

export async function responseError(
  response: Response,
  providerName: string
): Promise<Error> {
  let detail = "";

  try {
    const body = await response.text();

    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string } | string;
        message?: string;
      };

      if (typeof parsed.error === "string") {
        detail = parsed.error;
      } else if (parsed.error?.message) {
        detail = parsed.error.message;
      } else if (parsed.message) {
        detail = parsed.message;
      } else {
        detail = body;
      }
    } catch {
      detail = body;
    }
  } catch {
    // The response body was not readable; the status code is still useful.
  }

  const status = `HTTP ${response.status}${
    response.statusText ? ` ${response.statusText}` : ""
  }`;

  return new Error(
    `${providerName} request failed (${status})${
      detail ? `: ${detail.slice(0, 400)}` : ""
    }`
  );
}

export async function* lineStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        completed = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");

      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        yield line;
        newline = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();

    if (buffer) {
      yield buffer.replace(/\r$/, "");
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed.
      }
    }

    reader.releaseLock();
  }
}

export async function* sseData(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  for await (const line of lineStream(body)) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const data = line.slice(5).trim();

    if (data) {
      yield data;
    }
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
