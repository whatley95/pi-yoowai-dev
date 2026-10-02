import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokens } from "./token-budget.js";
import { resolveProjectPath } from "./path-security.js";

export const PACKAGED_SKILLS = [
  "wai-skill-design",
  "wai-debug",
  "wai-testing",
  "wai-safe-refactor",
  "wai-api-contracts",
  "wai-delivery",
  "wai-flutter",
  "wai-kotlin",
  "wai-spring",
  "wai-node",
  "wai-web",
  "wai-security",
] as const;
export type PackagedSkill = (typeof PACKAGED_SKILLS)[number];
export function getPackagedSkillsRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");
}
function readManifest(cwd: string, file: string): string {
  try {
    const path = resolveProjectPath(cwd, file);
    if (!path || statSync(path).size > 128 * 1024) return "";
    const text = readFileSync(path, "utf8");
    return text.length <= 128 * 1024 ? text : "";
  } catch {
    return "";
  }
}
export function isFlutterProject(cwd: string): boolean {
  return /^\s*flutter:\s*(?:#.*)?\r?\n\s+sdk:\s*flutter\s*(?:#.*)?$/m.test(readManifest(cwd, "pubspec.yaml"));
}

/** Nearest package owns stack selection in mixed repositories. Build tools
 * alone do not imply that browser code runs in Node. Cache per selection call. */
function javascriptSkills(cwd: string, file: string, manifests: Map<string, string>): PackagedSkill[] {
  if (!/\.(?:[cm]?[jt]sx?|vue|svelte|html|css|scss)$/i.test(file)) return [];
  const absolute = resolveProjectPath(cwd, file);
  if (!absolute) return [];
  const root = resolve(cwd);
  let manifest = "";
  const visited: string[] = [];
  for (let dir = dirname(absolute), depth = 0; depth < 24; dir = dirname(dir), depth++) {
    const known = manifests.get(dir);
    if (known !== undefined) {
      manifest = known;
      break;
    }
    visited.push(dir);
    const name = join(relative(root, dir), "package.json");
    const path = resolveProjectPath(cwd, name);
    if (path && existsSync(path)) {
      manifest = readManifest(cwd, name);
      break;
    }
    if (dir === root) break;
  }
  for (const dir of visited) manifests.set(dir, manifest);
  const browserFile = /\.(?:[jt]sx|vue|svelte|html|css|scss)$/i.test(file);
  let dependencies: string[] = [];
  let packageParsed = false;
  try {
    const pkg = JSON.parse(manifest) as Record<string, unknown>;
    if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return browserFile ? ["wai-web"] : [];
    packageParsed = true;
    dependencies = ["dependencies", "devDependencies", "peerDependencies"].flatMap((key) =>
      pkg[key] && typeof pkg[key] === "object" ? Object.keys(pkg[key] as object) : [],
    );
  } catch {
    /* Invalid/missing metadata is not stack evidence. */
  }
  const web =
    browserFile ||
    dependencies.some((name) =>
      /^(?:react|react-dom|next|vue|nuxt|svelte|@angular\/core|@sveltejs\/kit|@solidjs\/start|solid-js|astro)$/.test(
        name,
      ),
    );
  const server =
    /(?:^|\/)(?:server|backend|api|scripts)(?:\/|[.])|(?:^|\/)(?:vite|webpack|rollup|eslint)\.config\./i.test(file) ||
    dependencies.some((name) => /^(?:express|fastify|koa|hapi|@hapi\/hapi|@nestjs\/core)$/.test(name));
  return [
    ...(web ? ["wai-web" as const] : []),
    ...(packageParsed && (!web || server) && !browserFile ? ["wai-node" as const] : []),
  ];
}

/** Inspect the containing module, stopping at a non-Android Gradle boundary.
 * Kotlin syntax/build scripts alone are not Android evidence. The optional
 * cache belongs to one classification call, never a persisted workspace. */
export function isAndroidModuleFile(cwd: string, file: string, modules?: Map<string, boolean>): boolean {
  if (!/\.(?:kt|kts|java|xml)$/i.test(file)) return false;
  const absolute = resolveProjectPath(cwd, file.replace(/\\/g, "/"));
  if (!absolute) return false;
  const root = resolve(cwd);
  const visited: string[] = [];
  const remember = (android: boolean): boolean => {
    for (const dir of visited) modules?.set(dir, android);
    return android;
  };
  for (let dir = dirname(absolute), depth = 0; depth < 24; dir = dirname(dir), depth++) {
    const known = modules?.get(dir);
    if (known !== undefined) return remember(known);
    visited.push(dir);
    const module = relative(root, dir);
    const manifest = resolveProjectPath(cwd, join(module, "src", "main", "AndroidManifest.xml"));
    if (manifest && existsSync(manifest)) return remember(true);
    const builds = ["build.gradle", "build.gradle.kts"].map((name) => resolveProjectPath(cwd, join(module, name)));
    const present = builds.filter((path): path is string => path !== null && existsSync(path));
    if (
      present.some((path) =>
        /com\.android\.(?:application|library|dynamic-feature|test|kotlin\.multiplatform\.library)\b/.test(
          readManifest(cwd, relative(root, path)),
        ),
      )
    )
      return remember(true);
    if (present.length || dir === root) return remember(false);
  }
  return false;
}
/** Criteria are optional guidance, never evidence or a coverage decision. */
export function selectEvaluationSkills(cwd: string, action: string, files: string[]): PackagedSkill[] {
  if (!["review", "judge", "test", "security"].includes(action) || files.length === 0) return [];
  const paths = files.map((file) => file.replace(/\\/g, "/"));
  const selected: PackagedSkill[] = action === "security" ? ["wai-security", "wai-api-contracts"] : ["wai-testing"];
  if (
    action !== "security" &&
    paths.some((file) =>
      /(?:^|[/._-])(?:auth(?:entication|orization)?|secrets?|credentials?|permissions?)(?:[/._-]|$)/i.test(file),
    )
  )
    selected.push("wai-security");
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
  const androidModules = new Map<string, boolean>();
  if (paths.some((file) => isAndroidModuleFile(cwd, file, androidModules))) selected.push("wai-kotlin");
  if (
    paths.some((file) => /\.java$/i.test(file)) &&
    ["pom.xml", "build.gradle", "build.gradle.kts"].some((file) =>
      /org\.springframework|spring-boot/.test(readManifest(cwd, file)),
    )
  )
    selected.push("wai-spring");
  const manifests = new Map<string, string>();
  for (const path of paths) selected.push(...javascriptSkills(cwd, path, manifests));
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
