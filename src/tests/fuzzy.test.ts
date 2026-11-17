import assert from "node:assert/strict";
import test from "node:test";

import { fuzzyMatch, rankItems } from "../cli/fuzzy";

test("fuzzyMatch finds substrings and subsequences", () => {
  assert.deepEqual(fuzzyMatch("OpenRouter", "open"), {
    score: 220,
    positions: [0, 1, 2, 3]
  });

  const subsequence = fuzzyMatch("gpt-5", "gpt5");
  assert.ok(subsequence);
  assert.deepEqual(subsequence.positions, [0, 1, 2, 4]);

  assert.equal(fuzzyMatch("OpenAI", "xyz"), undefined);
});

test("rankItems prefers label matches and supports AND tokens", () => {
  const items = [
    {
      label: "OpenRouter",
      value: "openrouter",
      description: "One key, hundreds of models"
    },
    { label: "OpenAI", value: "openai", description: "GPT models" },
    {
      label: "Qwen (DashScope)",
      value: "qwen",
      description: "Alibaba Qwen · OpenAI-compatible"
    }
  ];

  const ranked = rankItems(items, "open");
  assert.deepEqual(
    ranked.map((result) => result.item.value).slice(0, 2),
    ["openrouter", "openai"]
  );
  assert.equal(ranked[2].item.value, "qwen");
  assert.ok(ranked[0].score > ranked[2].score);

  const andQuery = rankItems(items, "alibaba openai");
  assert.deepEqual(
    andQuery.map((result) => result.item.value),
    ["qwen"]
  );
});

test("empty query preserves the original order", () => {
  const items = [
    { label: "B", value: "b" },
    { label: "A", value: "a" }
  ];

  assert.deepEqual(
    rankItems(items, "  ").map((result) => result.item.value),
    ["b", "a"]
  );
});
