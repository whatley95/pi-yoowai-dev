import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SearchState {
  options: string[];
  filtered: string[];
  query: string;
  selectedIndex: number;
  result?: string;
  cancelled: boolean;
  done: boolean;
}

export function createSearchState(options: string[]): SearchState {
  return {
    options: [...options],
    filtered: [...options],
    query: "",
    selectedIndex: 0,
    result: undefined,
    cancelled: false,
    done: false,
  };
}

function updateFiltered(state: SearchState): void {
  const normalized = state.query.trim().toLowerCase();
  state.filtered = normalized
    ? state.options.filter((option) => option.toLowerCase().includes(normalized))
    : [...state.options];
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

  const state = createSearchState(options);
  const maxVisible = opts.maxVisible ?? 15;
  const widgetKey = "wai-model-search";

  const render = () => {
    ctx.ui.setWidget(widgetKey, renderSearchState(title, state, maxVisible));
  };

  return new Promise<string | undefined>((resolve) => {
    const unsubscribe = ctx.ui.onTerminalInput((data) => {
      handleSearchInput(state, data);
      if (state.done) {
        unsubscribe();
        ctx.ui.setWidget(widgetKey, undefined);
        resolve(state.cancelled ? undefined : state.result);
        return { consume: true };
      }
      render();
      return { consume: true };
    });
    render();
  });
}
