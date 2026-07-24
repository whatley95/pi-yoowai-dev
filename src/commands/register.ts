import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { VERSION, HOMEPAGE } from "../version.js";
import { getAgentDir } from "../pi-paths.js";
import { formatResultText } from "../format.js";
import { clearPromptCache } from "../prompts.js";
import { parseReviewCommandArgs, parseTestCommandArgs, parseSecurityCommandArgs } from "./arg-parsers.js";
import { createProgressReporter, clearWaiStatus } from "../progress.js";
import { callSecondaryModel, clearPiSessionId } from "../secondary-model.js";
import { getPiAiCompat } from "../backends/sdk-backend.js";
import { formatTokenCount, secondaryModelLabel } from "../actions/shared.js";
import { executeWaiPlan } from "../actions/plan.js";
import { executeWaiPlanUpdate } from "../actions/plan-update.js";
import { clearReviewCache } from "../review-cache.js";
import { executeWaiReview } from "../actions/review.js";
import { executeWaiSuggest } from "../actions/suggest.js";
import { executeWaiRecommend } from "../actions/recommend.js";
import { executeWaiDone } from "../actions/done.js";
import { executeWaiJudge } from "../actions/judge.js";
import { triggerAutoJudge } from "../integration/lifecycle.js";
import { publishWaiResult } from "../integration/publish.js";
import { updateWaiStatus } from "../integration/status.js";
import { updateWaiPlanWidget } from "../integration/widget.js";
import { refreshWaiProvider } from "../integration/provider.js";
import { executeWaiTest } from "../actions/test.js";
import { executeWaiSecurity } from "../actions/security.js";
import { executeWaiScan } from "../actions/scan.js";
import { executeWaiIndex, formatIndexResult } from "../wai-index.js";
import { executeWaiExplain } from "../wai-explain.js";
import { handleWaiSearchCommand } from "../wai-search.js";
import { handleWaiSearchConfigCommand } from "../wai-search-config.js";
import { loadYoowaiConfig, resolveTaskModel } from "../config.js";
import type { YoowaiConfig } from "../types.js";
import { getState, getProgress, dropSessionState, resetEditsSinceReview } from "../session-state.js";
import { loadRecentModels, saveRecentModel, formatRecentModel, type RecentModel } from "../model-history.js";
import { searchableSelect } from "./searchable-select.js";
import { clearState } from "../plan-store.js";
import { resetCost, getSessionCost, formatCost } from "../cost-tracker.js";
import { clearMemory } from "../review-memory.js";
import { loadConventions, clearConventions } from "../conventions.js";
import { logEvent, readRecentLogs, clearLogs } from "../logger.js";
import {
  recordLearnedFact,
  clearLearnedFacts,
  verifyLearnedFacts,
  verifyLearnedFactsDeep,
  formatVerificationReport,
} from "../wai-learn.js";
import { getVcsInfo } from "../diff-grabber.js";
import { WAI_MODEL_TASKS } from "../wai-tool-params.js";
import { planStepDescription } from "../types.js";
import type { SecondaryModelConfig, WaiToolResult, WaiModelTask, WaiAction } from "../types.js";
import type { LoopDetectionState } from "../loop-detector.js";

export interface ModelThinkingDetails {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

export function computeThinkingLevels(
  modelDetails: ModelThinkingDetails | undefined,
  canonicalLevels: readonly string[],
): string[] | null {
  // No catalog data at all: signal "unknown" so the caller falls back to a
  // safe set instead of guessing.
  if (!modelDetails) return null;
  // Mirror pi-ai's getSupportedThinkingLevels (the same source the main Pi
  // model picker uses): non-reasoning models support only "off"; a level
  // mapped to null is NOT supported (including "off" itself, e.g. gpt-5);
  // xhigh/max require an explicit mapping; every other level is supported by
  // default when the model reasons — even with no map at all, which is the
  // common case for gateway providers like OpenRouter.
  if (!modelDetails.reasoning) return ["off"];
  const map = modelDetails.thinkingLevelMap;
  return canonicalLevels.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** Resolve the thinking levels to offer for a model. Uses the model's
 *  advertised supported levels (mirroring pi-ai's own semantics). When the
 *  model is entirely unknown to the SDK catalog and registry (or advertises
 *  nothing selectable), returns a safe fallback of "off" plus the model's
 *  currently-configured / default level, so the user can keep their setting
 *  or disable reasoning without selecting an unverified level. */
export function resolveThinkingLevelOptions(
  modelDetails: ModelThinkingDetails | undefined,
  canonicalLevels: readonly string[],
  effectiveThinking: string,
): string[] {
  const advertised = computeThinkingLevels(modelDetails, canonicalLevels);
  if (advertised && advertised.length > 0) return advertised;
  const levels = ["off"];
  if (effectiveThinking && effectiveThinking !== "off" && !levels.includes(effectiveThinking)) {
    levels.push(effectiveThinking);
  }
  return levels;
}

/** Resolve a model's advertised thinking levels. The Pi model registry does not
 *  reliably expose `thinkingLevelMap` (its `getModel` may be absent or return a
 *  model without the map), which caused `/wai-model` to fall back to the full
 *  canonical list. The pi-ai SDK catalog — the same source the main agent's
 *  model picker reads — is authoritative, so prefer it and fall back to the
 *  registry only when the catalog has nothing. */
export async function resolveModelThinkingDetails(
  provider: string,
  modelId: string,
  registryModel: ModelThinkingDetails | undefined,
): Promise<ModelThinkingDetails | undefined> {
  let sdkModel: ModelThinkingDetails | undefined;
  try {
    const piAi = await getPiAiCompat();
    const m = piAi.getModel(provider, modelId);
    if (m) {
      sdkModel = { reasoning: m.reasoning, thinkingLevelMap: m.thinkingLevelMap };
    }
  } catch {
    // pi-ai catalog unavailable (e.g. package not resolvable); fall through.
  }
  const sdkHasMap = !!sdkModel?.thinkingLevelMap && Object.keys(sdkModel.thinkingLevelMap).length > 0;
  const registryHasMap = !!registryModel?.thinkingLevelMap && Object.keys(registryModel.thinkingLevelMap).length > 0;
  if (sdkHasMap) return sdkModel;
  if (registryHasMap) return registryModel;
  return sdkModel ?? registryModel;
}

const MODEL_PICKER_SOFT_CAP = 20;
const MODEL_PICKER_GROUP_CAP = 20;

/** Build the saved model-config entry by overlaying the newly selected
 *  provider/id/thinking onto any existing entry. This preserves
 *  provider-specific fields (baseUrl, style, backend, apiKey, cacheRetention,
 *  transport, authHeader, authPrefix, contextWindow, maxOutputTokens,
 *  maxRetries, maxRetryDelayMs, timeoutMs) so that
 *  re-selecting a model via /wai-model does not wipe a custom-endpoint config.
 *  If the provider changes, every provider-specific field is dropped so the new
 *  provider isn't authenticated or pointed at the old provider's endpoint. */
export function buildModelConfigEntry(
  prev: Record<string, unknown> | undefined,
  next: { provider: string; id: string; thinking: string },
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...(prev ?? {}),
    provider: next.provider,
    id: next.id,
    thinking: next.thinking,
  };
  if (typeof prev?.provider === "string" && prev.provider !== next.provider) {
    // Drop all provider-specific fields so a switch doesn't carry the old
    // provider's endpoint, auth, or SDK tuning onto the new provider.
    for (const key of [
      "baseUrl",
      "style",
      "authHeader",
      "authPrefix",
      "apiKey",
      "backend",
      "transport",
      "cacheRetention",
      "contextWindow",
      "maxOutputTokens",
      "maxRetries",
      "maxRetryDelayMs",
      "timeoutMs",
    ])
      delete merged[key];
  }
  return merged;
}

/** Whether a given /wai-model scope option has its own configured model entry.
 *  Used to mark scope options with "✓ current" independently, since the base
 *  secondary model and per-tool task models can each be configured at once. */
export function isScopeConfigured(scope: string, config: YoowaiConfig): boolean {
  if (scope === "Base secondary model") {
    return !!(config.secondary.provider && config.secondary.id);
  }
  const action = scope.replace(/^Use for /, "").replace(/ only$/, "") as WaiModelTask;
  const override = config.taskModels?.[action];
  return !!(override?.provider && override?.id);
}

export interface ModelRef {
  id: string;
  provider: string;
}

export async function promptSearchModels(
  ctx: ExtensionContext,
  provider: string,
  models: ModelRef[],
  currentId: string,
): Promise<string | undefined> {
  const query = await ctx.ui.input(`Search ${provider} models`);
  if (!query) return undefined;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return undefined;
  const filtered = models.filter((m) => m.id.toLowerCase().includes(normalized));
  if (filtered.length === 0) {
    ctx.ui.notify(`No ${provider} models match "${query}".`, "warning");
    return undefined;
  }
  const items = filtered.map((m) => formatModelItem(m, currentId));
  const picked = await ctx.ui.select(`Search ${provider} models:`, items);
  return picked ? parseModelIdFromItem(picked) : undefined;
}

async function searchOrSelectModel(
  ctx: ExtensionContext,
  provider: string,
  models: ModelRef[],
  currentId: string,
  groupLabel?: string,
): Promise<string | undefined> {
  const items = models.map((m) => formatModelItem(m, currentId));
  const title = groupLabel ? `Search ${provider} ${groupLabel} models:` : `Search ${provider} models:`;
  if (typeof ctx.ui.onTerminalInput === "function" && typeof ctx.ui.setWidget === "function") {
    const picked = await searchableSelect(ctx, title, items);
    return picked ? parseModelIdFromItem(picked) : undefined;
  }
  return promptSearchModels(ctx, provider, models, currentId);
}

export function formatModelItem(model: ModelRef, currentId?: string): string {
  const marker = model.id === currentId ? " ✓ current" : "";
  return `${model.id}${marker}`;
}

export function parseModelIdFromItem(item: string): string {
  return item.replace(/ ✓ current$/, "");
}

export function groupModelsByPrefix(models: ModelRef[]): Record<string, ModelRef[]> {
  const groups: Record<string, ModelRef[]> = {};
  for (const m of models) {
    const slashIdx = m.id.indexOf("/");
    const prefix = slashIdx > 0 ? m.id.slice(0, slashIdx) : "(other)";
    (groups[prefix] ??= []).push(m);
  }
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.id.localeCompare(b.id));
  }
  return groups;
}

