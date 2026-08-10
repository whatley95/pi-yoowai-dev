import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { loadYoowaiConfig, resolveTaskModel } from "./config.js";
import { callSecondaryModel } from "./secondary-model.js";
import { recordCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import { resolveProjectPath } from "./path-security.js";
import { buildVisionPrompt } from "./prompts.js";
import { createStreamProgressCallback } from "./actions/shared.js";
import { resolveBackendType } from "./backends/backend-resolver.js";
import type { ProgressReporter } from "./progress.js";
import type { StageProfile, UsageCost, VisionResult } from "./types.js";

/** Max image size sent to the secondary model (base64 inflates ~4/3 beyond this). */
export const VISION_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Map an image file path to its mime type, or undefined for unsupported types. */
export function imageMimeType(path: string): string | undefined {
  return MIME_BY_EXT[extname(path).toLowerCase()];
}

export interface YooVisionParams {
  path: string;
  question?: string;
  context?: string;
}

export function validateWaiVisionParams(
  raw: unknown,
): { ok: false; error: string } | { ok: true; params: YooVisionParams } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Invalid parameters: expected an object." };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string" || r.path.length === 0) {
    return { ok: false, error: "Missing or empty 'path' parameter." };
  }
  const params: YooVisionParams = { path: r.path };
  if (typeof r.question === "string" && r.question.length > 0) {
    params.question = r.question;
  }
  if (typeof r.context === "string" && r.context.length > 0) {
    params.context = r.context;
  }
  return { ok: true, params };
}

/** Resolve and validate the image file: project-relative path, supported type, size cap. */
export function loadVisionImage(
  cwd: string,
  path: string,
): { ok: false; error: string } | { ok: true; data: string; mimeType: string } {
  const safePath = resolveProjectPath(cwd, path);
  if (!safePath) {
    return { ok: false, error: `Invalid image path "${path}": must be a project-relative path inside the project.` };
  }
  const mimeType = imageMimeType(safePath);
  if (!mimeType) {
    return {
      ok: false,
      error: `Unsupported image type "${extname(path)}". Supported: ${Object.keys(MIME_BY_EXT).join(", ")}.`,
    };
  }
  if (!existsSync(safePath)) {
    return { ok: false, error: `Image not found: ${path}` };
  }
  let size: number;
  try {
    size = statSync(safePath).size;
  } catch {
    return { ok: false, error: `Cannot read image: ${path}` };
  }
  if (size > VISION_MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `Image too large: ${(size / 1024 / 1024).toFixed(1)} MB (max ${VISION_MAX_IMAGE_BYTES / 1024 / 1024} MB).`,
    };
  }
  try {
    return { ok: true, data: readFileSync(safePath).toString("base64"), mimeType };
  } catch {
    return { ok: false, error: `Cannot read image: ${path}` };
  }
}

export async function executeWaiVision(
  cwd: string,
  params: YooVisionParams,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
  sessionManager?: {
    getHeader(): unknown;
    getBranch(): unknown[];
  },
): Promise<{ result: VisionResult; cost: UsageCost; model: StageProfile } | { error: string }> {
  const config = loadYoowaiConfig(cwd);
  const modelConfig = resolveTaskModel(config, "vision");
  if (!modelConfig.provider || !modelConfig.id) {
    return { error: "No secondary model configured. Set pi-yoowai.secondary in settings.json." };
  }

  progress(1, 3, "Loading image…");
  const image = loadVisionImage(cwd, params.path);
  if (!image.ok) {
    return { error: image.error };
  }

  progress(2, 3, `Calling ${modelConfig.provider}:${modelConfig.id}…`);
  const { system, user } = buildVisionPrompt(params.path, params.question, params.context);
  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager,
    task: "vision",
    images: [{ data: image.data, mimeType: image.mimeType }],
    onStreamProgress: createStreamProgressCallback(progress, 2, 3),
  });

  const cost = recordCost(cwd, usage, config.costBudgetUsd);
  const model = {
    provider: modelConfig.provider,
    id: modelConfig.id,
    thinking: modelConfig.thinking,
    backend: resolveBackendType(modelConfig.provider, modelConfig),
  };
  logEvent(cwd, "info", "Vision analysis completed", {
    path: params.path,
    mimeType: image.mimeType,
    provider: modelConfig.provider,
    model: modelConfig.id,
  });

  progress(3, 3, "Vision analysis complete");
  return {
    result: {
      summary: raw.slice(0, 500).trim(),
      details: raw.trim(),
      imagePath: params.path,
      mimeType: image.mimeType,
    },
    cost,
    model,
  };
}
