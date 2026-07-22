import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiKey, readRawAuthEntry } from "./auth-reader.js";
import { getAgentDir, setAgentDirForTests } from "./pi-paths.js";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
];

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("auth-reader", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const originalAgentDir = getAgentDir();
  let tempAgentDir: string | undefined;

  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (tempAgentDir) {
      try {
        rmSync(tempAgentDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      tempAgentDir = undefined;
    }
    setAgentDirForTests(() => originalAgentDir);
  });

  it("returns configKey directly when it is a plain string", () => {
    assert.equal(resolveApiKey("anthropic", "sk-test-123"), "sk-test-123");
  });

  it("resolves $ENV indirection", () => {
    process.env.MY_TEST_KEY = "from-env";
    assert.equal(resolveApiKey("anthropic", "$MY_TEST_KEY"), "from-env");
    delete process.env.MY_TEST_KEY;
  });

  it("resolves ${ENV} indirection", () => {
    process.env.MY_TEST_KEY2 = "from-braces";
    assert.equal(resolveApiKey("anthropic", "${MY_TEST_KEY2}"), "from-braces");
    delete process.env.MY_TEST_KEY2;
  });

  it("returns undefined for missing $ENV", () => {
    delete process.env.NONEXISTENT_KEY;
    assert.equal(resolveApiKey("anthropic", "$NONEXISTENT_KEY"), undefined);
  });

  it("returns undefined for missing ${ENV}", () => {
    delete process.env.NONEXISTENT_KEY2;
    assert.equal(resolveApiKey("anthropic", "${NONEXISTENT_KEY2}"), undefined);
  });

  it("falls back to provider env var when no configKey", () => {
    process.env.ANTHROPIC_API_KEY = "sk-from-anthropic-env";
    assert.equal(resolveApiKey("anthropic"), "sk-from-anthropic-env");
  });

  it("maps opencode-go to OPENCODE_API_KEY (when no auth.json entry)", () => {
    // Use groq which is not in auth.json to test env var fallback.
    process.env.GROQ_API_KEY = "groq-key";
    assert.equal(resolveApiKey("groq"), "groq-key");
  });

  it("maps google to GEMINI_API_KEY", () => {
    process.env.GEMINI_API_KEY = "gemini-key";
    assert.equal(resolveApiKey("google"), "gemini-key");
  });

  it("returns undefined when no key found anywhere", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    assert.equal(resolveApiKey("anthropic"), undefined);
  });

  it("rejects shell metacharacters in !command", () => {
    assert.equal(resolveApiKey("anthropic", "!cat file; rm -rf /"), undefined);
  });

  it("rejects non-allowlisted commands", () => {
    assert.equal(resolveApiKey("anthropic", "!rm -rf /"), undefined);
  });

  it("rejects newlines in !command", () => {
    assert.equal(resolveApiKey("anthropic", "!echo hello\nworld"), undefined);
  });

  it("returns undefined for unknown provider with no configKey", () => {
    for (const k of ENV_KEYS) delete process.env[k];
    assert.equal(resolveApiKey("unknown-provider"), undefined);
  });

  it("reads raw OAuth credential from auth.json", () => {
    tempAgentDir = makeTempDir("pi-yoowai-auth-");
    mkdirSync(tempAgentDir, { recursive: true });
    writeFileSync(
      join(tempAgentDir, "auth.json"),
      JSON.stringify({ "openai-codex": { type: "oauth", accessToken: "oauth-token" } }),
      "utf-8",
    );
    setAgentDirForTests(() => tempAgentDir!);

    const entry = readRawAuthEntry("openai-codex");
    assert.deepEqual(entry, { type: "oauth", accessToken: "oauth-token" });
    assert.equal(resolveApiKey("openai-codex"), undefined);
  });
});
