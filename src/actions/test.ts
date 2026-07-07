import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadHeyyooConfig, resolveTaskModel } from "../config.js";
import { getDiff } from "../diff-grabber.js";
import { loadConventions, formatConventions } from "../conventions.js";
import { callSecondaryModel, providerSupportsJsonObject } from "../secondary-model.js";
import { loadFileContentsForReview, type FileContentEntry } from "../file-loader.js";
import { runPreReviewCommands, formatPreReviewOutput } from "../pre-review.js";
import { calculateReviewBudget } from "../token-budget.js";
import { buildTestPrompt, validateTestResult, getTestValidationErrors, salvageTestFromMarkdown } from "../prompts.js";
import { STAGES, secondaryModelLabel, recordCostWithBudget, parseStructuredResult } from "./shared.js";
import { getSessionContext } from "./review-helpers.js";
import type { ProgressReporter } from "../progress.js";
import type { YooToolResult, Conventions } from "../types.js";

function detectTestCommand(cwd: string, conventions: Conventions | null): string | undefined {
  try {
    const pkgPath = join(cwd, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
      if (typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim().length > 0) {
        return "npm test";
      }
    }
  } catch {
    // ignore
  }
  const testScript = conventions?.scripts.find((s) => s.trim().startsWith("test:"));
  if (testScript) {
    return testScript.replace(/^test:\s*/, "").trim();
  }
  return undefined;
}

function mapFileContentEntries(
  entries: FileContentEntry[],
): { file: string; content: string; mode: "full" | "outline" }[] {
  return entries.map((e) => ({ file: e.file, content: e.content, mode: e.mode }));
}

export async function executeYooTest(
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
    command?: string;
  } = {},
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
): Promise<YooToolResult> {
  const config = loadHeyyooConfig(cwd);
  const modelConfig = resolveTaskModel(config, "test");
  if (!modelConfig.provider || !modelConfig.id) {
    return { action: "test", error: "No secondary model configured. Set pi-heyyoo.secondary in settings.json." };
  }
  const nativeJson = providerSupportsJsonObject(modelConfig.provider, modelConfig.id, modelConfig);

  progress(1, STAGES.test, "Collecting diff…");
  const { diff, changedFiles } = getDiff(cwd, {
    ...options,
    maxDiffChars: config.reviewMaxDiffChars,
  });
  const sessionContext = getSessionContext(ctx);

  progress(2, STAGES.test, "Loading project conventions…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";

  progress(3, STAGES.test, "Running tests…");
  const testCommand = options.command ?? config.testCommand ?? detectTestCommand(cwd, conventions);
  let testOutput: string;
  if (testCommand) {
    const results = await runPreReviewCommands(cwd, [testCommand]);
    testOutput = formatPreReviewOutput(results);
  } else {
    testOutput = "No test command was detected or configured. Falling back to static analysis of the diff.";
  }

  progress(4, STAGES.test, "Calculating token budget…");
  const budget = calculateReviewBudget(
    modelConfig.provider,
    modelConfig.id,
    config,
    {
      systemPrompt: "",
      sessionContext,
      conventionsText,
      preReviewOutput: testOutput,
      description,
      memoryContext: "",
    },
    modelConfig,
  );

  progress(5, STAGES.test, "Loading changed file contents…");
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

  const { system, user } = buildTestPrompt(description, diff, fileContents, testOutput, conventionsText, nativeJson);
  progress(6, STAGES.test, `Calling ${secondaryModelLabel(modelConfig)}…`);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager: ctx.sessionManager,
    task: "test",
    structuredOutput: true,
  });

  progress(7, STAGES.test, "Parsing test result…");
  const cost = recordCostWithBudget(cwd, usage);
  const test = parseStructuredResult(cwd, raw, {
    label: "Test result",
    validate: validateTestResult,
    validationErrors: getTestValidationErrors,
    salvage: salvageTestFromMarkdown,
    salvageDetails: (salvaged) => ({
      verdict: salvaged.verdict,
      findingCount: salvaged.findings.length,
      missingTestCount: salvaged.missingTests.length,
    }),
  });
  if (!test) {
    return {
      action: "test",
      error: "Failed to parse test analysis from secondary model response.",
      cost,
    };
  }

  return { action: "test", test, cost };
}
