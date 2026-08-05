import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WaiModelTask, ReviewLevel } from "./types.js";

export type ProgressReporter = (stage: number, total: number, message: string) => void;

const TICK_INTERVAL_MS = 1000;

/** Active ticker stop functions per ctx. clearWaiStatus stops them all, so a
 *  reporter that never saw its final stage (early return / exception) cannot
 *  resurrect a cleared status line one second later. */
const activeTickers = new Map<ExtensionContext, Set<() => void>>();

function registerTicker(ctx: ExtensionContext, stop: () => void): void {
  let stops = activeTickers.get(ctx);
  if (!stops) {
    stops = new Set();
    activeTickers.set(ctx, stops);
  }
  stops.add(stop);
}

function unregisterTicker(ctx: ExtensionContext, stop: () => void): void {
  const stops = activeTickers.get(ctx);
  if (!stops) return;
  stops.delete(stop);
  if (stops.size === 0) activeTickers.delete(ctx);
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

  const elapsedText = () => {
    const elapsedMs = Date.now() - startTime;
    return elapsedMs > 1000 ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : "";
  };

  const renderStatus = () => {
    if (!current) return;
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
      unregisterTicker(ctx, stopTicker);
    }
  };

  const startTicker = () => {
    stopTicker();
    // A long stage (e.g. waiting on the model) otherwise leaves a frozen
    // status line that looks like a hang; refresh the elapsed time every second.
    ticker = setInterval(renderStatus, TICK_INTERVAL_MS);
    registerTicker(ctx, stopTicker);
    // Never keep the process alive for a status tick.
    (ticker as { unref?: () => void }).unref?.();
  };

  return (stage: number, total: number, message: string) => {
    if (startTime === 0) {
      startTime = Date.now();
    }

    if (stage >= total) {
      current = undefined;
      stopTicker();
      // Clear only the status text here — NOT clearWaiStatus, which also stops
      // other reporters' tickers (concurrent actions like /wai-audit share ctx).
      clearStatusText(ctx);
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

    if (onUpdate) {
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
    }

    renderStatus();
    startTicker();
  };
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
  if (stops) {
    // stop() unregisters itself, so iterate over a snapshot.
    for (const stop of [...stops]) stop();
  }
  clearStatusText(ctx);
}
