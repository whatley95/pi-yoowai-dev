import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchResults } from "duck-duck-scrape";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validateWaiToolParams } from "./wai-tool-params.js";
import { handleWaiSearchCommand } from "./wai-search.js";
import { setSearchFnForTests, resetSearchFnForTests } from "./doc-fetcher.js";
import { buildProjectIndex, saveProjectIndex } from "./project-index.js";
import { recordLearnedFact, type DeepVerifyModelCaller } from "./wai-learn.js";
import { setWaiLearnDeepCallerForTests } from "./index.js";
import initWai from "./index.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function mockCtx(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

function writeProjectSettings(cwd: string, settings: Record<string, unknown>): void {
  const dir = join(cwd, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ "pi-yoowai": settings }, null, 2) + "\n", "utf-8");
}

describe("validateWaiToolParams", () => {
  it("accepts an advisor question as its own action", () => {
    const result = validateWaiToolParams({ advisor: "Map or Record for this cache?" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.action, "advisor");
      assert.equal(result.params.advisor, "Map or Record for this cache?");
      assert.equal(result.params.suggest, undefined);
    }
  });

  it("rejects combining advisor with another action", () => {
    const result = validateWaiToolParams({ advisor: "which approach?", suggest: "a vs b" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Only one action per call/);
    }
  });

  it("accepts a regular action with docs", () => {
    const result = validateWaiToolParams({ suggest: "useEffect vs useLayoutEffect", docs: ["react"] });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.action, "suggest");
      assert.deepEqual(result.params.docs, ["react"]);
      assert.equal("search" in result.params, false);
    }
  });

  it("ignores a search parameter if present", () => {
    const result = validateWaiToolParams({ suggest: "Next.js caching", search: "Next.js caching 2024" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.action, "suggest");
      assert.equal("search" in result.params, false);
    }
  });

  it("rejects a call with only a search parameter", () => {
    const result = validateWaiToolParams({ search: "something" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /No action specified/);
    }
  });

  it("passes scanDeep through only for the scan action", () => {
    const scan = validateWaiToolParams({ scan: true, scanDeep: true });
    assert.equal(scan.ok, true);
    if (scan.ok) {
      assert.equal(scan.action, "scan");
      assert.equal(scan.params.scanDeep, true);
    }

    const other = validateWaiToolParams({ suggest: "q", scanDeep: true });
    assert.equal(other.ok, true);
    if (other.ok) {
      assert.equal(other.params.scanDeep, undefined);
    }
  });

  it("passes force through only for the done action", () => {
    const done = validateWaiToolParams({ done: true, force: true });
    assert.equal(done.ok, true);
    if (done.ok) {
      assert.equal(done.action, "done");
      assert.equal(done.params.force, true);
    }

    const other = validateWaiToolParams({ review: "changes", force: true });
    assert.equal(other.ok, true);
    if (other.ok) {
      assert.equal(other.params.force, undefined);
    }

    const notForced = validateWaiToolParams({ done: true });
    assert.equal(notForced.ok, true);
    if (notForced.ok) {
      assert.equal(notForced.params.force, undefined);
    }
  });
});

