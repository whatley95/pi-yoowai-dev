import { readFileSync, statSync } from "node:fs";
import { logEvent } from "./logger.js";
import { parseJsonResponse } from "./prompts.js";
import { runPreReviewCommands } from "./pre-review.js";
import { resolveProjectPath } from "./path-security.js";
import { mergeUsageCost } from "./actions/shared.js";
import type { CallSecondaryModelOptions, UsageCost } from "./types.js";

export interface ToolRequest {
  tool: "read_file" | "run_command";
  path?: string;
  command?: string;
}

export interface ToolResult {
  output: string;
  error?: string;
}

const DEFAULT_MAX_ITERATIONS = 3;
const MAX_TOOL_FILE_BYTES = 100 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 4000;

function buildToolInstruction(maxIterations: number): string {
  return `You may request additional context before producing your final structured JSON result. To request context, output a single JSON block exactly like one of these examples and nothing else:

{"tool": "read_file", "path": "relative/path/to/file.ts"}
{"tool": "run_command", "command": "npm run typecheck"}

You may make up to ${maxIterations} such request(s). After each request, the tool result will be appended to this conversation. Once you have enough context, produce the final structured JSON result requested below. Do not output explanatory text with a tool request. If no additional context is needed, produce the final JSON result immediately.`;
}

function parseToolRequest(text: string): ToolRequest | null {
  const parsed = parseJsonResponse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!("tool" in obj)) return null;
  const tool = obj.tool;
  if (tool !== "read_file" && tool !== "run_command") return null;
  return {
    tool,
    path: typeof obj.path === "string" ? obj.path : undefined,
    command: typeof obj.command === "string" ? obj.command : undefined,
  };
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_TOOL_OUTPUT_CHARS) + "\n… (truncated)";
}