export async function pickModelFromFlatList(
  ctx: ExtensionContext,
  provider: string,
  models: ModelRef[],
  currentId: string,
  groupLabel?: string,
): Promise<string | undefined> {
  if (models.length <= MODEL_PICKER_GROUP_CAP) {
    const items = models.map((m) => formatModelItem(m, currentId));
    const title = groupLabel ? `Pick ${provider} ${groupLabel} model:` : `Pick model for ${provider}:`;
    const picked = await ctx.ui.select(title, items);
    return picked ? parseModelIdFromItem(picked) : undefined;
  }

  return searchOrSelectModel(ctx, provider, models, currentId, groupLabel);
}

export async function pickModelFromProvider(
  ctx: ExtensionContext,
  provider: string,
  models: ModelRef[],
  currentId: string,
  filterQuery?: string,
): Promise<string | undefined> {
  let candidates = models;
  if (filterQuery) {
    candidates = candidates.filter((m) => m.id.toLowerCase().includes(filterQuery));
    if (candidates.length === 0) {
      ctx.ui.notify(`No ${provider} models match "${filterQuery}".`, "warning");
      return undefined;
    }
  }

  // Small catalogs: a single flat list is the best UX.
  if (candidates.length <= MODEL_PICKER_SOFT_CAP) {
    const items = candidates.map((m) => formatModelItem(m, currentId));
    const picked = await ctx.ui.select(`Pick model for ${provider}:`, items);
    return picked ? parseModelIdFromItem(picked) : undefined;
  }

  const groups = groupModelsByPrefix(candidates);
  const groupNames = Object.keys(groups).sort();
  const useGroups = groupNames.length > 1;

  // Large single-family catalog: no meaningful grouping, so search-first with a
  // flat fallback (unchanged behavior).
  if (!useGroups) {
    const searchResult = await searchOrSelectModel(ctx, provider, candidates, currentId);
    if (searchResult) return searchResult;
    return pickModelFromFlatList(ctx, provider, candidates, currentId);
  }

  // Large multi-family catalog (e.g. OpenRouter): browse families FIRST because
  // the flat list is unmanageable, with a search escape hatch that filters
  // across every family. Cancelling search returns to the family list.
  const SEARCH_ALL = `Search all ${provider} models…`;
  const familyOptions = [SEARCH_ALL, ...groupNames.map((g) => `${g} (${groups[g].length} models)`)];
  // Many families: make the family list itself searchable (type "open" -> openai/
  // openrouter) via the same widget the model list uses. Small family counts keep
  // the plain select. "Search all…" stays first so full-catalog search is one pick.
  const useSearchableFamilies = groupNames.length > MODEL_PICKER_SOFT_CAP;
  for (;;) {
    const picked = useSearchableFamilies
      ? await searchableSelect(ctx, `Pick ${provider} model family:`, familyOptions)
      : await ctx.ui.select(`Pick ${provider} model family:`, familyOptions);
    if (!picked) return undefined;
    if (picked === SEARCH_ALL) {
      const searchResult = await searchOrSelectModel(ctx, provider, candidates, currentId);
      if (searchResult) return searchResult;
      continue;
    }
    const groupName = picked.replace(/ \(\d+ models\)$/, "");
    return pickModelFromFlatList(ctx, provider, groups[groupName] ?? [], currentId, groupName);
  }
}

export async function pickRecentModel(ctx: ExtensionContext, recent: RecentModel[]): Promise<RecentModel | undefined> {
  if (recent.length === 0) return undefined;
  const items = ["Browse all configured models…", ...recent.map(formatRecentModel)];
  const picked = await ctx.ui.select("Recent wai models:", items);
  if (!picked || picked === "Browse all configured models…") return undefined;
  return recent.find((m) => formatRecentModel(m) === picked);
}

