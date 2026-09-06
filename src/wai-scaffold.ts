import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getProjectConfigPath } from "./pi-paths.js";

export type ScaffoldTarget = "skill" | "review" | "security" | "test";

export const SCAFFOLD_TARGETS: readonly ScaffoldTarget[] = ["skill", "review", "security", "test"] as const;

interface TemplateEntry {
  /** Packaged template path (relative to the package root). */
  template: string;
  /** Project-relative destination (always under .pi/). */
  destination: string;
}

/** Fixed template → destination map. Layouts are literal — no user input
 *  reaches these paths. */
const TEMPLATE_MAP: Record<ScaffoldTarget, TemplateEntry> = {
  skill: {
    template: "templates/skills/engineering-standards.SKILL.md.example",
    destination: ".pi/skills/engineering-standards/SKILL.md",
  },
  review: {
    template: "templates/instructions/review.md.example",
    destination: ".pi/yoowai/instructions/review.md",
  },
  security: {
    template: "templates/instructions/security.md.example",
    destination: ".pi/yoowai/instructions/security.md",
  },
  test: {
    template: "templates/instructions/test.md.example",
    destination: ".pi/yoowai/instructions/test.md",
  },
};

/** Strict substitution keys (double-braced). Filled ONLY from evidence:
 *  conventions scan + repo manifests. Anything unknown stays untouched.
 *  Marker grammar (documented contract): {{[A-Za-z0-9_.-]+}} */
const SUBSTITUTION_KEYS = ["stack", "language", "testCommand", "analyzeCommand"] as const;
type SubstitutionKey = (typeof SUBSTITUTION_KEYS)[number];
const MARKER_RE = /{{[A-Za-z0-9_.-]+}}/g;

export interface ScaffoldFacts {
  stack?: string;
  language?: string;
  testCommand?: string;
  analyzeCommand?: string;
}

export interface WaiScaffoldParams {
  targets: ScaffoldTarget[];
  apply?: boolean;
}

export interface ScaffoldFileResult {
  target: ScaffoldTarget;
  path: string;
  /** preview = proposed only; created = written; skipped = existed (byte-intact). */
  action: "preview" | "created" | "skipped";
  content?: string;
  /** Remaining {{...}} markers after substitution (unknown keys only). */
  unresolvedCount: number;
  /** <FILL ME...> occurrences rendered for recognized-but-unvalued keys. */
  fillMeCount: number;
}

export interface WaiScaffoldResult {
  mode: "preview" | "apply";
  targets: ScaffoldTarget[];
  files: ScaffoldFileResult[];
  created: string[];
  skipped: string[];
  unresolvedTotal: number;
  fillMeTotal: number;
}

export class WaiScaffoldError extends Error {}

/** Package-root anchored template read (cwd-independent). */
function templatePath(entry: TemplateEntry): string {
  return resolve(templateRoot(), entry.template);
}

/** Read-only factual detection: conventions first, then manifests as
 *  fallback/backfill. NEVER executes scripts or calls any model. */
