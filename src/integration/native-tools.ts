import { AsyncLocalStorage } from "node:async_hooks";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beginSessionWork } from "./session-work.js";

const usageScopes = new AsyncLocalStorage<{ usage?: Usage }>();
const mutableTools = new Set([
  "wai",
  "wai_review_min",
  "wai_review_med",
  "wai_review_high",
  "wai_learn",
  "wai_scaffold",
  "wai_design_ref",
  "wai_index",
]);
const queues = new Map<string, Promise<unknown>>();

/** SDK usage is collected once per actual provider response, never from cached action results. */
export function reportNativeUsage(usage: Usage): void {
  const scope = usageScopes.getStore();
  if (!scope) return;
  if (!scope.usage) {
    scope.usage = structuredClone(usage);
    return;
  }
  const sum = scope.usage;
  sum.input += usage.input;
  sum.output += usage.output;
  sum.cacheRead += usage.cacheRead;
  sum.cacheWrite += usage.cacheWrite;
  sum.totalTokens += usage.totalTokens;
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
    sum.cost[field] += usage.cost[field];
  if (usage.reasoning !== undefined) sum.reasoning = (sum.reasoning ?? 0) + usage.reasoning;
  if (usage.cacheWrite1h !== undefined) sum.cacheWrite1h = (sum.cacheWrite1h ?? 0) + usage.cacheWrite1h;
}

/** Keep tool names and structured details intact; Pi owns the native error flag. */
export function createNativeToolRegistrar(pi: ExtensionAPI): ExtensionAPI["registerTool"] {
  const names = new Set<string>();
  pi.on("tool_result", (event) => {
    if (!names.has(event.toolName)) return;
    const details: unknown = event.details;
    if (
      details &&
      typeof details === "object" &&
      "error" in details &&
      typeof details.error === "string" &&
      details.error
    ) {
      return { isError: true };
    }
  });
  return (definition) => {
    names.add(definition.name);
    const mutable = mutableTools.has(definition.name);
    pi.registerTool({
      ...definition,
      ...(mutable ? { executionMode: "sequential" as const } : {}),
      execute: async (id, params, signal, update, ctx) => {
        const work = beginSessionWork(ctx.cwd, signal);
        const run = () =>
          usageScopes.run({}, async () => {
            work.signal.throwIfAborted();
            const result = await definition.execute(id, params, work.signal, update, ctx);
            work.signal.throwIfAborted();
            const usage = usageScopes.getStore()?.usage;
            return usage ? { ...result, usage } : result;
          });
        if (!mutable) return run();
        const previous = queues.get(ctx.cwd) ?? Promise.resolve();
        const pending = previous.catch(() => {}).then(run);
        queues.set(ctx.cwd, pending);
        const releaseQueue = () => {
          if (queues.get(ctx.cwd) === pending) queues.delete(ctx.cwd);
        };
        work.signal.addEventListener("abort", releaseQueue, { once: true });
        if (work.signal.aborted) releaseQueue();
        try {
          return await pending;
        } finally {
          work.signal.removeEventListener("abort", releaseQueue);
          releaseQueue();
        }
      },
    });
  };
}