async function showWaiStatus(ctx: ExtensionContext): Promise<void> {
  const config = loadYoowaiConfig(ctx.cwd);
  const state = getState(ctx.cwd);
  const cost = getSessionCost(ctx.cwd);
  const conventions = loadConventions(ctx.cwd);
  const vcs = getVcsInfo(ctx.cwd);

  function modelStatusLine(model: SecondaryModelConfig): string {
    const backend = model.backend && model.backend !== "pi" ? ` (${model.backend})` : "";
    const thinking = model.thinking ? ` · ${model.thinking}` : "";
    return `${model.provider}:${model.id}${backend}${thinking}`;
  }

  const taskModelEntries = WAI_MODEL_TASKS.filter((a) => {
    const override = config.taskModels?.[a];
    return override?.provider || override?.id;
  });

  const lines = [
    `pi-yoowai v${VERSION}`,
    HOMEPAGE,
    "",
    "Configuration:",
    config.secondary.provider && config.secondary.id
      ? `  Base model: ${modelStatusLine(config.secondary)}`
      : "  Base model: not configured",
    `  Backend: ${config.secondary.backend ?? "sdk"}`,
    `  Auto-judge: ${config.autoJudge ? "enabled" : "disabled"}`,
    config.preReviewCommands && config.preReviewCommands.length > 0
      ? `  Pre-review commands: ${config.preReviewCommands.join(", ")}`
      : "  Pre-review commands: none",
    "",
    "Session:",
    `  Cost: ${formatCost(cost.costUsd)} (${cost.calls} call${cost.calls === 1 ? "" : "s"})`,
    state.completedSteps < state.totalSteps
      ? `  Review rounds this step: ${state.reviewRounds[state.completedSteps] ?? 0}`
      : "  Review rounds: all steps complete",
    "",
    "Plan:",
    state.plan ? `  Summary: ${state.plan.summary}` : "  No active plan",
  ];

  if (taskModelEntries.length > 0) {
    const sessionIndex = lines.indexOf("Session:");
    const insertAt = sessionIndex > 0 ? sessionIndex - 1 : lines.length;
    lines.splice(
      insertAt,
      0,
      "  Per-tool models:",
      ...taskModelEntries.map((action) => `    ${action}: ${modelStatusLine(resolveTaskModel(config, action))}`),
    );
  }

  if (state.plan) {
    lines.push(`  Progress: ${state.completedSteps}/${state.totalSteps} steps completed`);
    for (let i = 0; i < state.plan.todo.length; i++) {
      lines.push(`    ${state.completedSteps > i ? "✓" : "·"} ${planStepDescription(state.plan.todo[i])}`);
    }
    if (state.plan.acceptanceCriteria.length > 0) {
      lines.push("  Acceptance criteria:");
      for (const c of state.plan.acceptanceCriteria) {
        lines.push(`    · ${c}`);
      }
    }
  }

  lines.push("", "Version control:");
  if (vcs.type === "unknown") {
    lines.push("  No git or svn repository detected");
  } else {
    lines.push(`  Type: ${vcs.type}`);
    if (vcs.branch) lines.push(`  Branch/URL: ${vcs.branch}`);
    if (vcs.revision) lines.push(`  Revision: ${vcs.revision}`);
    if (vcs.dirty !== undefined) lines.push(`  Dirty: ${vcs.dirty ? "yes" : "no"}`);
    if (vcs.error) lines.push(`  Error: ${vcs.error}`);
  }

  lines.push("", "Project conventions:");
  if (conventions) {
    lines.push(`  Stack: ${conventions.stack}`);
    lines.push(`  Naming: ${conventions.naming}`);
    lines.push(`  Structure: ${conventions.structure}`);
    lines.push(`  Patterns: ${conventions.patterns.length > 0 ? conventions.patterns.join("; ") : "none"}`);
    lines.push(`  Scanned at: ${conventions.generatedAt}`);
  } else {
    lines.push("  Not scanned — run wai({ scan: true })");
  }

  lines.push("", `${HOMEPAGE} · pi-yoowai v${VERSION}`);

  await ctx.ui.select("wai status", lines.filter(Boolean));
}

