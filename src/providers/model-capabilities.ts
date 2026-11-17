import {
  EFFORT_BUDGETS,
  EFFORT_LABELS,
  REASONING_EFFORTS
} from "../interfaces/constants";
import {
  ModelMetadata,
  ModelVariant,
  ReasoningCapabilities,
  ReasoningEffort
} from "../interfaces/type";

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

  return isReasoningEffort(effort)
    ? EFFORT_LABELS[effort]
    : effort;
}

export function effortToBudget(effort: ReasoningEffort): number {
  return EFFORT_BUDGETS[effort] ?? 0;
}


interface FamilyRule {
  id: string;
  pattern: RegExp;
  providerIds?: string[];
  efforts?: ReasoningEffort[];
  budgets?: { min: number; max: number };
  toggle?: boolean;
  /** Variants using provider-native request fields rather than efforts. */
  variants?: ModelVariant[];
}

const FAMILY_RULES: FamilyRule[] = [
  {
    id: "gpt-5",
    pattern: /(?:^|\/)gpt-5(?:$|[-.])/i,
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh"]
  },
  {
    id: "o-series",
    pattern: /(?:^|\/)o[134](?:$|[-.])/i,
    efforts: ["low", "medium", "high"]
  },
  {
    id: "claude-3-7",
    pattern: /(?:^|\/)claude-3-7-sonnet/i,
    budgets: { min: 1024, max: 8192 },
    toggle: true
  },
  {
    id: "claude-3-5",
    pattern: /(?:^|\/)claude-3-5-sonnet/i,
    budgets: { min: 1024, max: 8192 },
    toggle: true
  },
  {
    id: "claude-4",
    pattern: /(?:^|\/)claude-(?:sonnet|opus)-4(?:$|[-.])/i,
    budgets: { min: 1024, max: 16384 },
    toggle: true
  },
  {
    id: "gemini-2-5",
    pattern: /(?:^|\/)gemini-2\.5/i,
    budgets: { min: 1024, max: 24576 },
    toggle: true
  },
  {
    id: "deepseek-r1",
    pattern: /(?:^|\/)(?:deepseek-)?r1(?:$|[-:.])/i,
    budgets: { min: 1024, max: 16384 },
    toggle: true
  },
  {
    id: "qwen3",
    pattern: /(?:^|\/)qwen3(?:$|[-.])/i,
    variants: [
      {
        id: "thinking",
        name: "Thinking",
        description: "Qwen3 hybrid thinking mode",
        body: { enable_thinking: true }
      },
      {
        id: "no-thinking",
        name: "No Thinking",
        description: "Qwen3 with thinking disabled",
        settings: { reasoningEffort: "none" },
        body: { enable_thinking: false }
      }
    ]
  },
  {
    id: "glm",
    pattern: /(?:^|\/)glm-(?:4\.5|4\.6)/i,
    variants: [
      {
        id: "thinking",
        name: "Thinking",
        description: "Z.ai GLM thinking mode",
        body: { thinking: { type: "enabled" } }
      },
      {
        id: "no-thinking",
        name: "No Thinking",
        description: "Z.ai GLM with thinking disabled",
        settings: { reasoningEffort: "none" },
        body: { thinking: { type: "disabled" } }
      }
    ]
  },
  {
    id: "hunyuan",
    pattern: /(?:^|\/)hunyuan/i,
    toggle: true
  },
  {
    id: "generic-reasoning",
    pattern: /(?:thinking|reasoning|reasoner)/i,
    toggle: true,
    efforts: ["low", "medium", "high"]
  }
];

function metadataFromRule(rule: FamilyRule): ModelMetadata {
  return {
    capabilities: {
      reasoning: {
        supported: true,
        type: rule.efforts?.length
          ? "effort"
          : rule.budgets
            ? "budget"
            : "toggle",
        effort: rule.efforts,
        toggle:
          rule.toggle ?? rule.efforts?.includes("none") ?? false,
        minBudget: rule.budgets?.min,
        maxBudget: rule.budgets?.max
      }
    },
    reasoning: true,
    reasoning_options: rule.budgets
      ? [
          {
            type: "budget_tokens",
            min: rule.budgets.min,
            max: rule.budgets.max
          }
        ]
      : rule.efforts
        ? [{ type: "effort", values: rule.efforts }]
        : undefined
  };
}

