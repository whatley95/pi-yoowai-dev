import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCachedOAuthApiKey, setCachedOAuthApiKey, clearOAuthCache } from "./oauth-cache.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("oauth-cache", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir("pi-yoowai-oauth-cache-");
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("stores and retrieves OAuth API keys", () => {
    const credential = { type: "oauth", accessToken: "abc" };
    assert.equal(getCachedOAuthApiKey(cwd, "openai-codex", credential), undefined);
    setCachedOAuthApiKey(cwd, "openai-codex", credential, "sk-oauth-123");
    assert.equal(getCachedOAuthApiKey(cwd, "openai-codex", credential), "sk-oauth-123");
  });

  it("does not return expired keys", () => {
    const credential = { type: "oauth", accessToken: "abc" };
    setCachedOAuthApiKey(cwd, "openai-codex", credential, "sk-expired", Date.now() - 1000);
    assert.equal(getCachedOAuthApiKey(cwd, "openai-codex", credential), undefined);
  });

  it("clears the cache", () => {
    const credential = { type: "oauth", accessToken: "abc" };
    setCachedOAuthApiKey(cwd, "openai-codex", credential, "sk-oauth-123");
    clearOAuthCache(cwd);
    assert.equal(getCachedOAuthApiKey(cwd, "openai-codex", credential), undefined);
  });
});
