import { describe, it } from "node:test";
import assert from "node:assert";
import { createSearchState, handleSearchInput, renderSearchState } from "./searchable-select.js";

describe("searchable-select", () => {
  it("filters options as the query is typed", () => {
    const state = createSearchState(["openai/gpt-4o", "anthropic/claude-sonnet", "openai/gpt-3.5"]);
    handleSearchInput(state, "g");
    handleSearchInput(state, "p");
    assert.deepStrictEqual(state.filtered, ["openai/gpt-4o", "openai/gpt-3.5"]);
  });

  it("keeps all options when the query is empty", () => {
    const state = createSearchState(["a", "b"]);
    handleSearchInput(state, "x");
    handleSearchInput(state, "\x7f"); // backspace
    assert.deepStrictEqual(state.filtered, ["a", "b"]);
  });

  it("moves selection up and down with arrow keys", () => {
    const state = createSearchState(["a", "b", "c"]);
    handleSearchInput(state, "\x1b[B"); // down
    assert.strictEqual(state.selectedIndex, 1);
    handleSearchInput(state, "\x1b[B"); // down
    assert.strictEqual(state.selectedIndex, 2);
    handleSearchInput(state, "\x1b[A"); // up
    assert.strictEqual(state.selectedIndex, 1);
  });

  it("clamps selection to filtered results after narrowing", () => {
    const state = createSearchState(["alpha", "beta", "gamma"]);
    handleSearchInput(state, "\x1b[B");
    handleSearchInput(state, "\x1b[B");
    assert.strictEqual(state.selectedIndex, 2);
    handleSearchInput(state, "a");
    assert.deepStrictEqual(state.filtered, ["alpha", "beta", "gamma"]);
    handleSearchInput(state, "l");
    assert.deepStrictEqual(state.filtered, ["alpha"]);
    assert.strictEqual(state.selectedIndex, 0);
  });

  it("resolves with the selected option on Enter", () => {
    const state = createSearchState(["openai/gpt-4o", "anthropic/claude-sonnet"]);
    handleSearchInput(state, "g");
    handleSearchInput(state, "\r");
    assert.strictEqual(state.done, true);
    assert.strictEqual(state.cancelled, false);
    assert.strictEqual(state.result, "openai/gpt-4o");
  });

  it("returns undefined when Enter is pressed with no matches", () => {
    const state = createSearchState(["openai/gpt-4o"]);
    handleSearchInput(state, "zzz");
    handleSearchInput(state, "\r");
    assert.strictEqual(state.done, true);
    assert.strictEqual(state.result, undefined);
  });

  it("cancels on Escape", () => {
    const state = createSearchState(["a"]);
    handleSearchInput(state, "\x1b");
    assert.strictEqual(state.done, true);
    assert.strictEqual(state.cancelled, true);
    assert.strictEqual(state.result, undefined);
  });

  it("cancels on Ctrl+C", () => {
    const state = createSearchState(["a"]);
    handleSearchInput(state, "\x03");
    assert.strictEqual(state.done, true);
    assert.strictEqual(state.cancelled, true);
  });

  it("renders the title, query, and visible window", () => {
    const state = createSearchState(["a", "b", "c", "d", "e"]);
    handleSearchInput(state, "\x1b[B");
    handleSearchInput(state, "\x1b[B");
    const lines = renderSearchState("Pick model:", state, 3);
    assert.deepStrictEqual(lines, ["Pick model:", "Search: ", "→ c", "  d", "  e", "  3-5 of 5"]);
  });

  it("shows a no-matches message when filtered is empty", () => {
    const state = createSearchState(["a"]);
    handleSearchInput(state, "zzz");
    const lines = renderSearchState("Pick model:", state, 5);
    assert.deepStrictEqual(lines, ["Pick model:", "Search: zzz", "  (no matches)"]);
  });
});