function findRule(
  modelId: string,
  providerId?: string
): FamilyRule | undefined {
  return FAMILY_RULES.find(
    (rule) =>
      (!rule.providerIds ||
        (providerId && rule.providerIds.includes(providerId))) &&
      rule.pattern.test(modelId)
  );
}

function mergeReasoning(
  base?: ReasoningCapabilities,
  extra?: ReasoningCapabilities
): ReasoningCapabilities | undefined {
  if (!base) {
    return extra;
  }

  if (!extra) {
    return base;
  }

  const merged: ReasoningCapabilities = {
    ...base,
    ...extra,
    effort: extra.effort ?? base.effort
  };

  // An explicit effort or budget list from the provider is authoritative;
  // don't inherit the family rule's toggle in that case.
  if (
    extra.effort ||
    extra.minBudget !== undefined ||
    extra.maxBudget !== undefined
  ) {
    merged.toggle = extra.toggle ?? false;
  }

  return merged;
}

function mergeMetadata(
  base?: ModelMetadata,
  extra?: ModelMetadata
): ModelMetadata | undefined {
  if (!base) {
    return extra;
  }

  if (!extra) {
    return base;
  }

  const reasoning = mergeReasoning(
    base.capabilities?.reasoning,
    extra.capabilities?.reasoning
  );

  return {
    capabilities: reasoning ? { reasoning } : undefined,
    reasoning: extra.reasoning ?? base.reasoning,
    reasoning_options:
      extra.reasoning_options && extra.reasoning_options.length > 0
        ? extra.reasoning_options
        : base.reasoning_options
  };
}

function variantsFromEfforts(
  efforts: ReasoningEffort[]
): ModelVariant[] {
  const variants: ModelVariant[] = [];
  const seen = new Set<string>();

  for (const effort of efforts) {
    if (!isReasoningEffort(effort) || seen.has(effort)) {
      continue;
    }

    seen.add(effort);
    variants.push({
      id: effort,
      name: EFFORT_LABELS[effort],
      settings: { reasoningEffort: effort }
    });
  }

  return variants;
}

export function buildModelVariants(
  metadata?: ModelMetadata,
  overrideEfforts?: ReasoningEffort[]
): ModelVariant[] {
  if (overrideEfforts && overrideEfforts.length > 0) {
    return variantsFromEfforts(overrideEfforts);
  }

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

  const efforts = reasoning?.effort ?? effortOption?.values ?? [];
  const variants = variantsFromEfforts(efforts);

  if (reasoning?.toggle && !variants.some((v) => v.id === "none")) {
    variants.unshift({
      id: "none",
      name: EFFORT_LABELS.none,
      settings: { reasoningEffort: "none" }
    });
  }

  if (efforts.length === 0 && budgetOption) {
    const budgets = [budgetOption.min, budgetOption.max].filter(
      (budget): budget is number => typeof budget === "number"
    );

    for (const budget of budgets) {
      const id = `budget-${budget}`;

      if (variants.some((variant) => variant.id === id)) {
        continue;
      }

      variants.push({
        id,
        name: `${budget.toLocaleString()} Thinking Tokens`,
        settings: { reasoningBudget: budget }
      });
    }
  }

  return variants;
}

export function resolveModelVariants(
  modelId: string,
  providerId?: string,
  metadata?: ModelMetadata,
  overrides?: Record<string, ReasoningEffort[]>
): ModelVariant[] {
  const rule = findRule(modelId, providerId);

  const overrideEfforts =
    (providerId
      ? overrides?.[`${providerId}/${modelId}`]
      : undefined) ??
    overrides?.[modelId];

  if (overrideEfforts && overrideEfforts.length > 0) {
    return buildModelVariants(undefined, overrideEfforts);
  }

  const providerReasoning = Boolean(
    metadata?.capabilities?.reasoning ||
      metadata?.reasoning ||
      metadata?.reasoning_options?.length
  );

  if (rule?.variants?.length && !providerReasoning) {
    return rule.variants;
  }

  const merged = mergeMetadata(
    rule ? metadataFromRule(rule) : undefined,
    metadata
  );

  return buildModelVariants(merged);
}

/** Backwards-compatible helper for callers that only have a model id. */
export function getModelVariants(
  modelId: string,
  metadata?: ModelMetadata
): ModelVariant[] {
  return resolveModelVariants(modelId, undefined, metadata);
}
