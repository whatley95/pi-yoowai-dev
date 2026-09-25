import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WaiModelTask, ReviewLevel } from "./types.js";

export type ProgressReporter = (stage: number, total: number, message: string) => void;

const TICK_INTERVAL_MS = 1000;

/** Reporter-local cleanup is intentionally stored outside the callable type so
 * injected test and integration callbacks remain valid ProgressReporters. */
const reporterCleanups = new WeakMap<ProgressReporter, () => void>();

/** Active reporter cleanup/render pairs per context. A reporter owns its own
 * ticker, but all reporters share Pi's single "wai" status line. */
const activeTickers = new Map<ExtensionContext, Map<() => void, () => void>>();
const clearingContexts = new WeakSet<ExtensionContext>();

function registerTicker(ctx: ExtensionContext, cleanup: () => void, render: () => void): void {
  let tickers = activeTickers.get(ctx);
  if (!tickers) {
    tickers = new Map();
    activeTickers.set(ctx, tickers);
  }
  tickers.set(cleanup, render);
}

function unregisterTicker(ctx: ExtensionContext, cleanup: () => void): void {
  const tickers = activeTickers.get(ctx);
  if (!tickers) return;
  tickers.delete(cleanup);
  if (tickers.size === 0) activeTickers.delete(ctx);
}

/** Move a rendering reporter to the end so completion restores the status most
 * recently written to Pi, rather than merely the most recently started ticker. */
function markTickerActive(ctx: ExtensionContext, cleanup: () => void): void {
  const tickers = activeTickers.get(ctx);
  if (!tickers) return;
  const render = tickers.get(cleanup);
  if (!render) return;
  tickers.delete(cleanup);
  tickers.set(cleanup, render);
}

/** Restore the most recently active reporter after another reporter finishes.
 * This prevents a completed reporter from clearing a concurrent reporter's
 * shared Pi status line. */
function isActiveStatusOwner(ctx: ExtensionContext, cleanup: () => void): boolean {
  const tickers = activeTickers.get(ctx);
  return tickers !== undefined && [...tickers.keys()].at(-1) === cleanup;
}

function renderActiveStatus(ctx: ExtensionContext): void {
  const tickers = activeTickers.get(ctx);
  const render = tickers && [...tickers.values()].at(-1);
  if (render) {
    render();
  } else {
    clearStatusText(ctx);
  }
}

export function createProgressReporter(
  action: WaiModelTask,
  ctx: ExtensionContext,
  onUpdate?: (update: unknown) => void,
  level?: ReviewLevel,
): ProgressReporter {
  let startTime = 0;
  let current: { stage: number; total: number; message: string } | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const elapsedText = () => {
    const elapsedMs = Date.now() - startTime;
    return elapsedMs > 1000 ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : "";
  };

  const renderStatus = (takeOwnership = false) => {
    if (!current) return;
    if (takeOwnership) markTickerActive(ctx, cleanup);
    if (!isActiveStatusOwner(ctx, cleanup)) return;
    try {
      ctx.ui.setStatus(
        "wai",
        `${level ? `(${level}) ` : ""}[${current.stage}/${current.total}] ${current.message}${elapsedText()}`,
      );
    } catch {
      // setStatus may not be available in all modes; ignore.
    }
  };

  const stopTicker = () => {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
    unregisterTicker(ctx, cleanup);
  };

  const startTicker = () => {
    stopTicker();
    // A long stage (e.g. waiting on the model) otherwise leaves a frozen
    // status line that looks like a hang; refresh the elapsed time every second.
    ticker = setInterval(() => renderStatus(), TICK_INTERVAL_MS);
    registerTicker(ctx, cleanup, renderStatus);
    // Never keep the process alive for a status tick.
    (ticker as { unref?: () => void }).unref?.();
  };

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    current = undefined;
    stopTicker();
    if (!clearingContexts.has(ctx)) renderActiveStatus(ctx);
  };

  const reporter: ProgressReporter = (stage: number, total: number, message: string) => {
    if (disposed) return;
    if (startTime === 0) {
      startTime = Date.now();
    }

    if (stage >= total) {
      disposed = true;
      current = undefined;
      stopTicker();
      // Re-render a concurrent reporter instead of clearing its shared status.
      renderActiveStatus(ctx);
      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: message }],
          details: {
            action,
            level,
            inProgress: false,
            progressMessage: message,
            stage,
            total,
          },
        });
      }
      return;
    }

    current = { stage, total, message };
    // Register before notifying so a re-entrant clearWaiStatus can dispose this
    // reporter before it gets a chance to create its interval.
    registerTicker(ctx, cleanup, renderStatus);

    if (onUpdate) {
      try {
        onUpdate({
          content: [{ type: "text", text: message }],
          details: {
            action,
            level,
            inProgress: true,
            progressMessage: message,
            stage,
            total,
          },
        });
      } catch (err) {
        cleanup();
        throw err;
      }
    }

    if (disposed) return;
    startTicker();
    renderStatus(true);
  };
  reporterCleanups.set(reporter, cleanup);
  return reporter;
}

/** Stop one reporter without affecting concurrent reporters on the same context.
 * Calls for ordinary injected callbacks, or repeated calls, are no-ops. */
export function cleanupProgressReporter(reporter: ProgressReporter): void {
  const cleanup = reporterCleanups.get(reporter);
  if (!cleanup) return;
  reporterCleanups.delete(reporter);
  cleanup();
}

function clearStatusText(ctx: ExtensionContext): void {
  try {
    ctx.ui.setStatus("wai", undefined);
  } catch {
    // ignore
  }
}

export function clearWaiStatus(ctx: ExtensionContext): void {
  const stops = activeTickers.get(ctx);
  clearingContexts.add(ctx);
  try {
    if (stops) {
      // cleanup() unregisters itself, so iterate over a snapshot.
      for (const cleanup of [...stops.keys()]) cleanup();
    }
  } finally {
    clearingContexts.delete(ctx);
    clearStatusText(ctx);
  }
}
