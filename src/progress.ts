import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { YooModelTask } from "./types.js";

export type ProgressReporter = (stage: number, total: number, message: string) => void;

export function createProgressReporter(
  action: YooModelTask,
  ctx: ExtensionContext,
  onUpdate?: (update: unknown) => void,
): ProgressReporter {
  return (stage: number, total: number, message: string) => {
    if (stage >= total) {
      clearYooStatus(ctx);
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
      ctx.ui.setStatus("yoo", `[${stage}/${total}] ${message}`);
    } catch {
      // setStatus may not be available in all modes; ignore.
    }
  };
}

export function clearYooStatus(ctx: ExtensionContext): void {
  try {
    ctx.ui.setStatus("yoo", undefined);
  } catch {
    // ignore
  }
}
