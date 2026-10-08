import { readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { relative, sep } from "node:path";
import { logEvent } from "./logger.js";
import { parseJsonResponse } from "./prompts.js";
import { runPreReviewCommands } from "./pre-review.js";
import { isSafeRelativePath, resolveProjectPath } from "./path-security.js";
import { listTrackedFiles } from "./conventions.js";
import { mergeUsageCost } from "./actions/shared.js";
import { estimateTokens, tokenBudgetChars } from "./token-budget.js";
import { emptyRecordedUsage } from "./cost-tracker.js";
import {
  dispatchNativeReadTool,
  getNativeReadToolNames,
  hasNativeReadTools,
  type NativeReadResult,
} from "./integration/read-tools.js";
import type { CallSecondaryModelOptions, UsageCost } from "./types.js";

export interface ToolRequest {
  tool: "read_file" | "run_command" | "search_code";
  path?: string;
  command?: string;
  /** Optional 1-based inclusive line range for read_file. */
  startLine?: number;
  endLine?: number;
  /** Zero-based character offset into the selected range (for very long lines). */
  offset?: number;
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
const MAX_TOOL_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_OUTPUT_CHARS = 4000;
const MAX_BATCH_READS = 4;
const MAX_REUSED_READS = 2;
const MAX_READ_PAGE_CHARS = 64_000;
const MAX_SEARCH_MATCHES = 50;
const MAX_NATIVE_SEARCH_FILES = 32;
const MAX_NATIVE_SEARCH_GLOB_CHARS = 2000;
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

export class ToolLoopCoverageError extends Error {
  constructor(
    message: string,
    public readonly usage: UsageCost,
    public readonly coverageGaps: string[],
  ) {
    super(message);
    this.name = "ToolLoopCoverageError";
  }
}

function buildToolInstruction(maxIterations: number): string {
  const nativeTools = getNativeReadToolNames();
  const reads = nativeTools === undefined || nativeTools.includes("read");
  const searches = nativeTools === undefined || nativeTools.includes("grep");
  const batchExample = JSON.stringify({
    tools: [
      { tool: "read_file", path: "src/component.ts" },
      ...(maxIterations > 1 ? [{ tool: "read_file", path: "src/component.spec.ts" }] : []),
    ],
  });
  return `You may request additional context before producing your final structured JSON result. To request context, output a single JSON block exactly like one of these examples and nothing else:

${reads ? `{"tool": "read_file", "path": "relative/path/to/file.ts"}\n{"tool": "read_file", "path": "relative/path/to/file.ts", "startLine": 100, "endLine": 200}\n${batchExample}\n` : ""}${searches ? '{"tool": "search_code", "pattern": "functionName\\\\(", "path": "src", "contextLines": 2}\n' : ""}
{"tool": "run_command", "command": "npm run typecheck"}

read_file accepts optional startLine/endLine (1-based, inclusive) and offset (zero-based characters within that range) to page through large files. Follow the exact next-page request in a truncated result; it preserves absolute line numbers and does not repeat the first page. Batch up to ${Math.min(MAX_BATCH_READS, maxIterations)} read_file requests in a tools array when you already know which files you need, but never exceed the latest remaining context-request allowance. New evidence and failed reads count against that allowance; with one request remaining, request only one tool. Use the diff, file contents, and previous tool results already provided before requesting more context; repeated identical reads add no evidence unless the file changes. search_code finds regex matches across project files (path is an optional file/directory scope, contextLines is 0-5 of surrounding lines per match). run_command accepts ONE allowlisted command without shell operators: no semicolons, pipes, &&, substitutions, grep, or ls. Use search_code/read_file for source inspection. It blocks destructive subcommands (push/reset/publish/…); for git, use "<command> -h" for terminal usage — full help ("--help" or "git help …") is rejected because it can open an external viewer (a browser on Windows).

${reads ? "" : "read_file is unavailable: Pi has no callable read tool in this session. Do not request it.\n"}${searches ? "" : "search_code is unavailable: Pi has no callable grep tool in this session. Do not request it.\n"}${nativeTools === undefined ? "" : "Pi controls the availability of reads and searches. Never bypass an unavailable or blocked operation with commands or another reader. Use the evidence already supplied, request permitted missing context, or report that required evidence is unavailable.\n"}

You may make up to ${maxIterations} new-evidence request(s). Identical approved read results can reuse earlier evidence at most ${MAX_REUSED_READS} times without spending another evidence request; commands and unsuccessful reads always count. Do not deliberately repeat reads: model rounds and repeat handling remain bounded. After each request, the tool result will be appended to this conversation. Once you have enough context, produce the final structured JSON result requested below. Do not output explanatory text with a tool request. If no additional context is needed, produce the final JSON result immediately.`;
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
    offset:
      typeof obj.offset === "number" && Number.isFinite(obj.offset) ? Math.max(0, Math.floor(obj.offset)) : undefined,
    pattern: typeof obj.pattern === "string" ? obj.pattern : undefined,
    contextLines,
  };
}

function parseToolRequests(text: string): ToolRequest[] | null {
  const parsed = parseJsonResponse(text);
  if (parsed && typeof parsed === "object" && "tools" in parsed) {
    const batch = (parsed as { tools?: unknown }).tools;
    if (!Array.isArray(batch) || batch.length === 0 || batch.length > MAX_BATCH_READS)
      throw new Error(`Context batches must contain 1-${MAX_BATCH_READS} read_file requests.`);
    const requests = batch.map((item) => parseToolRequest(JSON.stringify(item)));
    if (requests.some((item) => !item || item.tool !== "read_file"))
      throw new Error("Context batches support read_file only; run other tools separately.");
    return requests as ToolRequest[];
  }
  const request = parseToolRequest(text);
  return request ? [request] : null;
}

function remainingRequestInstruction(remaining: number): string {
  const instruction =
    remaining === 0
      ? "Produce the final structured JSON result without additional tools."
      : remaining === 1
        ? "Request at most one tool. Do not batch multiple reads; use existing evidence or request the single missing read."
        : `Batch at most ${Math.min(MAX_BATCH_READS, remaining)} read_file requests; use existing evidence before requesting missing context.`;
  return `\n\nRemaining context requests: ${remaining}. ${instruction} If required evidence cannot be obtained within this allowance, report incomplete coverage in the final result; never claim that unread evidence was reviewed.`;
}

/** Bound each page, preserve full lines where possible, and give a request
 *  that advances even when a single line exceeds the output cap. */
function pageFileOutput(
  lines: string[],
  path: string,
  start: number,
  end: number,
  offset = 0,
  maxChars = MAX_TOOL_OUTPUT_CHARS,
): string {
  const selected = lines.slice(start - 1, end).join("\n");
  offset = Math.min(offset, selected.length);
  let page = selected.slice(offset, offset + maxChars);
  if (offset + page.length < selected.length) {
    const newline = page.lastIndexOf("\n");
    if (newline >= 0) page = page.slice(0, newline + 1);
  }
  const consumed = offset + page.length;
  const prefix = selected.slice(0, consumed);
  const nextLine = start + (prefix.match(/\n/g)?.length ?? 0);
  const header = `[${path}: requested lines ${start}-${end}; file has ${lines.length} lines; offset ${offset}]\n`;
  if (consumed >= selected.length) return header + page;
  const lastNewline = prefix.lastIndexOf("\n");
  const nextOffset = consumed - lastNewline - 1;
  const nextRequest = {
    tool: "read_file",
    path,
    startLine: nextLine,
    endLine: end,
    ...(nextOffset > 0 ? { offset: nextOffset } : {}),
  };
  return header + page + `\n… (truncated — file has ${lines.length} lines; next page: ${JSON.stringify(nextRequest)})`;
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

function pageNativeRead(result: NativeReadResult, request: ToolRequest, maxChars = MAX_TOOL_OUTPUT_CHARS): ToolResult {
  if (result.error) return { output: "", error: truncateCommandOutput(result.error) };
  const truncation = result.details?.truncation as
    { truncated?: boolean; outputLines?: number; firstLineExceedsLimit?: boolean } | undefined;
  if (truncation?.firstLineExceedsLimit)
    return { output: "", error: "Pi read could not return this oversized line. Required context is incomplete." };
  const offset = Math.min(request.offset ?? 0, result.output.length);
  let output = result.output.slice(offset, offset + maxChars);
  // Native output may include host annotations. Page by characters in that
  // exact response, rather than treating annotations as source line numbers.
  if (/[\uD800-\uDBFF]$/.test(output)) output = output.slice(0, -1);
  if (offset + output.length < result.output.length) {
    const next = { ...request, offset: offset + output.length };
    output += `\n… (Pi read output truncated; next page: ${JSON.stringify(next)})`;
  } else if (truncation?.truncated) {
    if (!Number.isSafeInteger(truncation.outputLines) || (truncation.outputLines ?? 0) <= 0)
      return { output, error: "Pi read returned incomplete context. Narrow the requested line range." };
    const next = { ...request, startLine: (request.startLine ?? 1) + truncation.outputLines! };
    delete next.offset;
    output += `\n… (Pi read source truncated; next page: ${JSON.stringify(next)})`;
  }
  return {
    output: `[${request.path}: Pi read from line ${request.startLine ?? 1}; output offset ${offset}]\n${output}`,
  };
}

async function readFileTool(
  cwd: string,
  request: ToolRequest,
  signal?: AbortSignal,
  maxChars = MAX_TOOL_OUTPUT_CHARS,
): Promise<ToolResult> {
  const { path, startLine, endLine, offset } = request;
  if (!path) return { output: "", error: "read_file requires a path" };
  const safePath = resolveProjectPath(cwd, path);
  if (!safePath) {
    return { output: "", error: `Path is not allowed: ${path}` };
  }
  try {
    let nativeStart = Math.max(1, Math.floor(startLine ?? 1));
    let nativeEnd = endLine === undefined ? undefined : Math.max(1, Math.floor(endLine));
    if (nativeEnd !== undefined && nativeStart > nativeEnd) [nativeStart, nativeEnd] = [nativeEnd, nativeStart];
    const native = await dispatchNativeReadTool(
      cwd,
      "read",
      {
        path: safePath,
        offset: nativeStart,
        ...(nativeEnd === undefined ? {} : { limit: nativeEnd - nativeStart + 1 }),
      },
      signal,
    );
    if (native) return pageNativeRead(native, { ...request, startLine: nativeStart, endLine: nativeEnd }, maxChars);
    const content = readFileSync(safePath, "utf-8");
    const lines = content.split(/\r?\n/);
    // Clamp to file bounds; swap when inverted. Non-finite values were
    // already filtered during request parsing.
    let start = Math.max(1, Math.floor(startLine ?? 1));
    let end = Math.min(lines.length, Math.floor(endLine ?? lines.length));
    if (start > end) [start, end] = [Math.max(1, Math.min(end, lines.length)), Math.min(lines.length, start)];
    return { output: pageFileOutput(lines, path, start, end, offset, maxChars) };
  } catch (err) {
    return { output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

async function runCommandTool(cwd: string, command: string, signal?: AbortSignal): Promise<ToolResult> {
  try {
    // Model-generated commands are restricted to read-only subcommands;
    // user-configured preReviewCommands run without this restriction.
    // DELIBERATE: this workflow keeps the DEFAULT timeout and does NOT read
    // `preReviewTimeoutMs`. Config is not in scope here, and the budget's
    // purpose differs: it bounds ONE model-issued read-only command rather than
    // a project's whole analyze-and-test gate. Raising the gate's timeout must
    // not silently widen how long a model can pin a tool call.
    const [result] = await runPreReviewCommands(cwd, [command], { restrictSubcommands: true, signal });
    return {
      output: truncateCommandOutput(result.output),
      error: result.exitCode !== 0 ? `Command exited with code ${result.exitCode}` : undefined,
    };
  } catch (err) {
    return { output: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Exact approved paths share a bounded glob, so broad searches do not spawn
 * one host grep per file. Resolve every candidate first, including junctions;
 * glob escaping prevents a filename from broadening the allowlist. */
async function searchNativeFiles(
  cwd: string,
  files: string[],
  request: ToolRequest,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const batches: { paths: string[]; globs: string[] }[] = [];
  try {
    for (const file of files) {
      signal?.throwIfAborted();
      const path = resolveProjectPath(cwd, file);
      if (!path) continue;
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_TOOL_FILE_BYTES) continue;
      // Pi's local grep inherits process.cwd(); replacement tools can use
      // the session root. Include their exact spellings without wildcards.
      const fromProcess = relative(process.cwd(), path);
      const spellings = new Set([relative(cwd, path), isSafeRelativePath(fromProcess) ? fromProcess : path]);
      if (path.startsWith("/")) spellings.add(path.slice(1));
      const glob = [...spellings]
        .map((spelling) =>
          spelling
            .split(sep)
            .join("/")
            .replace(/[\\*?[\]{},]/g, "\\$&"),
        )
        .join(",");
      let batch = batches.at(-1);
      if (
        !batch ||
        batch.paths.length >= MAX_NATIVE_SEARCH_FILES ||
        batch.globs.join(",").length + glob.length >= MAX_NATIVE_SEARCH_GLOB_CHARS
      ) {
        batch = { paths: [], globs: [] };
        batches.push(batch);
      }
      batch.paths.push(path);
      batch.globs.push(glob);
    }
  } catch (error) {
    signal?.throwIfAborted();
    return { output: "", error: error instanceof Error ? error.message : String(error) };
  }
  let output = "";
  let matches = 0;
  for (const batch of batches) {
    signal?.throwIfAborted();
    const native = await dispatchNativeReadTool(
      cwd,
      "grep",
      {
        pattern: request.pattern,
        path: batch.paths.length === 1 ? batch.paths[0] : resolveProjectPath(cwd, "."),
        ...(batch.paths.length === 1 ? {} : { glob: `/{${batch.globs.join(",")}}` }),
        context: request.contextLines ?? 1,
        limit: MAX_SEARCH_MATCHES - matches,
      },
      signal,
    );
    if (!native || native.error)
      return { output, error: truncateCommandOutput(native?.error ?? "Pi grep context unavailable.") };
    if (native.output.trim() === "No matches found") continue;
    const label = batch.paths.length === 1 ? relative(cwd, batch.paths[0]) : `${batch.paths.length} approved files`;
    output += `[Pi grep: ${label}]\n${native.output}\n`;
    matches += Math.max(1, (native.output.match(/^.+:\d+: /gm) ?? []).length);
    if (
      matches >= MAX_SEARCH_MATCHES ||
      native.details?.matchLimitReached ||
      (native.details?.truncation as { truncated?: boolean } | undefined)?.truncated ||
      output.length >= MAX_TOOL_OUTPUT_CHARS
    ) {
      output = "… (search incomplete; match/output limit reached — narrow the pattern or path)\n" + output;
      break;
    }
  }
  if (!output) return { output: `No matches for /${request.pattern}/ in ${files.length} file(s).` };
  return {
    output:
      output.length > MAX_TOOL_OUTPUT_CHARS
        ? output.slice(0, MAX_TOOL_OUTPUT_CHARS) +
          "\n… (search results truncated; narrow the pattern or path to inspect more matches)"
        : output,
  };
}

/** Regex search across project files (git-tracked or the portable fallback scan).
 *  Returns file:line hits with ±contextLines of surrounding content, capped at
 *  MAX_SEARCH_MATCHES matches and MAX_TOOL_OUTPUT_CHARS total output. */
async function searchCodeTool(cwd: string, request: ToolRequest, signal?: AbortSignal): Promise<ToolResult> {
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
  if (hasNativeReadTools()) return searchNativeFiles(cwd, files, request, signal);

  const out: string[] = [];
  let matches = 0;
  let stoppedEarly = false;
  for (const file of files) {
    signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      // Unreadable file — skip it.
    }
  }

  if (matches === 0) return { output: `No matches for /${pattern}/ in ${files.length} file(s).` };
  const header = stoppedEarly ? `… (stopped after ${MAX_SEARCH_MATCHES} matches)\n` : "";
  const output = header + out.join("\n");
  return {
    output:
      output.length > MAX_TOOL_OUTPUT_CHARS
        ? output.slice(0, MAX_TOOL_OUTPUT_CHARS) +
          "\n… (search results truncated; narrow the pattern or path to inspect more matches)"
        : output,
  };
}

async function executeTool(
  cwd: string,
  request: ToolRequest,
  signal?: AbortSignal,
  readPageChars = MAX_TOOL_OUTPUT_CHARS,
): Promise<ToolResult> {
  if (request.tool === "read_file") {
    return readFileTool(cwd, request, signal, readPageChars);
  }
  if (request.tool === "search_code") {
    return searchCodeTool(cwd, request, signal);
  }
  if (request.tool === "run_command") {
    if (!request.command) return { output: "", error: "run_command requires a command" };
    return runCommandTool(cwd, request.command, signal);
  }
  return { output: "", error: `Unknown tool: ${request.tool}` };
}

function formatToolResult(request: ToolRequest, result: ToolResult): string {
  const description =
    request.tool === "read_file"
      ? `read_file ${request.path}${request.startLine !== undefined || request.endLine !== undefined ? ` lines ${request.startLine ?? 1}-${request.endLine ?? "end"}` : ""}${request.offset ? ` offset ${request.offset}` : ""}`
      : request.tool === "search_code"
        ? `search_code /${request.pattern}/${request.path ? ` in ${request.path}` : ""}`
        : `run_command ${request.command}`;
  const body = result.error ? `Error: ${result.error}\n${result.output}` : result.output;
  return `\n\n## Tool result: ${description}\n${body}`;
}

function fileStamp(cwd: string, path: string | undefined): string | undefined {
  const resolved = path && resolveProjectPath(cwd, path);
  if (!resolved) return undefined;
  try {
    const stat = statSync(resolved);
    return JSON.stringify([resolved, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch {
    return undefined;
  }
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
  maxToolIterations = Number.isFinite(maxToolIterations)
    ? Math.max(0, Math.floor(maxToolIterations))
    : DEFAULT_MAX_ITERATIONS;
  const toolInstruction = buildToolInstruction(maxToolIterations);
  const augmentedSystem = `${toolInstruction}\n\n${systemPrompt}`;
  const loopId = randomUUID();
  const started = Date.now();
  const metadata = { loopId, task: options.task, files: options.relevantPaths };
  let currentUser = userPrompt;
  let totalUsage: UsageCost | undefined;
  let used = 0;
  let modelCalls = 0;
  let batchCorrectionUsed = false;
  let attempts = 0;
  let reusedReads = 0;
  let toolContextChars = 0;
  const readPageChars = Number.isFinite(options.readPageChars)
    ? Math.max(1, Math.min(MAX_READ_PAGE_CHARS, Math.floor(options.readPageChars!)))
    : MAX_TOOL_OUTPUT_CHARS;
  const contextChars = Number.isFinite(options.maxToolContextChars)
    ? Math.max(0, options.maxToolContextChars!)
    : Infinity;
  const inputLimit = Number.isFinite(options.maxInputTokens) ? Math.max(0, options.maxInputTokens!) : Infinity;
  const coverageError = (message: string, requests: ToolRequest[] = []) =>
    new ToolLoopCoverageError(message, totalUsage ?? emptyRecordedUsage(cwd), [
      ...new Set(
        requests.some((r) => r.path)
          ? requests.map((r) => r.path).filter((p): p is string => !!p)
          : (options.relevantPaths ?? []),
      ),
    ]);
  const reads = new Map<string, { stamp: string; result: ToolResult; iteration: number }>();
  const nativeReads = new Map<string, { output: string; iteration: number }>();

  while (used <= maxToolIterations) {
    const finalOnly = used >= maxToolIterations || reusedReads >= MAX_REUSED_READS;
    // Keep the system/prompt prefix stable for provider prompt caching.
    const system = augmentedSystem;
    const user = finalOnly
      ? currentUser +
        "\n\nYou have reached the maximum number of tool requests or repeated unchanged reads. Produce the final structured JSON result now without additional tools. If necessary evidence is missing, set contextLimited and list coverageGaps; do not claim complete coverage."
      : currentUser;
    if (estimateTokens(system + user) > inputLimit)
      throw coverageError(
        "Context input allowance exhausted: the review conversation cannot fit more evidence in the model input budget.",
      );
    modelCalls++;
    const modelStarted = Date.now();
    logEvent(cwd, "info", "Tool loop model started", {
      ...metadata,
      modelCall: modelCalls,
      finalOnly,
      remainingRequests: maxToolIterations - used,
    });
    let response: Awaited<ReturnType<typeof callModel>>;
    try {
      response = await callModel(system, user, options);
    } catch (error) {
      logEvent(cwd, options.signal?.aborted ? "info" : "warn", "Tool loop model stopped", {
        ...metadata,
        modelCall: modelCalls,
        elapsedMs: Date.now() - modelStarted,
        cancelled: options.signal?.aborted === true,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    const { content, usage, truncated } = response;
    options.onToolLoopEvent?.({ phase: "model", elapsedMs: Date.now() - modelStarted });
    totalUsage = totalUsage ? mergeUsageCost(totalUsage, usage) : usage;
    logEvent(cwd, "info", "Tool loop model completed", {
      ...metadata,
      modelCall: modelCalls,
      elapsedMs: Date.now() - modelStarted,
      finalOnly,
      inputTokens: usage.estimatedInputTokens,
      outputTokens: usage.estimatedOutputTokens,
    });
    const requests = parseToolRequests(content);
    if (!requests) {
      const result = await toolLoopWrapTruncated(
        cwd,
        system,
        user,
        options,
        async (s, u, o) => {
          if (estimateTokens(s + u) > inputLimit)
            throw coverageError(
              "Context input allowance exhausted: the review continuation cannot fit in the model input budget.",
            );
          const resumeStarted = Date.now();
          modelCalls++;
          logEvent(cwd, "info", "Tool loop model started", {
            ...metadata,
            modelCall: modelCalls,
            phase: "resume",
            finalOnly: true,
          });
          try {
            const resumed = await callModel(s, u, o);
            options.onToolLoopEvent?.({ phase: "model", elapsedMs: Date.now() - resumeStarted });
            logEvent(cwd, "info", "Tool loop model completed", {
              ...metadata,
              modelCall: modelCalls,
              phase: "resume",
              elapsedMs: Date.now() - resumeStarted,
              finalOnly: true,
            });
            return resumed;
          } catch (error) {
            logEvent(cwd, o.signal?.aborted ? "info" : "warn", "Tool loop model stopped", {
              ...metadata,
              modelCall: modelCalls,
              phase: "resume",
              elapsedMs: Date.now() - resumeStarted,
              cancelled: o.signal?.aborted === true,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        },
        content,
        totalUsage,
        truncated,
      );
      logEvent(cwd, "info", "Tool loop completed", {
        ...metadata,
        modelCalls,
        toolRequests: attempts,
        evidenceRequests: used,
        reusedReads,
        elapsedMs: Date.now() - started,
        truncated: result.truncated,
      });
      return result;
    }

    if (finalOnly)
      throw coverageError(
        "Context-request allowance exhausted: the reviewer requested more evidence instead of producing a final result.",
        requests,
      );
    if (requests.length > maxToolIterations - used) {
      const remaining = maxToolIterations - used;
      logEvent(cwd, "warn", "Tool loop batch rejected", {
        ...metadata,
        modelCall: modelCalls,
        batchSize: requests.length,
        remainingRequests: remaining,
        correctionAvailable: !batchCorrectionUsed,
        requests,
      });
      if (!batchCorrectionUsed) {
        options.signal?.throwIfAborted();
        // One protocol correction, not a larger tool allowance or a partial
        // batch. Every requested read remains visibly unexecuted until the
        // model submits an admissible request; normal per-call cost guards apply.
        batchCorrectionUsed = true;
        currentUser += `\n\n## Context batch rejected\n${JSON.stringify({ tools: requests })}\nNone of these requests executed: the batch contains ${requests.length} reads but only ${remaining} context request(s) remain. Correct the batch size once, reuse evidence already supplied, or report incomplete coverage if the necessary evidence cannot fit. This correction does not increase the request allowance.`;
        currentUser += remainingRequestInstruction(remaining);
        continue;
      }
      throw coverageError(
        `Context batch exceeds the ${remaining} remaining request(s) after one correction; coverage is incomplete. Inspect the context-request logs and toolUseLoop allowance before retrying.`,
        requests,
      );
    }
    for (const request of requests) {
      options.signal?.throwIfAborted();
      attempts++;
      const detail = {
        ...metadata,
        iteration: attempts,
        modelCall: modelCalls,
        batchSize: requests.length,
        ...request,
      };
      logEvent(cwd, "info", "Tool loop request", detail);
      const toolStarted = Date.now();
      const key = JSON.stringify(request);
      // Local metadata cannot prove freshness for a host-overridden reader.
      const nativeRead = request.tool === "read_file" && hasNativeReadTools();
      const stamp = request.tool === "read_file" && !nativeRead ? fileStamp(cwd, request.path) : undefined;
      const previous = stamp ? reads.get(key) : undefined;
      const cached = previous && previous.stamp === stamp ? previous : undefined;
      let reused = !!cached;
      const remainingChars =
        Math.min(contextChars - toolContextChars, tokenBudgetChars(inputLimit - estimateTokens(system + currentUser))) -
        1200;
      if (!cached && remainingChars < 512)
        throw coverageError(
          "Context input allowance exhausted: required tool evidence cannot fit in the remaining review input budget.",
          [request],
        );
      let result = cached
        ? {
            output: `The unchanged file/range was already returned in context request ${cached.iteration}. Use that result above; request a different range if you need missing lines.`,
          }
        : await executeTool(cwd, request, options.signal, Math.min(readPageChars, Math.floor(remainingChars)));
      options.signal?.throwIfAborted();
      // Native reads must execute again for host policy and source freshness.
      // After approval, identical bounded output can refer to its earlier
      // prompt entry without repeating the source payload or model tokens.
      if (nativeRead && !result.error) {
        const earlier = nativeReads.get(key);
        if (earlier?.output === result.output) {
          reused = true;
          result = {
            output: `The same approved Pi read output was already returned in context request ${earlier.iteration}. Use that result above; request a different range for missing evidence.`,
          };
        } else nativeReads.set(key, { output: result.output, iteration: attempts });
      }
      if (stamp && !reused && !result.error && fileStamp(cwd, request.path) === stamp)
        reads.set(key, { stamp, result, iteration: attempts });
      if (reused && reusedReads < MAX_REUSED_READS) reusedReads++;
      else used++;
      logEvent(cwd, "info", "Tool loop result", {
        ...detail,
        elapsedMs: Date.now() - toolStarted,
        reused: !!reused,
        nativeRead,
        error: result.error,
        outputLength: result.output.length,
      });
      const formatted = formatToolResult(request, result);
      options.onToolLoopEvent?.({ phase: "context", elapsedMs: Date.now() - toolStarted });
      if (
        toolContextChars + formatted.length > contextChars ||
        estimateTokens(system + currentUser + formatted) > inputLimit
      )
        throw coverageError(
          "Context input allowance exhausted: required tool evidence exceeds the remaining review input budget.",
          [request],
        );
      toolContextChars += formatted.length;
      currentUser += formatted;
    }
    currentUser += remainingRequestInstruction(maxToolIterations - used);
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
