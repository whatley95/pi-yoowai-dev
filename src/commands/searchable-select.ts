import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Filters (and possibly ranks) options for a query. Empty query returns all. */
export type SearchMatcher = (options: string[], query: string) => string[];

const substringMatcher: SearchMatcher = (options, query) => {
  const normalized = query.trim().toLowerCase();
  return normalized ? options.filter((option) => option.toLowerCase().includes(normalized)) : [...options];
};

let matcherPromise: Promise<SearchMatcher> | undefined;
let matcherOverrideForTests: SearchMatcher | undefined;

/** Test hook: force the matcher so tests do not depend on whether the
 *  optional pi-tui peer dependency happens to be installed. */
export function setSearchMatcherForTests(matcher: SearchMatcher | undefined): void {
  matcherOverrideForTests = matcher;
}

/** Resolve the best available matcher: pi-tui's fuzzyFilter (the same matching
 *  Pi's own search uses — subsequence match, score-ranked, token-aware) when
 *  the peer dependency is present, plain substring matching otherwise. */
function loadSearchMatcher(): Promise<SearchMatcher> {
  if (matcherOverrideForTests) return Promise.resolve(matcherOverrideForTests);
  matcherPromise ??= (async () => {
    try {
      const mod = await import("@earendil-works/pi-tui");
      if (typeof mod.fuzzyFilter === "function") {
        return (options: string[], query: string) =>
          query.trim() ? mod.fuzzyFilter(options, query.trim(), (option) => option) : [...options];
      }
    } catch {
      // pi-tui unavailable; fall back to substring matching.
    }
    return substringMatcher;
  })();
  return matcherPromise;
}

export interface SearchState {
  options: string[];
  filtered: string[];
  query: string;
  selectedIndex: number;
  result?: string;
  cancelled: boolean;
  done: boolean;
  matcher: SearchMatcher;
}

export function createSearchState(options: string[], matcher: SearchMatcher = substringMatcher): SearchState {
  return {
    options: [...options],
    filtered: [...options],
    query: "",
    selectedIndex: 0,
    result: undefined,
    cancelled: false,
    done: false,
    matcher,
  };
}

function updateFiltered(state: SearchState): void {
  state.filtered = state.matcher(state.options, state.query);
  state.selectedIndex = Math.min(state.selectedIndex, Math.max(0, state.filtered.length - 1));
}

export function handleSearchInput(state: SearchState, data: string): void {
  for (let i = 0; i < data.length; i++) {
    const char = data[i];

    // Ctrl+C
    if (char === "\x03") {
      state.done = true;
      state.cancelled = true;
      return;
    }

    // Enter
    if (char === "\r" || char === "\n") {
      if (state.filtered.length > 0) {
        state.result = state.filtered[state.selectedIndex];
      }
      state.done = true;
      return;
    }

    // Backspace
    if (char === "\x7f" || char === "\x08") {
      state.query = state.query.slice(0, -1);
      updateFiltered(state);
      continue;
    }

    // Escape sequences
    if (char === "\x1b") {
      const seq = data.slice(i, i + 3);
      if (seq === "\x1b[A") {
        // Up
        state.selectedIndex = Math.max(0, state.selectedIndex - 1);
        i += 2;
        continue;
      }
      if (seq === "\x1b[B") {
        // Down
        state.selectedIndex = Math.min(state.filtered.length - 1, state.selectedIndex + 1);
        i += 2;
        continue;
      }
      // Plain Escape cancels
      state.done = true;
      state.cancelled = true;
      return;
    }

    // Printable character
    state.query += char;
    updateFiltered(state);
  }
}

export function renderSearchState(title: string, state: SearchState, maxVisible: number): string[] {
  const lines = [title, `Search: ${state.query}`];
  const total = state.filtered.length;

  if (total === 0) {
    lines.push("  (no matches)");
    return lines;
  }

  const start = Math.max(0, Math.min(state.selectedIndex, total - maxVisible));
  const end = Math.min(total, start + maxVisible);

  for (let i = start; i < end; i++) {
    const marker = i === state.selectedIndex ? "→" : " ";
    lines.push(`${marker} ${state.filtered[i]}`);
  }

  if (total > maxVisible) {
    lines.push(`  ${start + 1}-${end} of ${total}`);
  }

  return lines;
}

export interface SearchableSelectOptions {
  maxVisible?: number;
}

export async function searchableSelect(
  ctx: ExtensionContext,
  title: string,
  options: string[],
  opts: SearchableSelectOptions = {},
): Promise<string | undefined> {
  if (options.length === 0) return undefined;

  // Fallback to a plain select when interactive terminal input or widgets are unavailable.
  if (typeof ctx.ui.onTerminalInput !== "function" || typeof ctx.ui.setWidget !== "function") {
    return ctx.ui.select(title, options);
  }

  const maxVisible = opts.maxVisible ?? 15;
  const widgetKey = "wai-model-search";

  return new Promise<string | undefined>((resolve) => {
    // The matcher loads asynchronously (dynamic pi-tui import). Subscribe
    // immediately and buffer keystrokes so early input is not lost while it
    // resolves.
    let state: SearchState | undefined;
    const pending: string[] = [];

    const render = () => {
      if (state) ctx.ui.setWidget(widgetKey, renderSearchState(title, state, maxVisible));
    };

    const handle = (data: string) => {
      if (!state) return;
      handleSearchInput(state, data);
      if (state.done) {
        unsubscribe();
        ctx.ui.setWidget(widgetKey, undefined);
        resolve(state.cancelled ? undefined : state.result);
        return;
      }
      render();
    };

    const unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (state) {
        handle(data);
      } else {
        pending.push(data);
      }
      return { consume: true };
    });

    void loadSearchMatcher().then((matcher) => {
      state = createSearchState(options, matcher);
      render();
      for (const data of pending.splice(0)) handle(data);
    });
  });
}
