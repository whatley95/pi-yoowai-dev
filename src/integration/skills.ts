import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { logEvent } from "../logger.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Structural resources_discover event (not exported by host 0.82.1 types). */
interface ResourcesDiscoverEventPayload {
  type: "resources_discover";
  cwd: string;
  reason: "startup" | "reload";
}

/** The vendored design topics shipped with the package. MUST stay in sync
 *  with src/design-ref.ts (DESIGN_REF_TOPIC_DESCRIPTIONS keys) and
 *  scripts/setup.js (DESIGN_SKILL_TOPICS) — the parity test pins them. */
export const DESIGN_SKILL_TOPICS = [
  "animate",
  "animation-vocabulary",
  "apple-design",
  "emil-design-eng",
  "find-animation-opportunities",
  "improve-animations",
  "pick-ui-library",
  "prototype",
  "review-animations",
] as const;

/** Default vendored root: ../../design-refs relative to src/integration/. */
function defaultDesignRefsRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "design-refs");
}

export interface SkillDiscoveryOptions {
  /** Design-refs root; defaults to the packaged layout (import.meta.url). */
  designRefsRoot?: string;
  /** Existence check seam for tests (default: directory + SKILL.md exist). */
  isSkillDir?: (dir: string) => boolean;
  /** Warning sink seam for tests. ALWAYS invoked for every warning; sink
   *  failures are caught so they can never escape discovery. */
  warn?: (message: string) => void;
}

/** Records a warning through every available sink without ever throwing. */
function emitWarnings(messages: string[], options: SkillDiscoveryOptions): void {
  for (const message of messages) {
    try {
      options.warn?.(message);
    } catch {
      // A failing warning sink must never break discovery.
    }
  }
}

export interface SkillDiscoveryResult {
  /** Absolute package directories (allowlist order, deduped). */
  skillPaths: string[];
  warnings: string[];
}

/** Pure discovery over the fixed topic allowlist — never throws, never touches
 *  anything outside the packaged design-refs tree. Missing topics produce
 *  actionable warnings (and are skipped); an empty layout yields []. */
export function buildDesignSkillPaths(options: SkillDiscoveryOptions = {}): SkillDiscoveryResult {
  const root = resolve(options.designRefsRoot ?? defaultDesignRefsRoot());
  const isSkillDir = options.isSkillDir ?? ((dir: string) => existsSync(join(dir, "SKILL.md")) && existsSync(dir));
  const skillPaths: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const topic of DESIGN_SKILL_TOPICS) {
    const dir = join(root, topic);
    if (seen.has(dir)) continue;
    seen.add(dir);
    try {
      if (!isSkillDir(dir)) {
        warnings.push(
          `Design skill "${topic}" not found under ${root} — skipped (vendored design-refs missing or partial)?`,
        );
        continue;
      }
    } catch (err) {
      warnings.push(`Design skill check failed for ${topic}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    skillPaths.push(dir);
  }
  emitWarnings(warnings, options);
  return { skillPaths, warnings };
}

export interface SkillDiscoveryRegistrationOptions {
  /** Warning sink seam for tests (default: logEvent). Failures contained. */
  warn?: (message: string) => void;
  /** Design-refs root seam for tests (default: packaged layout). */
  designRefsRoot?: string;
}

/** Registers Pi's resources_discover handler so the vendored design topics
 *  are exposed as native skills to the MAIN agent automatically (host
 *  >= 0.82: runner collects skillPaths from extensions at startup/reload).
 *  No user home writes; scripts/setup.js remains the legacy fallback for
 *  hosts without this hook. */
export function registerDesignSkillDiscovery(pi: ExtensionAPI, options: SkillDiscoveryRegistrationOptions = {}): void {
  pi.on("resources_discover", (_event: ResourcesDiscoverEventPayload, ctx) => {
    const { skillPaths } = buildDesignSkillPaths({
      designRefsRoot: options.designRefsRoot,
      // Safe warning delivery: a failing logger must never break discovery.
      warn: options.warn ?? ((message) => logEvent(ctx.cwd, "warn", message)),
    });
    return { skillPaths };
  });
}
