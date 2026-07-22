import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadYoowaiConfig } from "../config.js";
import { logEvent } from "../logger.js";

function isShortcutsEnabled(ctx: ExtensionContext): boolean {
  try {
    return loadYoowaiConfig(ctx.cwd).shortcuts !== false;
  } catch {
    return true;
  }
}

function sendWaiShortcut(ctx: ExtensionContext, text: string): void {
  if (!isShortcutsEnabled(ctx)) return;
  try {
    ctx.ui.notify(`wai shortcut: ${text}`, "info");
  } catch {
    // ignore if UI is unavailable
  }
}

/** Register keyboard shortcuts for common wai actions.
 *  - Ctrl+Shift+R: request a review of recent edits
 *  - Ctrl+Shift+D: mark the current plan step done
 *  - Ctrl+Shift+S: show wai status
 *
 *  Shortcuts are best-effort: if the command API is unavailable, they send a
 *  user message so the main agent can call the wai tool. */
export function registerWaiShortcuts(pi: ExtensionAPI): void {
  pi.registerShortcut("ctrl+shift+r", {
    description: "Run wai review on recent changes",
    handler: (ctx: ExtensionContext) => {
      if (!isShortcutsEnabled(ctx)) return;
      sendWaiShortcut(ctx, "review recent changes");
      try {
        pi.sendUserMessage("Please run wai.review to review the recent changes.", { deliverAs: "steer" });
      } catch (err) {
        logEvent(ctx.cwd, "error", "wai review shortcut failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  pi.registerShortcut("ctrl+shift+d", {
    description: "Mark the current wai plan step done",
    handler: (ctx: ExtensionContext) => {
      if (!isShortcutsEnabled(ctx)) return;
      sendWaiShortcut(ctx, "mark current step done");
      try {
        pi.sendUserMessage("Please run wai.done to mark the current plan step complete.", { deliverAs: "steer" });
      } catch (err) {
        logEvent(ctx.cwd, "error", "wai done shortcut failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  pi.registerShortcut("ctrl+shift+s", {
    description: "Show wai status",
    handler: (ctx: ExtensionContext) => {
      if (!isShortcutsEnabled(ctx)) return;
      sendWaiShortcut(ctx, "show status");
      try {
        pi.sendUserMessage("Please show the wai status and current plan progress.", { deliverAs: "steer" });
      } catch (err) {
        logEvent(ctx.cwd, "error", "wai status shortcut failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });
}
