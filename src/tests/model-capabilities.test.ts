import assert from "node:assert/strict";
import test from "node:test";

import {
    buildModelVariants,
    effortLabel,
    effortToBudget,
    isReasoningEffort,
    resolveModelVariants
} from "../providers/model-capabilities";

test("gpt-5 family exposes the full effort range including xhigh", () => {
  const ids = resolveModelVariants("gpt-5", "openai").map(
    (variant) => variant.id
  );

  assert.deepEqual(ids, [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh"
  ]);

  assert.equal(
    resolveModelVariants("openrouter/openai/gpt-5.1", "openrouter").some(
      (variant) => variant.id === "xhigh"
    ),
    true
  );
});

test("o-series and Claude families get their own variants", () => {
  const o3 = resolveModelVariants("o3", "openai").map(
    (variant) => variant.id
  );
  assert.deepEqual(o3, ["low", "medium", "high"]);

  const claude = resolveModelVariants(
    "claude-sonnet-4-5",
    "anthropic"
  ).map((variant) => variant.id);
  assert.equal(claude[0], "none");
  assert.equal(claude.length, 3);
  assert.equal(
    claude.slice(1).every((id) => id.startsWith("budget-")),
    true
  );
});

test("provider metadata overrides family rules", () => {
  const variants = resolveModelVariants("gpt-5", "custom", {
    capabilities: {
      reasoning: { supported: true, effort: ["low"] }
    }
  });

  assert.deepEqual(
    variants.map((variant) => variant.id),
    ["low"]
  );
});

test("user overrides win and work for unknown models", () => {
  const variants = resolveModelVariants(
    "mystery-model",
    "custom",
    undefined,
    { "custom/mystery-model": ["medium", "high", "xhigh"] }
  );

  assert.deepEqual(
    variants.map((variant) => variant.id),
    ["medium", "high", "xhigh"]
  );
});

test("buildModelVariants deduplicates efforts and budgets", () => {
  const variants = buildModelVariants(
    {
      capabilities: {
        reasoning: {
          supported: true,
          toggle: true,
          effort: ["low", "low", "medium"]
        }
      }
    },
    ["high", "high"]
  );

  assert.deepEqual(
    variants.map((variant) => variant.id),
    ["high"]
  );
});

test("effort helpers are consistent", () => {
  assert.equal(isReasoningEffort("xhigh"), true);
  assert.equal(isReasoningEffort("ultra"), false);
  assert.equal(effortLabel("xhigh"), "Extra High");
  assert.equal(effortLabel("ultra"), "ultra");
  assert.equal(effortLabel(undefined), "Default");
  assert.equal(effortToBudget("xhigh"), 12288);
  assert.equal(effortToBudget("none"), 0);
});

test("Qwen3 and GLM expose native thinking variants", () => {
  const qwen = resolveModelVariants("qwen3-235b-a22b", "qwen");
  assert.deepEqual(
    qwen.map((variant) => variant.id),
    ["thinking", "no-thinking"]
  );
  assert.deepEqual(qwen[0].body, { enable_thinking: true });

  const glm = resolveModelVariants("glm-4.6", "zai");
  assert.deepEqual(
    glm.map((variant) => variant.id),
    ["thinking", "no-thinking"]
  );
  assert.deepEqual(glm[0].body, {
    thinking: { type: "enabled" }
  });
});

test("Hunyuan exposes a no-reasoning toggle", () => {
  assert.deepEqual(
    resolveModelVariants("hunyuan-t1", "hunyuan").map(
      (variant) => variant.id
    ),
    ["none"]
  );
});
