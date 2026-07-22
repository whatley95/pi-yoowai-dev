import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WaiModelTask } from "./types.js";

export type ProgressReporter = (stage: number, total: number, message: string) => void;

export function createProgressReporter(
  action: WaiModelTask,
  ctx: ExtensionContext,
  onUpdate?: (update: unknown) => void,
): ProgressReporter {
  let startTime = 0;

  return (stage: number, total: number, message: string) => {
    if (startTime === 0) {
      startTime = Date.now();
    }

    const elapsedMs = Date.now() - startTime;
    const elapsedText = elapsedMs > 1000 ? ` (${(elapsedMs / 1000).toFixed(1)}s)` : "";

    if (stage >= total) {
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

    try {
      ctx.ui.setStatus("wai", `[${stage}/${total}] ${message}${elapsedText}`);
    } catch {
      // setStatus may not be available in all modes; ignore.
    }
  };
}

export function clearWaiStatus(ctx: ExtensionContext): void {
  try {
    ctx.ui.setStatus("wai", undefined);
  } catch {
    // ignore
  }
}
