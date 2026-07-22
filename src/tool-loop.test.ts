import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeToolLoop } from "./tool-loop.js";
import type { UsageCost } from "./types.js";

function zeroUsage(): UsageCost {
  return { estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedCostUsd: 0, sessionCostUsd: 0 };
}

function makeCallModel(responses: string[]) {
  let index = 0;
  return async (_system: string, user: string) => {
    const content = responses[index++] ?? '{"done": true}';
    return { content: `${content}\n<!-- user length: ${user.length} -->`, usage: zeroUsage() };
  };
}

describe("executeToolLoop", () => {
  let cwd: string;

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "tool-loop-"));
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "foo.ts"), "export function foo(): string { return 'hello'; }\n");
  });

  it("returns content in one pass when no tool is requested", async () => {
    const responses = ['{"verdict": "pass"}'];
    const result = await executeToolLoop(cwd, "system", "user", {}, makeCallModel(responses), 2);
    assert.equal(result.content.includes('"verdict": "pass"'), true);
  });

  it("executes a read_file tool request and appends the result", async () => {
    const responses = ['{"tool": "read_file", "path": "src/foo.ts"}', '{"verdict": "pass"}'];
    const calls: Array<{ system: string; user: string }> = [];
    const callModel = async (system: string, user: string) => {
      calls.push({ system, user });
      const content = responses[calls.length - 1] ?? "{}";
      return { content, usage: zeroUsage() };
    };

    const result = await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    assert.equal(calls.length, 2);
    assert.equal(result.content, '{"verdict": "pass"}');
    const secondUser = calls[1].user;
    assert.equal(secondUser.includes("export function foo"), true);
    assert.equal(secondUser.includes("Tool result: read_file src/foo.ts"), true);
  });

  it("executes a run_command tool request and appends the result", async () => {
    const responses = ['{"tool": "run_command", "command": "node --version"}', '{"verdict": "pass"}'];
    const calls: Array<{ system: string; user: string }> = [];
    const callModel = async (system: string, user: string) => {
      calls.push({ system, user });
      const content = responses[calls.length - 1] ?? "{}";
      return { content, usage: zeroUsage() };
    };

    const result = await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    assert.equal(calls.length, 2);
    assert.equal(result.content, '{"verdict": "pass"}');
    const secondUser = calls[1].user;
    assert.equal(secondUser.includes("Tool result: run_command node --version"), true);
    assert.equal(secondUser.includes("v"), true);
  });

  it("enforces the iteration cap", async () => {
    const responses = [
      '{"tool": "read_file", "path": "src/foo.ts"}',
      '{"tool": "read_file", "path": "src/foo.ts"}',
      '{"verdict": "pass"}',
    ];
    const calls: Array<{ system: string; user: string }> = [];
    const callModel = async (system: string, user: string) => {
      calls.push({ system, user });
      const content = responses[calls.length - 1] ?? "{}";
      return { content, usage: zeroUsage() };
    };

    const result = await executeToolLoop(cwd, "system", "user", {}, callModel, 1);

    // 1 tool call + 1 cap warning + 1 forced final = 3 calls
    assert.equal(calls.length, 3);
    assert.equal(calls[2].user.includes("maximum number of tool requests"), true);
    assert.equal(result.content, '{"verdict": "pass"}');
  });

  it("rejects unsafe file paths", async () => {
    const responses = ['{"tool": "read_file", "path": "../package.json"}', '{"verdict": "pass"}'];
    const calls: Array<{ system: string; user: string }> = [];
    const callModel = async (system: string, user: string) => {
      calls.push({ system, user });
      const content = responses[calls.length - 1] ?? "{}";
      return { content, usage: zeroUsage() };
    };

    const result = await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    assert.equal(calls.length, 2);
    assert.equal(result.content, '{"verdict": "pass"}');
    const secondUser = calls[1].user;
    assert.equal(secondUser.includes("Path is not allowed"), true);
  });

  it("rejects disallowed commands", async () => {
    const responses = ['{"tool": "run_command", "command": "rm -rf node_modules"}', '{"verdict": "pass"}'];
    const calls: Array<{ system: string; user: string }> = [];
    const callModel = async (system: string, user: string) => {
      calls.push({ system, user });
      const content = responses[calls.length - 1] ?? "{}";
      return { content, usage: zeroUsage() };
    };

    const result = await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    assert.equal(calls.length, 2);
    assert.equal(result.content, '{"verdict": "pass"}');
    const secondUser = calls[1].user;
    assert.equal(secondUser.includes("not in the allowlist"), true);
  });

  it("resumes a truncated final response and stitches the tail", async () => {
    let callCount = 0;
    const callModel = async () => {
      callCount++;
      if (callCount === 1) {
        return { content: '{"verdict": "pa', usage: zeroUsage(), truncated: true };
      }
      return { content: 'ss"}', usage: zeroUsage(), truncated: false };
    };

    const result = await executeToolLoop(cwd, "system", "user", {}, callModel, 1);
    assert.equal(result.content, '{"verdict": "pass"}');
    assert.equal(result.truncated, false);
    assert.equal(callCount, 2);
  });

  it("deduplicates a resumed tail that repeats the original ending", async () => {
    let callCount = 0;
    const callModel = async () => {
      callCount++;
      if (callCount === 1) {
        return { content: '{"verdict": "pass', usage: zeroUsage(), truncated: true };
      }
      return { content: 'ss" and more', usage: zeroUsage(), truncated: false };
    };

    const result = await executeToolLoop(cwd, "system", "user", {}, callModel, 1);
    assert.equal(result.content, '{"verdict": "pass" and more');
    assert.equal(callCount, 2);
  });

  it("skips resume when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let callCount = 0;
    const callModel = async () => {
      callCount++;
      return { content: '{"verdict": "pa', usage: zeroUsage(), truncated: true };
    };

    const result = await executeToolLoop(cwd, "system", "user", { signal: controller.signal }, callModel, 1);
    assert.equal(result.content, '{"verdict": "pa');
    assert.equal(result.truncated, true);
    assert.equal(callCount, 1);
  });
});
