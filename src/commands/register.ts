import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { VERSION, HOMEPAGE } from "../version.js";
import { getAgentDir } from "../pi-paths.js";
import { formatResultText } from "../format.js";
import { clearPromptCache } from "../prompts.js";
import { parseReviewCommandArgs, parseTestCommandArgs, parseSecurityCommandArgs } from "./arg-parsers.js";
import { createProgressReporter, clearYooStatus } from "../progress.js";
import { callSecondaryModel, clearPiSessionId } from "../secondary-model.js";
import { formatTokenCount, secondaryModelLabel } from "../actions/shared.js";
import { executeYooPlan } from "../actions/plan.js";
import { executeYooPlanUpdate } from "../actions/plan-update.js";
import { executeYooReview } from "../actions/review.js";
import { executeYooSuggest } from "../actions/suggest.js";
import { executeYooRecommend } from "../actions/recommend.js";
import { executeYooJudge } from "../actions/judge.js";
import { executeYooTest } from "../actions/test.js";
import { executeYooSecurity } from "../actions/security.js";
import { executeYooScan } from "../actions/scan.js";
import { executeYooIndex, formatIndexResult } from "../yoo-index.js";
import { executeYooExplain } from "../yoo-explain.js";
import { handleYooSearchCommand } from "../yoo-search.js";
import { handleYooSearchConfigCommand } from "../yoo-search-config.js";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { getState, markStepComplete, getProgress, dropSessionState, markJudgeCompleted } from "../session-state.js";
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
} from "../yoo-learn.js";
import { getVcsInfo } from "../diff-grabber.js";
import { YOO_MODEL_TASKS } from "../yoo-tool-params.js";
import { planStepDescription } from "../types.js";
import type { SecondaryModelConfig, YooToolResult, YooModelTask, YooAction } from "../types.js";
import type { LoopDetectionState } from "../loop-detector.js";

async function showYooStatus(ctx: ExtensionContext): Promise<void> {
  const config = loadHeyyooConfig(ctx.cwd);
  const state = getState(ctx.cwd);
  const cost = getSessionCost(ctx.cwd);
  const conventions = loadConventions(ctx.cwd);
  const vcs = getVcsInfo(ctx.cwd);

  function modelStatusLine(model: SecondaryModelConfig): string {
    const backend = model.backend && model.backend !== "pi" ? ` (${model.backend})` : "";
    const thinking = model.thinking ? ` · ${model.thinking}` : "";
    return `${model.provider}:${model.id}${backend}${thinking}`;
  }

  const taskModelEntries = YOO_MODEL_TASKS.filter((a) => {
    const override = config.taskModels?.[a];
    return override?.provider || override?.id;
  });

  const lines = [
    `pi-heyyoo v${VERSION}`,
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
    lines.push("  Not scanned — run yoo({ scan: true })");
  }

  lines.push("", `${HOMEPAGE} · pi-heyyoo v${VERSION}`);

  await ctx.ui.select("yoo status", lines.filter(Boolean));
}