export function detectFacts(cwd: string): ScaffoldFacts {
  let conventionsStack: string | undefined;
  let packageManager: string | undefined;
  let scripts: Record<string, string> | undefined;
  let hasPkgJson = false;
  const hasPubspec = safeExists(join(cwd, "pubspec.yaml"));
  // Flutter evidence is SPECIFIC: a flutter SDK dependency in pubspec (or an
  // explicit Flutter convention). pubspec.yaml alone is only Dart evidence.
  const hasFlutterSdk = readPubspecFlutter(join(cwd, "pubspec.yaml"));
  // READ-ONLY metadata read (no logEvent side effects — a preview must never
  // create or append anything under .pi/).
  try {
    const convPath = getProjectConfigPath(cwd, "yoowai", "conventions.json");
    if (safeExists(convPath)) {
      const conv = JSON.parse(readFileSync(convPath, "utf-8")) as { stack?: unknown };
      if (typeof conv.stack === "string" && conv.stack.trim()) conventionsStack = conv.stack.trim();
    }
  } catch {
    // malformed/missing metadata — manifest evidence still applies
  }
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    if (pkg && typeof pkg === "object" && !Array.isArray(pkg)) {
      hasPkgJson = true;
      packageManager = typeof pkg.packageManager === "string" ? pkg.packageManager : undefined;
      const sc = pkg.scripts;
      if (sc && typeof sc === "object" && !Array.isArray(sc)) scripts = sc as Record<string, string>;
    }
  } catch {
    // no package.json
  }

  const isDart = hasPubspec || (conventionsStack ?? "").toLowerCase().includes("dart");
  // MANIFEST-AUTHORITATIVE sub-type: the canonical SDK dependency is the only
  // Flutter signal when a pubspec exists; a vague conventions keyword (e.g.
  // the word "flutter" in a comment) cannot promote a plain-Dart package.
  const manifestFlutter = hasFlutterSdk;
  const nodeStack = packageManager ? `Node (${packageManager.split("@")[0]?.trim() || packageManager})` : "Node";
  const manifestStack = manifestFlutter ? "Flutter (Dart)" : hasPubspec ? "Dart" : hasPkgJson ? nodeStack : undefined;
  // Symmetric resolution: when a pubspec exists, conventions are preserved
  // ONLY when they explicitly AGREE with the manifest ecosystem (a Flutter
  // term for Flutter manifests; a Dart term without Flutter for plain-Dart
  // manifests). Disagreements ("Node" on a Dart pubspec, "Flutter" without
  // the SDK dep) fall back to the manifest; agreeing richer stacks ("Riverpod
  // + Dart") stay preserved.
  const convMentionsFlutter = /flutter/i.test(conventionsStack ?? "");
  const convMentionsDart = /\bdart\b/i.test(conventionsStack ?? "");
  const agreesWithManifest = manifestFlutter
    ? convMentionsFlutter
    : hasPubspec
      ? convMentionsDart && !convMentionsFlutter
      : true;
  const stack = hasPubspec && !agreesWithManifest ? manifestStack : conventionsStack?.trim() || manifestStack;
  const isDartConvention = /\b(dart|flutter)\b/i.test(conventionsStack ?? "");
  const language =
    isDart || manifestFlutter || isDartConvention
      ? "Dart"
      : /\btypescript\b/i.test(conventionsStack ?? "")
        ? "TypeScript"
        : undefined;

  let testCommand: string | undefined;
  let analyzeCommand: string | undefined;
  if (manifestFlutter) {
    testCommand = "flutter test";
    analyzeCommand = "flutter analyze";
  } else if (isDart) {
    testCommand = "dart test";
    analyzeCommand = "dart analyze";
  } else if (scripts) {
    const firstString = (...candidates: unknown[]): string | undefined => {
      const c = candidates.find((x) => typeof x === "string" && x.trim().length > 0) as string | undefined;
      return c;
    };
    testCommand = firstString(scripts.test, scripts.check, scripts.verify);
    analyzeCommand = firstString(scripts.lint, scripts.analyze, scripts["typecheck"]);
  }
  return {
    stack,
    language,
    testCommand,
    analyzeCommand,
  };
}

