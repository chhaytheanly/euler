import { ProviderAdapter, ProviderConfig } from "../interfaces/type";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openai-compatible";
import { applyUrlVariables } from "./url-variables";

export function createProviderAdapter(
  providerId: string,
  config: ProviderConfig,
  apiKey?: string
): ProviderAdapter {
  const resolved = applyUrlVariables(config);

  switch (resolved.protocol) {
    case "openai-compatible":
    case "openai-chat":
    case "openai-responses":
    case "gemini":

      return new OpenAICompatibleProvider(
        providerId,
        resolved,
        apiKey
      );

    case "anthropic":
      return new AnthropicProvider(providerId, resolved, apiKey);

    case "ollama":
      return new OllamaProvider(providerId, resolved, apiKey);

    default:
      throw new Error(
        `Unsupported provider protocol: ${String(config.protocol)}`
      );
  }
}
