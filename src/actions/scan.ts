import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadYoowaiConfig, resolveTaskModel } from "../config.js";
import { callSecondaryModel, providerSupportsJsonObject } from "../secondary-model.js";
import { resolveBackendType } from "../backends/backend-resolver.js";
import { capActionInstructions } from "../instructions.js";
import {
  scanProjectConventions,
  gatherDeepScanSamples,
  filterSourceFiles,
  formatConfigFiles,
  saveConventions,
  mergeConventions,
} from "../conventions.js";
import { buildScanPrompt, validateConventionsResult, parseJsonResponse } from "../prompts.js";
import { resolveModelInfo } from "../model-registry.js";
import { estimateTokens } from "../token-budget.js";
import { loadFreshProjectIndex, enrichConventionsFromIndex } from "../project-index.js";
import { getCachedScan, saveScanCache, scanFingerprint } from "../scan-cache.js";
import { logEvent } from "../logger.js";
import {
  STAGES,
  secondaryModelLabel,
  recordCostWithBudget,
  createStreamProgressCallback,
  continuationMeta,
} from "./shared.js";
import type { ProgressReporter } from "../progress.js";
import type { WaiToolResult } from "../types.js";

export async function executeWaiScan(
  cwd: string,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: ExtensionContext["sessionManager"],
  deepOverride?: boolean | number,
  refresh = false,
): Promise<WaiToolResult> {
  const config = loadYoowaiConfig(cwd);
  const modelConfig = resolveTaskModel(config, "scan");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "scan", error: "No secondary model configured. Set pi-yoowai.secondary in settings.json." };
  }
  const modelProfile = {
    provider: modelConfig.provider,
    id: modelConfig.id,
    thinking: modelConfig.thinking,
    backend: resolveBackendType(modelConfig.provider, modelConfig),
  };
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig.id, modelConfig);

  progress(1, STAGES.scan, "Scanning local project conventions…");
  const localScan = scanProjectConventions(cwd);

  const { system, user } = buildScanPrompt(
    nativeJson,
    capActionInstructions(cwd, "scan", config.instructionsMaxTokens ?? 800),
  );
  const configFilesText = formatConfigFiles(cwd);

  const deepScanEnabled = deepOverride ?? config.deepScan;
  const deepScanSamples = deepScanEnabled
    ? gatherDeepScanSamples(cwd, localScan.files, typeof deepScanEnabled === "number" ? deepScanEnabled : 5)
    : [];

  const modelInfo = resolveModelInfo(modelConfig.provider, modelConfig.id, {
    contextWindow: modelConfig.contextWindow,
    maxOutputTokens: modelConfig.maxOutputTokens,
  });
  const reservedOutputTokens =
    modelConfig.thinking && modelConfig.thinking.toLowerCase() !== "off"
      ? Math.min(modelInfo.maxOutputTokens, 8192)
      : Math.min(modelInfo.maxOutputTokens, 2048);
  const safetyMarginTokens = Math.ceil(modelInfo.contextWindow * 0.1);
  const maxPromptTokens = modelInfo.contextWindow - reservedOutputTokens - safetyMarginTokens;

  let filesForPrompt = filterSourceFiles(localScan.files).slice(0, 200);
  let trimmedSamples = deepScanSamples;
  function buildScanUserPrompt(samples: typeof deepScanSamples): string {
    const samplesText =
      samples.length > 0
        ? `\n\n<code_samples>\n${samples.map((s) => `--- ${s.file} ---\n${s.content}`).join("\n\n")}\n</code_samples>`
        : "";
    return `${user}\n\nFiles:\n${filesForPrompt.join("\n")}${configFilesText}${samplesText}`;
  }
  while (true) {
    const promptText = buildScanUserPrompt(trimmedSamples);
    const totalTokens = estimateTokens(system) + estimateTokens(promptText);
    if (totalTokens <= maxPromptTokens || (filesForPrompt.length <= 50 && trimmedSamples.length === 0)) break;
    if (trimmedSamples.length > 0) {
      trimmedSamples = trimmedSamples.slice(0, Math.max(0, trimmedSamples.length - 1));
    } else if (filesForPrompt.length > 50) {
      filesForPrompt = filesForPrompt.slice(0, Math.max(50, Math.floor(filesForPrompt.length * 0.8)));
    } else {
      break;
    }
  }
  const deepScanText =
    trimmedSamples.length > 0
      ? `\n\n<code_samples>\n${trimmedSamples.map((s) => `--- ${s.file} ---\n${s.content}`).join("\n\n")}\n</code_samples>`
      : "";

  const prompt = `${user}\n\nFiles:\n${filesForPrompt.join("\n")}${configFilesText}${deepScanText}`;
  const localConventions = { ...localScan.conventions, generatedAt: undefined };
  const cacheKey = scanFingerprint({
    version: 1,
    system,
    prompt,
    modelConfig,
    deepScan: deepScanEnabled ?? false,
    files: localScan.files,
    localConventions,
  });
  const cached = refresh ? null : getCachedScan(cwd, cacheKey);
  if (cached && !signal?.aborted) {
    progress(2, STAGES.scan, "Reusing unchanged scan inputs…");
    if (deepScanEnabled) {
      try {
        const index = loadFreshProjectIndex(cwd, true)!;
        const enriched = enrichConventionsFromIndex(cached, index);
        cached.publicApi = enriched.publicApi;
        cached.commonPatterns = enriched.commonPatterns;
        saveConventions(cwd, cached);
        saveScanCache(cwd, cacheKey, cached, true);
      } catch (error) {
        logEvent(cwd, "warn", "Failed to refresh cached scan index", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { action: "scan", scan: { conventions: cached, files: localScan.files, cached: true }, model: modelProfile };
  }

  progress(2, STAGES.scan, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const {
    content: raw,
    usage,
    rounds,
    truncated: finalTruncated,
  } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, prompt, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    task: "scan",
    structuredOutput: true,
    onStreamProgress: createStreamProgressCallback(progress, 2, STAGES.scan),
  });

  progress(3, STAGES.scan, "Merging conventions…");
  const parsed = parseJsonResponse(raw);
  const llmConventions = validateConventionsResult(parsed);
  if (!llmConventions && raw.trim().length > 0) {
    logEvent(cwd, "debug", "Scan conventions response was not valid JSON; using local scan only", {
      raw: raw.slice(0, 2000),
    });
  }
  const conventions = llmConventions ? mergeConventions(localScan.conventions, llmConventions) : localScan.conventions;
  progress(4, STAGES.scan, "Saving conventions…");
  saveConventions(cwd, conventions);

  if (deepScanEnabled) {
    try {
      const index = loadFreshProjectIndex(cwd, true)!;
      const enriched = enrichConventionsFromIndex(conventions, index);
      conventions.publicApi = enriched.publicApi;
      conventions.commonPatterns = enriched.commonPatterns;
      saveConventions(cwd, conventions);
      logEvent(cwd, "info", "Project index built", {
        files: index.files.length,
        symbols: index.files.reduce((sum, f) => sum + f.symbols.length, 0),
        publicApiCount: conventions.publicApi?.length,
        commonPatternsCount: conventions.commonPatterns?.length,
      });
    } catch (err) {
      logEvent(cwd, "warn", "Failed to build project index", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Invalid/truncated model responses are retryable; do not freeze a local-only
  // fallback as if the secondary model had completed its scan.
  if (llmConventions && !finalTruncated && !signal?.aborted) saveScanCache(cwd, cacheKey, conventions);

  logEvent(cwd, "info", "Scan completed", {
    deepScan: Boolean(deepScanEnabled),
    sampleCount: trimmedSamples.length,
    filesForPrompt: filesForPrompt.length,
    provider: modelConfig.provider,
    model: modelConfig.id,
    estimatedCostUsd: usage.estimatedCostUsd,
  });

  return {
    action: "scan",
    scan: { conventions, files: localScan.files },
    cost: recordCostWithBudget(cwd, usage),
    model: modelProfile,
    continuation: continuationMeta(rounds, finalTruncated ?? false),
  };
}
