import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./pi-paths.js";
import type { YoowaiConfig, YoowaiPreset } from "./types.js";

export interface PresetEntry {
  name: string;
  preset: YoowaiPreset;
}

export function listPresets(config: YoowaiConfig): PresetEntry[] {
  return Object.entries(config.presets ?? {})
    .map(([name, preset]) => ({ name, preset }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getPreset(config: YoowaiConfig, name: string): YoowaiPreset | undefined {
  return config.presets?.[name];
}

/** One-line summary of what a preset changes, e.g.
 *  "secondary: openai:gpt-5-mini · taskModels: review, scan". */
export function describePreset(preset: YoowaiPreset): string {
  const parts: string[] = [];
  if (preset.secondary) {
    const provider = typeof preset.secondary.provider === "string" ? preset.secondary.provider : "";
    const id = typeof preset.secondary.id === "string" ? preset.secondary.id : "";
    const model = provider && id ? `${provider}:${id}` : provider || id || "partial override";
    const thinking = typeof preset.secondary.thinking === "string" ? ` (${preset.secondary.thinking})` : "";
    parts.push(`secondary: ${model}${thinking}`);
  }
  if (preset.taskModels) {
    const tasks = Object.keys(preset.taskModels);
    if (tasks.length > 0) parts.push(`taskModels: ${tasks.join(", ")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "(empty preset)";
}

export function formatPresetList(config: YoowaiConfig): string[] {
  const entries = listPresets(config);
  if (entries.length === 0) return [];
  const lines = [`${entries.length} preset(s) defined in pi-yoowai.presets:`, ""];
  for (const entry of entries) {
    lines.push(`- ${entry.name} — ${describePreset(entry.preset)}`);
  }
  lines.push("", "Apply with /wai-preset <name>; preview with /wai-preset show <name>.");
  return lines;
}

export function formatPresetDetails(name: string, preset: YoowaiPreset): string[] {
  return [
    `Preset "${name}" would write into ~/.pi/agent/settings.json under pi-yoowai:`,
    "",
    JSON.stringify(preset, null, 2),
  ];
}

/** Apply a preset to the GLOBAL settings file, merging `secondary` and
 *  `taskModels` over the existing pi-yoowai config and preserving every other
 *  key (same read-modify-write approach as /wai-model). Returns the settings
 *  file path that was written. */
export function applyPreset(preset: YoowaiPreset): string {
  const agentDir = getAgentDir();
  const settingsPath = join(agentDir, "settings.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error("Failed to read settings.json.", { cause: err });
    }
  }

  const existing = settings["pi-yoowai"];
  const waiSettings: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};

  if (preset.secondary) {
    const prev = (waiSettings.secondary as Record<string, unknown>) || {};
    waiSettings.secondary = { ...prev, ...preset.secondary };
  }
  if (preset.taskModels) {
    const taskModels = { ...((waiSettings.taskModels as Record<string, unknown>) || {}) };
    for (const [task, override] of Object.entries(preset.taskModels)) {
      taskModels[task] = { ...((taskModels[task] as Record<string, unknown>) || {}), ...override };
    }
    waiSettings.taskModels = taskModels;
  }

  settings["pi-yoowai"] = waiSettings;
  if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  return settingsPath;
}
