import assert from "node:assert/strict";
import test from "node:test";

import {
  dropCredential,
  putCredential
} from "../configs/config";
import {
  ProviderConfig
} from "../interfaces/type";
import { AuthDependencies } from "../interfaces/auth";
import {
  AuthError,
  ProviderAuthService
} from "../providers/auth-service";

const ENV_KEY = "EULER_TEST_PROVIDER_KEY";

const cloudProvider: ProviderConfig = {
  name: "Test Cloud",
  baseUrl: "https://api.example.test/v1",
  protocol: "openai-compatible",
  auth: { style: "bearer" },
  requiresKey: true,
  enabled: true,
  apiKeyEnv: ENV_KEY,
  keyUrl: "https://example.test/keys"
};

const localProvider: ProviderConfig = {
  name: "Local",
  baseUrl: "http://localhost:11434",
  protocol: "ollama",
  auth: { style: "none" },
  requiresKey: false,
  enabled: true
};

interface ValidationBehavior {
  kind: "ok" | "false" | "throws";
  message?: string;
}

interface Harness {
  service: ProviderAuthService;
  credentials: () => Record<string, string>;
  saveCount: () => number;
  adapterCount: () => number;
  behavior: ValidationBehavior;
}

function createHarness(
  initial: Record<string, string> = {},
  behavior: ValidationBehavior = { kind: "ok" }
): Harness {
  let credentials = { ...initial };
  let saves = 0;
  let adapters = 0;
  const current: ValidationBehavior = { ...behavior };

  const dependencies: AuthDependencies = {
    loadCredentials: async () => ({ ...credentials }),
    saveCredentials: async (next) => {
      credentials = { ...next };
      saves += 1;
    },
    createAdapter: (id, provider) => {
      adapters += 1;

      return {
        id,
        name: provider.name,
        listModels: async () => [],
        validate: async () => {
          if (current.kind === "throws") {
            throw new Error(current.message ?? "rejected");
          }

          return current.kind === "ok";
        },
        streamChat: async function* () {}
      };
    }
  };

  return {
    service: new ProviderAuthService(dependencies),
    credentials: () => ({ ...credentials }),
    saveCount: () => saves,
    adapterCount: () => adapters,
    behavior: current
  };
}

test("credential helpers upsert keys immutably and delete empty values", () => {
  const original = { openai: "sk-original", groq: "gsk-keep" };
  const updated = putCredential(original, "openai", "  sk-new  ");
  const removed = putCredential(original, "openai", " ");

  assert.equal(updated.openai, "sk-new");
  assert.equal(removed.openai, undefined);
  assert.equal(original.openai, "sk-original", "input is not mutated");

  const dropped = dropCredential(original, "openai");
  assert.equal(dropped.removed, true);
  assert.equal(dropped.credentials.openai, undefined);
  assert.equal(original.openai, "sk-original", "input is not mutated");

  const missing = dropCredential(original, "unknown");
  assert.equal(missing.removed, false);
});

test("status reports a stored key, masks it, and exposes the revoke URL", () => {
  const harness = createHarness({ openai: "sk-1234567890abcdef" });
  const status = harness.service.status(
    "openai",
    cloudProvider,
    harness.credentials()
  );

  assert.equal(status.source, "stored");
  assert.equal(status.usesKey, true);
  assert.equal(status.requiresKey, true);
  assert.equal(status.maskedKey, "sk-1…cdef");
  assert.equal(status.keyUrl, cloudProvider.keyUrl);
});

test("status falls back to the environment and then reports none", () => {
  const harness = createHarness();
  const previous = process.env[ENV_KEY];

  try {
    process.env[ENV_KEY] = "env-key";
    assert.equal(
      harness.service.status("openai", cloudProvider, {}).source,
      "environment"
    );

    delete process.env[ENV_KEY];
    assert.equal(
      harness.service.status("openai", cloudProvider, {}).source,
      "none"
    );
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
  }
});