describe("handleWaiSearchCommand", () => {
  const tmpDirs: string[] = [];

  after(() => {
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  afterEach(() => {
    resetSearchFnForTests();
    setWaiLearnDeepCallerForTests(undefined);
  });

  it("returns usage help when query is empty", async () => {
    const result = await handleWaiSearchCommand("  ", mockCtx(makeTempDir("wai-search-empty-")));
    assert.equal(result.content[0]?.text, "Usage: /wai-search <query>");
  });

  it("reports when web search is disabled", async () => {
    const cwd = makeTempDir("wai-search-disabled-");
    tmpDirs.push(cwd);
    const result = await handleWaiSearchCommand("react hooks", mockCtx(cwd));
    assert.match(
      result.content[0]?.text ?? "",
      /Web search is disabled\. Enable it with pi-yoowai\.docs\.webSearch\.enabled/,
    );
  });

  it("returns formatted web search results when enabled", async () => {
    const cwd = makeTempDir("wai-search-enabled-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      docs: {
        sources: {},
        webSearch: { enabled: true, maxResults: 2, maxCharsPerResult: 200 },
      },
    });

    setSearchFnForTests(
      async () =>
        ({
          noResults: false,
          results: [
            {
              title: "React Hooks",
              url: "https://react.dev/reference/react",
              description: "Official React hooks reference",
            },
          ],
        }) as unknown as SearchResults,
    );

    const result = await handleWaiSearchCommand("react hooks", mockCtx(cwd));
    const text = result.content[0]?.text ?? "";
    assert.match(text, /Web search results for "react hooks"/);
    assert.match(text, /<web_search query="react hooks">/);
    assert.match(text, /React Hooks/);
  });

  it("reports no results when search returns nothing", async () => {
    const cwd = makeTempDir("wai-search-noresults-");
    tmpDirs.push(cwd);
    writeProjectSettings(cwd, {
      docs: {
        sources: {},
        webSearch: { enabled: true, maxResults: 2, maxCharsPerResult: 200 },
      },
    });

    setSearchFnForTests(
      async () =>
        ({
          noResults: true,
          results: [],
        }) as unknown as SearchResults,
    );

    const result = await handleWaiSearchCommand("xyz123nomatch", mockCtx(cwd));
    assert.equal(result.content[0]?.text, 'No results for "xyz123nomatch".');
  });
});

