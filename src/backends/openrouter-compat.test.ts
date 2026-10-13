import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getPiHostVersion } from "../integration/host-capabilities.js";
import { resolveBudgetModel } from "./backend-resolver.js";
import { clearSdkRegistryOverride, isRegistryStreamCapable, setSdkSessionRegistry } from "./sdk-backend.js";

it("uses Pi's personalized OpenRouter limits and prices after refresh and offline restoration", async (t) => {
  const [major, minor] = (getPiHostVersion() ?? "").split(".").map(Number);
  if (!(major > 1 || (major === 1 && minor >= 2))) {
    t.skip("Personalized OpenRouter catalogs require Pi 1.2+");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "wai-openrouter-catalog-"));
  const originalFetch = globalThis.fetch;
  const originalOffline = process.env.PI_OFFLINE;
  delete process.env.PI_OFFLINE;
  let modelId = "";
  let userRequests = 0;
  let contextWindow = 64000;
  let maxOutputTokens = 2048;
  let pricing = { prompt: "0.000001", completion: "0.000003" };
  try {
    const authPath = join(cwd, "auth.json");
    const modelsPath = join(cwd, "models.json");
    const modelsStorePath = join(cwd, "catalog.json");
    writeFileSync(authPath, JSON.stringify({ openrouter: { type: "api_key", key: "catalog-test-key" } }));
    writeFileSync(
      modelsPath,
      JSON.stringify({ providers: { openrouter: { baseUrl: "https://us.openrouter.ai/api/v1" } } }),
    );
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://catalog.test/api/models/providers/openrouter?")) {
        return new Response(null, { status: 404 });
      }
      assert.equal(url, "https://us.openrouter.ai/api/v1/models/user");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer catalog-test-key");
      userRequests++;
      return Response.json({
        data: [
          {
            id: modelId,
            context_length: 128000,
            top_provider: { context_length: contextWindow, max_completion_tokens: maxOutputTokens },
            pricing,
          },
        ],
      });
    };
    const options = {
      authPath,
      modelsPath,
      modelsStorePath,
      catalogBaseUrl: "https://catalog.test",
      ...{ refreshOnCreate: false },
    };
    const runtime = await ModelRuntime.create(options);
    const original = runtime.getModels("openrouter").find((model) => model.id !== "openrouter/auto");
    assert.ok(original);
    modelId = original.id;
    const registry = new ModelRegistry(runtime);
    assert.ok(isRegistryStreamCapable(registry));
    clearSdkRegistryOverride();
    setSdkSessionRegistry(() => registry);
    const secondary = { provider: "openrouter", id: modelId };
    const refreshOptions = { allowNetwork: true, ...{ providers: ["openrouter"], force: true } };
    const refreshed = await runtime.refresh(refreshOptions);
    assert.equal(refreshed.errors.size, 0);
    assert.equal(userRequests, 1);
    assert.equal(runtime.getModels("openrouter").length, 1);
    assert.deepEqual(await resolveBudgetModel(secondary), { ...secondary, contextWindow, maxOutputTokens });
    assert.equal(registry.find("openrouter", modelId)?.cost.input, 1);
    assert.equal(registry.find("openrouter", modelId)?.cost.output, 3);

    // A subsequent key-specific catalog replaces previous capacity; Wai must
    // read it afresh rather than retaining the initial built-in or live values.
    contextWindow = 32000;
    maxOutputTokens = 1024;
    pricing = { prompt: "-1", completion: "-1" };
    assert.equal((await runtime.refresh(refreshOptions)).errors.size, 0);
    assert.deepEqual(await resolveBudgetModel(secondary), { ...secondary, contextWindow, maxOutputTokens });
    assert.equal(registry.find("openrouter", modelId)?.cost.input, 0);
    assert.equal(registry.find("openrouter", modelId)?.cost.output, 0);
    assert.equal(userRequests, 2);

    const restored = await ModelRuntime.create(options);
    await restored.refresh({ allowNetwork: false, ...{ providers: ["openrouter"] } });
    const restoredRegistry = new ModelRegistry(restored);
    assert.ok(isRegistryStreamCapable(restoredRegistry));
    setSdkSessionRegistry(() => restoredRegistry);
    assert.deepEqual(await resolveBudgetModel(secondary), { ...secondary, contextWindow, maxOutputTokens });
    assert.equal(userRequests, 2, "offline restoration must use the saved personalized catalog");
    assert.deepEqual(await resolveBudgetModel({ ...secondary, contextWindow: 16000, maxOutputTokens: 512 }), {
      ...secondary,
      contextWindow: 16000,
      maxOutputTokens: 512,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = originalOffline;
    setSdkSessionRegistry(null);
    clearSdkRegistryOverride();
    assert.equal(dirname(realpathSync(cwd)), realpathSync(tmpdir()));
    rmSync(cwd, { recursive: true, force: true });
  }
});