export function registerYooCommands(pi: ExtensionAPI, loopStates: Map<string, LoopDetectionState>): void {
  pi.registerCommand("yoo", {
    description:
      "Run a yoo action or show status. Usage: /yoo [plan|review|suggest|recommend|judge|scan|test|security|status] [args]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        await showYooStatus(ctx);
        return;
      }

      const [subcommand, ...rest] = trimmed.split(/\s+/);
      const restText = rest.join(" ").trim();
      const signal = undefined;
      const start = Date.now();

      const actionMap: Record<string, Exclude<YooAction, "done" | "planUpdate"> | "status"> = {
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
        ctx.ui.notify(`Unknown /yoo subcommand: ${subcommand}. Try /yoo status`, "warn");
        return;
      }

      const action: YooAction = known === "status" ? "scan" : known;

      const progress = createProgressReporter(action, ctx);
      const notifyProgress = (stage: number, total: number, message: string) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      let result: YooToolResult;
      try {
        switch (known) {
          case "status":
            await showYooStatus(ctx);
            return;
          case "plan":
            if (!restText) {
              ctx.ui.notify("Usage: /yoo plan <task description>", "warn");
              return;
            }
            result = await executeYooPlan(ctx.cwd, restText, signal, notifyProgress, ctx.sessionManager);
            break;
          case "review": {
            const { description, options: reviewOptions } = parseReviewCommandArgs(restText);
            result = await executeYooReview(ctx.cwd, description, ctx, reviewOptions, signal, notifyProgress);
            break;
          }
          case "suggest":
            if (!restText) {
              ctx.ui.notify("Usage: /yoo suggest <question>", "warn");
              return;
            }
            result = await executeYooSuggest(ctx.cwd, restText, signal, notifyProgress, ctx.sessionManager);
            break;
          case "recommend":
            result = await executeYooRecommend(
              ctx.cwd,
              restText || "what next",
              signal,
              notifyProgress,
              ctx.sessionManager,
            );
            break;
          case "judge":
            result = await executeYooJudge(ctx.cwd, restText || "all done", signal, notifyProgress, ctx.sessionManager);
            break;
          case "scan":
            result = await executeYooScan(ctx.cwd, signal, notifyProgress, ctx.sessionManager);
            break;
          case "test": {
            const { description, command, options: testOptions } = parseTestCommandArgs(restText);
            result = await executeYooTest(
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
            result = await executeYooSecurity(
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
        logEvent(ctx.cwd, "error", `yoo ${subcommand} command failed`, { error: message });
        ctx.ui.notify(`yoo error: ${message}`, "error");
        return;
      } finally {
        clearYooStatus(ctx);
      }

      result.elapsedMs = Date.now() - start;

      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-config", {
    description:
      "View or edit pi-heyyoo settings. Usage: /yoo-config [get|set|list] [key] [value], or /yoo-config <provider.model>",
    handler: async (args, ctx) => {
      const agentDir = getAgentDir();
      const settingsPath = join(agentDir, "settings.json");
      const trimmed = args.trim();

      function readSettings(): Record<string, unknown> {
        if (!existsSync(settingsPath)) return {};
        try {
          return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          logEvent(ctx.cwd, "error", "Failed to read settings for /yoo-config", {
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

      function getYooSettings(settings: Record<string, unknown>): Record<string, unknown> {
        const yoo = settings["pi-heyyoo"];
        return yoo && typeof yoo === "object" && !Array.isArray(yoo) ? (yoo as Record<string, unknown>) : {};
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

      // Legacy shorthand: /yoo-config provider.model
      if (trimmed && !trimmed.includes(" ") && trimmed.includes(".")) {
        const [provider, ...modelParts] = trimmed.split(".");
        const modelId = modelParts.join(".");
        if (provider && modelId) {
          try {
            const settings = readSettings();
            settings["pi-heyyoo"] = settings["pi-heyyoo"] || {};
            const yoo = getYooSettings(settings);
            yoo.secondary = (yoo.secondary as Record<string, unknown>) || {};
            (yoo.secondary as Record<string, unknown>).provider = provider;
            (yoo.secondary as Record<string, unknown>).id = modelId;
            settings["pi-heyyoo"] = yoo;
            writeSettings(settings);
            ctx.ui.notify(`Set yoo secondary model to ${provider}.${modelId} in ${settingsPath}`, "info");
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
          const yoo = getYooSettings(settings);
          const lines = [
            `Settings file: ${settingsPath}`,
            "",
            JSON.stringify(yoo, null, 2) || "(no pi-heyyoo settings configured)",
          ];
          await ctx.ui.select("pi-heyyoo settings", lines);
          return;
        }

        if (subcommand === "get") {
          const key = tokens[1];
          if (!key) {
            ctx.ui.notify("Usage: /yoo-config get <key> (e.g. /yoo-config get secondary.thinking)", "warn");
            return;
          }
          const settings = readSettings();
          const yoo = getYooSettings(settings);
          const value = getValueByPath(yoo, key);
          const display = value === undefined ? "(not set)" : JSON.stringify(value, null, 2);
          ctx.ui.notify(`${key} = ${display}`, "info");
          return;
        }

        if (subcommand === "set") {
          const key = tokens[1];
          const valueText = tokens.slice(2).join(" ");
          if (!key || valueText.length === 0) {
            ctx.ui.notify(
              "Usage: /yoo-config set <key> <value> (e.g. /yoo-config set secondary.thinking medium)",
              "warn",
            );
            return;
          }
          const value = parseConfigValue(valueText);
          const settings = readSettings();
          settings["pi-heyyoo"] = settings["pi-heyyoo"] || {};
          const yoo = getYooSettings(settings);
          setValueByPath(yoo, key, value);
          settings["pi-heyyoo"] = yoo;
          writeSettings(settings);
          ctx.ui.notify(`Set ${key} = ${JSON.stringify(value)} in ${settingsPath}`, "info");
          return;
        }

        ctx.ui.notify(
          "Unknown /yoo-config subcommand. Usage: /yoo-config [get|set|list] [key] [value], or /yoo-config <provider.model>",
          "warn",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Failed to update settings: ${message}`, "error");
      }
    },
  });

  pi.registerCommand("yoo-model", {
    description:
      "Interactively pick the secondary model for yoo, optionally per tool. Usage: /yoo-model [provider] [filter]",
    handler: async (_args, ctx) => {
      try {
        const registry = ctx.modelRegistry as unknown as {
          getAvailable(): Array<{ id: string; provider: string }>;
          getAll?(): Array<{ id: string; provider: string }>;
          getProviderAuthStatus(provider: string): { configured: boolean };
          hasConfiguredAuth(model: { provider: string }): boolean;
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

        const currentConfig = loadHeyyooConfig(ctx.cwd);

        // 1. Pick which yoo tool this model is for.
        const scopeOptions = ["Base secondary model", ...YOO_MODEL_TASKS.map((a) => `Use for ${a} only`)];
        const currentScope = (() => {
          if (currentConfig.secondary.provider && currentConfig.secondary.id) return "Base secondary model";
          const action = YOO_MODEL_TASKS.find((a) => {
            const override = currentConfig.taskModels?.[a];
            return override?.provider && override?.id;
          });
          return action ? `Use for ${action} only` : undefined;
        })();
        const scopeModelText = (scope: string): string => {
          const isBase = scope === "Base secondary model";
          const action = isBase ? undefined : (scope.replace(/^Use for /, "").replace(/ only$/, "") as YooModelTask);
          const model = isBase ? currentConfig.secondary : resolveTaskModel(currentConfig, action!);
          if (!model.provider || !model.id) return "not configured";
          return `${model.provider}:${model.id}${model.thinking ? ` · ${model.thinking}` : ""}`;
        };
        const scopeItems = scopeOptions.map(
          (s) => `${s} — ${scopeModelText(s)}${s === currentScope ? " ✓ current" : ""}`,
        );
        const scopePicked = await ctx.ui.select("Which yoo tool should use this model?", scopeItems);
        if (!scopePicked) return;
        const scope = scopePicked.replace(/ ✓ current$/, "").split(" — ")[0];
        const action =
          scope === "Base secondary model"
            ? undefined
            : (scope.replace(/^Use for /, "").replace(/ only$/, "") as YooModelTask);

        const target = action ? currentConfig.taskModels?.[action] : currentConfig.secondary;
        const effectiveProvider = target?.provider || currentConfig.secondary.provider;
        const effectiveId = target?.id || currentConfig.secondary.id;
        const effectiveThinking = target?.thinking ?? currentConfig.secondary.thinking ?? "xhigh";

        // 2. Pick provider.
        const providers = [...new Set(configuredModels.map((m) => m.provider))].sort();
        let provider: string;
        if (requestedProvider) {
          const matched = providers.find((p) => p.toLowerCase() === requestedProvider);
          if (!matched) {
            ctx.ui.notify(`No configured provider matching "${tokens[0]}".`, "warn");
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

        // 3. Pick model.
        let providerModels = configuredModels
          .filter((m) => m.provider === provider)
          .sort((a, b) => a.id.localeCompare(b.id));
        if (filterQuery) {
          providerModels = providerModels.filter((m) => m.id.toLowerCase().includes(filterQuery));
          if (providerModels.length === 0) {
            ctx.ui.notify(`No ${provider} models match "${tokens[1]}".`, "warn");
            return;
          }
        }
        const modelItems = providerModels.map((m) => {
          const marker =
            provider.toLowerCase() === effectiveProvider.toLowerCase() && m.id === effectiveId ? " ✓ current" : "";
          return `${m.id}${marker}`;
        });

        const modelIdPicked = await ctx.ui.select(`Pick model for ${provider}:`, modelItems);
        if (!modelIdPicked) return;
        const modelId = modelIdPicked.replace(/ ✓ current$/, "");

        // 4. Pick thinking level.
        const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
        const thinkingItems = thinkingLevels.map((t) => `${t}${t === effectiveThinking ? " ✓ current" : ""}`);
        const thinkingPicked = await ctx.ui.select("Pick thinking level:", thinkingItems);
        if (!thinkingPicked) return;
        const thinking = thinkingPicked.replace(" ✓ current", "");

        // 5. Save.
        const agentDir = getAgentDir();
        const settingsPath = join(agentDir, "settings.json");
        if (!existsSync(agentDir)) {
          mkdirSync(agentDir, { recursive: true });
        }
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
        }
        if (!settings["pi-heyyoo"]) settings["pi-heyyoo"] = {};
        const yooSettings = settings["pi-heyyoo"] as Record<string, unknown>;

        if (scope === "Base secondary model") {
          yooSettings.secondary = { provider, id: modelId, thinking };
          ctx.ui.notify(`Secondary model set to ${provider}:${modelId} (${thinking}).`, "info");
        } else {
          const taskModels = (yooSettings.taskModels as Record<string, unknown>) || {};
          const taskAction = action as YooModelTask;
          taskModels[taskAction] = { provider, id: modelId, thinking };
          yooSettings.taskModels = taskModels;
          ctx.ui.notify(`Task model for ${taskAction} set to ${provider}:${modelId} (${thinking}).`, "info");
        }

        writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      } catch (err) {
        ctx.ui.notify(`yoo-model failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("yoo-status", {
    description: "Show detailed yoo status (config, plan, VCS, conventions, memory)",
    handler: async (_args, ctx) => {
      await showYooStatus(ctx);
    },
  });

  pi.registerCommand("yoo-info", {
    description: "Alias for /yoo-status",
    handler: async (_args, ctx) => {
      await showYooStatus(ctx);
    },
  });

  pi.registerCommand("yoo-index", {
    description:
      "Read stored yoo project context. Usage: /yoo-index [all|plan|memory|conventions|cost|logs|index|learned] [--update]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const update = trimmed.includes("--update");
      const topic = trimmed.replace("--update", "").trim() || "all";
      const result = executeYooIndex(ctx.cwd, {
        topic: topic as import("../yoo-index.js").IndexTopic,
        update,
      });
      const text = formatIndexResult(result);
      await ctx.ui.select("yoo index", text.split("\n").filter(Boolean));
    },
  });

  pi.registerCommand("yoo-explain", {
    description: "Explain code, an error, or a file. Usage: /yoo-explain <target> [--files file1,file2,...]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Provide a target to explain, e.g. /yoo-explain src/index.ts", "warn");
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
      const result = await executeYooExplain(ctx.cwd, { target, files }, signal, progress, ctx.sessionManager);
      clearYooStatus(ctx);
      if ("error" in result) {
        ctx.ui.notify(`yoo-explain error: ${result.error}`, "error");
        return;
      }
      await ctx.ui.select("yoo explain", result.result.details.split("\n").filter(Boolean));
    },
  });

  pi.registerCommand("yoo-search", {
    description: "Search the web: /yoo-search <query>",
    handler: async (args, ctx) => {
      const result = await handleYooSearchCommand(args, ctx);
      const text = result.content[0]?.text ?? "";
      await ctx.ui.select("yoo search", text.split("\n").filter(Boolean));
    },
  });

  pi.registerCommand("yoo-search-config", {
    description:
      "Configure web search provider. Usage: /yoo-search-config (interactive) or /yoo-search-config brave <api-key>",
    handler: async (args, ctx) => {
      const result = await handleYooSearchConfigCommand(args, ctx);
      const text = result.content[0]?.text ?? "";
      await ctx.ui.select("yoo search config", text.split("\n").filter(Boolean));
    },
  });

  pi.registerCommand("yoo-learn", {
    description:
      "Record or verify project facts. Usage: /yoo-learn <fact> [--category <cat>] | /yoo-learn --verify [--query <keyword>] [--deep]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Provide a fact or use --verify, e.g. /yoo-learn Auth is handled by Clerk.", "warn");
        return;
      }

      if (trimmed === "--verify" || trimmed.startsWith("--verify ")) {
        const queryMatch = trimmed.match(/--query\s+(\S+)/);
        const query = queryMatch ? queryMatch[1] : undefined;
        const deep = trimmed.includes("--deep");

        if (deep) {
          const signal = undefined;
          const progress = createProgressReporter("explain", ctx);
          const learnConfig = loadHeyyooConfig(ctx.cwd);
          const learnModelConfig = resolveTaskModel(learnConfig, "explain");
          const learnModelLabel = secondaryModelLabel(learnModelConfig);
          const { results, cost } = await verifyLearnedFactsDeep(
            ctx.cwd,
            query,
            signal,
            (current, total) => progress(current, total, `Verifying fact ${current}/${total} with ${learnModelLabel}…`),
            ctx.sessionManager,
          );
          clearYooStatus(ctx);
          const lines = formatVerificationReport(results).split("\n").filter(Boolean);
          lines.push(
            "",
            `${cost.estimatedInputTokens + cost.estimatedOutputTokens} tokens · $${cost.estimatedCostUsd.toFixed(6)}`,
          );
          await ctx.ui.select("yoo learn verify (deep)", lines);
          return;
        }

        const results = verifyLearnedFacts(ctx.cwd, query);
        const text = formatVerificationReport(results);
        await ctx.ui.select("yoo learn verify", text.split("\n").filter(Boolean));
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
        ctx.ui.notify("Provide a fact to record.", "warn");
        return;
      }

      recordLearnedFact(ctx.cwd, fact, { category });
      ctx.ui.notify(`Recorded project fact${category ? ` [${category}]` : ""}.`, "info");
    },
  });

  pi.registerCommand("yoo-clear", {
    description:
      "Clear the active yoo plan, state, cost, memory, conventions, learned facts, loop history, and inherited session",
    handler: async (_args, ctx) => {
      dropSessionState(ctx.cwd);
      loopStates.delete(ctx.cwd);
      clearPiSessionId(ctx.cwd);
      clearState(ctx.cwd);
      resetCost(ctx.cwd);
      clearMemory(ctx.cwd);
      clearConventions(ctx.cwd);
      clearLearnedFacts(ctx.cwd);
      clearPromptCache();
      ctx.ui.notify(
        "yoo plan, state, cost, memory, conventions, learned facts, loop history, and inherited session cleared.",
        "info",
      );
    },
  });

  pi.registerCommand("yoo-next", {
    description: "Recommend the next step based on the active yoo plan",
    handler: async (_args, ctx) => {
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
      const result = await executeYooRecommend(ctx.cwd, situation, signal, notifyProgress, ctx.sessionManager);
      clearYooStatus(ctx);
      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-done", {
    description: "Mark the current yoo plan step complete and recommend the next step",
    handler: async (_args, ctx) => {
      const signal = undefined;
      const config = loadHeyyooConfig(ctx.cwd);
      const planProgress = getProgress(ctx.cwd);
      if (planProgress.total === 0) {
        ctx.ui.notify("No active yoo plan. Start one with /yoo plan <task>.", "warn");
        return;
      }
      if (planProgress.completed >= planProgress.total) {
        ctx.ui.notify("All plan steps are already complete. Run /yoo judge for a final review.", "info");
        return;
      }
      markStepComplete(ctx.cwd);
      const newProgress = getProgress(ctx.cwd);
      ctx.ui.notify(`Step ${planProgress.completed + 1} marked complete.`, "info");
      const situation = `Plan progress: ${newProgress.completed}/${newProgress.total} steps completed. Current step: ${newProgress.nextStep ?? "none"}`;
      const progress = createProgressReporter("recommend", ctx);
      const notifyProgress = (stage: number, total: number, message: string) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };
      const result = await executeYooRecommend(ctx.cwd, situation, signal, notifyProgress, ctx.sessionManager);
      clearYooStatus(ctx);
      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");

      if (
        config.autoJudge &&
        !getState(ctx.cwd).judgeCompleted &&
        newProgress.completed === newProgress.total &&
        newProgress.total > 0
      ) {
        const judgeNotify = (stage: number, _total: number, message: string) => {
          ctx.ui.notify(`[${stage}/10] ${message}`, "info");
        };
        const judgeResult = await executeYooJudge(
          ctx.cwd,
          `All ${newProgress.total} plan steps completed.`,
          signal,
          judgeNotify,
          ctx.sessionManager,
        );
        if (judgeResult.judge) {
          markJudgeCompleted(ctx.cwd);
          const judgeText = formatResultText(judgeResult);
          ctx.ui.notify(judgeText.slice(0, 500), judgeResult.error ? "error" : "info");
        } else if (judgeResult.error) {
          markJudgeCompleted(ctx.cwd);
          ctx.ui.notify(`Auto-judge failed: ${judgeResult.error}`, "error");
        }
      }
    },
  });

  pi.registerCommand("yoo-plan-update", {
    description: "Regenerate the active yoo plan from a new task description. Preserves already-completed progress.",
    handler: async (args, ctx) => {
      const signal = undefined;
      const description = args.trim();
      if (!description) {
        ctx.ui.notify("Usage: /yoo-plan-update <new task description>", "warn");
        return;
      }
      const progress = createProgressReporter("plan", ctx);
      const notifyProgress = (stage: number, total: number, message: string) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };
      const result = await executeYooPlanUpdate(ctx.cwd, description, signal, notifyProgress, ctx.sessionManager);
      clearYooStatus(ctx);
      const text = formatResultText({ action: "planUpdate", done: result });
      ctx.ui.notify(text.slice(0, 500), result.allDone || result.totalSteps > 0 ? "info" : "warn");
    },
  });

  pi.registerCommand("yoo-logs", {
    description: "Show recent yoo error/event log entries for this project",
    handler: async (_args, ctx) => {
      const entries = readRecentLogs(ctx.cwd, 50);
      if (entries.length === 0) {
        ctx.ui.notify("No yoo log entries yet.", "info");
        return;
      }
      await ctx.ui.select("Recent yoo logs", entries);
    },
  });

  pi.registerCommand("yoo-clear-logs", {
    description: "Clear the yoo error/event log for this project",
    handler: async (_args, ctx) => {
      clearLogs(ctx.cwd);
      ctx.ui.notify("yoo log cleared.", "info");
    },
  });

  pi.registerCommand("yoo-test", {
    description:
      "Test connectivity to configured secondary models. Optional: /yoo-test <plan|review|suggest|recommend|judge|scan|explain>",
    handler: async (args, ctx) => {
      const config = loadHeyyooConfig(ctx.cwd);
      const requestedTask = args.trim().toLowerCase();
      const task = YOO_MODEL_TASKS.find((action) => action === requestedTask);
      if (requestedTask && !task) {
        ctx.ui.notify(`Unknown yoo task "${requestedTask}". Use one of: ${YOO_MODEL_TASKS.join(", ")}.`, "warn");
        return;
      }

      const tests: { task?: YooModelTask; model: SecondaryModelConfig; label: string }[] = [];
      if (task) {
        const model = resolveTaskModel(config, task);
        tests.push({ task, model, label: secondaryModelLabel(model) });
      } else {
        if (config.secondary.provider && config.secondary.id) {
          tests.push({ model: config.secondary, label: secondaryModelLabel(config.secondary) });
        }
        const defaultKey = `${config.secondary.provider}:${config.secondary.id}:${config.secondary.backend ?? "sdk"}:${config.secondary.baseUrl ?? ""}`;
        for (const action of YOO_MODEL_TASKS) {
          const override = config.taskModels?.[action];
          if (!override?.provider && !override?.id) continue;
          const model = resolveTaskModel(config, action);
          const key = `${model.provider}:${model.id}:${model.backend ?? "sdk"}:${model.baseUrl ?? ""}`;
          if (key === defaultKey) continue;
          tests.push({ task: action, model, label: secondaryModelLabel(model) });
        }
      }

      if (tests.length === 0) {
        ctx.ui.notify("No secondary model configured. Run /yoo-config or /yoo-model first.", "warn");
        return;
      }

      const progress = createProgressReporter("scan", ctx);
      const notifyProgress = (stage: number, total: number, message: string) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      const runnableTests = tests.filter((t) => t.model.provider && t.model.id);
      if (runnableTests.length === 0) {
        ctx.ui.notify("No configured model has both a provider and model id.", "warn");
        return;
      }

      let failures = 0;
      const totalStages = runnableTests.length * 3;
      interface TestResult {
        label: string;
        task?: YooModelTask;
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
            "You are a helpful assistant. Reply with exactly: yoo connection OK",
            "Test connection. Reply with exactly: yoo connection OK",
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
          if (
            response.toLowerCase().includes("yoo connection ok") ||
            response.toLowerCase().includes("connection ok")
          ) {
            notifyProgress(baseStage + 3, totalStages, `${label}${taskSuffix} OK`);
            ctx.ui.notify(`yoo-test OK: ${label}${taskSuffix} is reachable${costText}`, "info");
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
              `yoo-test warning: ${label}${taskSuffix} replied but content was unexpected: "${response.slice(0, 100)}"${costText}`,
              "warn",
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
          logEvent(ctx.cwd, "error", "yoo-test failed", {
            provider: model.provider,
            model: model.id,
            error: message,
          });
          notifyProgress(baseStage + 3, totalStages, `${label}${taskSuffix} connection failed`);
          ctx.ui.notify(`yoo-test failed for ${label}${taskSuffix}: ${message}`, "error");
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
          ? `yoo-test complete: ${passed}/${results.length} model(s) passed in ${(overallElapsedMs / 1000).toFixed(1)}s`
          : `yoo-test complete: ${passed}/${results.length} passed, ${failures} failed in ${(overallElapsedMs / 1000).toFixed(1)}s`,
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
      clearYooStatus(ctx);
    },
  });

  pi.registerCommand("yoo-scan", {
    description: "Alias for /yoo scan — scan project conventions",
    handler: async (_args, ctx) => {
      const signal = undefined;
      const progress = createProgressReporter("scan", ctx);
      const notifyProgress = (stage: number, total: number, message: string) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      let result: YooToolResult;
      try {
        result = await executeYooScan(ctx.cwd, signal, notifyProgress, ctx.sessionManager);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(ctx.cwd, "error", "yoo-scan command failed", { error: message });
        ctx.ui.notify(`yoo-scan error: ${message}`, "error");
        return;
      } finally {
        clearYooStatus(ctx);
      }

      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-scan-deep", {
    description: "Run /yoo scan with deep source-file sampling enabled",
    handler: async (_args, ctx) => {
      const signal = undefined;
      const progress = createProgressReporter("scan", ctx);
      const notifyProgress = (stage: number, total: number, message: string) => {
        progress(stage, total, message);
        ctx.ui.notify(`[${stage}/${total}] ${message}`, "info");
      };

      let result: YooToolResult;
      try {
        result = await executeYooScan(ctx.cwd, signal, notifyProgress, ctx.sessionManager, true);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(ctx.cwd, "error", "yoo-scan-deep command failed", { error: message });
        ctx.ui.notify(`yoo-scan-deep error: ${message}`, "error");
        return;
      } finally {
        clearYooStatus(ctx);
      }

      const text = formatResultText(result);
      ctx.ui.notify(text.slice(0, 500), result.error ? "error" : "info");
    },
  });

  pi.registerCommand("yoo-backend", {
    description: "Switch secondary model backend: sdk (default), pi, or http",
    handler: async (args, ctx) => {
      const config = loadHeyyooConfig(ctx.cwd);
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
          logEvent(ctx.cwd, "error", "Failed to read settings for yoo-backend", {
            error: err instanceof Error ? err.message : String(err),
          });
          ctx.ui.notify("Failed to read settings.json.", "error");
          return;
        }
      }

      if (!settings["pi-heyyoo"] || typeof settings["pi-heyyoo"] !== "object") {
        settings["pi-heyyoo"] = {};
      }
      const yooSettings = settings["pi-heyyoo"] as Record<string, unknown>;
      if (!yooSettings.secondary || typeof yooSettings.secondary !== "object") {
        yooSettings.secondary = {};
      }
      const secondary = yooSettings.secondary as Record<string, unknown>;
      secondary.backend = next;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");

      ctx.ui.notify(`yoo secondary backend switched to ${next}. /reload to apply.`, "info");
    },
  });
}