/** True when the pubspec declares a Flutter SDK dependency (dir or package). */
function readPubspecFlutter(path: string): boolean {
  try {
    const lines = readFileSync(path, "utf-8").split(/\r?\n/);
    let inDependencies = false;
    let depsIndent = -1;
    let inFlutter = false;
    let flutterIndent = -1;
    let childIndent = -1;
    let flutterChildIndent = -1;
    for (const line of lines) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (!inDependencies) {
        // dependencies must be TOP-LEVEL (indent 0): a nested fake
        // dependencies: under another mapping is not the manifest section.
        // Trailing YAML comments are allowed.
        if (/^dependencies:\s*(#.*)?$/.test(line)) {
          inDependencies = true;
          depsIndent = indent;
          childIndent = -1;
        }
        continue;
      }
      if (indent <= depsIndent) break; // left the dependencies section
      if (childIndent < 0) childIndent = indent; // immediate-child indent
      if (!inFlutter) {
        // flutter must be an IMMEDIATE child of dependencies.
        if (indent === childIndent && /^\s*flutter:\s*(#.*)?$/.test(line)) {
          inFlutter = true;
          flutterIndent = indent;
          flutterChildIndent = -1;
        }
        continue;
      }
      if (indent <= flutterIndent) {
        inFlutter = false; // another sibling key under dependencies
        continue;
      }
      if (flutterChildIndent < 0) flutterChildIndent = indent;
      // sdk: flutter must be an immediate child of the flutter mapping.
      if (indent === flutterChildIndent && /^\s*sdk:\s*flutter\s*(#.*)?$/.test(line)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Test seam: redirect the packaged template root (default: package root). */
let templateRootOverride: string | undefined;
export function setWaiScaffoldTemplateRootForTests(root: string | undefined): void {
  templateRootOverride = root;
}

function templateRoot(): string {
  return templateRootOverride ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function safeExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** Strict {{key}} substitution; unknown keys remain untouched. Returns the
 *  rendered text and how many markers survive. */
export function substitutePlaceholders(
  template: string,
  facts: ScaffoldFacts,
): { text: string; unresolvedCount: number; fillMeCount: number } {
  // ONE pass over the ORIGINAL markers: allowlisted keys with non-empty facts
  // are replaced; everything else is preserved verbatim (no recursive
  // re-substitution of marker-shaped content inside factual values).
  const text = template.replace(MARKER_RE, (marker) => {
    const key = marker.slice(2, -2) as SubstitutionKey;
    if ((SUBSTITUTION_KEYS as readonly string[]).includes(key)) {
      const value = facts[key];
      if (value && value.trim().length > 0) return value;
      // A RECOGNIZED key without evidence renders as an explicit fill marker
      // (never a raw template token) — count it as a fill-me occurrence.
      return `<FILL ME: ${key} — evidence: CI steps or package scripts>`;
    }
    return marker;
  });
  const unresolvedCount = (text.match(MARKER_RE) ?? []).length;
  const fillMeCount = (text.match(/<FILL ME/gi) ?? []).length;
  return { text, unresolvedCount, fillMeCount };
}

/** Containment: destination must live under <cwd>/.pi and never escape via
 *  normalized path or an ancestor symlink. */
function assertContained(cwd: string, destination: string): string {
  const cwdResolved = resolve(cwd);
  const dest = resolve(cwd, destination);
  // Lexical containment via path.relative — filesystem-root cwds are safe
  // (no separator concatenation artifacts) and traversal is rejected.
  const relDest = relative(cwdResolved, dest);
  if (relDest !== "" && (isAbsolute(relDest) || relDest === ".." || relDest.startsWith(`..${sep}`))) {
    throw new WaiScaffoldError(`Destination escapes the project: ${destination}`);
  }
  // Symlink guard against the REAL project root: a legitimate cwd reached
  // through a symlink must not be rejected, but an ancestor symlink that
  // points OUTSIDE the real root must be.
  let realCwd = cwdResolved;
  try {
    realCwd = realpathSync(cwdResolved);
  } catch {
    // cwd not yet resolvable — lexical guard stands.
  }
  let ancestor = dirname(dest);
  while (ancestor !== cwdResolved && ancestor !== realCwd) {
    // Drive the walk with path.relative containment (root-cwd safe — no
    // separator concatenation artifacts, which would bypass the guard on a
    // filesystem-root cwd).
    const relAncestor = relative(cwdResolved, ancestor);
    if (relAncestor === ".." || relAncestor.startsWith(`..${sep}`) || isAbsolute(relAncestor)) break;
    try {
      const realAncestor = realpathSync(ancestor);
      const relReal = relative(realCwd, realAncestor);
      const insideReal =
        relReal === "" || (!isAbsolute(relReal) && relReal !== ".." && !relReal.startsWith(`..${sep}`));
      if (!insideReal) {
        throw new WaiScaffoldError(`Destination ancestor resolves outside the project: ${ancestor}`);
      }
    } catch (err) {
      if (err instanceof WaiScaffoldError) throw err;
      // Missing ancestor is fine — it will be created under the project.
    }
    ancestor = dirname(ancestor);
  }
  return dest;
}

export function runWaiScaffold(cwd: string, params: WaiScaffoldParams): WaiScaffoldResult {
  if (!Array.isArray(params.targets) || params.targets.length === 0) {
    throw new WaiScaffoldError("wai_scaffold: at least one target is required (skill, review, security, test).");
  }
  for (const target of params.targets) {
    if (!SCAFFOLD_TARGETS.includes(target)) {
      throw new WaiScaffoldError(
        `wai_scaffold: unknown target "${String(target)}" — valid: ${SCAFFOLD_TARGETS.join(", ")}.`,
      );
    }
  }
  const apply = params.apply === true;
  const facts = detectFacts(cwd);

  const files: ScaffoldFileResult[] = [];
  const created: string[] = [];
  const skipped: string[] = [];
  let unresolvedTotal = 0;

  // PREFLIGHT: read + render + validate ALL selected templates before any
  // mutation, so a missing template/unsafe destination never leaves a
  // partially-scaffolded project behind.
  const plans = params.targets.map((target) => {
    const entry = TEMPLATE_MAP[target];
    const template = templatePath(entry);
    if (!existsSync(template)) {
      throw new WaiScaffoldError(`wai_scaffold: packaged template missing: ${template}`);
    }
    const raw = readFileSync(template, "utf-8");
    const { text, unresolvedCount, fillMeCount } = substitutePlaceholders(raw, facts);
    const destination = assertContained(cwd, entry.destination);
    return { target, destination, text, unresolvedCount, fillMeCount };
  });
  let fillMeTotal = 0;
  for (const plan of plans) {
    unresolvedTotal += plan.unresolvedCount;
    fillMeTotal += plan.fillMeCount;
  }

  for (const plan of plans) {
    const { target, destination, text, unresolvedCount, fillMeCount } = plan;

    if (!apply) {
      files.push({ target, path: destination, action: "preview", content: text, unresolvedCount, fillMeCount });
      continue;
    }
    try {
      mkdirSync(dirname(destination), { recursive: true });
    } catch (mkdirErr) {
      // A directory-creation failure is never a "skipped file" (e.g. .pi
      // exists as a regular file) — surface it.
      throw new WaiScaffoldError(
        `wai_scaffold: failed to create directory for ${destination}: ${mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr)}`,
      );
    }
    try {
      writeFileSync(destination, text, { encoding: "utf-8", flag: "wx" });
      created.push(destination);
      files.push({ target, path: destination, action: "created", unresolvedCount, fillMeCount });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        skipped.push(destination);
        files.push({ target, path: destination, action: "skipped", unresolvedCount, fillMeCount });
      } else {
        throw new WaiScaffoldError(
          `wai_scaffold: failed to write ${destination}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    mode: apply ? "apply" : "preview",
    targets: [...params.targets],
    files,
    created,
    skipped,
    unresolvedTotal,
    fillMeTotal,
  };
}
