import { readFileSync, statSync } from "node:fs";
import { logEvent } from "./logger.js";
import { parseJsonResponse } from "./prompts.js";
import { runPreReviewCommands } from "./pre-review.js";
import { resolveProjectPath } from "./path-security.js";
import { listTrackedFiles } from "./conventions.js";
import { mergeUsageCost } from "./actions/shared.js";
import type { CallSecondaryModelOptions, UsageCost } from "./types.js";

export interface ToolRequest {
  tool: "read_file" | "run_command" | "search_code";
  path?: string;
  command?: string;
  /** Optional 1-based inclusive line range for read_file. */
  startLine?: number;
  endLine?: number;
  /** Regex pattern for search_code. */
  pattern?: string;
  /** Surrounding lines per match for search_code (0-5, default 1). */
  contextLines?: number;
}

export interface ToolResult {
  output: string;
  error?: string;
}

const DEFAULT_MAX_ITERATIONS = 5;
const MAX_TOOL_FILE_BYTES = 100 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 4000;
const MAX_SEARCH_MATCHES = 50;
// Guardrails for the model-generated search pattern: length cap, and a
// nested-quantifier heuristic for catastrophic-backtracking shapes like
// (a+)+ or (\w+\s?)+ — a group that contains a quantifier and is itself
// quantified. Coverage boundary: the heuristic does not parse character
// classes or nesting — a + or * inside [...] is treated as a quantifier
// (false positive, e.g. ([a+])+), and shapes where the quantifier is hidden
// an extra nesting level deep with no group-close directly followed by a
// quantifier (e.g. (?:(a+))+) are missed. Plain non-capturing groups like
// (?:a+)+ are caught. An escaped-literal pattern like \\(a+\\)+ is a false
// positive too (it only rejects the pattern with an explanatory error —
// acceptable for a model-retryable tool).
const MAX_SEARCH_PATTERN_CHARS = 200;
const MAX_SEARCH_LINE_CHARS = 10_000;
const NESTED_QUANTIFIER_RE = /\([^)]*[+*{][^)]*\)\s*[+*{]/;

function buildToolInstruction(maxIterations: number): string {
  return `You may request additional context before producing your final structured JSON result. To request context, output a single JSON block exactly like one of these examples and nothing else:

{"tool": "read_file", "path": "relative/path/to/file.ts"}
{"tool": "read_file", "path": "relative/path/to/file.ts", "startLine": 100, "endLine": 200}
{"tool": "search_code", "pattern": "functionName\\\\(", "path": "src", "contextLines": 2}
{"tool": "run_command", "command": "npm run typecheck"}

read_file accepts optional startLine/endLine (1-based, inclusive) to page through large files; when a file is truncated, the result tells you the total line count so you can request a specific range. search_code finds regex matches across project files (path is an optional file/directory scope, contextLines is 0-5 of surrounding lines per match) — use it to locate callers, definitions, or patterns, then read_file the hits.

You may make up to ${maxIterations} such request(s). After each request, the tool result will be appended to this conversation. Once you have enough context, produce the final structured JSON result requested below. Do not output explanatory text with a tool request. If no additional context is needed, produce the final JSON result immediately.`;
}

function parseToolRequest(text: string): ToolRequest | null {
  const parsed = parseJsonResponse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (!("tool" in obj)) return null;
  const tool = obj.tool;
  if (tool !== "read_file" && tool !== "run_command" && tool !== "search_code") return null;
  const contextLines =
    typeof obj.contextLines === "number" && Number.isFinite(obj.contextLines)
      ? Math.min(Math.max(Math.floor(obj.contextLines), 0), 5)
      : undefined;
  return {
    tool,
    path: typeof obj.path === "string" ? obj.path : undefined,
    command: typeof obj.command === "string" ? obj.command : undefined,
    startLine: typeof obj.startLine === "number" && Number.isFinite(obj.startLine) ? obj.startLine : undefined,
    endLine: typeof obj.endLine === "number" && Number.isFinite(obj.endLine) ? obj.endLine : undefined,
    pattern: typeof obj.pattern === "string" ? obj.pattern : undefined,
    contextLines,
  };
}

/** Truncate file content with a paging hint so the model can request a
 *  specific line range next. */
function truncateFileOutput(text: string, path: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const totalLines = text.split(/\r?\n/).length;
  const endLine = Math.min(totalLines, 300);
  return (
    text.slice(0, MAX_TOOL_OUTPUT_CHARS) +
    `\n… (truncated — file has ${totalLines} lines; request {"tool":"read_file","path":"${path}","startLine":1,"endLine":${endLine}} for a specific range)`
  );
}

/** Truncate command output keeping head (~70%) and tail (~30%) — command
 *  failures usually matter at the end. */
function truncateCommandOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const headChars = Math.floor(MAX_TOOL_OUTPUT_CHARS * 0.7);
  const tailChars = MAX_TOOL_OUTPUT_CHARS - headChars;
  const elided = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n… (${elided} chars elided) …\n${text.slice(-tailChars)}`;
}

function readFileTool(cwd: string, path: string, startLine?: number, endLine?: number): ToolResult {
  const safePath = resolveProjectPath(cwd, path);
  if (!safePath) {
    return { output: "", error: `Path is not allowed: ${path}` };
  }
  try {
    const content = readFileSync(safePath, "utf-8");
    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split(/\r?\n/);
      // Clamp to file bounds; swap when inverted. Non-finite values were
      // already filtered during request parsing.
      let start = Math.max(1, Math.floor(startLine ?? 1));
      let end = Math.min(lines.length, Math.floor(endLine ?? lines.length));
      if (start > end) [start, end] = [Math.max(1, Math.min(end, lines.length)), Math.min(lines.length, start)];
      const ranged = lines.slice(start - 1, end).join("\n");
      return { output: truncateFileOutput(ranged, path) };
    }
    const stats = statSync(safePath);
    if (stats.size > MAX_TOOL_FILE_BYTES) {
      return { output: truncateFileOutput(content, path) };
    }
    return { output: truncateFileOutput(content, path) };
  } catch (err) {
    return { output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

async function runCommandTool(cwd: string, command: string): Promise<ToolResult> {
  try {
    // Model-generated commands are restricted to read-only subcommands;
    // user-configured preReviewCommands run without this restriction.
    const [result] = await runPreReviewCommands(cwd, [command], { restrictSubcommands: true });
    return {
      output: truncateCommandOutput(result.output),
      error: result.exitCode !== 0 ? `Command exited with code ${result.exitCode}` : undefined,
    };
  } catch (err) {
    return { output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Regex search across project files (git-tracked or the portable fallback scan).
 *  Returns file:line hits with ±contextLines of surrounding content, capped at
 *  MAX_SEARCH_MATCHES matches and MAX_TOOL_OUTPUT_CHARS total output. */
function searchCodeTool(cwd: string, request: ToolRequest): ToolResult {
  const pattern = request.pattern;
  if (!pattern) return { output: "", error: "search_code requires a pattern" };
  if (pattern.length > MAX_SEARCH_PATTERN_CHARS) {
    return {
      output: "",
      error: `search_code pattern too long (${pattern.length} chars; max ${MAX_SEARCH_PATTERN_CHARS})`,
    };
  }
  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    return {
      output: "",
      error:
        "search_code pattern rejected: nested quantifiers (e.g. (a+)+) can cause catastrophic backtracking; simplify the pattern",
    };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (err) {
    return { output: "", error: `Invalid regex: ${err instanceof Error ? err.message : String(err)}` };
  }
  const context = request.contextLines ?? 1;

  // Scope: an explicit path (single file or directory prefix) or all tracked files.
  let files: string[];
  if (request.path) {
    const safePath = resolveProjectPath(cwd, request.path);
    if (!safePath) return { output: "", error: `Path is not allowed: ${request.path}` };
    try {
      const normalized = request.path.replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/+$/, "");
      if (statSync(safePath).isDirectory()) {
        files = listTrackedFiles(cwd).filter((f) => f === normalized || f.startsWith(`${normalized}/`));
      } else {
        files = [normalized];
      }
    } catch (err) {
      return { output: "", error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    files = listTrackedFiles(cwd);
  }

  const out: string[] = [];
  let matches = 0;
  let stoppedEarly = false;
  for (const file of files) {
    if (matches >= MAX_SEARCH_MATCHES) {
      stoppedEarly = true;
      break;
    }
    const safePath = resolveProjectPath(cwd, file);
    if (!safePath) continue;
    try {
      if (statSync(safePath).size > MAX_TOOL_FILE_BYTES) continue;
      const content = readFileSync(safePath, "utf-8");
      if (content.includes("\0")) continue; // skip binary files
      const fileLines = content.split(/\r?\n/);
      for (let i = 0; i < fileLines.length; i++) {
        // Very long lines (minified files) are skipped: with model-generated
        // patterns, even linear regexes get slow on megabyte lines, and
        // catastrophic backtracking only bites on long input.
        if (fileLines[i].length > MAX_SEARCH_LINE_CHARS) continue;
        if (!regex.test(fileLines[i])) continue;
        const from = Math.max(0, i - context);
        const to = Math.min(fileLines.length - 1, i + context);
        for (let j = from; j <= to; j++) {
          out.push(`${file}:${j + 1}: ${fileLines[j]}`);
        }
        out.push("--");
        matches++;
        if (matches >= MAX_SEARCH_MATCHES) {
          stoppedEarly = true;
          break;
        }
      }
    } catch {
      // Unreadable file — skip it.
    }
  }

  if (matches === 0) return { output: `No matches for /${pattern}/ in ${files.length} file(s).` };
  const header = stoppedEarly ? `… (stopped after ${MAX_SEARCH_MATCHES} matches)\n` : "";
  return { output: truncateFileOutput(header + out.join("\n"), request.path ?? "(search)") };
}

async function executeTool(cwd: string, request: ToolRequest): Promise<ToolResult> {
  if (request.tool === "read_file") {
    if (!request.path) return { output: "", error: "read_file requires a path" };
    return readFileTool(cwd, request.path, request.startLine, request.endLine);
  }
  if (request.tool === "search_code") {
    return searchCodeTool(cwd, request);
  }
  if (request.tool === "run_command") {
    if (!request.command) return { output: "", error: "run_command requires a command" };
    return runCommandTool(cwd, request.command);
  }
  return { output: "", error: `Unknown tool: ${request.tool}` };
}

function formatToolResult(request: ToolRequest, result: ToolResult): string {
  const description =
    request.tool === "read_file"
      ? `read_file ${request.path}`
      : request.tool === "search_code"
        ? `search_code /${request.pattern}/${request.path ? ` in ${request.path}` : ""}`
        : `run_command ${request.command}`;
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
