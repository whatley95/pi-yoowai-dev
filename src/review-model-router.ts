import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { resolveReviewModelCandidates } from "./config.js";
import type { ReviewLevel, SecondaryModelConfig, YoowaiConfig } from "./types.js";

interface ReviewPoolState {
  active: number[];
  next: number;
}

/** A reservation covers one whole review, including its parallel workers. */
export interface ReviewModelLease {
  /** Preferred model first; remaining candidates are whole-review failovers. */
  models: SecondaryModelConfig[];
  /** Move the reservation when retrying the whole review with another candidate. */
  activate(index: number): void;
  /** Always call from finally, including cancellation and local failures. */
  release(): void;
}

const MAX_IDLE_POOLS = 256;
const pools = new Map<string, ReviewPoolState>();

function pruneIdlePools(): void {
  if (pools.size <= MAX_IDLE_POOLS) return;
  for (const [key, state] of pools) {
    if (state.active.every((count) => count === 0)) pools.delete(key);
    if (pools.size <= MAX_IDLE_POOLS) break;
  }
}

function poolKey(cwd: string, models: SecondaryModelConfig[], level: ReviewLevel, mode: string): string {
  const project = resolve(cwd);
  // Hash connection settings as well as identities: credentials never appear in
  // map keys, and changed settings cannot reuse an old cursor or reservation.
  const normalizedModels = models.map((model) =>
    Object.fromEntries(Object.entries(model).sort(([left], [right]) => left.localeCompare(right))),
  );
  return createHash("sha256")
    .update(
      JSON.stringify([process.platform === "win32" ? project.toLowerCase() : project, level, mode, normalizedModels]),
    )
    .digest("hex");
}

/** Select and reserve synchronously, before starting any asynchronous work.
 *  State is process-local and independent for each project, depth and pool.
 *  Least busy counts whole reviews rather than their individual model calls. */
export function acquireReviewModel(cwd: string, config: YoowaiConfig, level: ReviewLevel): ReviewModelLease {
  const candidates = resolveReviewModelCandidates(config, level).map((model) => ({ ...model }));
  const mode = config.reviewLoadBalance ?? "least-busy";
  const key = poolKey(cwd, candidates, level, mode);
  let state = pools.get(key);
  if (!state) {
    state = { active: candidates.map(() => 0), next: 0 };
  }
  // Refresh insertion order so idle eviction preserves recently used pools.
  pools.delete(key);
  pools.set(key, state);

  let selected = 0;
  if (mode === "round-robin") {
    selected = state.next;
  } else if (mode === "least-busy") {
    const lowest = Math.min(...state.active);
    for (let offset = 0; offset < candidates.length; offset++) {
      const index = (state.next + offset) % candidates.length;
      if (state.active[index] === lowest) {
        selected = index;
        break;
      }
    }
  }
  state.next = (selected + 1) % candidates.length;
  state.active[selected]++;
  pruneIdlePools();

  const order = [selected, ...candidates.map((_, index) => index).filter((index) => index !== selected)];
  let active = selected;
  let released = false;
  return {
    models: order.map((index) => candidates[index]),
    activate(index) {
      if (!Number.isInteger(index) || index < 0 || index >= order.length) {
        throw new RangeError("Invalid review model candidate index");
      }
      if (released || order[index] === active) return;
      state.active[active]--;
      active = order[index];
      state.active[active]++;
    },
    release() {
      if (released) return;
      released = true;
      state.active[active]--;
      pruneIdlePools();
    },
  };
}

/** Test isolation only; production reservations end through lease.release(). */
export function resetReviewModelRouterForTests(): void {
  pools.clear();
}
