import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadTool, createGrepTool } from "@earendil-works/pi-coding-agent";
import { dispatchNativeReadTool, withNativeReadTools } from "./read-tools.js";
import { executeToolLoop, type ToolRequest } from "../tool-loop.js";

const usage = { estimatedInputTokens: 0, estimatedOutputTokens: 0, estimatedCostUsd: 0, sessionCostUsd: 0 };
const outcome = (text: string, isError = false, details?: Record<string, unknown>) => ({
  isError,
  result: { content: [{ type: "text", text }], details },
});

describe("Pi read tool dispatch", () => {
  let cwd: string;
  before(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-native-reads-"));
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, "src", "one.ts"), "LOCAL_PRIVATE_MARKER\n");
    writeFileSync(join(cwd, ".pi", "state.json"), "STATE_PRIVATE_MARKER");
  });
  after(() => rmSync(cwd, { recursive: true, force: true }));

  function context(
    executeTool: (name: string, args: Record<string, unknown>, options: { signal?: AbortSignal }) => Promise<unknown>,
  ) {
    return { cwd, tools: [{ name: "read" }, { name: "grep" }], executeTool };
  }
  async function review(requests: ToolRequest[], signal?: AbortSignal): Promise<string> {
    let index = 0;
    let prompt = "";
    await executeToolLoop(
      cwd,
      "system",
      "user",
      { signal },
      async (_system, user) => {
        prompt = user;
        return { content: index < requests.length ? JSON.stringify(requests[index++]) : '{"verdict":"pass"}', usage };
      },
      requests.length,
    );
    return prompt;
  }

  it("forwards approved native reads with absolute paths, line bounds and the caller signal", async () => {
    const signal = new AbortController().signal;
    const calls: unknown[] = [];
    const prompt = await withNativeReadTools(
      context(async (name, args, options) => {
        calls.push({ name, args, signal: options.signal });
        return outcome("HOST_APPROVED_CONTEXT");
      }),
      () => review([{ tool: "read_file", path: "src/one.ts", startLine: 5, endLine: 2 }], signal),
    );
    assert.deepEqual(calls, [
      { name: "read", args: { path: join(cwd, "src", "one.ts"), offset: 2, limit: 4 }, signal },
    ]);
    assert.match(prompt, /HOST_APPROVED_CONTEXT/);
    assert.doesNotMatch(prompt, /LOCAL_PRIVATE_MARKER/);
  });

  it("does not bypass a failed or disabled Pi tool through the local reader", async () => {
    for (const native of [
      context(async () => outcome("Blocked by host policy", true)),
      {
        ...context(async () => {
          throw new Error("must not run");
        }),
        tools: [],
      },
    ]) {
      const prompt = await withNativeReadTools(native, () => review([{ tool: "read_file", path: "src/one.ts" }]));
      assert.match(prompt, /Blocked by host policy|not callable/);
      assert.doesNotMatch(prompt, /LOCAL_PRIVATE_MARKER/);
    }
  });

  it("retains the local reader only when the native execution API is absent", async () => {
    const prompt = await withNativeReadTools({ cwd }, () => review([{ tool: "read_file", path: "src/one.ts" }]));
    assert.match(prompt, /LOCAL_PRIVATE_MARKER/);
    assert.equal(await dispatchNativeReadTool(cwd, "read", {}), undefined);
  });

  it("advertises only callable native reads/searches, including Pi's default read-only availability", async () => {
    for (const names of [["read"], ["grep"], []]) {
      const native = { ...context(async () => outcome("must not run")), tools: names.map((name) => ({ name })) };
      await withNativeReadTools(native, () =>
        executeToolLoop(cwd, "system", "user", {}, async (system) => {
          assert.equal(system.includes('{"tool": "read_file"'), names.includes("read"));
          assert.equal(system.includes('{"tool": "search_code"'), names.includes("grep"));
          if (!names.includes("read")) assert.match(system, /read_file is unavailable/);
          if (!names.includes("grep")) assert.match(system, /search_code is unavailable/);
          assert.match(system, /Never bypass an unavailable or blocked operation/);
          return { content: '{"verdict":"pass"}', usage };
        }),
      );
    }
  });

  it("fails closed when a native API omits its callable-tool list", async () => {
    const native = {
      ...context(async () => {
        assert.fail("unlisted tool must not execute");
      }),
      tools: undefined,
    };
    const prompt = await withNativeReadTools(native, () => review([{ tool: "read_file", path: "src/one.ts" }]));
    assert.match(prompt, /not callable/);
    assert.doesNotMatch(prompt, /LOCAL_PRIVATE_MARKER/);
  });

  it("rejects traversal and external junctions before native dispatch", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wai-native-outside-"));
    const link = join(cwd, "external");
    let calls = 0;
    try {
      writeFileSync(join(outside, "private.txt"), "OUTSIDE_PRIVATE_MARKER");
      symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
      const prompt = await withNativeReadTools(
        context(async () => {
          calls++;
          return outcome("must not read");
        }),
        () =>
          review([
            { tool: "read_file", path: "../private.txt" },
            { tool: "read_file", path: "external/private.txt" },
            { tool: "search_code", pattern: "private", path: "external" },
          ]),
      );
      assert.equal(calls, 0);
      assert.match(prompt, /Path is not allowed/);
      assert.doesNotMatch(prompt, /OUTSIDE_PRIVATE_MARKER/);
    } finally {
      rmSync(link, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("revalidates repeated native reads instead of trusting local file timestamps", async () => {
    let calls = 0;
    const prompt = await withNativeReadTools(
      context(async () => outcome(`HOST_VERSION_${++calls}`)),
      () =>
        review([
          { tool: "read_file", path: "src/one.ts" },
          { tool: "read_file", path: "src/one.ts" },
        ]),
    );
    assert.equal(calls, 2);
    assert.match(prompt, /HOST_VERSION_1/);
    assert.match(prompt, /HOST_VERSION_2/);
    assert.doesNotMatch(prompt, /unchanged file\/range/);
  });

  it("rechecks host permissions but avoids repeating identical approved source in the model prompt", async () => {
    let calls = 0;
    const prompt = await withNativeReadTools(
      context(async () => {
        calls++;
        return outcome("IDENTICAL_APPROVED_SOURCE");
      }),
      () =>
        review([
          { tool: "read_file", path: "src/one.ts" },
          { tool: "read_file", path: "src/one.ts" },
        ]),
    );
    assert.equal(calls, 2, "both requests must go through Pi's policy hooks");
    assert.equal(prompt.match(/IDENTICAL_APPROVED_SOURCE/g)?.length, 1);
    assert.match(prompt, /same approved Pi read output.*context request 1/);
  });

  it("preserves native pages without treating host annotations as source lines", async () => {
    const source = "x".repeat(3999) + "🚀" + "y".repeat(30);
    const native = context(async () => outcome(source));
    const first = await withNativeReadTools(native, () => review([{ tool: "read_file", path: "src/one.ts" }]));
    const next = JSON.parse(first.match(/next page: (\{[^\n]+\})/)![1]) as ToolRequest;
    assert.equal(next.offset, 3999);
    assert.equal(next.startLine, 1);
    const second = await withNativeReadTools(native, () => review([next]));
    assert.match(second, /🚀y+/);
    assert.doesNotMatch(first, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("maps native source truncation to a wai line request and rejects unreadable giant lines", async () => {
    const prompt = await withNativeReadTools(
      context(async () => outcome("two\nlines", false, { truncation: { truncated: true, outputLines: 2 } })),
      () => review([{ tool: "read_file", path: "src/one.ts", startLine: 10, endLine: 99 }]),
    );
    const next = JSON.parse(prompt.match(/next page: (\{[^\n]+\})/)![1]) as ToolRequest;
    assert.equal(next.startLine, 12);
    assert.equal(next.endLine, 99);
    const rejected = await withNativeReadTools(
      context(async () => outcome("host suggests bash", false, { truncation: { firstLineExceedsLimit: true } })),
      () => review([{ tool: "read_file", path: "src/one.ts" }]),
    );
    assert.match(rejected, /Required context is incomplete/);
    assert.doesNotMatch(rejected, /host suggests bash|LOCAL_PRIVATE_MARKER/);
  });

  it("searches only individually approved project files and preserves regex guards", async () => {
    const paths: string[] = [];
    const native = context(async (name, args) => {
      assert.equal(name, "grep");
      assert.equal(args.context, 2);
      assert.equal(args.limit, 50);
      paths.push(args.path as string);
      return outcome("one.ts:1: HOST_SEARCH_MATCH");
    });
    const prompt = await withNativeReadTools(native, () =>
      review([{ tool: "search_code", pattern: "MARKER", path: "src", contextLines: 2 }]),
    );
    assert.deepEqual(paths, [join(cwd, "src", "one.ts")]);
    assert.match(prompt, /HOST_SEARCH_MATCH/);
    assert.doesNotMatch(prompt, /LOCAL_PRIVATE_MARKER|STATE_PRIVATE_MARKER/);
    paths.length = 0;
    const rejected = await withNativeReadTools(native, () => review([{ tool: "search_code", pattern: "(a+)+" }]));
    assert.equal(paths.length, 0);
    assert.match(rejected, /pattern rejected/);
  });

  it("reports blocked and truncated native searches without a local fallback", async () => {
    const blocked = await withNativeReadTools(
      context(async () => outcome("SEARCH_DENIED", true)),
      () => review([{ tool: "search_code", pattern: "PRIVATE", path: "src" }]),
    );
    assert.match(blocked, /SEARCH_DENIED/);
    assert.doesNotMatch(blocked, /LOCAL_PRIVATE_MARKER/);
    const capped = await withNativeReadTools(
      context(async () => outcome("one.ts:1: " + "x".repeat(9000), false, { matchLimitReached: 50 })),
      () => review([{ tool: "search_code", pattern: "PRIVATE", path: "src" }]),
    );
    assert.match(capped, /search incomplete/);
    assert.match(capped, /search results truncated/);
    assert.ok(capped.length < 5000);
  });

  it("isolates concurrent invocations and refuses a different project context", async () => {
    const results = await Promise.all(
      ["first", "second"].map((label) =>
        withNativeReadTools(
          context(async () => {
            await Promise.resolve();
            return outcome(label);
          }),
          () => dispatchNativeReadTool(cwd, "read", {}),
        ),
      ),
    );
    assert.deepEqual(
      results.map((result) => result?.output),
      ["first", "second"],
    );
    const other = await withNativeReadTools(
      context(async () => outcome("must not run")),
      () => dispatchNativeReadTool(join(cwd, "other"), "read", {}),
    );
    assert.match(other!.error!, /another project/);
  });

  it("propagates abort and rejects non-text native results", async () => {
    const controller = new AbortController();
    await assert.rejects(
      withNativeReadTools(
        context(async () => {
          controller.abort(new Error("review cancelled"));
          return outcome("obsolete context");
        }),
        () => review([{ tool: "read_file", path: "src/one.ts" }], controller.signal),
      ),
      /review cancelled/,
    );
    const rejected = await withNativeReadTools(
      context(async () => ({ isError: false, result: { content: [{ type: "image", data: "PRIVATE_IMAGE" }] } })),
      () => review([{ tool: "read_file", path: "src/one.ts" }]),
    );
    assert.match(rejected, /non-text or invalid/);
    assert.doesNotMatch(rejected, /PRIVATE_IMAGE/);
  });

  it("uses Pi's real read tool with wai's range mapping", async () => {
    const tool = createReadTool(cwd);
    const native = context(async (_name, args, options) => ({
      isError: false,
      result: await tool.execute("wai/read", args as Parameters<typeof tool.execute>[1], options.signal),
    }));
    const prompt = await withNativeReadTools(native, () =>
      review([{ tool: "read_file", path: "src/one.ts", startLine: 1, endLine: 1 }]),
    );
    assert.match(prompt, /LOCAL_PRIVATE_MARKER/);
    assert.match(prompt, /Pi read from line 1/);
  });

  it("batches broad searches into bounded exact-path globs instead of one call per file", async () => {
    const directory = join(cwd, "batch");
    mkdirSync(directory);
    try {
      for (let i = 0; i < 80; i++) writeFileSync(join(directory, `file${i}.ts`), "empty");
      const calls: Record<string, unknown>[] = [];
      const prompt = await withNativeReadTools(
        context(async (_name, args) => {
          calls.push(args);
          assert.equal(args.path, cwd);
          assert.ok((args.glob as string).length < 2005);
          assert.ok(new Set((args.glob as string).match(/file\d+\.ts/g)).size <= 32);
          return outcome("No matches found");
        }),
        () => review([{ tool: "search_code", pattern: "missing", path: "batch" }]),
      );
      assert.ok(calls.length >= 3 && calls.length < 12, "bounded groups should use far fewer than 80 host calls");
      assert.match(prompt, /No matches/);
      assert.equal(
        new Set(
          calls
            .map((args) => args.glob)
            .join("")
            .match(/batch\/file\d+\.ts/g),
        ).size,
        80,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses Pi's real grep with literal glob metacharacters and excludes generated/state files", async () => {
    const directory = join(cwd, "glob-case");
    mkdirSync(directory);
    writeFileSync(join(directory, "literal[one],two.ts"), "GLOB_SOURCE_MARKER");
    writeFileSync(join(directory, "other.ts"), "other");
    writeFileSync(join(directory, "generated.class"), "GLOB_GENERATED_PRIVATE_MARKER");
    const tool = createGrepTool(cwd);
    let calls = 0;
    try {
      const prompt = await withNativeReadTools(
        context(async (_name, args, options) => {
          calls++;
          return {
            isError: false,
            result: await tool.execute("wai/grep", args as Parameters<typeof tool.execute>[1], options.signal),
          };
        }),
        () => review([{ tool: "search_code", pattern: "GLOB_", path: "glob-case", contextLines: 0 }]),
      );
      assert.equal(calls, 1);
      assert.match(prompt, /literal\[one\],two\.ts:1: GLOB_SOURCE_MARKER/);
      assert.doesNotMatch(prompt, /GLOB_GENERATED_PRIVATE_MARKER|STATE_PRIVATE_MARKER|Error:/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
