import {
    ChatOptions,
    ModelVariant,
    ProviderConfig,
    ReasoningEffort
} from "../interfaces/type";
import { effortToBudget } from "./model-capabilities";

function isReasoningEffortValue(
    value: unknown
): value is ReasoningEffort {
    return (
        typeof value === "string" &&
        [
            "none",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "max"
        ].includes(value)
    );
}

export function resolveVariant(
    options: ChatOptions,
    variants: ModelVariant[] = []
): ModelVariant | undefined {
    if (options.reasoningEffort) {
        const byEffort = variants.find(
            (variant) =>
                variant.settings?.reasoningEffort ===
                options.reasoningEffort
        );

        if (byEffort) {
            return byEffort;
        }

        return {
            id: options.reasoningEffort,
            name: options.reasoningEffort,
            settings: {
                reasoningEffort: options.reasoningEffort
            }
        };
    }

    if (!options.variant) {
        return undefined;
    }

    const byId = variants.find(
        (variant) => variant.id === options.variant
    );

    if (byId) {
        return byId;
    }

    if (isReasoningEffortValue(options.variant)) {
        return {
            id: options.variant,
            name: options.variant,
            settings: {
                reasoningEffort: options.variant
            }
        };
    }

    return undefined;
}

export function applyVariant(
    body: Record<string, unknown>,
    options: ChatOptions,
    config: ProviderConfig,
    variants: ModelVariant[] = []
): Record<string, unknown> {
    const result = { ...body };
    const variant = resolveVariant(options, variants);
    const effort = options.reasoningEffort
        ? options.reasoningEffort
        : variant?.settings?.reasoningEffort;

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
                (effort
                    ? effortToBudget(effort)
                    : undefined);

            if (budget) {
                result.thinking = {
                    type: "enabled",
                    budget_tokens: budget
                };
            } else {
                delete result.thinking;
            }
            break;
        }

        case "gemini": {
            const budget =
                variant?.settings?.reasoningBudget ??
                (effort
                    ? effortToBudget(effort)
                    : undefined);

            if (budget) {
                result.generationConfig = {
                    ...((result.generationConfig as
                        | Record<string, unknown>
                        | undefined) ?? {}),
                    thinkingConfig: {
                        thinkingBudget: budget
                    }
                };
            } else {
                delete result.generationConfig;
            }
            break;
        }

        case "ollama": {
            const options_ = {
                ...((result.options as
                    | Record<string, unknown>
                    | undefined) ?? {})
            };

            if (effort && effort !== "none") {
                options_.thinking = true;
            } else {
                delete options_.thinking;
            }

            if (Object.keys(options_).length > 0) {
                result.options = options_;
            } else {
                delete result.options;
            }
            break;
        }
    }

    // Allow explicit model-specific request overrides.
    return {
        ...result,
        ...(variant?.body ?? {})
    };
}