function readFileTool(cwd: string, path: string): ToolResult {
  const safePath = resolveProjectPath(cwd, path);
  if (!safePath) {
    return { output: "", error: `Path is not allowed: ${path}` };
  }
  try {
    const stats = statSync(safePath);
    if (stats.size > MAX_TOOL_FILE_BYTES) {
      const content = readFileSync(safePath, "utf-8");
      return { output: truncateOutput(content) };
    }
    const content = readFileSync(safePath, "utf-8");
    return { output: truncateOutput(content) };
  } catch (err) {
    return { output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

async function runCommandTool(cwd: string, command: string): Promise<ToolResult> {
  try {
    const [result] = await runPreReviewCommands(cwd, [command]);
    return {
      output: truncateOutput(result.output),
      error: result.exitCode !== 0 ? `Command exited with code ${result.exitCode}` : undefined,
    };
  } catch (err) {
    return { output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

async function executeTool(cwd: string, request: ToolRequest): Promise<ToolResult> {
  if (request.tool === "read_file") {
    if (!request.path) return { output: "", error: "read_file requires a path" };
    return readFileTool(cwd, request.path);
  }
  if (request.tool === "run_command") {
    if (!request.command) return { output: "", error: "run_command requires a command" };
    return runCommandTool(cwd, request.command);
  }
  return { output: "", error: `Unknown tool: ${request.tool}` };
}

function formatToolResult(request: ToolRequest, result: ToolResult): string {
  const description = request.tool === "read_file" ? `read_file ${request.path}` : `run_command ${request.command}`;
  const body = result.error ? `Error: ${result.error}\n${result.output}` : result.output;
  return `\n\n## Tool result: ${description}\n${body}\n\nYou may request another tool or produce the final structured JSON result.`;
}

// NOTE: The tool-loop path is intentionally excluded from full continuation handling
// (see callWithContinuation in secondary-model.ts). The tool-loop manages its own
// multi-turn flow (tool requests/results). However, when the final model response
// is length-truncated (hit its output-token cap), a single resume-call continuation
// is issued so the last structured result is not silently truncated.
export async function executeToolLoop(
  cwd: string,
  systemPrompt: string,
  userPrompt: string,
  options: CallSecondaryModelOptions,
  callModel: (
    system: string,
    user: string,
    opts: CallSecondaryModelOptions,
  ) => Promise<{ content: string; usage: UsageCost; truncated?: boolean }>,
  maxToolIterations = DEFAULT_MAX_ITERATIONS,
): Promise<{ content: string; usage: UsageCost; truncated?: boolean }> {
  const toolInstruction = buildToolInstruction(maxToolIterations);
  const augmentedSystem = `${toolInstruction}\n\n${systemPrompt}`;

  let currentUser = userPrompt;
  let totalUsage: UsageCost | undefined;

  for (let i = 0; i <= maxToolIterations; i++) {
    const { content, usage, truncated } = await callModel(augmentedSystem, currentUser, options);
    totalUsage = totalUsage ? mergeUsageCost(totalUsage, usage) : usage;

    const request = parseToolRequest(content);
    if (!request) {
      return toolLoopWrapTruncated(
        cwd,
        augmentedSystem,
        currentUser,
        options,
        callModel,
        content,
        totalUsage,
        truncated,
      );
    }

    logEvent(cwd, "info", "Tool loop request", {
      iteration: i + 1,
      tool: request.tool,
      path: request.path,
      command: request.command,
    });

    if (i >= maxToolIterations) {
      currentUser +=
        "\n\nYou have reached the maximum number of tool requests. Please produce the final structured JSON result now without additional tools.";
      const {
        content: finalContent,
        usage: finalUsage,
        truncated: finalTruncated,
      } = await callModel(augmentedSystem, currentUser, options);
      totalUsage = mergeUsageCost(totalUsage, finalUsage);
      return toolLoopWrapTruncated(
        cwd,
        augmentedSystem,
        currentUser,
        options,
        callModel,
        finalContent,
        totalUsage,
        finalTruncated,
      );
    }

    const result = await executeTool(cwd, request);
    logEvent(cwd, "info", "Tool loop result", {
      iteration: i + 1,
      tool: request.tool,
      path: request.path,
      command: request.command,
      error: result.error,
      outputLength: result.output.length,
    });
    currentUser += formatToolResult(request, result);
  }

  // All loop iterations return early; this path is unreachable.
  throw new Error("executeToolLoop reached an unreachable state");
}

/** Remove a leading prefix of `previous` from `next` so continuation content is
 *  not duplicated. Mirrors the deduplication used by callWithContinuation in
 *  secondary-model.ts without introducing a circular dependency. */
function stripToolLoopOverlap(previous: string, next: string): string {
  const maxOverlap = Math.min(previous.length, next.length, 200);
  for (let len = maxOverlap; len > 0; len--) {
    if (previous.endsWith(next.slice(0, len))) {
      return next.slice(len);
    }
  }
  const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
  const prevNorm = norm(previous);
  for (let len = maxOverlap; len > 0; len--) {
    const candidate = next.slice(0, len);
    const candidateNorm = norm(candidate);
    if (candidateNorm.length === 0) continue;
    if (prevNorm.endsWith(candidateNorm)) {
      return next.slice(candidate.trimEnd().length);
    }
  }
  return next;
}

/** When the tool-loop's final model call returns a length-truncated response,
 *  issue exactly one resume-call continuation so the structured result is not
 *  silently incomplete. Returns the stitched content or the original if already
 *  complete. */
async function toolLoopWrapTruncated(
  cwd: string,
  system: string,
  user: string,
  options: CallSecondaryModelOptions,
  callModel: (
    s: string,
    u: string,
    o: CallSecondaryModelOptions,
  ) => Promise<{ content: string; usage: UsageCost; truncated?: boolean }>,
  content: string,
  usage: UsageCost,
  truncated: boolean | undefined,
): Promise<{ content: string; usage: UsageCost; truncated?: boolean }> {
  if (!truncated) return { content, usage, truncated: false };

  if (options.signal?.aborted) {
    logEvent(cwd, "info", "Tool-loop resume skipped; request already aborted", {});
    return { content, usage, truncated: true };
  }

  logEvent(cwd, "info", "Tool-loop final response truncated; issuing single resume call", {});
  // Include the tail of the tool conversation for context, then append the resume anchor.
  const toolContext = user.slice(-4000);
  const continued = `${toolContext}\n\nContinue your previous response exactly where it left off. Do not repeat what you already wrote; output only the remaining content.\n\n=== Last content (do not repeat) ===\n${content.slice(-2000)}`;
  try {
    if (options.signal?.aborted) throw new Error("Aborted");
    const {
      content: resumed,
      usage: resumeUsage,
      truncated: resumedTruncated,
    } = await callModel(system, continued, options);
    const deduped = stripToolLoopOverlap(content, resumed);
    const stitched = content + deduped;
    return { content: stitched, usage: mergeUsageCost(usage, resumeUsage), truncated: resumedTruncated ?? false };
  } catch (err) {
    if (options.signal?.aborted) throw err;
    logEvent(cwd, "warn", "Tool-loop resume call failed; returning original truncated content", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { content, usage, truncated: true };
  }
}
