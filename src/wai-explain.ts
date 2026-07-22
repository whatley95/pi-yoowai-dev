import { existsSync, readFileSync } from "node:fs";
import { loadYoowaiConfig, resolveTaskModel } from "./config.js";
import { callSecondaryModel } from "./secondary-model.js";
import { loadConventions, formatConventions } from "./conventions.js";
import { loadProjectIndex } from "./project-index.js";
import { recordCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import { resolveProjectPath } from "./path-security.js";
import { buildExplainPrompt } from "./prompts.js";
import { loadDocContext, type DocContextRequest } from "./doc-fetcher.js";
import { createStreamProgressCallback } from "./actions/shared.js";
import type { ProgressReporter } from "./progress.js";
import type { ExplainResult, UsageCost } from "./types.js";

export interface YooExplainParams {
  target: string;
  context?: string;
  files?: string[];
  docs?: string[];
}

export function validateWaiExplainParams(
  raw: unknown,
): { ok: false; error: string } | { ok: true; params: YooExplainParams } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid parameters: expected an object." };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.target !== "string" || r.target.length === 0) {
    return { ok: false, error: "Missing or empty 'target' parameter." };
  }
  const params: YooExplainParams = { target: r.target };
  if (typeof r.context === "string") {
    params.context = r.context;
  }
  if (Array.isArray(r.files)) {
    params.files = r.files.filter((f): f is string => typeof f === "string");
  }
  if (Array.isArray(r.docs)) {
    params.docs = r.docs.filter((d): d is string => typeof d === "string" && d.length > 0);
  }
  return { ok: true, params };
}

function readFiles(cwd: string, files: string[]): Array<{ file: string; content: string }> {
  const entries: Array<{ file: string; content: string }> = [];
  for (const file of files) {
    const safePath = resolveProjectPath(cwd, file);
    if (!safePath || !existsSync(safePath)) continue;
    try {
      const content = readFileSync(safePath, "utf-8");
      if (content.length > 500 * 1024) {
        entries.push({ file, content: content.slice(0, 500 * 1024) + "\n..." });
      } else {
        entries.push({ file, content });
      }
    } catch {
      // ignore unreadable files
    }
  }
  return entries;
}

export async function executeWaiExplain(
  cwd: string,
  params: YooExplainParams,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: {
    getHeader(): unknown;
    getBranch(): unknown[];
  },
): Promise<{ result: ExplainResult; cost: UsageCost } | { error: string }> {
  const config = loadYoowaiConfig(cwd);
  const modelConfig = resolveTaskModel(config, "explain");
  if (!modelConfig.provider || !modelConfig.id) {
    return { error: "No secondary model configured. Set pi-yoowai.secondary in settings.json." };
  }

  const docRequest: DocContextRequest = { docs: params.docs };
  const hasDocs = Boolean(params.docs?.length);
  const totalStages = hasDocs ? 4 : 3;

  progress(1, totalStages, "Loading project context…");
  const conventions = loadConventions(cwd);
  const conventionsText = conventions ? formatConventions(conventions) : "";
  const index = loadProjectIndex(cwd);
  const indexSummary = index ? summarizeIndexForExplain(index, params.target) : "";

  progress(2, totalStages, "Reading referenced files…");
  const fileContents = params.files ? readFiles(cwd, params.files) : [];

  let docContext = "";
  if (hasDocs) {
    progress(3, totalStages, "Fetching external docs…");
    docContext = await loadDocContext(cwd, config.docs, docRequest);
  }

  progress(hasDocs ? 4 : 3, totalStages, `Calling ${modelConfig.provider}:${modelConfig.id}…`);
  const { system, user } = buildExplainPrompt(
    params.target,
    params.context,
    conventionsText,
    indexSummary,
    fileContents,
    docContext,
  );
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    task: "explain",
    onStreamProgress: createStreamProgressCallback(progress, hasDocs ? 4 : 3, totalStages),
  });

  const cost = recordCost(cwd, usage, config.costBudgetUsd);
  logEvent(cwd, "info", "Explain completed", {
    target: params.target.slice(0, 200),
    files: fileContents.map((f) => f.file),
    provider: modelConfig.provider,
    model: modelConfig.id,
  });

  return {
    result: {
      summary: raw.slice(0, 500).trim(),
      details: raw.trim(),
      relatedFiles: fileContents.map((f) => f.file),
    },
    cost,
  };
}

function summarizeIndexForExplain(index: import("./project-index.js").ProjectIndex, target: string): string {
  const lowerTarget = target.toLowerCase();
  const matches: string[] = [];
  for (const file of index.files) {
    for (const symbol of file.symbols) {
      if (
        symbol.name.toLowerCase().includes(lowerTarget) ||
        file.file.toLowerCase().includes(lowerTarget) ||
        (symbol.signature && symbol.signature.toLowerCase().includes(lowerTarget))
      ) {
        matches.push(
          `${symbol.kind} ${symbol.name} in ${file.file}:${symbol.line}${symbol.exported ? " (exported)" : ""}`,
        );
      }
    }
  }
  if (matches.length === 0) return "";
  return `Relevant symbols from the project index:\n${matches.slice(0, 20).join("\n")}`;
}
