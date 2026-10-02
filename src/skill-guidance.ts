import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "./token-budget.js";

export const PACKAGED_SKILLS = [
  "wai-skill-design",
  "wai-debug",
  "wai-testing",
  "wai-safe-refactor",
  "wai-api-contracts",
  "wai-delivery",
  "wai-flutter",
  "wai-spring",
  "wai-node",
] as const;
export type PackagedSkill = (typeof PACKAGED_SKILLS)[number];
export function getPackagedSkillsRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}
function readManifest(cwd: string, file: string): string {
  try {
    const text = readFileSync(join(cwd, file), "utf8");
    return text.length <= 128 * 1024 ? text : "";
  } catch {
    return "";
  }
}
export function isFlutterProject(cwd: string): boolean {
  return /^\s*flutter:\s*(?:#.*)?\r?\n\s+sdk:\s*flutter\s*(?:#.*)?$/m.test(readManifest(cwd, "pubspec.yaml"));
}
/** Criteria are optional guidance, never evidence or a coverage decision. */
export function selectEvaluationSkills(cwd: string, action: string, files: string[]): PackagedSkill[] {
  if (!["review", "judge", "test", "security"].includes(action) || files.length === 0) return [];
  const paths = files.map((file) => file.replace(/\\/g, "/"));
  const selected: PackagedSkill[] = action === "security" ? ["wai-api-contracts"] : ["wai-testing"];
  if (
    action !== "test" &&
    paths.some((file) =>
      /(?:^|[/._-])(?:api|auth(?:entication|orization)?|routes?|controllers?|dto|schemas?|migration)(?:[/._-]|$)/i.test(
        file,
      ),
    )
  )
    selected.push("wai-api-contracts");
  if (paths.some((file) => /\.dart$/i.test(file)) && isFlutterProject(cwd)) selected.push("wai-flutter");
  if (
    paths.some((file) => /\.java$/i.test(file)) &&
    ["pom.xml", "build.gradle", "build.gradle.kts"].some((file) =>
      /org\.springframework|spring-boot/.test(readManifest(cwd, file)),
    )
  )
    selected.push("wai-spring");
  if (paths.some((file) => /\.[cm]?[jt]sx?$/i.test(file)) && existsSync(join(cwd, "package.json")))
    selected.push("wai-node");
  return [...new Set(selected)];
}
const selections = new Map<string, Record<string, PackagedSkill[]>>();
export function clearSkillSelections(cwd: string): void {
  selections.delete(cwd);
}
export function getSkillSelections(cwd: string): Record<string, PackagedSkill[]> {
  return Object.fromEntries(Object.entries(selections.get(cwd) ?? {}).map(([action, names]) => [action, [...names]]));
}
/** Shared with main-agent references. Whole criteria only, within the existing
 * instruction budget. Content changes change the existing prompt/cache key. */
export function formatEvaluationGuidance(cwd: string, action: string, files: string[], maxTokens: number): string {
  const state = selections.get(cwd) ?? {};
  state[action] = [];
  selections.set(cwd, state);
  if (maxTokens <= 0) return "";
  const lines = ["Built-in evaluation criteria (explicit requirements and project instructions take precedence):"];
  for (const name of selectEvaluationSkills(cwd, action, files)) {
    try {
      const text = readFileSync(join(getPackagedSkillsRoot(), name, "references", "checks.md"), "utf8").trim();
      if (text.length > 8000) continue;
      const entry = name + ":\n" + text;
      if (estimateTokens([...lines, entry].join("\n")) > maxTokens) continue;
      lines.push(entry);
      state[action].push(name);
    } catch {
      /* Optional guidance must not prevent reviewing complete source. */
    }
  }
  return lines.length > 1 ? lines.join("\n") : "";
}
