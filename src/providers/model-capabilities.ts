import {
    ModelMetadata,
    ModelVariant,
    ReasoningEffort
} from "../interfaces/type";

const EFFORT_LABELS: Record<string, string> = {
    none: "No Reasoning",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Maximum"
};

const REASONING_EFFORTS: ReasoningEffort[] = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max"
];

export function isReasoningEffort(
    value: unknown
): value is ReasoningEffort {
    return (
        typeof value === "string" &&
        (REASONING_EFFORTS as string[]).includes(value)
    );
}

export function effortLabel(effort?: string): string {
    if (!effort) {
        return "Default";
    }

    return EFFORT_LABELS[effort] ?? effort;
}

export function effortToBudget(effort: ReasoningEffort): number {
    switch (effort) {
        case "none":
            return 0;
        case "minimal":
            return 1024;
        case "low":
            return 2048;
        case "medium":
            return 4096;
        case "high":
            return 8192;
        case "xhigh":
            return 12288;
        case "max":
            return 16384;
    }
}

export function buildModelVariants(
    metadata?: ModelMetadata
): ModelVariant[] {
    if (!metadata) {
        return [];
    }

    const reasoning = metadata.capabilities?.reasoning;

    const options = metadata.reasoning_options ?? [];

    const effortOption = options.find(
        (option) => option.type === "effort"
    );

    const budgetOption = options.find(
        (option) => option.type === "budget_tokens"
    );

    const supported =
        reasoning?.supported ??
        metadata.reasoning ??
        Boolean(options.length);

    if (!supported) {
        return [];
    }

    const efforts =
        reasoning?.effort ??
        effortOption?.values ??
        [];

    const variants: ModelVariant[] = [];

    if (reasoning?.toggle) {
        variants.push({
            id: "none",
            name: "No Reasoning",
            settings: {
                reasoningEffort: "none"
            }
        });
    }

    for (const effort of efforts) {
        if (String(effort) === "default") continue;

        variants.push({
            id: effort,
            name: EFFORT_LABELS[effort] ?? effort,
            settings: {
                reasoningEffort: effort as ReasoningEffort
            }
        });
    }

    if (!efforts.length && budgetOption) {
        const budgets = [
            budgetOption.min,
            budgetOption.max
        ].filter(
            (budget): budget is number =>
                typeof budget === "number"
        );

        for (const budget of budgets) {
            const id = `budget-${budget}`;

            if (variants.some((variant) => variant.id === id)) {
                continue;
            }

            variants.push({
                id,
                name: `${budget.toLocaleString()} Thinking Tokens`,
                settings: {
                    reasoningBudget: budget
                }
            });
        }
    }

    return variants;
}

const KNOWN_MODEL_METADATA: Record<string, ModelMetadata> = {

    "gpt-5": {
        capabilities: {
            reasoning: {
                supported: true,
                effort: ["low", "medium", "high"]
            }
        }
    },
    "gpt-5-mini": {
        capabilities: {
            reasoning: {
                supported: true,
                effort: ["low", "medium", "high"]
            }
        }
    },
    "gpt-5-nano": {
        capabilities: {
            reasoning: {
                supported: true,
                effort: ["low", "medium", "high"]
            }
        }
    },
    o1: {
        capabilities: {
            reasoning: {
                supported: true,
                effort: ["low", "medium", "high"]
            }
        }
    },
    o3: {
        capabilities: {
            reasoning: {
                supported: true,
                effort: ["low", "medium", "high"]
            }
        }
    },
    o4: {
        capabilities: {
            reasoning: {
                supported: true,
                effort: ["low", "medium", "high"]
            }
        }
    },
    "o4-mini": {
        capabilities: {
            reasoning: {
                supported: true,
                effort: ["low", "medium", "high"]
            }
        }
    },
    "deepseek-r1": {
        capabilities: {
            reasoning: {
                supported: true,
                effort: ["low", "medium", "high"]
            }
        }
    },

    // Anthropic exposes thinking budgets instead of effort levels.
    "claude-3-7-sonnet": {
        capabilities: {
            reasoning: {
                supported: true
            }
        },
        reasoning_options: [
            {
                type: "budget_tokens",
                min: 1024,
                max: 8192
            }
        ]
    },
    "claude-sonnet-4-5": {
        capabilities: {
            reasoning: {
                supported: true
            }
        },
        reasoning_options: [
            {
                type: "budget_tokens",
                min: 1024,
                max: 12800
            }
        ]
    },
    "claude-opus-4-5": {
        capabilities: {
            reasoning: {
                supported: true
            }
        },
        reasoning_options: [
            {
                type: "budget_tokens",
                min: 1024,
                max: 16384
            }
        ]
    }
};

export const MODEL_VARIANT: Record<string, ModelVariant[]> =
    Object.fromEntries(
        Object.entries(KNOWN_MODEL_METADATA).map(
            ([id, metadata]) => [
                id,
                buildModelVariants(metadata)
            ]
        )
    ) as Record<string, ModelVariant[]>;

export function getModelVariants(modelId: string, metadata?: ModelMetadata): ModelVariant[] {
  const fallback = KNOWN_MODEL_METADATA[modelId];

  const resolved: ModelMetadata = {
    ...fallback,
    ...metadata,
    capabilities:
      metadata?.capabilities ?? fallback?.capabilities,
    reasoning:
      metadata?.reasoning ?? fallback?.reasoning,
    reasoning_options:
      metadata?.reasoning_options ?? fallback?.reasoning_options
  };

  return buildModelVariants(resolved);
}