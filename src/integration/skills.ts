import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getProjectConfigPath } from "../pi-paths.js";
import { PACKAGED_SKILLS, getPackagedSkillsRoot, getSkillSelections, clearSkillSelections } from "../skill-guidance.js";

export const LEGACY_DESIGN_SKILLS = [
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
interface SkillRead {
  skill: string;
  document: string;
  path: string;
}
const reads = new Map<string, SkillRead[]>();
export function recordSkillRead(cwd: string, path: string): void {
  const absolute = resolve(cwd, path);
  const rel = relative(getPackagedSkillsRoot(), absolute);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) return;
  const [name, ...parts] = rel.split(sep);
  if (!(PACKAGED_SKILLS as readonly string[]).includes(name) || !parts.length || !absolute.endsWith(".md")) return;
  const previous = reads.get(cwd) ?? [];
  reads.set(
    cwd,
    [
      ...previous.filter((item) => item.path !== absolute),
      {
        skill: name,
        document: parts.join("/"),
        path: absolute,
      },
    ].slice(-24),
  );
}
export function getSkillDiagnostics(cwd: string) {
  const directories = [
    join(getAgentDir(), "skills"),
    getProjectConfigPath(cwd, "skills"),
    join(cwd, ".agents", "skills"),
    join(homedir(), ".agents", "skills"),
  ];
  return {
    packaged: PACKAGED_SKILLS.map((name) => ({
      name,
      path: join(getPackagedSkillsRoot(), name, "SKILL.md"),
      available: existsSync(join(getPackagedSkillsRoot(), name, "SKILL.md")),
    })),
    // Pi resolves actual filters/collisions. Availability does not claim a
    // skill is in the active catalog or that its instructions were followed.
    observedReads: (reads.get(cwd) ?? []).map((item) => ({ ...item })),
    evaluationSkills: getSkillSelections(cwd),
    overrides: directories.flatMap((dir) =>
      PACKAGED_SKILLS.map((name) => join(dir, name, "SKILL.md")).filter(existsSync),
    ),
    legacyCopies: directories.flatMap((dir) =>
      LEGACY_DESIGN_SKILLS.map((name) => join(dir, name, "SKILL.md")).filter(existsSync),
    ),
  };
}
export function formatSkillDiagnostics(cwd: string): string {
  const info = getSkillDiagnostics(cwd);
  return [
    "Packaged skills: " +
      info.packaged.filter((skill) => skill.available).length +
      "/" +
      PACKAGED_SKILLS.length +
      " available (Pi settings control activation).",
    "Observed successful reads: " +
      (info.observedReads.length
        ? info.observedReads.map((read) => read.skill + "/" + read.document).join(", ")
        : "none this session") +
      ". Reads do not prove compliance.",
    ...Object.entries(info.evaluationSkills).map(
      ([action, names]) => "Secondary " + action + " criteria: " + (names.join(", ") || "none within budget") + ".",
    ),
    ...info.overrides.map(
      (path) => "Possible skill-name collision: " + path + ". Inspect Pi startup diagnostics; first discovered wins.",
    ),
    ...info.legacyCopies.map(
      (path) =>
        "Legacy design copy: " +
        path +
        ". It can expose the original workflow alongside wai-skill-design; inspect before removing.",
    ),
  ].join("\n");
}
/** Native pi.skills owns discovery/filtering. This hook observes reads only. */
export function registerSkillReadTracking(pi: ExtensionAPI): void {
  const clear = (cwd: string) => {
    reads.delete(cwd);
    clearSkillSelections(cwd);
  };
  pi.on("session_start", (_event, ctx) => clear(ctx.cwd));
  pi.on("session_shutdown", (_event, ctx) => clear(ctx.cwd));
  pi.on("tool_result", (event, ctx) => {
    if (event.isError || !event.input || typeof event.input !== "object") return;
    const input = event.input as Record<string, unknown>;
    const path =
      event.toolName === "read"
        ? input.path
        : event.toolName === "wai_design_ref" && input.topic === "wai-skill-design"
          ? join(getPackagedSkillsRoot(), "wai-skill-design", typeof input.doc === "string" ? input.doc : "SKILL.md")
          : undefined;
    if (typeof path === "string") recordSkillRead(ctx.cwd, path);
  });
}
