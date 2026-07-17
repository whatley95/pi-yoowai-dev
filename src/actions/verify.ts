import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callSecondaryModel } from "../secondary-model.js";
import { buildVerifyPrompt, parseJsonResponse, getJsonParseError } from "../prompts.js";
import { logEvent } from "../logger.js";
import { mergeUsageCost } from "./shared.js";
import type { UsageCost, SecondaryModelConfig } from "../types.js";

export async function verifyResult<T>(
  cwd: string,
  modelConfig: SecondaryModelConfig,
  options: {
    originalSystem: string;
    originalUser: string;
    result: T;
    task: "review" | "judge";
    signal?: AbortSignal;
    sessionManager?: ExtensionContext["sessionManager"];
    validate: (data: unknown) => T | null;
    validationErrors: (data: unknown) => Array<{ path: string; message: string; value: unknown }>;
    salvage?: (raw: string) => T | null;
  },
): Promise<{ result: T; usage: UsageCost }> {
  const originalContextRaw = `${options.originalSystem}\n\n${options.originalUser}`;
  const originalResultRaw = JSON.stringify(options.result, null, 2);
  // Self-verification re-sends the full original context + result. For the
  // largest reviews that overflows the model context and the verify call fails
  // deterministically, so cap both inputs before building the prompt.
  const MAX_VERIFY_CONTEXT_CHARS = 120_000;
  const MAX_VERIFY_RESULT_CHARS = 40_000;
  const originalContext =
    originalContextRaw.length > MAX_VERIFY_CONTEXT_CHARS
      ? originalContextRaw.slice(0, MAX_VERIFY_CONTEXT_CHARS) + "\n... (original context truncated for verification)"
      : originalContextRaw;
  const originalResult =
    originalResultRaw.length > MAX_VERIFY_RESULT_CHARS
      ? originalResultRaw.slice(0, MAX_VERIFY_RESULT_CHARS) + "\n... (original result truncated for verification)"
      : originalResultRaw;
  const { system, user } = buildVerifyPrompt(originalContext, originalResult, options.task);

  const { content: raw, usage } = await callSecondaryModel(modelConfig.provider, modelConfig.id, system, user, {
    signal: options.signal,
    thinking: modelConfig.thinking,
    cwd,
    sessionManager: options.sessionManager,
    task: options.task,
    structuredOutput: true,
  });

  const parsed = parseJsonResponse(raw);
  const verified = options.validate(parsed);
  if (verified) {
    logEvent(cwd, "info", `Self-verified ${options.task} result`, {
      provider: modelConfig.provider,
      model: modelConfig.id,
    });
    return { result: verified, usage };
  }

  const details = {
    raw: raw.slice(0, 2000),
    parsed: parsed === null ? null : typeof parsed,
    parseError: getJsonParseError(raw),
    validationErrors: parsed ? options.validationErrors(parsed) : [],
  };
  logEvent(cwd, "warn", `Self-verification of ${options.task} produced invalid JSON; keeping original result`, details);
  // Keep the already-valid original result rather than replacing it with a
  // lossy keyword salvage of the (invalid) re-verification output.
  return { result: options.result, usage };
}

export function mergeVerifiedCost(base: UsageCost | undefined, verify: UsageCost | undefined): UsageCost | undefined {
  if (!base) return verify;
  if (!verify) return base;
  return mergeUsageCost(base, verify);
}
