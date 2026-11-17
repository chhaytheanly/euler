import assert from "node:assert/strict";
import test from "node:test";

import { ChatOptions, ProviderConfig } from "../interfaces/type";
import { applyVariant, resolveVariant } from "../providers/variant-translators";

const options = (variant: string): ChatOptions => ({
  model: "test-model",
  variant
});

const config = (protocol: ProviderConfig["protocol"]): ProviderConfig => ({
  name: "Test",
  baseUrl: "https://example.test",
  protocol,
  enabled: true
});

test("effort ids resolve even without variant metadata", () => {
  const resolved = resolveVariant(options("xhigh"));

  assert.equal(resolved.effort, "xhigh");
  assert.equal(resolved.variant?.id, "xhigh");
  assert.deepEqual(resolveVariant(options("default")), {});
});

test("openai-compatible receives reasoning_effort", () => {
  const body = applyVariant(
    { model: "test-model", messages: [] },
    options("xhigh"),
    config("openai-compatible")
  );

  assert.equal(body.reasoning_effort, "xhigh");
});

test("anthropic receives a thinking budget and a safe max_tokens", () => {
  const body = applyVariant(
    { model: "test-model", max_tokens: 2000 },
    options("xhigh"),
    config("anthropic")
  );

  assert.deepEqual(body.thinking, {
    type: "enabled",
    budget_tokens: 12288
  });
  assert.equal(body.max_tokens, 13312);
});

test("gemini and ollama receive their native reasoning fields", () => {
  const gemini = applyVariant(
    { model: "test-model" },
    options("high"),
    config("gemini")
  );
  assert.deepEqual(
    (gemini.generationConfig as Record<string, unknown>)
      .thinkingConfig,
    { thinkingBudget: 8192 }
  );

  const ollama = applyVariant(
    { model: "test-model" },
    options("high"),
    config("ollama")
  );
  assert.deepEqual(ollama.options, { thinking: true });
});

test("variant bodies cannot replace the conversation or target model", () => {
  const body = applyVariant(
    { model: "original", messages: [{ role: "user" }] },
    { model: "test-model", variant: "custom" },
    config("openai-compatible"),
    [
      {
        id: "custom",
        name: "Custom",
        settings: { reasoningEffort: "high" },
        body: {
          model: "hijacked",
          messages: [],
          temperature: 0.2
        }
      }
    ]
  );

  assert.equal(body.model, "original");
  assert.deepEqual(body.messages, [{ role: "user" }]);
  assert.equal(body.temperature, 0.2);
  assert.equal(body.reasoning_effort, "high");
});

test("no variant leaves the body untouched", () => {
  const body = applyVariant(
    { model: "test-model", messages: [] },
    { model: "test-model" },
    config("openai-compatible")
  );

  assert.deepEqual(body, {
    model: "test-model",
    messages: []
  });
});
