import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApiKey } from "./auth-reader.js";
import { loadHeyyooConfig, resolveTaskModel } from "./config.js";
import { formatCost, getSessionCost, getReservedCost } from "./cost-tracker.js";
import { logEvent } from "./logger.js";
import { resolveModelInfo } from "./model-registry.js";
import type { ProviderApiInfo, UsageCost, CallSecondaryModelOptions, SecondaryModelConfig } from "./types.js";

const PROVIDER_API_MAP: Record<string, ProviderApiInfo> = {
  "opencode-go": {
    style: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/go/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  opencode: {
    style: "openai-compatible",
    baseUrl: "https://opencode.ai/zen/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  anthropic: {
    style: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  openai: {
    style: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  deepseek: {
    style: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  openrouter: {
    style: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  groq: {
    style: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  mistral: {
    style: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  xai: {
    style: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  together: {
    style: "openai-compatible",
    baseUrl: "https://api.together.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  fireworks: {
    style: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  cerebras: {
    style: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  google: {
    style: "openai-compatible",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    authHeader: "x-goog-api-key",
    authPrefix: "",
    supportsJsonObject: true,
  },
  // ── Additional providers (matched from Pi's built-in provider list) ──
  "ant-ling": {
    style: "openai-compatible",
    baseUrl: "https://api.ant-ling.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  nvidia: {
    style: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  huggingface: {
    style: "openai-compatible",
    baseUrl: "https://router.huggingface.co/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  moonshotai: {
    style: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  "moonshotai-cn": {
    style: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  xiaomi: {
    style: "openai-compatible",
    baseUrl: "https://api.xiaomimimo.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  "xiaomi-token-plan-ams": {
    style: "openai-compatible",
    baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  "xiaomi-token-plan-cn": {
    style: "openai-compatible",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  "xiaomi-token-plan-sgp": {
    style: "openai-compatible",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  zai: {
    style: "openai-compatible",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  "zai-coding-cn": {
    style: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    authHeader: "Authorization",
    authPrefix: "Bearer ",
    supportsJsonObject: true,
  },
  // ── Anthropic-style providers ──
  "kimi-coding": {
    style: "anthropic",
    baseUrl: "https://api.kimi.com/coding/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  minimax: {
    style: "anthropic",
    baseUrl: "https://api.minimax.io/anthropic/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  "minimax-cn": {
    style: "anthropic",
    baseUrl: "https://api.minimaxi.com/anthropic/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
  "vercel-ai-gateway": {
    style: "anthropic",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    authHeader: "x-api-key",
    authPrefix: "",
  },
};

export function getProviderApiInfo(provider: string): ProviderApiInfo | undefined {
  return PROVIDER_API_MAP[provider.toLowerCase()];
}

function resolveProviderApiInfo(provider: string, secondary?: SecondaryModelConfig): ProviderApiInfo | undefined {
  if (secondary?.baseUrl) {
    const style = secondary.style ?? "openai-compatible";
    if (style !== "openai-compatible" && style !== "anthropic") {
      throw new Error(`Unsupported secondary style: ${style}. Use "openai-compatible" or "anthropic".`);
    }
    return {
      style,
      baseUrl: secondary.baseUrl.replace(/\/$/, ""),
      authHeader: secondary.authHeader ?? (style === "anthropic" ? "x-api-key" : "Authorization"),
      authPrefix: secondary.authPrefix ?? (style === "anthropic" ? "" : "Bearer "),
      supportsJsonObject: style === "openai-compatible",
    };
  }
  return getProviderApiInfo(provider);
}

/** Returns true when the effective provider supports OpenAI-style json_object structured output. */
export function providerSupportsJsonObject(provider: string, secondary?: SecondaryModelConfig): boolean {
  const apiInfo = resolveProviderApiInfo(provider, secondary);
  return apiInfo?.supportsJsonObject === true;
}

const piSessionIds = new Map<string, string>();

export function setPiSessionId(cwd: string, sessionId: string): void {
  piSessionIds.set(cwd, sessionId);
}

export function clearPiSessionId(cwd: string): void {
  piSessionIds.delete(cwd);
}

export async function callSecondaryModel(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: CallSecondaryModelOptions = {},
): Promise<{ content: string; usage: UsageCost }> {
  const { signal, thinking: optionsThinking, cwd, sessionManager, relevantPaths, task, structuredOutput } = options;
  const config = cwd ? loadHeyyooConfig(cwd) : undefined;
  const effectiveSecondary = config && task ? resolveTaskModel(config, task) : config?.secondary;
  provider = (effectiveSecondary?.provider || provider).toLowerCase();
  model = effectiveSecondary?.id || model;
  const thinking = optionsThinking ?? effectiveSecondary?.thinking;
  // Auto-detect backend: use direct HTTP for known providers or custom baseUrl,
  // fall back to pi process for unknown providers that need Pi's routing/auth layer.
  const knownProvider = Object.hasOwn(PROVIDER_API_MAP, provider) || Boolean(effectiveSecondary?.baseUrl);
  const backend = effectiveSecondary?.backend ?? (knownProvider ? "http" : "pi");

  const modelInfoOverride = buildModelInfoOverride(effectiveSecondary, config?.modelInfo, model);
  const thinkingEnabledForBudget = Boolean(thinking) && thinking?.toLowerCase() !== "off";
  const modelInfoForBudget = cwd ? resolveModelInfo(provider, model, modelInfoOverride) : undefined;

  if (cwd) {
    const budgetUsd = config?.costBudgetUsd;
    if (budgetUsd !== undefined && budgetUsd >= 0) {
      const estimatedInputTokens = estimateTokens(systemPrompt + userPrompt);
      const estimatedOutputTokens = thinkingEnabledForBudget ? (modelInfoForBudget?.maxOutputTokens ?? 8192) : 2048;
      const projectedCost = estimateCost(provider, model, estimatedInputTokens, estimatedOutputTokens);
      const sessionCost = getSessionCost(cwd).costUsd + getReservedCost(cwd);
      if (sessionCost + projectedCost > budgetUsd) {
        throw new Error(
          `yoo call would exceed cost budget: projected ${formatCost(sessionCost + projectedCost)} / ${formatCost(budgetUsd)}. ` +
            `Increase pi-heyyoo.costBudgetUsd in settings or use /yoo-clear to reset.`,
        );
      }
    }
  }

  try {
    if (backend === "pi") {
      return await callPiBackend(provider, model, systemPrompt, userPrompt, {
        signal,
        thinking,
        cwd,
        sessionManager,
        relevantPaths,
      });
    }

    const apiInfo = resolveProviderApiInfo(provider, effectiveSecondary);
    if (!apiInfo) {
      throw new Error(
        `Unknown provider: ${provider}. Supported providers: ${Object.keys(PROVIDER_API_MAP).join(", ")}. ` +
          `Or set pi-heyyoo.secondary.baseUrl to use any OpenAI-compatible or Anthropic-compatible endpoint.`,
      );
    }

    const apiKey = resolveApiKey(provider, effectiveSecondary?.apiKey);
    if (!apiKey) {
      throw new Error(
        `No API key found for provider "${provider}". Set the appropriate environment variable, configure auth.json, ` +
          `or set pi-heyyoo.secondary.apiKey.`,
      );
    }

    const sessionId = cwd ? piSessionIds.get(cwd) : undefined;

    if (apiInfo.style === "anthropic") {
      return await callAnthropicApi(
        provider,
        apiInfo,
        apiKey,
        model,
        systemPrompt,
        userPrompt,
        signal,
        thinking,
        modelInfoOverride,
      );
    }
    return await callOpenAiCompatibleApi(
      provider,
      apiInfo,
      apiKey,
      model,
      systemPrompt,
      userPrompt,
      signal,
      thinking,
      false,
      modelInfoOverride,
      cwd,
      sessionId,
      structuredOutput,
    );
  } catch (err) {
    if (cwd) {
      logEvent(cwd, "error", err instanceof Error ? err.message : String(err), {
        provider,
        model,
        thinking,
        promptTokensEstimate: Math.ceil((systemPrompt.length + userPrompt.length) / 4),
        backend,
      });
    }
    throw err;
  }
}

function buildModelInfoOverride(
  secondary: SecondaryModelConfig | undefined,
  modelInfo: import("./types.js").HeyyooConfig["modelInfo"],
  model: string,
): Partial<import("./model-registry.js").ModelInfo> | undefined {
  if (!secondary) return undefined;
  const user = modelInfo?.[model.toLowerCase()];
  const override: { contextWindow?: number; maxOutputTokens?: number } = {};
  if (typeof secondary.contextWindow === "number" && Number.isFinite(secondary.contextWindow)) {
    override.contextWindow = secondary.contextWindow;
  } else if (typeof user?.contextWindow === "number" && Number.isFinite(user.contextWindow)) {
    override.contextWindow = user.contextWindow;
  }
  if (typeof secondary.maxOutputTokens === "number" && Number.isFinite(secondary.maxOutputTokens)) {
    override.maxOutputTokens = secondary.maxOutputTokens;
  } else if (typeof user?.maxOutputTokens === "number" && Number.isFinite(user.maxOutputTokens)) {
    override.maxOutputTokens = user.maxOutputTokens;
  }
  return Object.keys(override).length > 0 ? override : undefined;
}

const SIGKILL_TIMEOUT_MS = 5000;

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
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-heyyoo-"));
  const filePath = join(tmpDir, "session.jsonl");
  writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

interface ContentPart {
  type?: unknown;
  text?: unknown;
}

interface AssistantMessageLike {
  role?: unknown;
  content?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cost?: { total?: number } | number;
    totalTokens?: number;
  };
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const typed = part as ContentPart;
    if (typed.type === "text" && typeof typed.text === "string") {
      parts.push(typed.text);
    }
  }
  return parts.join("\n").trim();
}

function getFinalAssistantText(messages: AssistantMessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const text = extractTextFromContent(message.content);
    if (text.length > 0) return text;
  }
  return "";
}

interface PiProcessResult {
  messages: AssistantMessageLike[];
  stderr: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

function processPiJsonLine(line: string, result: PiProcessResult): void {
  if (!line.trim()) return;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  const message = event.message as AssistantMessageLike | undefined;
  if (!message) return;

  if (event.type === "message_end" || event.type === "turn_end") {
    if (message.role === "assistant") {
      result.messages.push(message);
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

const INHERITED_SESSION_MAX_ENTRIES = 10;

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

async function callPiBackend(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  options: CallSecondaryModelOptions = {},
): Promise<{ content: string; usage: UsageCost }> {
  const { signal, thinking, cwd, sessionManager, relevantPaths } = options;

  const config = cwd ? loadHeyyooConfig(cwd) : undefined;
  const processTimeoutMs = config?.processTimeoutMs ?? PI_PROCESS_TIMEOUT_MS;

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

  const sessionJsonl = inheritedSession ? inheritedSession + taskJsonl : taskJsonl;

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
        const content = getFinalAssistantText(result.messages);
        if (content) {
          const estimatedInputTokens = result.inputTokens ?? estimateTokens(systemPrompt + userPrompt);
          const estimatedOutputTokens = result.outputTokens ?? estimateTokens(content);
          const usage: UsageCost = {
            estimatedInputTokens,
            estimatedOutputTokens,
            estimatedCostUsd: result.cost ?? estimateCost(provider, model, estimatedInputTokens, estimatedOutputTokens),
            sessionCostUsd: 0,
          };
          return { content, usage };
        }
        // No assistant text — collect diagnostics and retry.
        const stderrPreview = result.stderr.trim().slice(0, 500);
        const msgRoles = result.messages.map((m) => m.role).join(",");
        const diag = `messages=${result.messages.length} [${msgRoles}], stderr=${stderrPreview || "(empty)"}`;
        attemptErrors.push(`attempt ${attempt + 1}: ${diag}`);
        if (cwd) {
          logEvent(cwd, "warn", "Pi backend produced no assistant text, retrying", {
            attempt: attempt + 1,
            maxRetries: maxRetries + 1,
            messageCount: result.messages.length,
            provider,
            model,
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
    // On final failure, include raw output diagnostics if PI_HEYYOO_DEBUG is set.
    const debug = process.env.PI_HEYYOO_DEBUG === "1" || process.env.PI_HEYYOO_DEBUG === "true";
    if (debug && cwd) {
      logEvent(cwd, "error", "Pi backend exhausted retries — raw diagnostics", {
        attemptErrors,
        provider,
        model,
        promptTokensEstimate: estimateTokens(systemPrompt + userPrompt),
      });
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

const PI_PROCESS_TIMEOUT_MS = 300_000; // 5 minutes default timeout for child pi process

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
      if (buffer.trim()) processPiJsonLine(buffer, result);
      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    };

    const onStdoutData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) processPiJsonLine(line, result);
    };

    proc.stdout.on("data", onStdoutData);

    proc.stderr.on("data", (chunk: Buffer) => {
      result.stderr += chunk.toString();
    });

    proc.on("close", (code, procSignal) => {
      const effectiveCode = code ?? (procSignal ? 1 : 0);
      if (effectiveCode !== 0 && !getFinalAssistantText(result.messages)) {
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

export function estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  // Approximate cost per 1M tokens in USD. These are rough averages.
  const key = `${provider}:${model}`.toLowerCase();
  const rates: Record<string, { input: number; output: number }> = {
    // OpenCode Go rates derived from actual dashboard usage:
    // glm-5.2 ~$2/M in · $3/M out, qwen3.7-plus ~$0.5/M in · $1.5/M out,
    // qwen3.7-max ~$3/M in · $6/M out, deepseek-v4-pro ~$2/M in · $3/M out.
    "opencode-go": { input: 2.0, output: 3.0 },
    "opencode-go:deepseek-v4-pro": { input: 2.0, output: 3.0 },
    "opencode-go:deepseek-v4-flash": { input: 0.5, output: 1.5 },
    "opencode-go:glm-5.2": { input: 2.0, output: 4.0 },
    "opencode-go:glm-5.1": { input: 2.0, output: 4.0 },
    "opencode-go:qwen3.7-max": { input: 3.0, output: 6.0 },
    "opencode-go:qwen3.7-plus": { input: 0.5, output: 1.5 },
    "opencode-go:qwen3.6-plus": { input: 0.5, output: 1.5 },
    "opencode-go:kimi-k2.7-code": { input: 2.0, output: 6.0 },
    "opencode-go:kimi-k2.6": { input: 2.0, output: 6.0 },
    "opencode-go:mimo-v2.5-pro": { input: 1.0, output: 3.0 },
    "opencode-go:mimo-v2.5": { input: 1.0, output: 3.0 },
    "opencode-go:minimax-m2.7": { input: 1.0, output: 3.0 },
    "opencode-go:minimax-m3": { input: 1.0, output: 3.0 },
    // OpenCode Zen (full model list) is typically more expensive than Go.
    opencode: { input: 3.0, output: 9.0 },
    deepseek: { input: 0.3, output: 1.0 },
    "deepseek:deepseek-chat": { input: 0.14, output: 0.28 },
    "deepseek:deepseek-reasoner": { input: 0.55, output: 2.19 },
    "deepseek:deepseek-v3": { input: 0.14, output: 0.28 },
    anthropic: { input: 3.0, output: 15.0 },
    "anthropic:claude-sonnet-4-5": { input: 3.0, output: 15.0 },
    "anthropic:claude-opus-4-5": { input: 15.0, output: 75.0 },
    "anthropic:claude-3-5-sonnet": { input: 3.0, output: 15.0 },
    "anthropic:claude-3-7-sonnet": { input: 3.0, output: 15.0 },
    "anthropic:claude-3-opus": { input: 15.0, output: 75.0 },
    "anthropic:claude-3-haiku": { input: 0.25, output: 1.25 },
    openai: { input: 2.5, output: 10.0 },
    "openai:gpt-5": { input: 5.0, output: 15.0 },
    "openai:gpt-5-mini": { input: 0.5, output: 1.5 },
    "openai:gpt-4o": { input: 2.5, output: 10.0 },
    "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
    "openai:gpt-4.5": { input: 5.0, output: 15.0 },
    "openai:gpt-4.5-preview": { input: 5.0, output: 15.0 },
    "openai:o1": { input: 15.0, output: 60.0 },
    "openai:o1-mini": { input: 1.1, output: 4.4 },
    "openai:o3": { input: 10.0, output: 40.0 },
    "openai:o3-mini": { input: 1.1, output: 4.4 },
    "openai:o4": { input: 10.0, output: 40.0 },
    "openai:o4-mini": { input: 1.5, output: 6.0 },
    openrouter: { input: 2.0, output: 6.0 },
    "openrouter:deepseek/deepseek-r1": { input: 0.55, output: 2.19 },
    "openrouter:anthropic/claude-3.5-sonnet": { input: 3.0, output: 15.0 },
    "openrouter:openai/gpt-4o": { input: 2.5, output: 10.0 },
    groq: { input: 0.6, output: 0.8 },
    "groq:llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
    "groq:llama-3.1-70b-versatile": { input: 0.59, output: 0.79 },
    "groq:mixtral-8x7b-32768": { input: 0.24, output: 0.24 },
    mistral: { input: 2.0, output: 6.0 },
    "mistral:mistral-large": { input: 2.0, output: 6.0 },
    "mistral:mistral-medium": { input: 2.7, output: 8.1 },
    "mistral:mistral-small": { input: 1.0, output: 3.0 },
    xai: { input: 2.0, output: 10.0 },
    "xai:grok-2": { input: 2.0, output: 10.0 },
    "xai:grok-3": { input: 3.0, output: 15.0 },
    together: { input: 0.9, output: 0.9 },
    "together:meta-llama/Llama-3.3-70B-Instruct-Turbo": { input: 0.88, output: 0.88 },
    fireworks: { input: 0.5, output: 1.5 },
    cerebras: { input: 0.6, output: 0.6 },
    "cerebras:llama-3.3-70b": { input: 0.6, output: 0.6 },
    google: { input: 1.0, output: 4.0 },
    "google:gemini-1.5-pro": { input: 1.25, output: 5.0 },
    "google:gemini-1.5-flash": { input: 0.075, output: 0.3 },
    "google:gemini-2.0-flash": { input: 0.1, output: 0.4 },
    "google:gemini-2.5-pro": { input: 1.25, output: 10.0 },
  };
  const rate = rates[key] ?? rates[provider] ?? { input: 2.0, output: 6.0 };
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 chars per token for English/code
  return Math.ceil(text.length / 4);
}

function buildUsage(
  provider: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  content: string,
): UsageCost {
  const estimatedInputTokens = estimateTokens(systemPrompt + userPrompt);
  const estimatedOutputTokens = estimateTokens(content);
  const estimatedCostUsd = estimateCost(provider, model, estimatedInputTokens, estimatedOutputTokens);
  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCostUsd,
    sessionCostUsd: 0,
  };
}

function applyReportedUsage(
  provider: string,
  model: string,
  usage: UsageCost,
  inputTokens: unknown,
  outputTokens: unknown,
): UsageCost {
  const inTokens =
    typeof inputTokens === "number" && Number.isFinite(inputTokens) ? inputTokens : usage.estimatedInputTokens;
  const outTokens =
    typeof outputTokens === "number" && Number.isFinite(outputTokens) ? outputTokens : usage.estimatedOutputTokens;
  return {
    ...usage,
    estimatedInputTokens: inTokens,
    estimatedOutputTokens: outTokens,
    estimatedCostUsd: estimateCost(provider, model, inTokens, outTokens),
  };
}

async function callOpenAiCompatibleApi(
  provider: string,
  apiInfo: ProviderApiInfo,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  thinking?: string,
  retriedWithReasoningOff = false,
  modelInfoOverride?: Partial<import("./model-registry.js").ModelInfo>,
  cwd?: string,
  sessionId?: string,
  structuredOutput = false,
): Promise<{ content: string; usage: UsageCost }> {
  const url = buildOpenAiUrl(apiInfo, apiKey);

  const supportsReasoning = supportsReasoningEffort(provider, model);
  const supportsAnthropicThinking = modelSupportsAnthropicThinking(provider, model);
  const thinkingEnabled =
    Boolean(thinking) && thinking!.toLowerCase() !== "off" && (supportsReasoning || supportsAnthropicThinking);
  const modelInfo = resolveModelInfo(provider, model, modelInfoOverride);
  // Reasoning models can consume a large portion of the output budget in internal reasoning tokens,
  // so use the model's full output limit when thinking/reasoning is enabled. Otherwise keep calls cheap
  // while still honoring explicit maxOutputTokens overrides.
  const outputTokenLimit = thinkingEnabled ? modelInfo.maxOutputTokens : Math.min(modelInfo.maxOutputTokens, 2048);

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: outputTokenLimit,
  };
  if (structuredOutput && apiInfo.supportsJsonObject) {
    body.response_format = { type: "json_object" };
  }
  if (thinkingEnabled) {
    delete body.temperature;
    if (supportsReasoning) {
      body.reasoning_effort = reasoningEffortForModel(provider, model, thinking ?? "medium");
    } else {
      // Anthropic requires budget_tokens < max_tokens, so keep a safety margin for visible output.
      const budget = Math.min(thinkingBudget(thinking ?? "medium"), outputTokenLimit - 512);
      body.thinking = { type: "enabled", budget_tokens: Math.max(1024, budget) };
    }
  }
  if (provider === "openai" && supportsMaxCompletionTokens(provider, model)) {
    delete body.max_tokens;
    body.max_completion_tokens = outputTokenLimit;
  }

  const headers = buildOpenAiHeaders(apiInfo, apiKey);
  if ((provider === "opencode-go" || provider === "opencode") && sessionId) {
    headers["x-opencode-session"] = sessionId;
  }

  const response = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Secondary model API error (${response.status}): ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
        refusal?: string;
        reasoning_content?: string;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(`Secondary model API error: ${data.error.message}`);
  }

  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error(`Empty response from secondary model: no choices. Raw: ${JSON.stringify(data).slice(0, 800)}`);
  }

  const message = choice.message;
  if (message?.refusal) {
    throw new Error(`Secondary model refused: ${message.refusal}`);
  }

  let content: string | undefined;
  if (typeof message?.content === "string") {
    content = message.content;
  } else if (Array.isArray(message?.content)) {
    content = message.content.map((c) => (typeof c === "object" && c?.text ? c.text : "")).join("");
  }

  const reasoningContent = message?.reasoning_content;
  if (
    (!content || content.trim().length === 0) &&
    reasoningContent &&
    choice.finish_reason === "length" &&
    !retriedWithReasoningOff
  ) {
    // The model spent its whole output budget on reasoning_content. Retry once with reasoning disabled
    // so there is room for the required structured content.
    return callOpenAiCompatibleApi(
      provider,
      apiInfo,
      apiKey,
      model,
      systemPrompt,
      userPrompt,
      signal,
      "off",
      true,
      modelInfoOverride,
      cwd,
      sessionId,
      structuredOutput,
    );
  }

  if (!content || content.trim().length === 0) {
    throw new Error(
      `Empty response from secondary model (finish_reason: ${choice.finish_reason ?? "unknown"}). Raw: ${JSON.stringify(data).slice(0, 800)}`,
    );
  }

  const usage = applyReportedUsage(
    provider,
    model,
    buildUsage(provider, model, systemPrompt, userPrompt, content),
    data.usage?.prompt_tokens,
    data.usage?.completion_tokens,
  );

  return { content, usage };
}

function buildOpenAiUrl(apiInfo: ProviderApiInfo, apiKey: string): string {
  const base = apiInfo.baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/chat/completions`);
  if (apiInfo.queryAuthKey) {
    url.searchParams.set(apiInfo.queryAuthKey, apiKey);
  }
  return url.toString();
}

function buildOpenAiHeaders(apiInfo: ProviderApiInfo, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!apiInfo.queryAuthKey) {
    headers[apiInfo.authHeader] = `${apiInfo.authPrefix}${apiKey}`;
  }
  return headers;
}

function supportsMaxCompletionTokens(provider: string, model: string): boolean {
  const key = `${provider}:${model}`.toLowerCase();
  const known = new Set([
    "openai:o1",
    "openai:o1-mini",
    "openai:o3",
    "openai:o3-mini",
    "openai:o4",
    "openai:o4-mini",
    "openai:gpt-4.5",
    "openai:gpt-5",
    "openai:gpt-5-mini",
  ]);
  return known.has(key) || model.toLowerCase().startsWith("o") || model.toLowerCase().startsWith("gpt-5");
}

async function callAnthropicApi(
  provider: string,
  apiInfo: ProviderApiInfo,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  signal?: AbortSignal,
  thinking?: string,
  modelInfoOverride?: Partial<import("./model-registry.js").ModelInfo>,
): Promise<{ content: string; usage: UsageCost }> {
  const url = `${apiInfo.baseUrl}/messages`;

  const thinkingEnabled =
    Boolean(thinking) &&
    (thinking as string).toLowerCase() !== "off" &&
    modelSupportsAnthropicThinking(provider, model);
  const modelInfo = resolveModelInfo(provider, model, modelInfoOverride);
  // Anthropic counts thinking tokens against max_tokens, so reserve room for visible output.
  const outputTokenLimit = thinkingEnabled ? modelInfo.maxOutputTokens : Math.min(modelInfo.maxOutputTokens, 2048);

  const body: Record<string, unknown> = {
    model,
    max_tokens: outputTokenLimit,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };
  if (thinkingEnabled) {
    const budget = Math.min(thinkingBudget(thinking ?? "medium"), outputTokenLimit - 512);
    body.thinking = { type: "enabled", budget_tokens: Math.max(1024, budget) };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [apiInfo.authHeader]: `${apiInfo.authPrefix}${apiKey}`,
    "anthropic-version": "2023-06-01",
  };

  const response = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Secondary model API error (${response.status}): ${text.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string; thinking?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };

  if (data.error?.message) {
    throw new Error(`Secondary model API error: ${data.error.message}`);
  }

  const textContent = data.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  if (!textContent || textContent.trim().length === 0) {
    throw new Error(`Empty response from secondary model. Raw: ${JSON.stringify(data).slice(0, 800)}`);
  }

  const usage = applyReportedUsage(
    provider,
    model,
    buildUsage(provider, model, systemPrompt, userPrompt, textContent),
    data.usage?.input_tokens,
    data.usage?.output_tokens,
  );

  return { content: textContent, usage };
}

function modelSupportsAnthropicThinking(provider: string, model: string): boolean {
  // Anthropic extended thinking is supported by Claude 4 series and later thinking-enabled models.
  const lc = `${provider}:${model}`.toLowerCase();
  const modelLc = model.toLowerCase();
  const thinkingModels = new Set([
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-3-7-sonnet",
    "claude-3.7-sonnet",
    "anthropic/claude-3-7-sonnet",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-opus-4-5",
  ]);
  const baseModel = modelLc.replace(/-\d{8}$/, "").replace(/-latest$/, "");
  if (thinkingModels.has(baseModel)) return true;
  if (lc.startsWith("openrouter:")) {
    // OpenRouter passes provider-specific params only for Anthropic thinking models.
    return [...thinkingModels].some((m) => baseModel.includes(m.replace("anthropic/", "")));
  }
  return false;
}

function supportsReasoningEffort(_provider: string, model: string): boolean {
  // OpenAI-style reasoning_effort is supported by OpenAI o-series/gpt-5 models.
  // DeepSeek reasoner models emit reasoning_content but do not accept a reasoning_effort parameter.
  const modelLc = model.toLowerCase();
  if (modelLc.startsWith("o") && /^o\d/.test(modelLc)) return true;
  if (modelLc.startsWith("gpt-5")) return true;
  return false;
}

function reasoningEffortFromThinking(level: string): "low" | "medium" | "high" {
  switch (level?.toLowerCase()) {
    case "minimal":
    case "low":
      return "low";
    case "high":
    case "xhigh":
      return "high";
    default:
      return "medium";
  }
}

function reasoningEffortForModel(provider: string, model: string, level: string): "low" | "medium" | "high" {
  // DeepSeek V4 models are prone to consuming the entire output budget with reasoning_content,
  // leaving no tokens for the required JSON content. Cap them at low reasoning effort.
  if (/^deepseek[-/]?v4/.test(`${provider}:${model}`.toLowerCase())) {
    return "low";
  }
  return reasoningEffortFromThinking(level);
}

function thinkingBudget(level: string): number {
  const budgets: Record<string, number> = {
    off: 0,
    minimal: 256,
    low: 512,
    medium: 1024,
    high: 2048,
    xhigh: 4096,
  };
  return budgets[level?.toLowerCase()] ?? 1024;
}

function formatFetchError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const parts: string[] = [message];
  if (err instanceof Error && err.cause instanceof Error) {
    parts.push(`cause: ${err.cause.message}`);
  }
  if (err instanceof AggregateError) {
    for (const e of err.errors) {
      parts.push(`cause: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return parts.join("; ");
}

async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 2, baseDelayMs = 500): Promise<Response> {
  const attemptErrors: string[] = [];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);
      // Retry on 5xx and rate-limit (429); do not retry on 4xx auth/validation errors.
      if (response.status >= 500 || response.status === 429) {
        const text = await response.text().catch(() => "(no body)");
        const errorText = `Transient API error (${response.status}): ${text.slice(0, 200)}`;
        attemptErrors.push(`attempt ${attempt + 1}: ${errorText}`);
      } else {
        return response;
      }
    } catch (err) {
      const errorText = formatFetchError(err);
      attemptErrors.push(`attempt ${attempt + 1}: ${errorText}`);
    }

    if (attempt < maxRetries) {
      if (init.signal?.aborted) {
        throw new Error("Secondary model request aborted");
      }
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delay);
        const signal = init.signal;
        if (!signal) return;
        const onAbort = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      if (init.signal?.aborted) {
        throw new Error("Secondary model request aborted");
      }
    }
  }
  throw new Error(`Secondary model request failed after ${maxRetries + 1} attempts: ${attemptErrors.join(" | ")}`);
}
