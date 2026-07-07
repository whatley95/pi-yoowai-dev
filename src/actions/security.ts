import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { getDiff } from "../diff-grabber.js";
import { loadConventions, formatConventions, scanProjectConventions, gatherDeepScanSamples } from "../conventions.js";
import { callSecondaryModel, providerSupportsJsonObject } from "../secondary-model.js";
import { loadFileContentsForReview, type FileContentEntry } from "../file-loader.js";
import { calculateReviewBudget } from "../token-budget.js";
import {
  buildSecurityPrompt,
  validateSecurityResult,
  getSecurityValidationErrors,
  salvageSecurityFromMarkdown,
} from "../prompts.js";
import { STAGES, secondaryModelLabel, recordCostWithBudget, parseStructuredResult } from "./shared.js";
import { getSessionContext } from "./review-helpers.js";
import type { ProgressReporter } from "../progress.js";
import type { YooToolResult } from "../types.js";

function mapFileContentEntries(
  entries: FileContentEntry[],
): { file: string; content: string; mode: "full" | "outline" }[] {
  return entries.map((e) => ({ file: e.file, content: e.content, mode: e.mode }));
}

export async function executeYooSecurity(
  cwd: string,
  description: string,
  ctx: ExtensionContext,
  options: {
    files?: string[];
    exclude?: string[];
    revision?: string;
    since?: string;
    vcs?: "git" | "svn";
    untracked?: boolean;
    fullProject?: boolean;
  } = {},
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "security");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "security", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig);

  const sessionContext = getSessionContext(ctx);
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  let diff: string;
  let changedFiles: string[];

  if (options.fullProject) {
    progress(1, STAGES.security, "Collecting project files…");
    const scanResult = conventions ? { conventions, files: conventions.entryPoints } : scanProjectConventions(cwd);
    const samples = gatherDeepScanSamples(cwd, scanResult.files, 10);
    changedFiles = samples.map((s) => s.file);
    diff = `Project-wide security scan of ${changedFiles.length} sampled file(s).`;
  } else {
    progress(1, STAGES.security, "Collecting diff…");
    const diffResult = getDiff(cwd, {
      ...options,
      maxDiffChars: config.reviewMaxDiffChars,
    });
    diff = diffResult.diff;
    changedFiles = diffResult.changedFiles;
  }

  progress(2, STAGES.security, "Calculating token budget…");
  const budget = calculateReviewBudget(
    modelConfig.provider,
    modelConfig.id,
    config,
    {
      systemPrompt: "",
      sessionContext,
      conventionsText,
      preReviewOutput: "",
      description,
      memoryContext: "",
    },
    modelConfig,
  );

  progress(3, STAGES.security, "Loading file contents…");
  const strategy = config.reviewStrategy ?? "auto";
  const fullFileThresholdLines = config.reviewFullFileThresholdLines ?? 300;
  const fileResult = await loadFileContentsForReview({
    cwd,
    changedFiles,
    budget,
    strategy,
    fullFileThresholdLines,
  });
  const fileContents = mapFileContentEntries(fileResult.entries);

  const { system, user } = buildSecurityPrompt(description, diff, fileContents, conventionsText, nativeJson);
  progress(4, STAGES.security, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager: ctx.sessionManager,
    task: "security",
    structuredOutput: true,
  });

  progress(5, STAGES.security, "Parsing security audit…");
  const cost = recordCostWithBudget(cwd, usage);
  const security = parseStructuredResult(cwd, raw, {
    label: "Security result",
    validate: validateSecurityResult,
    validationErrors: getSecurityValidationErrors,
    salvage: salvageSecurityFromMarkdown,
    salvageDetails: (salvaged) => ({
      verdict: salvaged.verdict,
      findingCount: salvaged.findings.length,
    }),
  });
  if (!security) {
    return {
      action: "security",
      error: "Failed to parse security audit from secondary model response.",
      cost,
    };
  }

  return { action: "security", security, cost };
}
