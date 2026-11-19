import assert from "node:assert/strict";
import test from "node:test";

import {
  applyUrlVariables,
  getCatalogEntry,
  makeCatalogProvider,
  missingUrlVariables,
  PROVIDER_CATALOG,
  PROVIDER_ORDER,
  refreshProviderCatalog
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

test("the Qwen web bridge is a keyless local provider", () => {
  const entry = getCatalogEntry("qwen-web");

  assert.ok(entry);
  assert.equal(entry.baseUrl, "http://127.0.0.1:8787/v1");
  assert.equal(entry.protocol, "openai-compatible");
  assert.equal(entry.requiresKey, false);
  assert.equal(entry.auth?.style, "none");
  assert.ok(PROVIDER_ORDER.includes("qwen-web"));
});

test("catalog and picker order are driven entirely by YAML", () => {
  for (const id of Object.keys(PROVIDER_CATALOG)) {
    assert.ok(PROVIDER_ORDER.includes(id), `${id} is missing from order`);
  }

  const custom = getCatalogEntry("my-custom-provider");
  assert.ok(custom, "YAML-only provider should be in the catalog");
  assert.equal(custom.baseUrl, "https://api.mycompany.com/v1");
  assert.equal(custom.auth?.style, "bearer");
  assert.ok(PROVIDER_ORDER.includes("my-custom-provider"));
});

test("refreshProviderCatalog reloads YAML without losing entries", () => {
  const before = Object.keys(PROVIDER_CATALOG).sort();

  refreshProviderCatalog();

  assert.deepEqual(Object.keys(PROVIDER_CATALOG).sort(), before);
  assert.ok(getCatalogEntry("my-custom-provider"));
});

test("catalog expands ${ENV_VAR} placeholders in baseUrl", () => {
  const previous = process.env.CLOUDFLARE_ACCOUNT_ID;

  try {
    process.env.CLOUDFLARE_ACCOUNT_ID = "abc123";
    refreshProviderCatalog();

    const resolved = getCatalogEntry("cloudflare");
    assert.ok(resolved);
    assert.equal(
      resolved.baseUrl,
      "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1"
    );
    assert.deepEqual(missingUrlVariables(resolved), []);

    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    refreshProviderCatalog();

    const unresolved = getCatalogEntry("cloudflare");
    assert.ok(unresolved);
    assert.match(unresolved.baseUrl, /\$\{CLOUDFLARE_ACCOUNT_ID\}/);
    assert.deepEqual(missingUrlVariables(unresolved), [
      "CLOUDFLARE_ACCOUNT_ID"
    ]);
  } finally {
    if (previous === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = previous;
    }
    refreshProviderCatalog();
  }
});

test("setup values resolve URL placeholders without environment variables", () => {
  const previous = process.env.CLOUDFLARE_ACCOUNT_ID;

  try {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    refreshProviderCatalog();

    const provider = makeCatalogProvider("cloudflare");
    assert.ok(provider);
    assert.deepEqual(missingUrlVariables(provider), [
      "CLOUDFLARE_ACCOUNT_ID"
    ]);

    const configured: typeof provider = {
      ...provider,
      urlVariableValues: { CLOUDFLARE_ACCOUNT_ID: "abc123" }
    };
    assert.deepEqual(missingUrlVariables(configured), []);
    assert.equal(
      applyUrlVariables(configured).baseUrl,
      "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1"
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = previous;
    }
    refreshProviderCatalog();
  }
});
