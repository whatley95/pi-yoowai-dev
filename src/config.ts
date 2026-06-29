import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HeyyoConfig } from "./types.js";

let getAgentDirImpl: () => string;
try {
  const pi = await import("@earendil-works/pi-coding-agent");
  getAgentDirImpl = pi.getAgentDir;
} catch {
  getAgentDirImpl = () => join(homedir(), ".pi", "agent");
}

export function getAgentDir(): string {
  return getAgentDirImpl();
}

export function loadHeyyoConfig(cwd: string): HeyyoConfig {
  const agentDir = getAgentDir();
  const globalPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");

  let config: HeyyoConfig = {
    secondary: { provider: "", id: "", thinking: "xhigh" },
  };

  if (existsSync(globalPath)) {
    try {
      const global = JSON.parse(readFileSync(globalPath, "utf-8"));
      if (global["pi-heyyo"]) {
        config = mergeConfig(config, global["pi-heyyo"]);
      }
    } catch { /* ignore parse errors */ }
  }

  if (existsSync(projectPath)) {
    try {
      const project = JSON.parse(readFileSync(projectPath, "utf-8"));
      if (project["pi-heyyo"]) {
        config = mergeConfig(config, project["pi-heyyo"]);
      }
    } catch { /* ignore parse errors */ }
  }

  return config;
}

function mergeConfig(base: HeyyoConfig, override: Partial<HeyyoConfig>): HeyyoConfig {
  return {
    secondary: {
      provider: override.secondary?.provider || base.secondary.provider,
      id: override.secondary?.id || base.secondary.id,
      thinking: override.secondary?.thinking ?? base.secondary.thinking,
    },
  };
}
