import assert from "node:assert/strict";
import test from "node:test";

import {
    AppConfig,
    ModelInfo,
    ProviderAdapter
} from "../interfaces/type";
import {
    clearModelCache,
    configureModelVariants,
    fetchAllModels,
    fetchModelsForProvider,
    getVariants
} from "../providers/model-service";

function fakeAdapter(
  id: string,
  models: ModelInfo[]
): ProviderAdapter {
  return {
    id,
    name: id,
    listModels: async () => models,
    validate: async () => true,
    streamChat: async function* () {}
  };
}

const localProvider = {
  name: "Local",
  baseUrl: "http://localhost",
  protocol: "openai-compatible" as const,
  auth: { style: "none" as const },
  requiresKey: false,
  enabled: true
};

function model(id: string): ModelInfo {
  return { id, provider: "Local", providerId: id };
}

test("configured overrides feed the variant resolver", () => {
  clearModelCache();
  configureModelVariants({
    variantOverrides: { "custom/mystery": ["medium", "xhigh"] }
  });

  assert.deepEqual(
    getVariants("custom", "mystery").map((variant) => variant.id),
    ["medium", "xhigh"]
  );
});

test("model lists are cached and can be force refreshed", async () => {
  clearModelCache();
  let calls = 0;

  const factory = (() => {
    calls += 1;
    return fakeAdapter("cached-provider", [model("m1")]);
  }) as typeof import("../providers/registry").createProviderAdapter;

  const first = await fetchModelsForProvider(
    "cached-provider",
    localProvider,
    undefined,
    { factory }
  );
  await fetchModelsForProvider(
    "cached-provider",
    localProvider,
    undefined,
    { factory }
  );
  const forced = await fetchModelsForProvider(
    "cached-provider",
    localProvider,
    undefined,
    { factory, force: true }
  );

  assert.equal(first.length, 1);
  assert.equal(forced.length, 1);
  assert.equal(calls, 2);
});

test("fetchAllModels isolates failing providers and keeps successes", async () => {
  clearModelCache();

  const factory = ((
    providerId: string
  ): ProviderAdapter => {
    if (providerId === "broken") {
      throw new Error("provider offline");
    }

    return fakeAdapter(providerId, [
      model(`${providerId}-model`)
    ]);
  }) as typeof import("../providers/registry").createProviderAdapter;

  const config: AppConfig = {
    providers: {
      good: localProvider,
      broken: { ...localProvider, name: "Broken" }
    }
  };

  const result = await fetchAllModels(config, {}, { factory });

  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, "good-model");

  const broken = result.providers.find(
    (provider) => provider.id === "broken"
  );
  assert.match(broken?.error ?? "", /provider offline/);
});
