import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadYoowaiConfig } from "../config.js";
import { logEvent } from "../logger.js";
import type { CallSecondaryModelOptions } from "../types.js";
import {
  estimateCost,
  estimateTokens,
  buildUsage,
  extractTextFromContent,
  isLengthStop,
  isYoowaiDebugEnabled,
  type AssistantMessageLike,
  type PiProcessResult,
} from "./shared.js";

const piSessionIds = new Map<string, string>();

export function setPiSessionId(cwd: string, sessionId: string): void {
  piSessionIds.set(cwd, sessionId);
}

export function clearPiSessionId(cwd: string): void {
  piSessionIds.delete(cwd);
}

export function getPiSessionId(cwd: string): string | undefined {
  return piSessionIds.get(cwd);
}

const SIGKILL_TIMEOUT_MS = 5000;
const PI_PROCESS_TIMEOUT_MS = 300_000; // 5 minutes default timeout for child pi process
const INHERITED_SESSION_MAX_ENTRIES = 10;

let testPiSpawnResolver: (() => { command: string; prefixArgs: string[] }) | null = null;

/** Test hook: override the Pi binary used by the pi backend. */
export function setPiSpawnResolver(resolver: (() => { command: string; prefixArgs: string[] }) | null): void {
  testPiSpawnResolver = resolver;
}

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  if (testPiSpawnResolver) return testPiSpawnResolver();
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  const isBun = /[\\/]bun(?:\.exe)?$/i.test(process.execPath);
  if ((isNode || isBun) && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

function writeTempSessionJsonl(sessionJsonl: string): { dir: string; filePath: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-yoowai-"));
  const filePath = join(tmpDir, "session.jsonl");
  writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function redactSessionJsonl(jsonl: string): string {
  return jsonl
    .replace(/\b(sk-[a-zA-Z0-9_-]{20,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b([a-f0-9]{64,})\b/gi, "[REDACTED_HEX_KEY]")
    .replace(/\b([A-Za-z0-9+/]{48,}={0,2})\b/g, "[REDACTED_B64_KEY]")
    .replace(/(--api-key\s+)\S+/gi, "$1[REDACTED]");
}

function isValidSessionEntry(entry: unknown): boolean {
  return normalizeSessionEntry(entry) !== null;
}

function normalizeSessionEntry(entry: unknown): unknown | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;

  // Real Pi branches return event objects: { type: "message", message: { role, content } }.
  // Some events have a malformed/undefined message object, so reject those to avoid crashing
  // the child pi process during session inheritance.
  if (e.type === "message") {
    const msg = e.message;
    if (msg && typeof msg === "object" && !Array.isArray(msg)) {
      const nestedRole = (msg as Record<string, unknown>).role;
      if (nestedRole === "system" || nestedRole === "user" || nestedRole === "assistant") return entry;
    }
    return null;
  }

  // Legacy/test entries that carry the role directly on the event object are wrapped into
  // the event shape the child pi process expects.
  const role = e.role;
  if (role === "system" || role === "user" || role === "assistant") {
    return { type: "message", message: entry };
  }
  return null;
}

function normalizePathForMatch(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function entryMentionsAnyPath(entry: unknown, paths: string[]): boolean {
  const text = JSON.stringify(entry);
  if (!text) return false;
  const normalizedText = text.replace(/\\/g, "/");
  return paths.some((p) => {
    const normalized = normalizePathForMatch(p);
    return normalizedText.includes(normalized) || text.includes(p);
  });
}

function selectRelevantEntries(branch: unknown[], maxEntries: number, relevantPaths?: string[]): unknown[] {
  const messages = branch.map((entry, index) => ({ entry, index })).filter(({ entry }) => isValidSessionEntry(entry));

  if (!relevantPaths || relevantPaths.length === 0) {
    return messages.slice(-maxEntries).map(({ entry }) => entry);
  }

  const matching: { entry: unknown; index: number }[] = [];
  const nonMatching: { entry: unknown; index: number }[] = [];
  for (const item of messages) {
    if (entryMentionsAnyPath(item.entry, relevantPaths)) {
      matching.push(item);
    } else {
      nonMatching.push(item);
    }
  }

  const selected = matching.slice(-maxEntries);
  const remainingSlots = maxEntries - selected.length;
  if (remainingSlots > 0) {
    const usedIndices = new Set(selected.map((i) => i.index));
    const recentNonMatching = nonMatching.filter((i) => !usedIndices.has(i.index)).slice(-remainingSlots);
    selected.push(...recentNonMatching);
  }

  selected.sort((a, b) => a.index - b.index);
  return selected.map(({ entry }) => entry);
}

function buildInheritedSessionJsonl(
  sessionManager?: CallSecondaryModelOptions["sessionManager"],
  relevantPaths?: string[],
  maxEntries = INHERITED_SESSION_MAX_ENTRIES,
): string | null {
  if (!sessionManager) return null;
  try {
    const header = sessionManager.getHeader();
    const branch = sessionManager.getBranch();
    if (!header || typeof header !== "object" || !Array.isArray(branch)) return null;
    const lines: string[] = [JSON.stringify(header)];
    const selected = selectRelevantEntries(branch, maxEntries, relevantPaths);
    for (const entry of selected) {
      const normalized = normalizeSessionEntry(entry);
      if (normalized) lines.push(JSON.stringify(normalized));
    }
    return redactSessionJsonl(lines.join("\n") + "\n");
  } catch {
    return null;
  }
}

function processPiJsonLine(line: string, result: PiProcessResult, cwd?: string): void {
  if (!line.trim()) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  // Debug: log every event type so we can diagnose providers that emit unusual events.
  if (isYoowaiDebugEnabled()) {
    function shapeOf(value: unknown, depth = 0): unknown {
      if (value === null || typeof value !== "object") return typeof value;
      if (depth > 3) return "...";
      if (Array.isArray(value)) {
        const first = value.length > 0 ? shapeOf(value[0], depth + 1) : "empty";
        return `array(${value.length})<${JSON.stringify(first)}>`;
      }
      const record = value as Record<string, unknown>;
      const shaped: Record<string, unknown> = {};
      for (const key of Object.keys(record).slice(0, 20)) {
        const v = record[key];
        if (key === "text" || key === "thinking" || key === "content" || key === "delta") {
          shaped[key] = typeof v === "string" ? `string(${v.length})` : shapeOf(v, depth + 1);
        } else {
          shaped[key] = shapeOf(v, depth + 1);
        }
      }
      return shaped;
    }
    const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
    const message = event.message as AssistantMessageLike | undefined;
    const debugInfo = JSON.stringify({
      type: event.type,
      keys: Object.keys(event),
      messageShape: shapeOf(message),
      assistantMessageEventShape: shapeOf(assistantMessageEvent),
    });
    if (cwd) {
      logEvent(cwd, "debug", "pi-backend event", { event: debugInfo });
    } else {
      console.log("[pi-yoowai pi-backend event]", debugInfo);
    }
  }

  // Extract deltas from top-level streaming events and from nested assistantMessageEvent
  // inside message_update events. Pi's json mode can emit content in either location.
  function accumulateDelta(e: Record<string, unknown>): void {
    const type = e.type;
    const delta = e.delta;
    if (typeof delta === "string") {
      if (type === "thinking_delta") {
        result.streamThinking += delta;
      } else if (type === "text_delta") {
        result.streamText += delta;
      }
    } else if (delta && typeof delta === "object" && !Array.isArray(delta)) {
      const deltaObj = delta as Record<string, unknown>;
      if (deltaObj.type === "text_delta" && typeof deltaObj.text === "string") {
        result.streamText += deltaObj.text;
      } else if (deltaObj.type === "thinking_delta" && typeof deltaObj.thinking === "string") {
        result.streamThinking += deltaObj.thinking;
      } else if (typeof deltaObj.text === "string") {
        result.streamText += deltaObj.text;
      } else if (typeof deltaObj.thinking === "string") {
        result.streamThinking += deltaObj.thinking;
      }
    }
    if (type === "text_delta" && typeof e.text === "string") {
      result.streamText += e.text;
    }
    if (type === "thinking_delta" && typeof e.thinking === "string") {
      result.streamThinking += e.thinking;
    }
    const contentBlock = e.content_block as Record<string, unknown> | undefined;
    if (contentBlock) {
      if (contentBlock.type === "text" && typeof contentBlock.text === "string") {
        result.streamText += contentBlock.text;
      } else if (contentBlock.type === "thinking" && typeof contentBlock.thinking === "string") {
        result.streamThinking += contentBlock.thinking;
      }
    }
    // Some provider streams emit the finalized block content on text_end/thinking_end.
    if ((type === "text_end" || type === "text") && typeof e.content === "string") {
      result.streamText += e.content;
    }
    if ((type === "thinking_end" || type === "thinking") && typeof e.content === "string") {
      result.streamThinking += e.content;
    }
    // The unified AI event carries the partial AssistantMessage in `partial`.
    const partial = e.partial as AssistantMessageLike | undefined;
    if (partial && partial.role === "assistant") {
      const text = extractTextFromContent(partial.content);
      if (text.length > 0) {
        result.lastMessageUpdateText = text;
      }
      // Capture stopReason from partial assistant messages so truncation can be
      // detected even when no final assistant message is present in `messages`.
      if (partial.stopReason !== undefined && partial.stopReason !== null) {
        result.lastStopReason = partial.stopReason;
      }
    }
  }
  accumulateDelta(event);
  const assistantMessageEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
  if (assistantMessageEvent) {
    accumulateDelta(assistantMessageEvent);
    result.lastAssistantMessageEvent = assistantMessageEvent;
  }

  const message = event.message as AssistantMessageLike | undefined;
  if (!message) return;

  // message_update events carry the partial assistant message. Capture the latest
  // partial content as a fallback when the final message_end/turn_end is empty.
  if (event.type === "message_update" && message.role === "assistant") {
    const text = extractTextFromContent(message.content);
    if (text.length > 0) {
      result.lastMessageUpdateText = text;
    }
    // Capture stopReason from partial messages as a fallback for truncation detection.
    if (message.stopReason !== undefined && message.stopReason !== null) {
      result.lastStopReason = message.stopReason;
    }
  }

  if (event.type === "message_end" || event.type === "turn_end") {
    if (message.role === "assistant") {
      result.messages.push(message);
      const stopReason = message.stopReason;
      const errorMessage = message.errorMessage;
      if (
        (stopReason === "error" || stopReason === "aborted") &&
        typeof errorMessage === "string" &&
        errorMessage.length > 0
      ) {
        result.lastErrorMessage = errorMessage;
      }
      if (message.usage) {
        result.inputTokens += message.usage.input || 0;
        result.outputTokens += message.usage.output || 0;
        result.cost +=
          typeof message.usage.cost === "object" && message.usage.cost !== null
            ? (message.usage.cost as { total?: number }).total || 0
            : typeof message.usage.cost === "number"
              ? message.usage.cost
              : 0;
      }
    }
  }
}

function getFinalAssistantText(result: PiProcessResult): string {
  // Prefer the final assembled message content.
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const message = result.messages[i];
    if (message.role !== "assistant") continue;
    const text = extractTextFromContent(message.content);
    if (text.length > 0) return text;
  }
  // Fallback to accumulated streaming deltas (for Anthropic-style streaming).
  if (result.streamText.trim().length > 0) return result.streamText.trim();
  if (result.streamThinking.trim().length > 0) return result.streamThinking.trim();
  // Fallback to the last message_update event's partial message content.
  if (result.lastMessageUpdateText && result.lastMessageUpdateText.length > 0) {
    return result.lastMessageUpdateText;
  }
  // Fallback to the last assistantMessageEvent content block if present.
  if (result.lastAssistantMessageEvent) {
    const text = extractTextFromContent(result.lastAssistantMessageEvent.content);
    if (text.length > 0) return text;
  }
  return "";
}

function runPiProcess(
  command: string,
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
  timeoutMs = PI_PROCESS_TIMEOUT_MS,
): Promise<PiProcessResult> {
  const result: PiProcessResult = {
    messages: [],
    stderr: "",
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    streamText: "",
    streamThinking: "",
    rawStdout: [],
  };

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Secondary pi process aborted"));
      return;
    }

    const proc = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let buffer = "";
    let settled = false;
    let killed = false;
    let sigkillTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;

    const killProc = () => {
      if (killed || !proc.pid) return;
      killed = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // ignore
      }
      sigkillTimeoutId = setTimeout(() => {
        if (settled || !proc.pid) return;
        if (process.platform === "win32") {
          try {
            spawn("taskkill", ["/pid", String(proc.pid), "/f", "/t"], { stdio: "ignore" }).unref();
          } catch {
            // ignore
          }
        } else {
          try {
            proc.kill("SIGKILL");
          } catch {
            // ignore
          }
        }
        sigkillTimeoutId = undefined;
      }, SIGKILL_TIMEOUT_MS);
    };

    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (sigkillTimeoutId) {
        clearTimeout(sigkillTimeoutId);
        sigkillTimeoutId = undefined;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (abortHandler && signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      proc.stdout.off("data", onStdoutData);
      proc.stderr.removeAllListeners("data");
      if (buffer.trim()) processPiJsonLine(buffer, result, cwd);
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    };

    const rawStdout: string[] = [];

    const onStdoutData = (chunk: Buffer) => {
      const text = chunk.toString();
      rawStdout.push(text);
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) processPiJsonLine(line, result, cwd);
    };

    proc.stdout.on("data", onStdoutData);

    proc.stderr.on("data", (chunk: Buffer) => {
      result.stderr += chunk.toString();
    });

    proc.on("close", (code, procSignal) => {
      const effectiveCode = code ?? (procSignal ? 1 : 0);
      if (effectiveCode !== 0 && !getFinalAssistantText(result)) {
        const stderrPreview = result.stderr.trim().slice(0, 500);
        settle(
          new Error(
            `Secondary pi process exited with code ${effectiveCode}${stderrPreview ? `: ${stderrPreview}` : ""}`,
          ),
        );
        return;
      }
      settle();
    });

    proc.on("error", (err) => {
      settle(err);
    });

    if (signal) {
      abortHandler = () => {
        killProc();
        settle(new Error("Secondary pi process aborted"));
      };
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    // Timeout: kill the process if it hasn't completed within timeoutMs.
    timeoutId = setTimeout(() => {
      if (settled) return;
      killProc();
      settle(new Error(`Secondary pi process timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
}

export async function callPiBackend(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: CallSecondaryModelOptions = {},
): Promise<{ content: string; usage: ReturnType<typeof buildUsage>; truncated?: boolean }> {
  const { signal, thinking, cwd, sessionManager, relevantPaths } = options;

  const config = cwd ? loadYoowaiConfig(cwd) : undefined;
  const processTimeoutMs = config?.processTimeoutMs ?? PI_PROCESS_TIMEOUT_MS;
  // Pass the parent Pi session ID to the child process so opencode-go/opencode
  // receive the same x-opencode-session header for sticky provider routing.
  const sessionId = cwd ? getPiSessionId(cwd) : undefined;

  const inheritedSession = buildInheritedSessionJsonl(sessionManager, relevantPaths);
  if (cwd) {
    const inheritedLines = inheritedSession ? inheritedSession.split("\n").filter(Boolean) : [];
    const inheritedEntries = Math.max(0, inheritedLines.length - 1); // header line is not a conversation entry
    logEvent(cwd, "info", "Pi session inheritance prepared", {
      inheritedEntries,
      relevantPathsCount: relevantPaths?.length ?? 0,
      provider,
      model,
    });
  }
  const taskJsonl =
    [
      JSON.stringify({
        type: "message",
        message: { role: "system", content: [{ type: "text", text: systemPrompt }] },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: userPrompt }] },
      }),
    ].join("\n") + "\n";

  // Preserve parent Pi session ID in the header so opencode-go/opencode get the
  // same x-opencode-session header for sticky routing. When there is no inherited
  // session, create a minimal header with the parent session ID.
  let sessionJsonl: string;
  if (inheritedSession) {
    sessionJsonl = inheritedSession + taskJsonl;
  } else if (sessionId) {
    const header = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: cwd,
    };
    sessionJsonl = JSON.stringify(header) + "\n" + taskJsonl;
  } else {
    sessionJsonl = taskJsonl;
  }

  const tmp = writeTempSessionJsonl(sessionJsonl);
  const { command, prefixArgs } = resolvePiSpawn();

  const args = [
    "--mode",
    "json",
    "-p",
    "--session",
    tmp.filePath,
    "--provider",
    provider,
    "--model",
    model,
    "--thinking",
    thinking ?? "off",
    "--no-extensions",
    "Respond to the user message above.",
  ];

  try {
    const maxRetries = 2;
    const attemptErrors: string[] = [];
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await runPiProcess(command, [...prefixArgs, ...args], cwd, signal, processTimeoutMs);
        const content = getFinalAssistantText(result);
        if (content) {
          // Detect truncation from the final assistant message's stopReason, falling
          // back to the last stopReason seen on a streamed/partial message.
          const lastAssistant = [...result.messages].reverse().find((m) => m.role === "assistant");
          const truncated = isLengthStop(lastAssistant?.stopReason ?? result.lastStopReason);
          const estimatedInputTokens = result.inputTokens ?? estimateTokens(systemPrompt + userPrompt);
          const estimatedOutputTokens = result.outputTokens ?? estimateTokens(content);
          const usage = {
            estimatedInputTokens,
            estimatedOutputTokens,
            estimatedCostUsd: result.cost ?? estimateCost(provider, model, estimatedInputTokens, estimatedOutputTokens),
            sessionCostUsd: 0,
          };
          return { content, usage, truncated };
        }
        // No assistant text — collect diagnostics and retry.
        const stderrPreview = result.stderr.trim().slice(0, 500);
        const msgRoles = result.messages.map((m) => m.role).join(",");
        const errorMsg = result.lastErrorMessage ? `error="${result.lastErrorMessage.slice(0, 500)}"` : "";
        const diag = `messages=${result.messages.length} [${msgRoles}], stderr=${stderrPreview || "(empty)"}${errorMsg ? `, ${errorMsg}` : ""}`;
        attemptErrors.push(`attempt ${attempt + 1}: ${diag}`);
        if (cwd) {
          logEvent(cwd, "warn", "Pi backend produced no assistant text, retrying", {
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            messageCount: result.messages.length,
            provider,
            model,
            errorMessage: result.lastErrorMessage,
            contentTypes: result.messages.map((m) => ({
              role: m.role,
              stopReason: m.stopReason,
              types: Array.isArray(m.content)
                ? m.content.map((c) => (c && typeof c === "object" ? (c as { type?: unknown }).type : typeof c))
                : typeof m.content,
            })),
            rawStdout: result.rawStdout.join("").slice(0, 5000),
          });
        }
      } catch (err) {
        // Process-level errors (spawn failure, abort, non-zero exit) — retry transient ones.
        const msg = err instanceof Error ? err.message : String(err);
        if (signal?.aborted || /aborted/i.test(msg)) throw err; // don't retry aborts
        attemptErrors.push(`attempt ${attempt + 1}: ${msg}`);
        if (cwd) {
          logEvent(cwd, "warn", "Pi backend error, retrying", {
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            error: msg,
            provider,
            model,
          });
        }
      }
      if (attempt < maxRetries) {
        const delay = 500 * 2 ** attempt; // 500ms, 1s
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    // On final failure, include raw output diagnostics if PI_YOOWAI_DEBUG is set.
    const debug = isYoowaiDebugEnabled();
    if (debug && cwd) {
      logEvent(cwd, "error", "Pi backend exhausted retries — raw diagnostics", {
        attemptErrors,
        provider,
        model,
        promptTokensEstimate: estimateTokens(systemPrompt + userPrompt),
      });
    }
    // If the model returned an explicit error message (e.g. rate limit, content policy),
    // surface it instead of the generic "no assistant text" message.
    const lastError = attemptErrors
      .map((e) => {
        const match = /error="([^"]+)"/.exec(e);
        return match?.[1];
      })
      .find(Boolean);
    if (lastError) {
      throw new Error(`Secondary pi process failed after ${maxRetries + 1} attempts: ${lastError}`);
    }
    throw new Error(
      `Secondary pi process produced no assistant text after ${maxRetries + 1} attempts: ${attemptErrors.join(" | ")}`,
    );
  } finally {
    try {
      rmSync(tmp.dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
