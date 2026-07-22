import type { ExtensionAPI, EntryRenderer } from "@earendil-works/pi-coding-agent";
import type { Text as PiText } from "@earendil-works/pi-tui";
import { loadYoowaiConfig } from "../config.js";
import type { WaiAuditEntry, WaiAuditEntryType } from "./audit.js";

export type TextConstructor = new (text?: string, paddingX?: number, paddingY?: number) => PiText;

const EMOJI: Record<WaiAuditEntryType, string> = {
  "plan-created": "📋",
  "plan-updated": "📝",
  "step-done": "✅",
  "review-pass": "✅",
  "review-needs-work": "🔧",
  "judge-pass": "🏁",
  "judge-needs-work": "⚠️",
  "scan-complete": "🔍",
};

const LABEL: Record<WaiAuditEntryType, string> = {
  "plan-created": "Plan created",
  "plan-updated": "Plan updated",
  "step-done": "Step done",
  "review-pass": "Review passed",
  "review-needs-work": "Review needs work",
  "judge-pass": "Judge passed",
  "judge-needs-work": "Judge needs work",
  "scan-complete": "Scan complete",
};

function formatEntry(entry: WaiAuditEntry): string {
  const icon = EMOJI[entry.type] ?? "●";
  const label = LABEL[entry.type] ?? entry.type;

  let header = `${icon} ${label}`;
  if (entry.summary) header += ` · ${entry.summary}`;
  if (typeof entry.total === "number") {
    const completed = typeof entry.completed === "number" ? entry.completed : 0;
    header += ` (${completed}/${entry.total})`;
  }

  const lines = [header];
  if (entry.step) lines.push(`  step: ${entry.step}`);
  if (typeof entry.issueCount === "number") lines.push(`  issues: ${entry.issueCount}`);
  if (entry.message) lines.push(`  note: ${entry.message}`);

  return lines.join("\n");
}

async function loadTextClass(): Promise<TextConstructor | undefined> {
  try {
    const mod = await import("@earendil-works/pi-tui");
    return mod.Text as TextConstructor;
  } catch {
    return undefined;
  }
}

/** Register a custom entry renderer for wai audit entries.
 *  The renderer is registered asynchronously because it depends on the
 *  optional `pi-tui` peer dependency, which is only available when the
 *  extension is loaded inside Pi. */
export async function registerWaiEntryRenderer(pi: ExtensionAPI, textClass?: TextConstructor): Promise<void> {
  const Text = textClass ?? (await loadTextClass());
  if (!Text) return;

  const renderWaiEntry: EntryRenderer<WaiAuditEntry> = (entry) => {
    if (!entry.data) return undefined;
    try {
      const config = loadYoowaiConfig(entry.data.cwd);
      if (config.entryRenderer === false) return undefined;
    } catch {
      // If config cannot be loaded, fall back to rendering.
    }
    return new Text(formatEntry(entry.data), 0, 0);
  };

  pi.registerEntryRenderer("wai", renderWaiEntry);
}