describe("wai extension registration", () => {
  function createMockPi(): {
    pi: ExtensionAPI;
    tools: Array<{ name: string; label?: string; description?: string }>;
    commands: Array<{ name: string; description?: string }>;
    toolDefs: Array<{ name: string } & Record<string, unknown>>;
    commandDefs: Array<{ name: string; description?: string } & Record<string, unknown>>;
    eventHandlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  } {
    const tools: Array<{ name: string; label?: string; description?: string }> = [];
    const toolDefs: Array<{ name: string } & Record<string, unknown>> = [];
    const commands: Array<{ name: string; description?: string }> = [];
    const commandDefs: Array<{ name: string; description?: string } & Record<string, unknown>> = [];
    const eventHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, []);
        eventHandlers.get(event)!.push(handler);
      },
      registerTool: (tool: { name: string; label?: string; description?: string } & Record<string, unknown>) => {
        tools.push(tool);
        toolDefs.push(tool);
      },
      registerCommand: (name: string, command: { description?: string } & Record<string, unknown>) => {
        commands.push({ name, description: command.description });
        commandDefs.push({ name, description: command.description, ...command });
      },
      registerShortcut: () => {},
      registerEntryRenderer: () => {},
      registerProvider: () => {},
      unregisterProvider: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
      ui: {
        setStatus: () => {},
        setWidget: () => {},
        select: async () => undefined,
        notify: () => {},
        input: async () => undefined,
      },
    } as unknown as ExtensionAPI;
    return { pi, tools, commands, toolDefs, commandDefs, eventHandlers };
  }

  async function runLearnCommand(
    cwd: string,
    args: string,
  ): Promise<{ selects: string[][]; notifies: Array<[string, string]> }> {
    const { pi, commandDefs } = createMockPi();
    await initWai(pi);
    const def = commandDefs.find((c) => c.name === "wai-learn");
    assert.ok(def, "wai-learn command must be registered");
    const handler = def.handler as (args: string, ctx: unknown) => Promise<void>;
    assert.ok(handler, "wai-learn must have a handler");
    const selects: string[][] = [];
    const notifies: Array<[string, string]> = [];
    const ctx = {
      cwd,
      ui: {
        select: async (_label: string, lines: string[]) => {
          selects.push(lines);
        },
        notify: (text: string, level: string) => {
          notifies.push([text, level]);
        },
        setStatus: () => {},
        clearStatus: () => {},
        input: async () => undefined,
        output: async () => undefined,
      },
    } as unknown as ExtensionContext;
    await handler(args, ctx);
    return { selects, notifies };
  }

  it("registerCommand captures handlers (mock sanity)", async () => {
    const { pi, commandDefs } = createMockPi();
    await initWai(pi);
    assert.ok(
      commandDefs.some((c) => c.name === "wai-learn" && typeof (c as { handler?: unknown }).handler === "function"),
    );
  });

  async function callLearnTool(cwd: string, params: Record<string, unknown>): Promise<string> {
    const { pi, toolDefs } = createMockPi();
    await initWai(pi);
    const def = toolDefs.find((t) => t.name === "wai_learn");
    assert.ok(def, "wai_learn must be registered");
    const execute = (def as { execute?: (...args: unknown[]) => Promise<unknown> }).execute;
    assert.ok(execute, "wai_learn must have an executor");
    const result = (await execute("t", params, undefined, undefined, { cwd } as unknown as ExtensionContext)) as {
      content: Array<{ text: string }>;
    };
    return result.content[0]?.text ?? "";
  }

  afterEach(() => {
    setWaiLearnDeepCallerForTests(undefined);
  });

  it("wai_learn lists stale facts via stale:true", async () => {
    const cwd = makeTempDir("wai-learn-stale-tool-");
    recordLearnedFact(cwd, "Fresh one.");
    recordLearnedFact(cwd, "Aged one.", { kind: "decision" });
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    const stale = store.facts.find((f) => f.fact === "Aged one.")!;
    stale.lastVerifiedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    stale.timestamp = stale.lastVerifiedAt;
    writeFileSync(path, JSON.stringify(store));

    const text = await callLearnTool(cwd, { stale: true });
    assert.match(text, /STALE/);
    assert.match(text, /Aged one/);
    assert.match(text, /verify, update, or revoke/);
    assert.ok(!text.includes("Fresh one."), "fresh facts are not in the stale listing");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("wai_learn reaffirms an entry by exact text", async () => {
    const cwd = makeTempDir("wai-learn-reaffirm-tool-");
    recordLearnedFact(cwd, "Lockfile pinned.", { kind: "decision" });
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const oldStamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    store.facts[0].lastVerifiedAt = oldStamp;
    writeFileSync(path, JSON.stringify(store));

    const text = await callLearnTool(cwd, { reaffirm: "Lockfile pinned." });
    assert.match(text, /Reaffirmed/);
    const after = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    assert.ok(
      Date.parse(after.facts[0].lastVerifiedAt!) > Date.parse(oldStamp),
      "stamp strictly newer than the aged value",
    );

    const missing = await callLearnTool(cwd, { reaffirm: "Never recorded." });
    assert.match(missing, /No matching fact/);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("wai_learn verify renews only all-clear entries", async () => {
    const cwd = makeTempDir("wai-learn-verify-tool-");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "demo.ts"), "export const demo = 1;", "utf-8");
    buildProjectIndex(cwd);
    saveProjectIndex(cwd, buildProjectIndex(cwd));
    recordLearnedFact(cwd, "Use the demo export in src/demo.ts.");
    recordLearnedFact(cwd, "Call removedFunction() to reset state.");
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    for (const f of store.facts) {
      f.lastVerifiedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    }
    writeFileSync(path, JSON.stringify(store));

    const text = await callLearnTool(cwd, { verify: true });
    assert.match(text, /Renewed 1 fact/);
    const after = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    const valid = after.facts.find((f) => f.fact.startsWith("Use the demo"))!;
    const questionable = after.facts.find((f) => f.fact.startsWith("Call removedFunction"))!;
    assert.ok(Date.parse(valid.lastVerifiedAt!) > Date.now() - 5000, "valid fact renewed");
    assert.ok(
      Date.parse(questionable.lastVerifiedAt!) <= Date.now() - 9 * 24 * 60 * 60 * 1000,
      "questionable NOT renewed",
    );
    rmSync(cwd, { recursive: true, force: true });
  });

  it("wai_learn rejects conflicting action parameters", async () => {
    const cwd = makeTempDir("wai-learn-conflict-tool-");
    const text = await callLearnTool(cwd, { fact: "X.", stale: true });
    assert.match(text, /conflicting actions/);
    const deepOnly = await callLearnTool(cwd, { deep: true });
    assert.match(deepOnly, /deep requires verify/);
    const deepStale = await callLearnTool(cwd, { stale: true, deep: true });
    assert.match(deepStale, /deep requires verify/);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("wai_learn deep verify: awaited before renewal; malformed never renews", { timeout: 20000 }, async () => {
    const cwd = makeTempDir("wai-learn-deep-tool-");
    recordLearnedFact(cwd, "Deep checked fact.");
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const oldStamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    store.facts[0].lastVerifiedAt = oldStamp;
    writeFileSync(path, JSON.stringify(store));

    // Controlled caller: signals start, then resolves AFTER a deferred tick.
    let markCallerStarted: (() => void) | undefined;
    const callerStarted = new Promise<void>((resolve) => {
      markCallerStarted = resolve;
    });
    let releaseCall: (() => void) | undefined;
    const deferred = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const caller: DeepVerifyModelCaller = async () => {
      markCallerStarted!(); // handshake: the deep pass has begun
      await deferred;
      return {
        content: "STATUS: valid\nREASON: confirmed by fixture.",
        usage: { estimatedInputTokens: 10, estimatedOutputTokens: 5, estimatedCostUsd: 0.0001, sessionCostUsd: 0.0001 },
      };
    };
    setWaiLearnDeepCallerForTests(caller);
    const pending = callLearnTool(cwd, { verify: true, deep: true });
    await callerStarted; // wait until the deep caller actually started
    // While the deep call is in flight, the stamp must still be old.
    const mid = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    assert.equal(mid.facts[0].lastVerifiedAt, oldStamp, "no renewal before the deep pass resolves");
    releaseCall!();
    const text = await pending;
    assert.match(text, /Renewed 1 fact\(s\)/);
    const after = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    assert.notEqual(after.facts[0].lastVerifiedAt, oldStamp, "valid deep result renews after resolution");

    // Malformed deep response → unconfirmed → never renews.
    setWaiLearnDeepCallerForTests(async () => ({
      content: "STATUS: validated",
      usage: { estimatedInputTokens: 10, estimatedOutputTokens: 5, estimatedCostUsd: 0.0001, sessionCostUsd: 0.0001 },
    }));
    const stampAfterValid = after.facts[0].lastVerifiedAt;
    const text2 = await callLearnTool(cwd, { verify: true, deep: true });
    assert.match(text2, /Renewed 0 fact\(s\)/);
    const after2 = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    assert.equal(after2.facts[0].lastVerifiedAt, stampAfterValid, "malformed deep result must not renew");

    // Empty content, inconclusive, and FAILING calls must leave stamps unchanged.
    for (const scenario of [
      { content: "", label: "empty" },
      { content: "STATUS: questionable\nREASON: may be stale.", label: "inconclusive" },
    ]) {
      setWaiLearnDeepCallerForTests(async () => ({
        content: scenario.content,
        usage: { estimatedInputTokens: 10, estimatedOutputTokens: 5, estimatedCostUsd: 0.0001, sessionCostUsd: 0.0001 },
      }));
      const beforeCall = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
      const textN = await callLearnTool(cwd, { verify: true, deep: true });
      assert.match(textN, /Renewed 0 fact\(s\)/, `${scenario.label} deep → 0 renewals`);
      const afterN = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
      assert.equal(
        afterN.facts[0].lastVerifiedAt,
        beforeCall.facts[0].lastVerifiedAt,
        `${scenario.label} deep must not renew`,
      );
    }
    // A throttling/failing model call rejects the tool; no renewal either.
    setWaiLearnDeepCallerForTests(async () => {
      throw new Error("provider unavailable");
    });
    const beforeFail = (JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> }).facts[0]
      .lastVerifiedAt;
    await assert.rejects(() => callLearnTool(cwd, { verify: true, deep: true }), /provider unavailable/);
    const afterFail = (JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> }).facts[0]
      .lastVerifiedAt;
    assert.equal(afterFail, beforeFail, "a failed deep call must not renew");

    // SKIPPED path: a deep query matching nothing skips all entries (no facts
    // to verify) — the caller is NEVER invoked, the store stays byte-identical
    // and 0 renewals are reported.
    let callerCalls = 0;
    setWaiLearnDeepCallerForTests(async () => {
      callerCalls++;
      throw new Error("must not be called"); // proving the skip path
    });
    const beforeSkip = readFileSync(path, "utf-8");
    const textSkip = await callLearnTool(cwd, { verify: true, deep: true, query: "zzz-no-such-fact" });
    assert.equal(callerCalls, 0, "an unmatched query must not invoke the deep caller");
    assert.match(textSkip, /Renewed 0 fact\(s\)/);
    assert.equal(readFileSync(path, "utf-8"), beforeSkip, "skipped deep verification changes nothing");
    setWaiLearnDeepCallerForTests(undefined);
    rmSync(cwd, { recursive: true, force: true });
  });
  it("wai_learn verify always reports the renewal count (0 included)", async () => {
    const cwd = makeTempDir("wai-learn-zero-tool-");
    // Build a real symbol index so removedFunction is questioned (not valid).
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "demo.ts"), "export const demo = 1;", "utf-8");
    buildProjectIndex(cwd);
    saveProjectIndex(cwd, buildProjectIndex(cwd));
    recordLearnedFact(cwd, "Call removedFunction() to reset state.");
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    store.facts[0].lastVerifiedAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(path, JSON.stringify(store));

    const text = await callLearnTool(cwd, { verify: true });
    assert.match(text, /Renewed 0 fact\(s\)/, "zero renewal must still be reported");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("/wai-learn --stale lists only aged entries via the command handler", async () => {
    const cwd = makeTempDir("wai-learn-cmd-stale-");
    recordLearnedFact(cwd, "Fresh cmd fact.");
    recordLearnedFact(cwd, "Aged cmd decision.", { kind: "decision" });
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    const stale = store.facts.find((f) => f.fact === "Aged cmd decision.")!;
    stale.lastVerifiedAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    stale.timestamp = stale.lastVerifiedAt;
    writeFileSync(path, JSON.stringify(store));

    const { selects } = await runLearnCommand(cwd, "--stale");
    assert.equal(selects.length, 1);
    const lines = selects[0].join("\n");
    assert.match(lines, /STALE/);
    assert.match(lines, /Aged cmd decision/);
    assert.ok(!lines.includes("Fresh cmd fact."), "fresh entries must not appear");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("/wai-learn --reaffirm renews and rejects unknown facts via the handler", async () => {
    const cwd = makeTempDir("wai-learn-cmd-reaffirm-");
    recordLearnedFact(cwd, "Cmd pin.", { kind: "decision" });
    recordLearnedFact(cwd, "Untouched fact.");
    const path = join(cwd, ".pi", "yoowai", "learned.json");
    const oldStamp = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const store = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    store.facts[0].lastVerifiedAt = oldStamp;
    const untouchedStamp = store.facts[1].lastVerifiedAt;
    writeFileSync(path, JSON.stringify(store));

    const ok = await runLearnCommand(cwd, "--reaffirm Cmd pin.");
    assert.equal(ok.notifies.length, 1);
    assert.match(ok.notifies[0][0], /renewed/);
    const after = JSON.parse(readFileSync(path, "utf-8")) as { facts: Array<Record<string, string>> };
    assert.ok(
      Date.parse(after.facts[0].lastVerifiedAt!) > Date.parse(oldStamp),
      "the selected entry got a NEWER stamp",
    );
    assert.equal(after.facts[1].lastVerifiedAt, untouchedStamp, "the other entry keeps its stamp");

    const missing = await runLearnCommand(cwd, "--reaffirm Nope.");
    assert.match(missing.notifies[0][0], /No matching fact/);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("/wai-learn --verify reports 0 renewals for non-valid outcomes", async () => {
    const cwd = makeTempDir("wai-learn-cmd-verify-");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "demo.ts"), "export const demo = 1;", "utf-8");
    buildProjectIndex(cwd);
    saveProjectIndex(cwd, buildProjectIndex(cwd));
    recordLearnedFact(cwd, "Call removedFunction() to reset state.");
    const { selects } = await runLearnCommand(cwd, "--verify");
    assert.equal(selects.length, 1);
    assert.match(selects[0].join("\n"), /Renewed 0 fact\(s\)/);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("registers exactly one resources_discover handler during init (design skills auto-discovery)", async () => {
    const { pi, eventHandlers } = createMockPi();
    await initWai(pi);
    const registered = eventHandlers.get("resources_discover") ?? [];
    assert.equal(registered.length, 1, "resources_discover must be registered once");
    assert.ok(registered[0], "handler must exist");
  });

  it("registers the wai_scaffold tool", async () => {
    const { pi, toolDefs } = createMockPi();
    await initWai(pi);
    const def = toolDefs.find((t) => t.name === "wai_scaffold");
    assert.ok(def, "wai_scaffold must be registered");
    // Schema: exactly four literals, minItems 1, optional boolean apply.
    const params = (def as { parameters?: unknown }).parameters as
      | {
          properties?: {
            targets?: { type?: string; items?: { anyOf?: Array<{ const?: string }> }; minItems?: number };
            apply?: { type?: string };
          };
          required?: string[];
        }
      | undefined;
    assert.ok(params, "parameters defined");
    assert.ok(params.required?.includes("targets") ?? false, "targets is required");
    assert.ok(!(params.required?.includes("apply") ?? false), "apply stays optional");
    const targets = params.properties?.targets;
    assert.equal(targets?.type, "array");
    assert.equal(targets?.minItems, 1, "targets requires at least one");
    const literals = (targets?.items?.anyOf ?? []).map((x) => x.const);
    assert.deepEqual([...literals].sort(), ["review", "security", "skill", "test"], "exactly the four target literals");
    assert.equal(params.properties?.apply?.type, "boolean");
    const execute = (def as { execute?: (...args: unknown[]) => Promise<unknown> }).execute;
    assert.ok(execute, "wai_scaffold must have an executor");
    // Preview default: no writes, no .pi directory.
    const cwd = makeTempDir("wai-scaffold-tool-");
    writeFileSync(join(cwd, "pubspec.yaml"), "name: demo\n", "utf-8");
    const result = (await execute("t", { targets: ["review"] }, undefined, undefined, {
      cwd,
    } as unknown as ExtensionContext)) as {
      content: Array<{ text: string }>;
      details?: { mode?: string };
    };
    assert.match(result.content[0]?.text ?? "", /PREVIEW/);
    assert.equal(result.details?.mode, "preview");
    assert.ok(!existsSync(join(cwd, ".pi")), "preview creates no .pi directory");
    // Render hooks exist and are invocable with representative data.
    const renderCall = (def as { renderCall?: unknown }).renderCall;
    const renderResult = (def as { renderResult?: unknown }).renderResult;
    assert.equal(typeof renderCall, "function", "renderCall registered");
    assert.equal(typeof renderResult, "function", "renderResult registered");
    const theme = { fg: (_t: string, text: string) => text, bg: (_t: string, text: string) => text };
    const { Text } = await import("@earendil-works/pi-tui");
    const callTitle = (
      (renderCall as (a: unknown, t: unknown, c: unknown) => unknown)(
        { targets: ["skill"], apply: true },
        theme,
        {},
      ) as {
        render: (w: number) => string[];
      }
    )
      .render(200)
      .join("\n")
      .trimEnd();
    assert.match(callTitle, /wai scaffold: skill/);
    assert.match(callTitle, /\(apply\)/);
    const resultTitle = (
      (renderResult as (r: unknown, o: unknown, t: unknown, c: unknown) => unknown)(
        result, // the ACTUAL executor result — no fabricated shape
        { status: "ok" },
        theme,
        {},
      ) as { render: (w: number) => string[] }
    )
      .render(200)
      .join("\n")
      .trimEnd();
    assert.match(resultTitle, /wai scaffold/);
    assert.ok(Text === undefined || typeof Text === "function", "pi-tui Text available for assertions");
    rmSync(cwd, { recursive: true, force: true });
  });

  it("registers the explicit review-depth tools", async () => {
    const { pi, tools } = createMockPi();
    await initWai(pi);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("wai_review_min"), `expected wai_review_min in ${names.join(", ")}`);
    assert.ok(names.includes("wai_review_med"), `expected wai_review_med in ${names.join(", ")}`);
    assert.ok(names.includes("wai_review_high"), `expected wai_review_high in ${names.join(", ")}`);
  });

  it("registers slash commands for explicit review levels", async () => {
    const { pi, commands } = createMockPi();
    await initWai(pi);
    const names = commands.map((c) => c.name);
    assert.ok(names.includes("wai-review-min"), `expected wai-review-min in ${names.join(", ")}`);
    assert.ok(names.includes("wai-review-med"), `expected wai-review-med in ${names.join(", ")}`);
    assert.ok(names.includes("wai-review-high"), `expected wai-review-high in ${names.join(", ")}`);
  });
});
