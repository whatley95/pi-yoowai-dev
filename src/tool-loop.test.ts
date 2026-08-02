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

  it("reads a specific line range from a file", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}-content`).join("\n");
    writeFileSync(join(cwd, "src", "ranged.ts"), lines, "utf-8");
    const responses = [
      '{"tool": "read_file", "path": "src/ranged.ts", "startLine": 3, "endLine": 5}',
      '{"done": true}',
    ];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    const toolResult = calls[1];
    assert.equal(toolResult.includes("line-3-content"), true);
    assert.equal(toolResult.includes("line-5-content"), true);
    assert.equal(toolResult.includes("line-1-content"), false);
    assert.equal(toolResult.includes("line-6-content"), false);
  });

  it("clamps and swaps inverted line ranges", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `row-${i + 1}`).join("\n");
    writeFileSync(join(cwd, "src", "inverted.ts"), lines, "utf-8");
    const responses = [
      '{"tool": "read_file", "path": "src/inverted.ts", "startLine": 8, "endLine": 2}',
      '{"done": true}',
    ];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    const toolResult = calls[1];
    assert.equal(toolResult.includes("row-2"), true);
    assert.equal(toolResult.includes("row-8"), true);
    assert.equal(toolResult.includes("row-1\n"), false);
    assert.equal(toolResult.includes("row-9"), false);
  });

  it("ignores non-numeric range fields", async () => {
    const responses = ['{"tool": "read_file", "path": "src/foo.ts", "startLine": "abc"}', '{"done": true}'];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    assert.equal(calls[1].includes("export function foo"), true);
  });

  it("appends a paging hint when file content is truncated", async () => {
    const big = Array.from({ length: 500 }, (_, i) => `const value${i} = "xxxxxxxxxxxxxxxxxxxx";`).join("\n");
    writeFileSync(join(cwd, "src", "big.ts"), big, "utf-8");
    const responses = ['{"tool": "read_file", "path": "src/big.ts"}', '{"done": true}'];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    const toolResult = calls[1];
    assert.equal(toolResult.includes("truncated — file has 500 lines"), true);
    assert.equal(toolResult.includes('"startLine":1'), true);
  });

  it("truncates run_command output keeping head and tail", async () => {
    mkdirSync(join(cwd, "scripts"), { recursive: true });
    writeFileSync(
      join(cwd, "scripts", "long-output.js"),
      'for (let i = 0; i < 400; i++) console.log("line-" + i + "-" + "x".repeat(20));',
      "utf-8",
    );
    const responses = ['{"tool": "run_command", "command": "node scripts/long-output.js"}', '{"done": true}'];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    const toolResult = calls[1];
    assert.equal(toolResult.includes("chars elided"), true);
    assert.equal(toolResult.includes("line-0-"), true, "head should be kept");
    assert.equal(toolResult.includes("line-399-"), true, "tail should be kept");
    assert.equal(toolResult.includes("line-200-"), false, "middle should be elided");
  });

  it("defaults to 5 tool iterations when maxToolIterations is omitted", async () => {
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: '{"tool": "read_file", "path": "src/foo.ts"}', usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel);

    // 5 tool requests within the cap + 1 at the cap + 1 forced final call.
    assert.equal(calls.length, 7);
    assert.equal(calls[6].includes("maximum number of tool requests"), true);
  });

  it("executes a search_code request and returns file:line matches with context", async () => {
    const responses = ['{"tool": "search_code", "pattern": "foo", "contextLines": 0}', '{"verdict": "pass"}'];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    const toolResult = calls[1];
    assert.equal(toolResult.includes("Tool result: search_code /foo/"), true);
    assert.equal(toolResult.includes("src/foo.ts:1: export function foo"), true);
  });

  it("reports when search_code finds no matches", async () => {
    const responses = ['{"tool": "search_code", "pattern": "zzz-no-such-thing"}', '{"verdict": "pass"}'];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    assert.equal(calls[1].includes("No matches for /zzz-no-such-thing/"), true);
  });

  it("rejects an invalid search_code regex", async () => {
    const responses = ['{"tool": "search_code", "pattern": "("}', '{"verdict": "pass"}'];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    assert.equal(calls[1].includes("Invalid regex"), true);
  });

  it("rejects catastrophic search_code patterns without executing them", async () => {
    const responses = ['{"tool": "search_code", "pattern": "(a+)+"}', '{"verdict": "pass"}'];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    assert.equal(calls.length, 2);
    assert.equal(calls[1].includes("nested quantifiers"), true);
  });

  it("rejects overlong search_code patterns", async () => {
    const longPattern = "a".repeat(201);
    const responses = [`{"tool": "search_code", "pattern": "${longPattern}"}`, '{"verdict": "pass"}'];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    assert.equal(calls.length, 2);
    assert.equal(calls[1].includes("pattern too long"), true);
  });

  it("skips very long (minified) lines when searching", async () => {
    writeFileSync(join(cwd, "src", "minified.ts"), "x".repeat(12_000) + " needle\n", "utf-8");
    const responses = ['{"tool": "search_code", "pattern": "needle", "contextLines": 0}', '{"verdict": "pass"}'];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    assert.equal(calls.length, 2);
    assert.equal(calls[1].includes("No matches for /needle/"), true);
  });

  it("scopes search_code to a directory path", async () => {
    writeFileSync(join(cwd, "root-match.ts"), "export const fooOutside = 1;\n", "utf-8");
    const responses = [
      '{"tool": "search_code", "pattern": "foo", "path": "src", "contextLines": 0}',
      '{"verdict": "pass"}',
    ];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    const toolResult = calls[1];
    assert.equal(toolResult.includes("src/foo.ts:1:"), true);
    assert.equal(toolResult.includes("root-match.ts"), false, "matches outside the scope must be excluded");
  });

  it("stops search_code after the match cap", async () => {
    mkdirSync(join(cwd, "many"), { recursive: true });
    const lines = Array.from({ length: 80 }, (_, i) => `export const match${i} = ${i};`).join("\n");
    writeFileSync(join(cwd, "many", "matches.ts"), lines + "\n", "utf-8");
    const responses = [
      '{"tool": "search_code", "pattern": "match", "path": "many", "contextLines": 0}',
      '{"verdict": "pass"}',
    ];
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return { content: responses[calls.length - 1] ?? "{}", usage: zeroUsage() };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel, 2);

    const toolResult = calls[1];
    assert.equal(toolResult.includes("stopped after 50 matches"), true);
    assert.equal(toolResult.includes("match79"), false, "matches past the cap must not appear");
  });
});
