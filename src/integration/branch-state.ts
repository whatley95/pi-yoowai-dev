import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getState, replaceSessionState, syncWorkspaceChanges } from "../session-state.js";
import type { YoowaiSessionState } from "../types.js";

export function branchStateSnapshot(cwd: string): { stateVersion: 1; state: YoowaiSessionState } {
  return { stateVersion: 1, state: structuredClone(getState(cwd)) };
}

/** Restore only the active conversation branch, never entries from abandoned branches. */
export function restoreBranchState(ctx: ExtensionContext, navigation = false): void {
  let branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
  try {
    branch = ctx.sessionManager.getBranch();
  } catch {
    return;
  }
  const snapshots = branch.filter((entry) => entry.type === "custom" && entry.customType === "wai");
  let restored = false;
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const entry = snapshots[i];
    if (entry.type !== "custom") continue;
    const data: unknown = entry.data;
    if (!data || typeof data !== "object" || !("stateVersion" in data) || data.stateVersion !== 1 || !("state" in data))
      continue;
    if (!data.state || typeof data.state !== "object" || Array.isArray(data.state)) continue;
    replaceSessionState(ctx.cwd, data.state as YoowaiSessionState);
    restored = true;
    break;
  }
  // Legacy resumed sessions keep their disk state until a branch navigation.
  // A branch preceding the first wai entry cannot inherit progress from its future.
  if (!restored && navigation) replaceSessionState(ctx.cwd);
  syncWorkspaceChanges(ctx.cwd);
}