export function registerWaiCommands(pi: ExtensionAPI, loopStates: Map<string, LoopDetectionState>): void {
  const waiHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const trimmed = args.trim();
    if (!trimmed) {
      await showWaiStatus(ctx);
      return;
    }

    const [subcommand, ...rest] = trimmed.split(/\s+/);
    const restText = rest.join(" ").trim();
    const signal = undefined;
    const start = Date.now();

    const actionMap: Record<string, Exclude<WaiAction, "done" | "planUpdate"> | "status"> = {
      plan: "plan",
      review: "review",
      suggest: "suggest",
      recommend: "recommend",
      judge: "judge",
      scan: "scan",
      test: "test",
      security: "security",
      status: "status",
    };
    const known = actionMap[subcommand.toLowerCase()];
    if (!known) {
      ctx.ui.notify(`Unknown /wai subcommand: ${subcommand}. Try /wai status`, "warning");
      return;
    }

    const action: WaiAction = known === "status" ? "scan" : known;

    const progress = createProgressReporter(action, ctx);
    const notifyProgress = (stage: number, total: number, message: string) => {
      progress(stage, total, message);
      ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
    };

    let result: WaiToolResult;
    try {
      switch (known) {
        case "status":
          await showWaiStatus(ctx);
          return;
        case "plan":
          if (!restText) {
            ctx.ui.notify("Usage: /wai plan <task description>", "warning");
            return;
          }
          result = await executeWaiPlan(ctx.cwd, restText, signal, notifyProgress, ctx.sessionManager);
          break;
        case "review": {
          const { description, options: reviewOptions } = parseReviewCommandArgs(restText);
          result = await executeWaiReview(ctx.cwd, description, ctx, reviewOptions, signal, notifyProgress);
          // A manual review counts as a review: keep the unreviewed-edits
          // steer in sync, but only when the review actually ran.
          if (!result.error) resetEditsSinceReview(ctx.cwd);
          break;
        }
        case "suggest":
          if (!restText) {
            ctx.ui.notify("Usage: /wai suggest <question>", "warning");
            return;
          }
          result = await executeWaiSuggest(ctx.cwd, restText, signal, notifyProgress, ctx.sessionManager);
          break;
        case "recommend":
          result = await executeWaiRecommend(
            ctx.cwd,
            restText || "what next",
            signal,
            notifyProgress,
            ctx.sessionManager,
          );
          break;
        case "judge":
          result = await executeWaiJudge(ctx.cwd, restText || "all done", signal, notifyProgress, ctx.sessionManager);
          break;
        case "scan": {
          const deep = restText.includes("--deep") ? true : undefined;
          result = await executeWaiScan(ctx.cwd, signal, notifyProgress, ctx.sessionManager, deep);
          break;
        }
        case "test": {
          const { description, command, options: testOptions } = parseTestCommandArgs(restText);
          result = await executeWaiTest(
            ctx.cwd,
            description || "review test coverage",
            ctx,
            { ...testOptions, command },
            signal,
            notifyProgress,
          );
          break;
        }
        case "security": {
          const { description, options: securityOptions } = parseSecurityCommandArgs(restText);
          result = await executeWaiSecurity(
            ctx.cwd,
            description || "security audit",
            ctx,
            securityOptions,
            signal,
            notifyProgress,
          );
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent(ctx.cwd, "error", `wai ${subcommand} command failed`, { error: message });
      ctx.ui.notify(`wai error: ${message}`, "error");
      return;
    } finally {
      clearWaiStatus(ctx);
    }

    result.elapsedMs = Date.now() - start;
    publishWaiResult(ctx, result);

    const text = formatResultText(result);
    ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
  };

  pi.registerCommand("wai", {
    description:
      "Run a wai action or show status. Usage: /wai [plan|review|suggest|recommend|judge|scan|test|security|status] [args] — 'scan' accepts --deep for deep source-file sampling",
    handler: waiHandler,
  });

  pi.registerCommand("wai-scan-deep", {
    description: "Alias for /wai scan --deep — deep scan with source-file sampling and symbol index build",
    handler: async (_args, ctx) => waiHandler("scan --deep", ctx),
  });

  const configHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const agentDir = getAgentDir();
    const settingsPath = join(agentDir, "settings.json");
    const trimmed = args.trim();

    function readSettings(): Record<string, unknown> {
      if (!existsSync(settingsPath)) return {};
      try {
        return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      } catch (err) {
        logEvent(ctx.cwd, "error", "Failed to read settings for /wai-config", {
          error: err instanceof Error ? err.message : String(err),
          path: settingsPath,
        });
        throw new Error("Failed to read settings.json.", { cause: err });
      }
    }

    function writeSettings(settings: Record<string, unknown>): void {
      if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    }

    function getWaiSettings(settings: Record<string, unknown>): Record<string, unknown> {
      const wai = settings["pi-yoowai"];
      return wai && typeof wai === "object" && !Array.isArray(wai) ? (wai as Record<string, unknown>) : {};
    }

    function setValueByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
      const parts = path.split(".");
      let current: Record<string, unknown> = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        const next = current[key];
        if (!next || typeof next !== "object" || Array.isArray(next)) {
          current[key] = {};
        }
        current = current[key] as Record<string, unknown>;
      }
      current[parts[parts.length - 1]] = value;
    }

    function getValueByPath(obj: Record<string, unknown>, path: string): unknown {
      const parts = path.split(".");
      let current: unknown = obj;
      for (const part of parts) {
        if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
        current = (current as Record<string, unknown>)[part];
      }
      return current;
    }

    function parseConfigValue(raw: string): unknown {
      const stripped = raw.trim();
      if (/^".*"$/.test(stripped)) return stripped.slice(1, -1);
      if (/^'.*'$/.test(stripped)) return stripped.slice(1, -1);
      if (stripped.toLowerCase() === "true" || stripped.toLowerCase() === "yes") return true;
      if (stripped.toLowerCase() === "false" || stripped.toLowerCase() === "no") return false;
      if (stripped === "null") return null;
      if (stripped === "undefined") return undefined;
      const num = Number(stripped);
      if (stripped !== "" && !Number.isNaN(num) && Number.isFinite(num)) return num;
      try {
        return JSON.parse(stripped);
      } catch {
        return stripped;
      }
    }

    function tokenize(input: string): string[] {
      const tokens: string[] = [];
      const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(input)) !== null) {
        tokens.push(match[1] ?? match[2] ?? match[0]);
      }
      return tokens;
    }

    // Legacy shorthand: /wai-config provider.model
    if (trimmed && !trimmed.includes(" ") && trimmed.includes(".")) {
      const [provider, ...modelParts] = trimmed.split(".");
      const modelId = modelParts.join(".");
      if (provider && modelId) {
        try {
          const settings = readSettings();
          settings["pi-yoowai"] = settings["pi-yoowai"] || {};
          const wai = getWaiSettings(settings);
          wai.secondary = (wai.secondary as Record<string, unknown>) || {};
          (wai.secondary as Record<string, unknown>).provider = provider;
          (wai.secondary as Record<string, unknown>).id = modelId;
          settings["pi-yoowai"] = wai;
          writeSettings(settings);
          await refreshWaiProvider(pi, ctx.cwd);
          ctx.ui.notify(`Set wai secondary model to ${provider}.${modelId} in ${settingsPath}`, "info");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.ui.notify(`Failed to update settings: ${message}`, "error");
        }
        return;
      }
    }

    const tokens = tokenize(trimmed);
    const subcommand = tokens[0]?.toLowerCase() ?? "";

    try {
      if (!trimmed || subcommand === "list") {
        const settings = readSettings();
        const wai = getWaiSettings(settings);
        const lines = [
          `Settings file: ${settingsPath}`,
          "",
          JSON.stringify(wai, null, 2) || "(no pi-yoowai settings configured)",
        ];
        await ctx.ui.select("pi-yoowai settings", lines);
        return;
      }

      if (subcommand === "get") {
        const key = tokens[1];
        if (!key) {
          ctx.ui.notify("Usage: /wai-config get <key> (e.g. /wai-config get secondary.thinking)", "warning");
          return;
        }
        const settings = readSettings();
        const wai = getWaiSettings(settings);
        const value = getValueByPath(wai, key);
        const display = value === undefined ? "(not set)" : JSON.stringify(value, null, 2);
        ctx.ui.notify(`${key} = ${display}`, "info");
        return;
      }

      if (subcommand === "set") {
        const key = tokens[1];
        const valueText = tokens.slice(2).join(" ");
        if (!key || valueText.length === 0) {
          ctx.ui.notify(
            "Usage: /wai-config set <key> <value> (e.g. /wai-config set secondary.thinking medium)",
            "warning",
          );
          return;
        }
        const value = parseConfigValue(valueText);
        const settings = readSettings();
        settings["pi-yoowai"] = settings["pi-yoowai"] || {};
        const wai = getWaiSettings(settings);
        setValueByPath(wai, key, value);
        settings["pi-yoowai"] = wai;
        writeSettings(settings);
        await refreshWaiProvider(pi, ctx.cwd);
        ctx.ui.notify(`Set ${key} = ${JSON.stringify(value)} in ${settingsPath}`, "info");
        return;
      }

      ctx.ui.notify(
        "Unknown /wai-config subcommand. Usage: /wai-config [get|set|list] [key] [value], or /wai-config <provider.model>",
        "warning",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to update settings: ${message}`, "error");
    }
  };

  pi.registerCommand("wai-config", {
    description:
      "View or edit pi-yoowai settings. Usage: /wai-config [get|set|list] [key] [value], or /wai-config <provider.model>",
    handler: configHandler,
  });

  const modelHandler = async (_args: string, ctx: ExtensionContext) => {
    try {
      const registry = ctx.modelRegistry as unknown as {
        getAvailable(): Array<{ id: string; provider: string }>;
        getAll?(): Array<{ id: string; provider: string }>;
        getProviderAuthStatus(provider: string): { configured: boolean };
        hasConfiguredAuth(model: { provider: string }): boolean;
        getModel?(
          provider: string,
          id: string,
        ):
          | {
              reasoning?: boolean;
              thinkingLevelMap?: Partial<Record<string, string | null>>;
            }
          | undefined;
      };

      if (!registry || typeof registry.getAvailable !== "function") {
        ctx.ui.notify("Model registry is not available in this environment.", "error");
        return;
      }

      const allModels = typeof registry.getAll === "function" ? registry.getAll() : registry.getAvailable();
      if (!Array.isArray(allModels) || allModels.length === 0) {
        ctx.ui.notify("No models found. Run /login first.", "error");
        return;
      }

      const configuredModels = allModels.filter((m) => {
        try {
          return registry.getProviderAuthStatus(m.provider).configured;
        } catch {
          return registry.hasConfiguredAuth(m);
        }
      });

      if (configuredModels.length === 0) {
        ctx.ui.notify("No configured models found. Run /login first.", "error");
        return;
      }

      const trimmed = _args.trim();
      const tokens: string[] = [];
      const tokenRegex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
      let tokenMatch: RegExpExecArray | null;
      while ((tokenMatch = tokenRegex.exec(trimmed)) !== null) {
        tokens.push(tokenMatch[1] ?? tokenMatch[2] ?? tokenMatch[0]);
      }
      const requestedProvider = tokens[0]?.toLowerCase();
      const filterQuery = tokens[1]?.toLowerCase();

      const currentConfig = loadYoowaiConfig(ctx.cwd);

      // 1. Pick which wai tool this model is for.
      const scopeOptions = ["Base secondary model", ...WAI_MODEL_TASKS.map((a) => `Use for ${a} only`)];
      const scopeModelText = (scope: string): string => {
        const isBase = scope === "Base secondary model";
        const action = isBase ? undefined : (scope.replace(/^Use for /, "").replace(/ only$/, "") as WaiModelTask);
        const model = isBase ? currentConfig.secondary : resolveTaskModel(currentConfig, action!);
        if (!model.provider || !model.id) return "not configured";
        return `${model.provider}:${model.id}${model.thinking ? ` · ${model.thinking}` : ""}`;
      };
      // Each scope is marked "✓ current" based on its own config entry (base and
      // per-tool task models coexist), rather than pinning the marker to Base.
      const scopeItems = scopeOptions.map(
        (s) => `${s} — ${scopeModelText(s)}${isScopeConfigured(s, currentConfig) ? " ✓ current" : ""}`,
      );
      const scopePicked = await ctx.ui.select("Which wai tool should use this model?", scopeItems);
      if (!scopePicked) return;
      const scope = scopePicked.replace(/ ✓ current$/, "").split(" — ")[0];
      const action =
        scope === "Base secondary model"
          ? undefined
          : (scope.replace(/^Use for /, "").replace(/ only$/, "") as WaiModelTask);

      const target = action ? currentConfig.taskModels?.[action] : currentConfig.secondary;
      const effectiveProvider = target?.provider || currentConfig.secondary.provider;
      const effectiveId = target?.id || currentConfig.secondary.id;
      const effectiveThinking = target?.thinking ?? currentConfig.secondary.thinking ?? "xhigh";

      // 2. Pick provider/model, with recent-model shortcut and hierarchical grouping
      //    for providers with huge catalogs (e.g. OpenRouter).
      let provider: string;
      let modelId: string;

      const recent = loadRecentModels(ctx.cwd);
      const recentPicked = !requestedProvider && !filterQuery ? await pickRecentModel(ctx, recent) : undefined;

      if (recentPicked) {
        const stillConfigured = configuredModels.some(
          (m) => m.provider === recentPicked.provider && m.id === recentPicked.id,
        );
        if (!stillConfigured) {
          ctx.ui.notify(`Recent model ${recentPicked.provider}:${recentPicked.id} is no longer configured.`, "warning");
          return;
        }
        provider = recentPicked.provider;
        modelId = recentPicked.id;
      } else {
        const providers = [...new Set(configuredModels.map((m) => m.provider))].sort();
        if (requestedProvider) {
          const matched = providers.find((p) => p.toLowerCase() === requestedProvider);
          if (!matched) {
            ctx.ui.notify(`No configured provider matching "${tokens[0]}".`, "warning");
            return;
          }
          provider = matched;
        } else if (providers.length === 1) {
          provider = providers[0];
        } else {
          const providerItems = providers.map((p) => {
            const count = configuredModels.filter((m) => m.provider === p).length;
            const marker = p.toLowerCase() === effectiveProvider.toLowerCase() ? " ✓ current" : "";
            return `${p} (${count} models)${marker}`;
          });
          const picked = await ctx.ui.select("Pick provider:", providerItems);
          if (!picked) return;
          provider = picked.replace(/ ✓ current$/, "").split(" ")[0];
        }

        const providerModels = configuredModels
          .filter((m) => m.provider === provider)
          .sort((a, b) => a.id.localeCompare(b.id));

        const pickedModelId = await pickModelFromProvider(ctx, provider, providerModels, effectiveId, filterQuery);
        if (!pickedModelId) return;
        modelId = pickedModelId;
      }

      // 3. Pick thinking level.
      // Offer the model's advertised supported levels from the Pi SDK catalog /
      // registry, mirroring pi-ai's getSupportedThinkingLevels semantics
      // (gateway providers like OpenRouter get the default reasoning set).
      // resolveThinkingLevelOptions falls back to a safe set ("off" + the
      // current default) only for models unknown to both sources.
      const canonicalThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
      const registryModel = typeof registry.getModel === "function" ? registry.getModel(provider, modelId) : undefined;
      const modelDetails = await resolveModelThinkingDetails(provider, modelId, registryModel);
      const thinkingLevels = resolveThinkingLevelOptions(modelDetails, canonicalThinkingLevels, effectiveThinking);
      if (thinkingLevels.length === 0) {
        ctx.ui.notify(`Model ${provider}:${modelId} does not advertise any thinking levels.`, "warning");
        return;
      }
      const thinkingItems = thinkingLevels.map((t) => `${t}${t === effectiveThinking ? " ✓ current" : ""}`);
      const thinkingPicked = await ctx.ui.select("Pick thinking level:", thinkingItems);
      if (!thinkingPicked) return;
      const thinking = thinkingPicked.replace(" ✓ current", "");

      // 4. Save.
      const agentDir = getAgentDir();
      const settingsPath = join(agentDir, "settings.json");
      if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true });
      }
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      }
      if (!settings["pi-yoowai"]) settings["pi-yoowai"] = {};
      const waiSettings = settings["pi-yoowai"] as Record<string, unknown>;

      if (scope === "Base secondary model") {
        // Merge into the existing secondary config instead of replacing it, so
        // provider-specific fields (baseUrl, style, backend, apiKey, cacheRetention,
        // transport, authHeader, authPrefix, contextWindow, maxOutputTokens) are
        // preserved when the user re-selects a model via /wai-model.
        const prevSecondary = (waiSettings.secondary as Record<string, unknown>) || {};
        waiSettings.secondary = buildModelConfigEntry(prevSecondary, { provider, id: modelId, thinking });
        ctx.ui.notify(`Secondary model set to ${provider}:${modelId} (${thinking}).`, "info");
      } else {
        const taskModels = (waiSettings.taskModels as Record<string, unknown>) || {};
        const taskAction = action as WaiModelTask;
        // Merge into any existing task override so non-model fields survive.
        const prevTask = (taskModels[taskAction] as Record<string, unknown>) || {};
        taskModels[taskAction] = buildModelConfigEntry(prevTask, { provider, id: modelId, thinking });
        waiSettings.taskModels = taskModels;
        ctx.ui.notify(`Task model for ${taskAction} set to ${provider}:${modelId} (${thinking}).`, "info");
      }

      saveRecentModel(ctx.cwd, { provider, id: modelId, thinking, scope: action ?? "base" });

      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      await refreshWaiProvider(pi, ctx.cwd);
    } catch (err) {
      ctx.ui.notify(`wai-model failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
  };

  pi.registerCommand("wai-model", {
    description:
      "Interactively pick the secondary model for wai, optionally per tool. Usage: /wai-model [provider] [filter]",
    handler: modelHandler,
  });

  const statusHandler = async (_args: string, ctx: ExtensionContext) => {
    await showWaiStatus(ctx);
  };

  pi.registerCommand("wai-status", {
    description: "Show detailed wai status (config, plan, VCS, conventions, memory)",
    handler: statusHandler,
  });

  const indexHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const trimmed = args.trim();
    const update = trimmed.includes("--update");
    const topic = trimmed.replace("--update", "").trim() || "all";
    const result = executeWaiIndex(ctx.cwd, {
      topic: topic as import("../wai-index.js").IndexTopic,
      update,
    });
    const text = formatIndexResult(result);
    await ctx.ui.select("wai index", text.split("\n").filter(Boolean));
  };

  pi.registerCommand("wai-index", {
    description:
      "Read stored wai project context. Usage: /wai-index [all|plan|memory|conventions|cost|logs|index|learned] [--update]",
    handler: indexHandler,
  });

  const explainHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const trimmed = args.trim();
    if (!trimmed) {
      ctx.ui.notify("Provide a target to explain, e.g. /wai-explain src/index.ts", "warning");
      return;
    }

    let target = trimmed;
    let files: string[] = [];
    const filesMatch = trimmed.match(/--files\s+(.+)$/);
    if (filesMatch) {
      target = trimmed.slice(0, trimmed.indexOf("--files")).trim();
      files = filesMatch[1]
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
    }

    const signal = undefined;
    const progress = createProgressReporter("explain", ctx);
    const result = await executeWaiExplain(ctx.cwd, { target, files }, signal, progress, ctx.sessionManager);
    clearWaiStatus(ctx);
    if ("error" in result) {
      ctx.ui.notify(`wai-explain error: ${result.error}`, "error");
      return;
    }
    await ctx.ui.select("wai explain", result.result.details.split("\n").filter(Boolean));
  };

  pi.registerCommand("wai-explain", {
    description: "Explain code, an error, or a file. Usage: /wai-explain <target> [--files file1,file2,...]",
    handler: explainHandler,
  });

  const searchHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const result = await handleWaiSearchCommand(args, ctx);
    const text = result.content[0]?.text ?? "";
    await ctx.ui.select("wai search", text.split("\n").filter(Boolean));
  };

  pi.registerCommand("wai-search", {
    description: "Search the web: /wai-search <query>",
    handler: searchHandler,
  });

  const searchConfigHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const result = await handleWaiSearchConfigCommand(args, ctx);
    const text = result.content[0]?.text ?? "";
    await ctx.ui.select("wai search config", text.split("\n").filter(Boolean));
  };

  pi.registerCommand("wai-search-config", {
    description:
      "Configure web search provider. Usage: /wai-search-config (interactive) or /wai-search-config brave <api-key>",
    handler: searchConfigHandler,
  });

  const learnHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const trimmed = args.trim();
    if (!trimmed) {
      ctx.ui.notify("Provide a fact or use --verify, e.g. /wai-learn Auth is handled by Clerk.", "warning");
      return;
    }

    if (trimmed === "--verify" || trimmed.startsWith("--verify ")) {
      const queryMatch = trimmed.match(/--query\s+(\S+)/);
      const query = queryMatch ? queryMatch[1] : undefined;
      const deep = trimmed.includes("--deep");

      if (deep) {
        const signal = undefined;
        const progress = createProgressReporter("explain", ctx);
        const learnConfig = loadYoowaiConfig(ctx.cwd);
        const learnModelConfig = resolveTaskModel(learnConfig, "explain");
        const learnModelLabel = secondaryModelLabel(learnModelConfig);
        const { results, cost } = await verifyLearnedFactsDeep(
          ctx.cwd,
          query,
          signal,
          (current, total) => progress(current, total, `Verifying fact ${current}/${total} with ${learnModelLabel}…`),
          ctx.sessionManager,
        );
        clearWaiStatus(ctx);
        const lines = formatVerificationReport(results).split("\n").filter(Boolean);
        lines.push(
          "",
          `${cost.estimatedInputTokens + cost.estimatedOutputTokens} tokens · $${cost.estimatedCostUsd.toFixed(6)}`,
        );
        await ctx.ui.select("wai learn verify (deep)", lines);
        return;
      }

      const results = verifyLearnedFacts(ctx.cwd, query);
      const text = formatVerificationReport(results);
      await ctx.ui.select("wai learn verify", text.split("\n").filter(Boolean));
      return;
    }

    let fact = trimmed;
    let category: string | undefined;
    const categoryMatch = trimmed.match(/--category\s+(\S+)/);
    if (categoryMatch) {
      category = categoryMatch[1];
      fact = trimmed.replace(categoryMatch[0], "").trim();
    }

    if (!fact) {
      ctx.ui.notify("Provide a fact to record.", "warning");
      return;
    }

    recordLearnedFact(ctx.cwd, fact, { category });
    ctx.ui.notify(`Recorded project fact${category ? ` [${category}]` : ""}.`, "info");
  };

  pi.registerCommand("wai-learn", {
    description:
      "Record or verify project facts. Usage: /wai-learn <fact> [--category <cat>] | /wai-learn --verify [--query <keyword>] [--deep]",
    handler: learnHandler,
  });

  const clearHandler = async (_args: string, ctx: ExtensionContext) => {
    dropSessionState(ctx.cwd);
    loopStates.delete(ctx.cwd);
    clearPiSessionId(ctx.cwd);
    clearState(ctx.cwd);
    resetCost(ctx.cwd);
    clearMemory(ctx.cwd);
    clearConventions(ctx.cwd);
    clearLearnedFacts(ctx.cwd);
    clearPromptCache();
    clearReviewCache(ctx.cwd);
    // Refresh the UI surfaces so the cleared plan does not linger on screen.
    updateWaiStatus(ctx);
    updateWaiPlanWidget(ctx);
    ctx.ui.notify(
      "wai plan, state, cost, memory, conventions, learned facts, loop history, and inherited session cleared.",
      "info",
    );
  };

  pi.registerCommand("wai-clear", {
    description:
      "Clear the active wai plan, state, cost, memory, conventions, learned facts, loop history, and inherited session",
    handler: clearHandler,
  });

  const nextHandler = async (_args: string, ctx: ExtensionContext) => {
    const signal = undefined;
    const planProgress = getProgress(ctx.cwd);
    const situation =
      planProgress.total > 0
        ? `Plan progress: ${planProgress.completed}/${planProgress.total} steps completed. Current step: ${planProgress.nextStep ?? "none"}`
        : "No active plan. Recommend a next step for this project.";
    const progress = createProgressReporter("recommend", ctx);
    const notifyProgress = (stage: number, total: number, message: string) => {
      progress(stage, total, message);
      ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
    };
    const result = await executeWaiRecommend(ctx.cwd, situation, signal, notifyProgress, ctx.sessionManager);
    clearWaiStatus(ctx);
    const text = formatResultText(result);
    ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
  };

  pi.registerCommand("wai-next", {
    description: "Recommend the next step based on the active wai plan",
    handler: nextHandler,
  });

  const doneHandler = async (args: string, ctx: ExtensionContext) => {
    const signal = undefined;
    const target = args.trim() || undefined;
    const planProgress = getProgress(ctx.cwd);
    if (planProgress.total === 0) {
      ctx.ui.notify("No active wai plan. Start one with /wai plan <task>.", "warning");
      return;
    }
    // An explicit numeric target below the current progress is a regression
    // request and must be allowed even when all steps are complete.
    const isRegression = target !== undefined && /^\d+$/.test(target) && Number(target) < planProgress.completed;
    if (planProgress.completed >= planProgress.total && !isRegression) {
      ctx.ui.notify("All plan steps are already complete. Run /wai judge for a final review.", "info");
      return;
    }
    const doneResult = await executeWaiDone(ctx.cwd, target, signal);
    clearWaiStatus(ctx);
    publishWaiResult(ctx, { action: "done", done: doneResult });
    const text = formatResultText({ action: "done", done: doneResult });
    ctx.ui.notify(text.slice(0, 500), doneResult.verified === false ? "warning" : "info");

    if (doneResult.allDone && doneResult.totalSteps > 0) {
      await triggerAutoJudge(ctx, `All ${doneResult.totalSteps} plan steps completed.`);
    }
  };

  pi.registerCommand("wai-done", {
    description:
      "Mark the current wai plan step complete and recommend the next step. Usage: /wai-done [step number|'all'|description] — a lower number regresses the tracker, 0 resets it",
    handler: doneHandler,
  });

  const planUpdateHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const signal = undefined;
    const description = args.trim();
    if (!description) {
      ctx.ui.notify("Usage: /wai-plan-update <new task description>", "warning");
      return;
    }
    const progress = createProgressReporter("plan", ctx);
    const notifyProgress = (stage: number, total: number, message: string) => {
      progress(stage, total, message);
      ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
    };
    const result = await executeWaiPlanUpdate(ctx.cwd, description, signal, notifyProgress, ctx.sessionManager);
    clearWaiStatus(ctx);
    publishWaiResult(ctx, { action: "planUpdate", done: result });
    const text = formatResultText({ action: "planUpdate", done: result });
    ctx.ui.notify(text.slice(0, 500), result.allDone || result.totalSteps > 0 ? "info" : "warning");
  };

  pi.registerCommand("wai-plan-update", {
    description: "Regenerate the active wai plan from a new task description. Preserves already-completed progress.",
    handler: planUpdateHandler,
  });

  const logsHandler = async (_args: string, ctx: ExtensionContext) => {
    const entries = readRecentLogs(ctx.cwd, 50);
    if (entries.length === 0) {
      ctx.ui.notify("No wai log entries yet.", "info");
      return;
    }
    await ctx.ui.select("Recent wai logs", entries);
  };

  pi.registerCommand("wai-logs", {
    description: "Show recent wai error/event log entries for this project",
    handler: logsHandler,
  });

  const clearLogsHandler = async (_args: string, ctx: ExtensionContext) => {
    clearLogs(ctx.cwd);
    ctx.ui.notify("wai log cleared.", "info");
  };

  pi.registerCommand("wai-clear-logs", {
    description: "Clear the wai error/event log for this project",
    handler: clearLogsHandler,
  });

  const testHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const config = loadYoowaiConfig(ctx.cwd);
    const requestedTask = args.trim().toLowerCase();
    const task = WAI_MODEL_TASKS.find((action) => action === requestedTask);
    if (requestedTask && !task) {
      ctx.ui.notify(`Unknown wai task "${requestedTask}". Use one of: ${WAI_MODEL_TASKS.join(", ")}.`, "warning");
      return;
    }

    const tests: { task?: WaiModelTask; model: SecondaryModelConfig; label: string }[] = [];
    if (task) {
      const model = resolveTaskModel(config, task);
      tests.push({ task, model, label: secondaryModelLabel(model) });
    } else {
      if (config.secondary.provider && config.secondary.id) {
        tests.push({ model: config.secondary, label: secondaryModelLabel(config.secondary) });
      }
      const defaultKey = `${config.secondary.provider}:${config.secondary.id}:${config.secondary.backend ?? "sdk"}:${config.secondary.baseUrl ?? ""}`;
      for (const action of WAI_MODEL_TASKS) {
        const override = config.taskModels?.[action];
        if (!override?.provider && !override?.id) continue;
        const model = resolveTaskModel(config, action);
        const key = `${model.provider}:${model.id}:${model.backend ?? "sdk"}:${model.baseUrl ?? ""}`;
        if (key === defaultKey) continue;
        tests.push({ task: action, model, label: secondaryModelLabel(model) });
      }
    }

    if (tests.length === 0) {
      ctx.ui.notify("No secondary model configured. Run /wai-config or /wai-model first.", "warning");
      return;
    }

    const progress = createProgressReporter("scan", ctx);
    const notifyProgress = (stage: number, total: number, message: string) => {
      progress(stage, total, message);
      ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
    };

    const runnableTests = tests.filter((t) => t.model.provider && t.model.id);
    if (runnableTests.length === 0) {
      ctx.ui.notify("No configured model has both a provider and model id.", "warning");
      return;
    }

    let failures = 0;
    const totalStages = runnableTests.length * 3;
    interface TestResult {
      label: string;
      task?: WaiModelTask;
      provider: string;
      id: string;
      backend?: string;
      thinking?: string;
      baseUrl?: string;
      status: "ok" | "unexpected" | "error";
      elapsedMs: number;
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      response?: string;
      error?: string;
    }

    const results: TestResult[] = [];

    const formatModelDetails = (model: TestResult) => {
      const parts: string[] = [];
      // Determine actual backend: explicit config wins, custom endpoint uses HTTP,
      // otherwise the SDK backend is the universal default.
      const actualBackend = model.backend ?? (model.baseUrl ? "http" : "sdk");
      parts.push(`backend: ${actualBackend}`);
      if (model.thinking) parts.push(`thinking: ${model.thinking}`);
      else parts.push("thinking: off");
      if (model.baseUrl) parts.push(`endpoint: ${model.baseUrl}`);
      return parts.length > 0 ? ` (${parts.join(", ")})` : "";
    };

    const overallStart = Date.now();

    for (let i = 0; i < runnableTests.length; i++) {
      const { task: testTask, model, label } = runnableTests[i];
      const taskSuffix = testTask ? ` (${testTask})` : "";
      const baseStage = i * 3;
      const testStart = Date.now();

      notifyProgress(baseStage + 1, totalStages, `Testing ${label}${taskSuffix}…`);
      const controller = new AbortController();
      // Thinking models via the pi backend can take 60+ seconds. Use 120s to avoid
      // false failures on slow providers while still catching hung processes.
      const testTimeoutMs = config.testTimeoutMs ?? 120_000;
      const timeout = setTimeout(() => controller.abort(), testTimeoutMs);

      try {
        const { content, usage } = await callSecondaryModel(
          model.provider,
          model.id,
          "You are a helpful assistant. Reply with exactly: wai connection OK",
          "Test connection. Reply with exactly: wai connection OK",
          {
            signal: controller.signal,
            thinking: model.thinking,
            cwd: ctx.cwd,
            sessionManager: ctx.sessionManager,
            task: testTask,
          },
        );
        clearTimeout(timeout);
        const elapsedMs = Date.now() - testStart;
        notifyProgress(baseStage + 2, totalStages, `Got response from ${label}${taskSuffix}`);
        const response = content.trim();
        const costText = usage
          ? ` (${formatTokenCount(usage.estimatedInputTokens)} in · ${formatTokenCount(usage.estimatedOutputTokens)} out · ${formatCost(usage.estimatedCostUsd)})`
          : "";
        if (response.toLowerCase().includes("wai connection ok") || response.toLowerCase().includes("connection ok")) {
          notifyProgress(baseStage + 3, totalStages, `${label}${taskSuffix} OK`);
          ctx.ui.notify(`wai-test OK: ${label}${taskSuffix} is reachable${costText}`, "info");
          results.push({
            label,
            task: testTask,
            provider: model.provider,
            id: model.id,
            backend: model.backend,
            thinking: model.thinking,
            baseUrl: model.baseUrl,
            status: "ok",
            elapsedMs,
            inputTokens: usage?.estimatedInputTokens,
            outputTokens: usage?.estimatedOutputTokens,
            costUsd: usage?.estimatedCostUsd,
            response: response.slice(0, 80),
          });
        } else {
          failures++;
          notifyProgress(baseStage + 3, totalStages, `${label}${taskSuffix} unexpected response`);
          ctx.ui.notify(
            `wai-test warning: ${label}${taskSuffix} replied but content was unexpected: "${response.slice(0, 100)}"${costText}`,
            "warning",
          );
          results.push({
            label,
            task: testTask,
            provider: model.provider,
            id: model.id,
            backend: model.backend,
            thinking: model.thinking,
            baseUrl: model.baseUrl,
            status: "unexpected",
            elapsedMs,
            inputTokens: usage?.estimatedInputTokens,
            outputTokens: usage?.estimatedOutputTokens,
            costUsd: usage?.estimatedCostUsd,
            response: response.slice(0, 120),
          });
        }
      } catch (err) {
        failures++;
        clearTimeout(timeout);
        const elapsedMs = Date.now() - testStart;
        const message = err instanceof Error ? err.message : String(err);
        logEvent(ctx.cwd, "error", "wai-test failed", {
          provider: model.provider,
          model: model.id,
          error: message,
        });
        notifyProgress(baseStage + 3, totalStages, `${label}${taskSuffix} connection failed`);
        ctx.ui.notify(`wai-test failed for ${label}${taskSuffix}: ${message}`, "error");
        results.push({
          label,
          task: testTask,
          provider: model.provider,
          id: model.id,
          backend: model.backend,
          thinking: model.thinking,
          baseUrl: model.baseUrl,
          status: "error",
          elapsedMs,
          error: message,
        });
      }
    }

    const overallElapsedMs = Date.now() - overallStart;
    const totalInput = results.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0);
    const totalOutput = results.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0);
    const totalCost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    const passed = results.length - failures;

    const summaryLines: string[] = [
      failures === 0
        ? `wai-test complete: ${passed}/${results.length} model(s) passed in ${(overallElapsedMs / 1000).toFixed(1)}s`
        : `wai-test complete: ${passed}/${results.length} passed, ${failures} failed in ${(overallElapsedMs / 1000).toFixed(1)}s`,
      "",
      ...results.map((r) => {
        const taskTag = r.task ? ` [${r.task}]` : "";
        const details = formatModelDetails(r);
        const elapsed = `${(r.elapsedMs / 1000).toFixed(1)}s`;
        const usage =
          r.inputTokens !== undefined
            ? ` · ${formatTokenCount(r.inputTokens)} in · ${formatTokenCount(r.outputTokens ?? 0)} out · ${formatCost(r.costUsd ?? 0)}`
            : "";
        if (r.status === "ok") {
          return `- ✅ ${r.label}${taskTag}${details} — ${elapsed}${usage}`;
        }
        if (r.status === "unexpected") {
          return `- ⚠️ ${r.label}${taskTag}${details} — unexpected response (${elapsed})${usage}: "${r.response}"`;
        }
        return `- ❌ ${r.label}${taskTag}${details} — failed after ${elapsed}: ${r.error}`;
      }),
    ];

    if (totalCost > 0) {
      summaryLines.push(
        "",
        `Totals: ${formatTokenCount(totalInput)} in · ${formatTokenCount(totalOutput)} out · ${formatCost(totalCost)}`,
      );
    }

    notifyProgress(
      totalStages,
      totalStages,
      failures === 0 ? "All connections verified" : `${failures} connection(s) failed`,
    );
    ctx.ui.notify(summaryLines.join("\n"), failures === 0 ? "info" : "error");
    clearWaiStatus(ctx);
  };

  pi.registerCommand("wai-test", {
    description:
      "Test connectivity to configured secondary models. Optional: /wai-test <plan|review|suggest|recommend|judge|scan|explain>",
    handler: testHandler,
  });

  const backendHandler = async (args: string, ctx: ExtensionCommandContext) => {
    const config = loadYoowaiConfig(ctx.cwd);
    const VALID_BACKENDS = ["sdk", "pi", "http"] as const;
    type Backend = (typeof VALID_BACKENDS)[number];
    const current = config.secondary.backend ?? "sdk";
    const requested = args.trim().toLowerCase();
    let next: Backend;
    if (VALID_BACKENDS.includes(requested as Backend)) {
      next = requested as Backend;
    } else {
      const idx = VALID_BACKENDS.indexOf(current as Backend);
      next = VALID_BACKENDS[(idx + 1) % VALID_BACKENDS.length];
    }

    const settingsPath = join(getAgentDir(), "settings.json");
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      } catch (err) {
        logEvent(ctx.cwd, "error", "Failed to read settings for wai-backend", {
          error: err instanceof Error ? err.message : String(err),
        });
        ctx.ui.notify("Failed to read settings.json.", "error");
        return;
      }
    }

    if (!settings["pi-yoowai"] || typeof settings["pi-yoowai"] !== "object") {
      settings["pi-yoowai"] = {};
    }
    const waiSettings = settings["pi-yoowai"] as Record<string, unknown>;
    if (!waiSettings.secondary || typeof waiSettings.secondary !== "object") {
      waiSettings.secondary = {};
    }
    const secondary = waiSettings.secondary as Record<string, unknown>;
    secondary.backend = next;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    await refreshWaiProvider(pi, ctx.cwd);

    ctx.ui.notify(`wai secondary backend switched to ${next}. Provider registration refreshed.`, "info");
  };

  pi.registerCommand("wai-backend", {
    description: "Switch secondary model backend: sdk (default), pi, or http",
    handler: backendHandler,
  });
}
