import { join } from "node:path";
import { homedir } from "node:os";

let getAgentDirImpl: () => string;
let configDirNameImpl: string;

try {
  const pi = (await import("@earendil-works/pi-coding-agent")) as Record<string, unknown>;
  getAgentDirImpl =
    typeof pi.getAgentDir === "function" ? (pi.getAgentDir as () => string) : () => join(homedir(), ".pi", "agent");
  configDirNameImpl = (pi.CONFIG_DIR_NAME as string) || ".pi";
} catch {
  getAgentDirImpl = () => join(homedir(), ".pi", "agent");
  configDirNameImpl = ".pi";
}

export function getAgentDir(): string {
  return getAgentDirImpl();
}

/** Test hook: override the agent directory used for auth/settings resolution. */
export function setAgentDirForTests(fn: () => string): void {
  getAgentDirImpl = fn;
}

export function getConfigDirName(): string {
  return configDirNameImpl;
}

export function getProjectConfigPath(cwd: string, ...segments: string[]): string {
  return join(cwd, configDirNameImpl, ...segments);
}
