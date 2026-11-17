import {
    ChatOptions,
    ModelVariant,
    ProviderConfig,
    ReasoningEffort
} from "../interfaces/type";

import {
    effortToBudget,
    isReasoningEffort
} from "./model-capabilities";

type JsonObject = Record<string, unknown>;

interface VariantResolution {
  variant?: ModelVariant;
  effort?: ReasoningEffort;
}

const FORBIDDEN_VARIANT_BODY_KEYS = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "stream"
]);

function isJsonObject(value: unknown): value is JsonObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function resolveVariant(
  options: ChatOptions,
  variants: ModelVariant[] = []
): VariantResolution {
  if (options.reasoningEffort) {
    const matchingVariant = variants.find(
      (variant) =>
        variant.settings?.reasoningEffort === options.reasoningEffort
    );

    return {
      variant: matchingVariant ?? {
        id: options.reasoningEffort,
        name: options.reasoningEffort,
        settings: {
          reasoningEffort: options.reasoningEffort
        }
      },
      effort: options.reasoningEffort
    };
  }

  if (!options.variant || options.variant === "default") {
    return {};
  }

  const selectedVariant = variants.find(
    (variant) => variant.id === options.variant
  );

  if (!selectedVariant) {
    if (isReasoningEffort(options.variant)) {
      return {
        variant: {
          id: options.variant,
          name: options.variant,
          settings: {
            reasoningEffort: options.variant
          }
        },
        effort: options.variant
      };
    }

    return {};
  }

  const effort = selectedVariant.settings?.reasoningEffort;

  return {
    variant: selectedVariant,
    effort: isReasoningEffort(effort) ? effort : undefined
  };
}

export function applyVariant(
  body: JsonObject,
  options: ChatOptions,
  config: ProviderConfig,
  variants: ModelVariant[] = []
): JsonObject {
  const result: JsonObject = { ...body };

  const { variant, effort } = resolveVariant(options, variants);

  if (!variant && !effort) {
    return result;
  }

  switch (config.protocol) {
    case "openai-chat":
    case "openai-compatible": {
      if (effort && effort !== "none") {
        result.reasoning_effort = effort;
      } else {
        delete result.reasoning_effort;
      }

      break;
    }

    case "openai-responses": {
      if (effort && effort !== "none") {
        result.reasoning = {
          ...(
            isJsonObject(result.reasoning)
              ? result.reasoning
              : {}
          ),
          effort
        };
      } else {
        delete result.reasoning;
      }

      break;
    }

    case "anthropic": {
      const budget =
        variant?.settings?.reasoningBudget ??
        (effort && effort !== "none"
          ? effortToBudget(effort)
          : undefined);

      if (typeof budget === "number" && budget > 0) {
        result.thinking = {
          type: "enabled",
          budget_tokens: budget
        };

        // Anthropic extended thinking requires an appropriate token limit.
        const maxTokens =
          typeof result.max_tokens === "number"
            ? result.max_tokens
            : 0;

        if (maxTokens > 0 && maxTokens <= budget) {
          result.max_tokens = budget + 1024;
        }
      } else {
        delete result.thinking;
      }

      break;
    }

    case "gemini": {
      const budget =
        variant?.settings?.reasoningBudget ??
        (effort && effort !== "none"
          ? effortToBudget(effort)
          : undefined);

      const generationConfig = {
        ...(
          isJsonObject(result.generationConfig)
            ? result.generationConfig
            : {}
        )
      };

      if (typeof budget === "number" && budget > 0) {
        generationConfig.thinkingConfig = {
          ...(
            isJsonObject(generationConfig.thinkingConfig)
              ? generationConfig.thinkingConfig
              : {}
          ),
          thinkingBudget: budget
        };
      } else {
        delete generationConfig.thinkingConfig;
      }

      if (Object.keys(generationConfig).length > 0) {
        result.generationConfig = generationConfig;
      } else {
        delete result.generationConfig;
      }

      break;
    }

    case "ollama": {
      const ollamaOptions = {
        ...(isJsonObject(result.options) ? result.options : {})
      };

      if (effort && effort !== "none") {
        ollamaOptions.thinking = true;
      } else {
        delete ollamaOptions.thinking;
      }

      if (Object.keys(ollamaOptions).length > 0) {
        result.options = ollamaOptions;
      } else {
        delete result.options;
      }

      break;
    }

    default:
      // Unknown protocols should not receive guessed reasoning fields.
      break;
  }

  if (variant?.body && isJsonObject(variant.body)) {
    const safeBody = Object.fromEntries(
      Object.entries(variant.body).filter(
        ([key]) => !FORBIDDEN_VARIANT_BODY_KEYS.has(key.toLowerCase())
      )
    );

    return {
      ...result,
      ...safeBody
    };
  }

  return result;
}
