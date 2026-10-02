import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

interface NativeReadContext {
  cwd: string;
  tools: readonly { name: string }[];
  executeTool(name: string, args: unknown, options: { signal?: AbortSignal }): Promise<unknown>;
}

export interface NativeReadResult {
  output: string;
  error?: string;
  details?: Record<string, unknown>;
}

const contexts = new AsyncLocalStorage<NativeReadContext | undefined>();

/** Scope the live tool context to this invocation, including parallel model calls.
 * Commands and older hosts retain the local reader; they never inherit a caller's context. */
export function withNativeReadTools<T>(context: unknown, run: () => T): T {
  const candidate = context as Partial<NativeReadContext> | undefined;
  const native =
    typeof candidate?.cwd === "string" && typeof candidate.executeTool === "function"
      ? {
          cwd: candidate.cwd,
          tools: Array.isArray(candidate.tools) ? candidate.tools : [],
          executeTool: candidate.executeTool.bind(candidate),
        }
      : undefined;
  return contexts.run(native, run);
}

export function hasNativeReadTools(): boolean {
  return !!contexts.getStore();
}

/** Undefined means a legacy/local invocation. An empty list means that the
 * native API exists but no read/search tools are callable; do not advertise them. */
export function getNativeReadToolNames(): readonly ("read" | "grep")[] | undefined {
  const context = contexts.getStore();
  return context && (["read", "grep"] as const).filter((name) => context.tools.some((tool) => tool?.name === name));
}

/** Only a missing host API permits local fallback. A missing/blocked/failed native
 * tool remains an error; executing a local reader then would bypass Pi's policy. */
export async function dispatchNativeReadTool(
  cwd: string,
  name: "read" | "grep",
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<NativeReadResult | undefined> {
  const context = contexts.getStore();
  if (!context) return undefined;
  signal?.throwIfAborted();
  if (resolve(context.cwd) !== resolve(cwd))
    return { output: "", error: "Pi read context belongs to another project." };
  if (!context.tools.some((tool) => tool?.name === name))
    return {
      output: "",
      error: `Pi tool '${name}' is not callable in this session. Enable it before requesting context.`,
    };
  try {
    const outcome = (await context.executeTool(name, args, { signal })) as {
      isError?: boolean;
      result?: { content?: { type?: string; text?: string }[]; details?: Record<string, unknown> };
    };
    signal?.throwIfAborted();
    const content = outcome?.result?.content;
    if (!Array.isArray(content) || content.some((item) => item.type !== "text" || typeof item.text !== "string"))
      return { output: "", error: `Pi ${name} returned non-text or invalid context.` };
    const output = content.map((item) => item.text).join("\n");
    if (outcome.isError) return { output: "", error: output || `Pi ${name} failed without an error message.` };
    if (content.length === 0) return { output: "", error: `Pi ${name} returned no context.` };
    return { output, details: outcome.result?.details };
  } catch (error) {
    signal?.throwIfAborted();
    return { output: "", error: error instanceof Error ? error.message : String(error) };
  }
}