test("login validates the key before storing it", async () => {
  const harness = createHarness();

  const result = await harness.service.login({
    providerId: "openai",
    provider: cloudProvider,
    apiKey: "  sk-valid-key  "
  });

  assert.equal(result.validated, true);
  assert.equal(result.credentials.openai, "sk-valid-key");
  assert.equal(result.status.source, "stored");
  assert.equal(harness.adapterCount(), 1);
  assert.equal(harness.saveCount(), 1);
});

test("login never stores a key that the provider rejects", async () => {
  const harness = createHarness(
    { openai: "sk-old-key" },
    { kind: "throws", message: "HTTP 401: invalid key" }
  );

  await assert.rejects(
    harness.service.login({
      providerId: "openai",
      provider: cloudProvider,
      apiKey: "sk-bad-key"
    }),
    (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.match(error.message, /401/);
      return true;
    }
  );

  assert.equal(
    harness.credentials().openai,
    "sk-old-key",
    "the previous key is preserved"
  );
  assert.equal(harness.saveCount(), 0);
});

test("login rejects an empty key when the provider requires one", async () => {
  const harness = createHarness();

  await assert.rejects(
    harness.service.login({
      providerId: "openai",
      provider: cloudProvider,
      apiKey: "   "
    }),
    /requires an API key/
  );

  assert.equal(harness.adapterCount(), 0);
  assert.equal(harness.saveCount(), 0);
});

test("login can store a key without network validation", async () => {
  const harness = createHarness();

  const result = await harness.service.login({
    providerId: "openai",
    provider: cloudProvider,
    apiKey: "sk-unverified",
    validate: false
  });

  assert.equal(result.validated, false);
  assert.equal(result.credentials.openai, "sk-unverified");
  assert.equal(harness.adapterCount(), 0);
  assert.equal(harness.saveCount(), 1);
});

test("local providers have no key to store but can be validated", async () => {
  const harness = createHarness();

  const result = await harness.service.login({
    providerId: "ollama",
    provider: localProvider,
    apiKey: ""
  });

  assert.equal(result.validated, true);
  assert.deepEqual(result.credentials, {});
  assert.equal(result.status.source, "none");
  assert.equal(harness.saveCount(), 0);
});

test("logout removes the saved key and is idempotent", async () => {
  const harness = createHarness({ openai: "sk-remove-me" });

  const first = await harness.service.logout({
    providerId: "openai",
    provider: cloudProvider
  });
  assert.equal(first.removed, true);
  assert.deepEqual(first.credentials, {});
  assert.equal(first.status.source, "none");
  assert.equal(harness.saveCount(), 1);

  const second = await harness.service.logout({
    providerId: "openai",
    provider: cloudProvider
  });
  assert.equal(second.removed, false);
  assert.equal(harness.saveCount(), 1, "no redundant write");
});

test("logout reports an environment fallback after deleting the stored key", async () => {
  const harness = createHarness({ openai: "sk-stored" });
  const previous = process.env[ENV_KEY];

  try {
    process.env[ENV_KEY] = "env-key";

    const result = await harness.service.logout({
      providerId: "openai",
      provider: cloudProvider
    });

    assert.equal(result.removed, true);
    assert.equal(result.environmentFallback, true);
    assert.equal(result.status.source, "environment");
    assert.equal(harness.credentials().openai, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = previous;
    }
  }
});

test("validate distinguishes valid keys from provider errors", async () => {
  const harness = createHarness();
  const valid = await harness.service.validate(
    "openai",
    cloudProvider,
    "sk-ok"
  );
  assert.equal(valid.valid, true);

  harness.behavior.kind = "throws";
  harness.behavior.message = "HTTP 403: forbidden";

  const invalid = await harness.service.validate(
    "openai",
    cloudProvider,
    "sk-bad"
  );
  assert.equal(invalid.valid, false);
  assert.match(invalid.error ?? "", /403/);

  const missing = await harness.service.validate(
    "openai",
    cloudProvider,
    undefined
  );
  assert.equal(missing.valid, false);
  assert.match(missing.error ?? "", /needs an API key/);
});
