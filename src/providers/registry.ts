import { ProviderAdapter, ProviderConfig } from "../interfaces/type";
import { AnthropicProvider } from "./anthropic";
import { OllamaProvider } from "./ollama";
import { OpenAICompatibleProvider } from "./openai-compatible";

export function createProviderAdapter(
  providerId: string,
  config: ProviderConfig,
  apiKey?: string
): ProviderAdapter {
  switch (config.protocol) {
    case "openai-compatible":
    case "openai-chat":
    case "openai-responses":
    case "gemini":

      return new OpenAICompatibleProvider(
        providerId,
        config,
        apiKey
      );

    case "anthropic":
      return new AnthropicProvider(providerId, config, apiKey);

    case "ollama":
      return new OllamaProvider(providerId, config, apiKey);

    default:
      throw new Error(
        `Unsupported provider protocol: ${String(config.protocol)}`
      );
  }
}
