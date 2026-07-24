import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import {
  createSearchState,
  handleSearchInput,
  searchableSelect,
  setSearchMatcherForTests,
} from "./searchable-select.js";

function typeText(state: Parameters<typeof handleSearchInput>[0], text: string): void {
  handleSearchInput(state, text);
}

describe("searchable-select matcher", () => {
  afterEach(() => {
    setSearchMatcherForTests(undefined);
  });

  it("filters by substring with the default matcher", () => {
    const state = createSearchState(["deepseek-r1", "gpt-5", "claude-sonnet"]);
    typeText(state, "gpt");
    assert.deepStrictEqual(state.filtered, ["gpt-5"]);
  });

  it("uses an injected matcher and respects its ranking", () => {
    const fuzzy = (options: string[], query: string) =>
      query ? [...options].sort((a, b) => a.indexOf(query) - b.indexOf(query)) : [...options];
    const state = createSearchState(["xxgptxx", "gpt"], fuzzy);
    typeText(state, "gpt");
    assert.deepStrictEqual(state.filtered, ["gpt", "xxgptxx"]);
  });

  it("fuzzy-matches non-consecutive queries via pi-tui (dsr1 -> deepseek-r1)", () => {
    const fuzzy = (options: string[], query: string) =>
      query.trim() ? fuzzyFilter(options, query.trim(), (o) => o) : [...options];
    const state = createSearchState(["deepseek-r1", "gpt-5"], fuzzy);
    typeText(state, "dsr1");
    assert.deepStrictEqual(state.filtered, ["deepseek-r1"]);
  });

  it("searchableSelect fuzzy-matches with the real pi-tui matcher", async () => {
    let inputCb: (data: string) => { consume: boolean } = () => ({ consume: false });
    const ctx = {
      ui: {
        onTerminalInput: (cb: (data: string) => { consume: boolean }) => {
          inputCb = cb;
          return () => {};
        },
        setWidget: () => {},
        select: async () => undefined,
        input: async () => undefined,
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    const promise = searchableSelect(ctx, "Pick model:", ["deepseek-r1", "gpt-5"]);
    inputCb("dsr1");
    inputCb("\r");
    const result = await promise;
    assert.strictEqual(result, "deepseek-r1");
  });

  it("searchableSelect falls back to substring when the matcher override is a substring matcher", async () => {
    setSearchMatcherForTests((options, query) =>
      options.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase())),
    );
    let inputCb: (data: string) => { consume: boolean } = () => ({ consume: false });
    const ctx = {
      ui: {
        onTerminalInput: (cb: (data: string) => { consume: boolean }) => {
          inputCb = cb;
          return () => {};
        },
        setWidget: () => {},
        select: async () => undefined,
        input: async () => undefined,
        notify: () => {},
      },
    } as unknown as ExtensionContext;

    const promise = searchableSelect(ctx, "Pick model:", ["deepseek-r1", "gpt-5"]);
    inputCb("gpt");
    inputCb("\r");
    const result = await promise;
    assert.strictEqual(result, "gpt-5");
  });
});
