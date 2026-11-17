import assert from "node:assert/strict";
import test from "node:test";

import {
  getCatalogEntry,
  makeCatalogProvider,
  PROVIDER_ORDER
} from "../configs/catalog";

const expected: Record<
  string,
  { baseUrl: string; apiKeyEnv: string }
> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY"
  },
  mistral: {
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY"
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY"
  },
  zai: {
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY"
  },
  hunyuan: {
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    apiKeyEnv: "HUNYUAN_API_KEY"
  }
};

test("requested providers are in the catalog and in picker order", () => {
  for (const [id, values] of Object.entries(expected)) {
    const entry = getCatalogEntry(id);

    assert.ok(entry, `${id} is missing from the catalog`);
    assert.equal(entry.baseUrl, values.baseUrl);
    assert.equal(entry.apiKeyEnv, values.apiKeyEnv);
    assert.equal(entry.protocol, "openai-compatible");
    assert.ok(PROVIDER_ORDER.includes(id));

    const provider = makeCatalogProvider(id);
    assert.equal(provider?.enabled, true);
  }
});

test("new catalog entries are all chat-model capable", () => {
  for (const id of Object.keys(expected)) {
    const entry = getCatalogEntry(id);
    assert.equal(entry?.modelsPath, "/models");
    assert.equal(entry?.chatPath, "/chat/completions");
    assert.equal(entry?.requiresKey, true);
    assert.ok(entry?.keyUrl);
  }
});
