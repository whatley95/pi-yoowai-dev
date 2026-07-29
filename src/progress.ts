import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WaiModelTask } from "./types.js";

export type ProgressReporter = (stage: number, total: number, message: string) => void;

const TICK_INTERVAL_MS = 1000;

export function createProgressReporter(
  action: WaiModelTask,
  ctx: ExtensionContext,
  onUpdate?: (update: unknown) => void,
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
      ctx.ui.setStatus("wai", `[${current.stage}/${current.total}] ${current.message}${elapsedText()}`);
    } catch {
      // setStatus may not be available in all modes; ignore.
    }
  };

  const stopTicker = () => {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  const startTicker = () => {
    stopTicker();
    // A long stage (e.g. waiting on the model) otherwise leaves a frozen
    // status line that looks like a hang; refresh the elapsed time every second.
    ticker = setInterval(renderStatus, TICK_INTERVAL_MS);
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
      clearWaiStatus(ctx);
      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: message }],
          details: {
            action,
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

export function clearWaiStatus(ctx: ExtensionContext): void {
  try {
    ctx.ui.setStatus("wai", undefined);
  } catch {
    // ignore
  }
}
