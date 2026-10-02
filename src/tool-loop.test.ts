import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeToolLoop, ToolLoopCoverageError } from "./tool-loop.js";
import { getSessionCost, recordCost } from "./cost-tracker.js";
import type { UsageCost } from "./types.js";
import { BENCHMARK_CASES } from "./review-benchmark.js";
import { readRecentLogs } from "./logger.js";

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
  after(() => rmSync(cwd, { recursive: true, force: true }));

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

  it("never sends external junction contents back to the reviewer", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wai-tool-outside-"));
    const link = join(cwd, "outside-link");
    try {
      writeFileSync(join(outside, "private.txt"), "EXTERNAL_PRIVATE_MARKER");
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      const users: string[] = [];
      await executeToolLoop(
        cwd,
        "system",
        "user",
        {},
        async (_system, user) => {
          users.push(user);
          return {
            content:
              users.length === 1
                ? JSON.stringify({ tool: "read_file", path: "outside-link/private.txt" })
                : '{"verdict":"pass"}',
            usage: zeroUsage(),
          };
        },
        2,
      );
      assert.equal(users.length, 2);
      assert.match(users[1], /Path is not allowed/);
      assert.ok(!users[1].includes("EXTERNAL_PRIVATE_MARKER"));
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
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
    const responses = ['{"tool": "read_file", "path": "src/foo.ts"}', '{"verdict": "pass"}'];
    const calls: Array<{ system: string; user: string }> = [];
    const callModel = async (system: string, user: string) => {
      calls.push({ system, user });
      const content = responses[calls.length - 1] ?? "{}";
      return { content, usage: zeroUsage() };
    };

    const result = await executeToolLoop(cwd, "system", "user", {}, callModel, 1);

    // Keep the one allowed context request, then ask for the verdict directly.
    assert.equal(calls.length, 2);
    assert.equal(calls[1].user.includes("maximum number of tool requests"), true);
    assert.equal(calls[1].system, calls[0].system, "finalization preserves the cacheable system prefix");
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
    const next = JSON.parse(toolResult.match(/next page: (\{[^\n]+\})/)![1]);
    assert.ok(next.startLine > 1, "paging must advance past the first page");
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
    for (let i = 1; i <= 5; i++) writeFileSync(join(cwd, `src/default-${i}.ts`), `EVIDENCE_${i}`);
    const calls: string[] = [];
    const callModel = async (_system: string, user: string) => {
      calls.push(user);
      return {
        content:
          calls.length <= 5
            ? JSON.stringify({ tool: "read_file", path: `src/default-${calls.length}.ts` })
            : '{"verdict":"pass"}',
        usage: zeroUsage(),
      };
    };

    await executeToolLoop(cwd, "system", "user", {}, callModel);

    // The same five permitted requests, with no discarded sixth request.
    assert.equal(calls.length, 6);
    assert.equal(calls[5].includes("maximum number of tool requests"), true);
  });

  it("fails closed when the model requests more tools after the final-only prompt", async () => {
    let calls = 0;
    await assert.rejects(
      executeToolLoop(
        cwd,
        "system",
        "user",
        {},
        async () => {
          calls++;
          return { content: '{"tool":"read_file","path":"src/foo.ts"}', usage: zeroUsage() };
        },
        1,
      ),
      /allowance exhausted/,
    );
    assert.equal(calls, 2);
  });

  it("reuses an identical read without consuming the last new-evidence request", async () => {
    writeFileSync(join(cwd, "src", "fresh.ts"), "FRESH_EVIDENCE");
    let calls = 0;
    await executeToolLoop(
      cwd,
      "system",
      "diff supplied",
      {},
      async (_system, user) => {
        calls++;
        if (calls === 3) assert.match(user, /Remaining context requests: 1/);
        if (calls === 4) {
          assert.match(user, /FRESH_EVIDENCE/);
          assert.match(user, /Remaining context requests: 0/);
        }
        return {
          content:
            calls < 4
              ? JSON.stringify({ tool: "read_file", path: calls === 3 ? "src/fresh.ts" : "src/foo.ts" })
              : '{"verdict":"pass"}',
          usage: zeroUsage(),
        };
      },
      2,
    );
    assert.equal(calls, 4);
  });

  it("bounds endless identical read requests even with a large allowance", async () => {
    let calls = 0;
    await assert.rejects(
      executeToolLoop(
        cwd,
        "system",
        "user",
        {},
        async () => {
          calls++;
          return { content: '{"tool":"read_file","path":"src/foo.ts"}', usage: zeroUsage() };
        },
        20,
      ),
      (error: unknown) => {
        assert.ok(error instanceof ToolLoopCoverageError);
        assert.deepEqual(error.coverageGaps, ["src/foo.ts"]);
        return true;
      },
    );
    assert.equal(calls, 4);
  });

  it("fails before a provider call when input is full, without recording phantom usage", async () => {
    const priorCalls = getSessionCost(cwd).calls;
    let calls = 0;
    await assert.rejects(
      executeToolLoop(cwd, "system", "user", { maxInputTokens: 1, relevantPaths: ["src/foo.ts"] }, async () => {
        calls++;
        return { content: "{}", usage: zeroUsage() };
      }),
      (error: unknown) => {
        assert.ok(error instanceof ToolLoopCoverageError);
        assert.match(error.message, /Context input allowance exhausted/);
        recordCost(cwd, error.usage);
        assert.deepEqual(error.coverageGaps, ["src/foo.ts"]);
        return true;
      },
    );
    assert.equal(calls, 0);
    assert.equal(getSessionCost(cwd).calls, priorCalls);
  });

  it("batches file reads without losing any seeded-bug or clean-control evidence", async () => {
    const files = BENCHMARK_CASES.map((fixture) => {
      const path = `src/${fixture.id}.js`;
      writeFileSync(join(cwd, path), fixture.after);
      return path;
    });
    const run = async (batchSize: number) => {
      let cursor = 0;
      const calls: string[] = [];
      const result = await executeToolLoop(
        cwd,
        "system",
        "user",
        {},
        async (_system, user) => {
          calls.push(user);
          const reads = files.slice(cursor, cursor + batchSize).map((path) => ({ tool: "read_file", path }));
          cursor += reads.length;
          return {
            content: reads.length
              ? JSON.stringify(reads.length === 1 ? reads[0] : { tools: reads })
              : '{"verdict":"pass"}',
            usage: zeroUsage(),
          };
        },
        files.length,
      );
      for (const fixture of BENCHMARK_CASES) assert.ok(calls.at(-1)!.includes(fixture.after.trim()), fixture.id);
      return { calls, result };
    };
    const serial = await run(1);
    const batched = await run(4);
    assert.equal(serial.calls.length, 9);
    assert.equal(batched.calls.length, 3);
    assert.equal(batched.result.content, serial.result.content);
  });

  it("counts every batch read against the unchanged request allowance", async () => {
    let calls = 0;
    await assert.rejects(
      executeToolLoop(
        cwd,
        "system",
        "user",
        {},
        async (_system, user) => {
          calls++;
          assert.doesNotMatch(user, /## Tool result:/, "no part of the oversized batch should execute");
          return {
            content: JSON.stringify({
              tools: Array.from({ length: 3 }, () => ({ tool: "read_file", path: "src/foo.ts" })),
            }),
            usage: zeroUsage(),
          };
        },
        2,
      ),
      /batch exceeds.*2 remaining.*after one correction/,
    );
    assert.equal(calls, 2, "only one correction call is allowed");
    await assert.rejects(
      executeToolLoop(
        cwd,
        "system",
        "user",
        {},
        async () => ({
          content: '{"tools":[{"tool":"run_command","command":"node --version"}]}',
          usage: zeroUsage(),
        }),
        2,
      ),
      /read_file only/,
    );
  });

  it("corrects an oversized batch with one request remaining without discarding or executing its reads", async () => {
    writeFileSync(join(cwd, "src", "last-read.ts"), "LAST_MISSING_EVIDENCE");
    writeFileSync(join(cwd, "src", "prior-read.ts"), "PRIOR_EVIDENCE");
    const responses = [
      '{"tools":[{"tool":"read_file","path":"src/foo.ts"},{"tool":"read_file","path":"src/prior-read.ts"}]}',
      '{"tools":[{"tool":"read_file","path":"src/foo.ts"},{"tool":"read_file","path":"src/last-read.ts"}]}',
      '{"tool":"read_file","path":"src/last-read.ts"}',
      '{"verdict":"pass"}',
    ];
    const calls: Array<{ system: string; user: string }> = [];
    const result = await executeToolLoop(
      cwd,
      "system",
      "user",
      {},
      async (system, user) => {
        calls.push({ system, user });
        if (calls.length === 2) assert.match(user, /Remaining context requests: 1\. Request at most one tool/);
        if (calls.length === 3) {
          assert.match(user, /None of these requests executed/);
          assert.match(user, /This correction does not increase the request allowance/);
          assert.ok(user.includes(responses[1]), "both rejected reads remain visible to the reviewer");
          assert.doesNotMatch(user, /LAST_MISSING_EVIDENCE/);
          assert.equal(user.match(/## Tool result:/g)?.length, 2);
        }
        if (calls.length === 4) {
          assert.match(user, /LAST_MISSING_EVIDENCE/);
          assert.match(user, /Remaining context requests: 0/);
          assert.match(user, /maximum number of tool requests/);
          assert.equal(user.match(/## Tool result:/g)?.length, 3);
        }
        return { content: responses[calls.length - 1], usage: zeroUsage() };
      },
      3,
    );
    assert.equal(result.content, '{"verdict":"pass"}');
    assert.equal(calls.length, 4);
    assert.ok(
      calls.every((call) => call.system === calls[0].system),
      "prompt-cache prefix remains stable",
    );
  });

  it("keeps an explicit incomplete-coverage result when the requested evidence cannot fit", async () => {
    let calls = 0;
    const incomplete = JSON.stringify({ verdict: "needs-work", issues: [], contextLimited: true });
    const result = await executeToolLoop(
      cwd,
      "system",
      "user",
      {},
      async (_system, user) => {
        calls++;
        if (calls === 2) {
          assert.doesNotMatch(user, /## Tool result:/);
          assert.match(user, /report incomplete coverage/);
          assert.match(user, /never claim that unread evidence was reviewed/);
        }
        return {
          content:
            calls === 1
              ? '{"tools":[{"tool":"read_file","path":"src/foo.ts"},{"tool":"read_file","path":"src/missing.ts"}]}'
              : incomplete,
          usage: zeroUsage(),
        };
      },
      1,
    );
    assert.equal(result.content, incomplete);
    assert.equal(calls, 2);
  });

  it("limits batch correction to once for the entire loop, even after valid reads", async () => {
    const responses = [
      '{"tools":[{"tool":"read_file","path":"src/foo.ts"},{"tool":"read_file","path":"src/foo.ts"},{"tool":"read_file","path":"src/foo.ts"}]}',
      '{"tool":"read_file","path":"src/foo.ts"}',
      '{"tools":[{"tool":"read_file","path":"src/foo.ts"},{"tool":"read_file","path":"src/foo.ts"}]}',
    ];
    let calls = 0;
    await assert.rejects(
      executeToolLoop(cwd, "system", "user", {}, async () => ({ content: responses[calls++], usage: zeroUsage() }), 2),
      /batch exceeds.*1 remaining.*after one correction/,
    );
    assert.equal(calls, 3);
  });

  it("honors cancellation before an oversized-batch correction makes another call", async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(
      executeToolLoop(
        cwd,
        "system",
        "user",
        { signal: controller.signal },
        async () => {
          calls++;
          controller.abort();
          return {
            content: '{"tools":[{"tool":"read_file","path":"src/foo.ts"},{"tool":"read_file","path":"src/foo.ts"}]}',
            usage: zeroUsage(),
          };
        },
        1,
      ),
      { name: "AbortError" },
    );
    assert.equal(calls, 1);
  });

  it("keeps unsafe batch paths visibly rejected while returning the allowed file", async () => {
    let calls = 0;
    await executeToolLoop(
      cwd,
      "system",
      "user",
      {},
      async (_system, user) => {
        calls++;
        if (calls === 2) {
          assert.match(user, /Path is not allowed/);
          assert.match(user, /export function foo/);
        }
        return {
          content:
            calls === 1
              ? '{"tools":[{"tool":"read_file","path":"../private.txt"},{"tool":"read_file","path":"src/foo.ts"}]}'
              : '{"verdict":"pass"}',
          usage: zeroUsage(),
        };
      },
      2,
    );
  });

  it("references an unchanged prior read, then refreshes after the file changes", async () => {
    const path = "src/reused.ts";
    writeFileSync(join(cwd, path), "ORIGINAL_EVIDENCE");
    let calls = 0;
    await executeToolLoop(
      cwd,
      "system",
      "user",
      {},
      async (_system, user) => {
        calls++;
        if (calls === 3) {
          assert.match(user, /already returned in context request 1/);
          assert.equal(user.match(/ORIGINAL_EVIDENCE/g)?.length, 1);
          writeFileSync(join(cwd, path), "UPDATED_EVIDENCE_LONGER");
        }
        if (calls === 4) assert.match(user, /UPDATED_EVIDENCE_LONGER/);
        return {
          content: calls < 4 ? JSON.stringify({ tool: "read_file", path }) : '{"verdict":"pass"}',
          usage: zeroUsage(),
        };
      },
      3,
    );
  });

  for (const ranged of [false, true]) {
    it(`pages through ${ranged ? "an absolute line range" : "a very long line"} without gaps or repeated content`, async () => {
      const lines = ranged
        ? Array.from({ length: 600 }, (_, i) => `row-${i + 1}-${"x".repeat(30)}`)
        : ["LONG_LINE_" + "x".repeat(9400) + "_TAIL"];
      const path = `src/paged-${ranged}.ts`;
      writeFileSync(join(cwd, path), lines.join("\n"));
      const pages: string[] = [];
      let next: unknown = { tool: "read_file", path, ...(ranged ? { startLine: 150, endLine: 400 } : {}) };
      await executeToolLoop(
        cwd,
        "system",
        "user",
        {},
        async (_system, user) => {
          if (pages.length > 0 || user.includes("## Tool result:")) {
            const result = user.slice(user.lastIndexOf("## Tool result:"));
            const page = result
              .slice(result.indexOf("]\n") + 2)
              .split("\n… (truncated")[0]
              .split("\n\nRemaining context requests:")[0];
            pages.push(page);
            const hint = result.match(/next page: (\{[^\n]+\})/);
            next = hint ? JSON.parse(hint[1]) : { verdict: "pass" };
            if (hint && ranged) assert.ok((next as { startLine: number }).startLine >= 150);
          }
          return { content: JSON.stringify(next), usage: zeroUsage() };
        },
        5,
      );
      assert.equal(pages.join(""), (ranged ? lines.slice(149, 400) : lines).join("\n"));
    });
  }

  it("logs correlated model/tool timings, file ranges, and repeat-read reuse", async () => {
    let calls = 0;
    await executeToolLoop(
      cwd,
      "system",
      "user",
      { task: "review", relevantPaths: ["src/foo.ts"] },
      async () => ({
        content:
          ++calls < 3 ? '{"tool":"read_file","path":"src/foo.ts","startLine":1,"endLine":1}' : '{"verdict":"pass"}',
        usage: zeroUsage(),
      }),
      2,
    );
    const logs = readRecentLogs(cwd, 100);
    const completed = logs.find((line) => line.includes("Tool loop completed") && line.includes('"toolRequests":2'))!;
    const loopId = JSON.parse(completed.split(" | ")[1]).loopId;
    const entries = logs.filter((line) => line.includes(loopId)).map((line) => JSON.parse(line.split(" | ")[1]));
    assert.ok(entries.some((entry) => entry.startLine === 1 && entry.endLine === 1 && entry.reused === true));
    assert.ok(
      entries.some((entry) => entry.modelCall === 3 && entry.finalOnly === false && entry.remainingRequests === 1),
    );
    assert.ok(
      entries.some((entry) => entry.toolRequests === 2 && entry.evidenceRequests === 1 && entry.reusedReads === 1),
    );
    assert.ok(entries.some((entry) => typeof entry.elapsedMs === "number" && entry.files?.includes("src/foo.ts")));
  });

  it("always reruns commands and records user cancellation separately from model failure", async () => {
    const script = "src/live-command.cjs";
    const countPath = join(cwd, "command-runs");
    writeFileSync(
      join(cwd, script),
      "const fs = require('node:fs'); const p = 'command-runs'; const n = fs.existsSync(p) ? Number(fs.readFileSync(p, 'utf8')) : 0; fs.writeFileSync(p, String(n + 1)); console.log(n + 1);",
    );
    let calls = 0;
    await executeToolLoop(
      cwd,
      "system",
      "user",
      {},
      async () => ({
        content:
          ++calls < 3 ? JSON.stringify({ tool: "run_command", command: `node ${script}` }) : '{"verdict":"pass"}',
        usage: zeroUsage(),
      }),
      2,
    );
    const { readFileSync } = await import("node:fs");
    assert.equal(readFileSync(countPath, "utf8"), "2");
    const controller = new AbortController();
    await assert.rejects(
      executeToolLoop(
        cwd,
        "system",
        "user",
        { signal: controller.signal },
        async () => {
          controller.abort();
          throw new Error("manual cancellation");
        },
        2,
      ),
      /manual cancellation/,
    );
    assert.ok(
      readRecentLogs(cwd).some((line) => line.includes("Tool loop model stopped") && line.includes('"cancelled":true')),
    );
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
