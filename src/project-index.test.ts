import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildProjectIndex, loadProjectIndex, saveProjectIndex } from "./project-index.js";

/** git availability, detected once at module load. */
function detectGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
const hasGit = detectGit();

// Isolate spawned git processes from the contributor's global/system config
// (gpgsign, core.excludesFile, core.hooksPath, XDG default excludes) so the
// tests behave the same on every machine. Uses an EMPTY temp config file
// rather than the null device: on Windows, GIT_CONFIG_GLOBAL=NUL makes git
// fail with "unable to access '//./nul'" (the device path is only translated
// by MSYS). git treats a missing GIT_CONFIG_GLOBAL file as no global config,
// so even if the write fails the isolation only gets stronger.
const emptyGitConfig = join(tmpdir(), `wai-empty-git-config-${process.pid}.cfg`);
const emptyXdgDir = join(tmpdir(), `wai-empty-xdg-${process.pid}`);
try {
  writeFileSync(emptyGitConfig, "", "utf-8");
  mkdirSync(emptyXdgDir, { recursive: true });
} catch {
  // best-effort; see the comment above
}
process.on("exit", () => {
  try {
    rmSync(emptyGitConfig, { force: true });
    rmSync(emptyXdgDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});
const gitEnv: Record<string, string | undefined> = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  XDG_CONFIG_HOME: emptyXdgDir,
};
// Ambient GIT_* variables from the test runner's own environment (e.g. when
// CI runs inside a git hook, git exports GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE,
// and GIT_CONFIG_PARAMETERS can re-inject core.excludesFile) would redirect
// the spawned processes at the real repo and bypass the isolation above.
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"]) {
  delete gitEnv[key];
}
const GIT_OPTS = { stdio: "pipe" as const, env: gitEnv };

/** git init + local identity config, shared by the git-based tests. */
function initGitRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, ...GIT_OPTS });
  execFileSync("git", ["config", "user.email", "wai-test@example.com"], { cwd: dir, ...GIT_OPTS });
  execFileSync("git", ["config", "user.name", "wai test"], { cwd: dir, ...GIT_OPTS });
}

/** commit with signing disabled, shared by the git-based tests. */
function gitCommit(dir: string): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: dir, ...GIT_OPTS });
}

describe("project-index", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-index-test-"));
  });

  it("indexes TypeScript source files", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "utils.ts"),
      `
export function greet(name: string): string {
  return \`Hello, \${name}\`;
}

class Helper {
  run() {}
}

export interface Config {
  debug: boolean;
}
`,
      "utf-8",
    );

    const index = buildProjectIndex(cwd);
    assert.ok(index.files.length > 0, "should index at least one file");
    const file = index.files.find((f) => f.file === "src/utils.ts");
    assert.ok(file, "should include src/utils.ts");

    const names = file.symbols.map((s) => s.name);
    assert.ok(names.includes("greet"), "should include greet function");
    assert.ok(names.includes("Helper"), "should include Helper class");
    assert.ok(names.includes("Config"), "should include Config interface");

    const greet = file.symbols.find((s) => s.name === "greet");
    assert.equal(greet?.kind, "function");
    assert.equal(greet?.exported, true);
    assert.ok(greet?.line && greet.line > 0);
  });

  it("indexes import edges and reverse dependents", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "api.ts"), "export function getToken(): string { return 't'; }", "utf-8");
    writeFileSync(
      join(cwd, "src", "auth.ts"),
      "import { getToken } from './api';\nexport const authed = getToken();",
      "utf-8",
    );
    writeFileSync(
      join(cwd, "src", "dashboard.ts"),
      "import { getToken } from './api.js';\nexport const d = getToken();",
      "utf-8",
    );

    const index = buildProjectIndex(cwd);
    const api = index.files.find((f) => f.file === "src/api.ts");
    const auth = index.files.find((f) => f.file === "src/auth.ts");
    const dashboard = index.files.find((f) => f.file === "src/dashboard.ts");
    assert.ok(api && auth && dashboard);

    // Literal imports are preserved, deduped, sorted.
    assert.deepEqual(auth.imports, ["./api"]);
    assert.deepEqual(dashboard.imports, ["./api.js"]);
    // Reverse dependents resolved to project files (including the .js → .ts
    // convention used by dashboard.ts).
    assert.deepEqual(api.dependents, ["src/auth.ts", "src/dashboard.ts"]);
    // Package imports (non-relative) never become project dependents.
    writeFileSync(join(cwd, "src", "vendor.ts"), "import { z } from 'zod';\nexport const v = z;\n", "utf-8");
    const index2 = buildProjectIndex(cwd);
    const vendor = index2.files.find((f) => f.file === "src/vendor.ts");
    assert.deepEqual(vendor?.imports, ["zod"]);
    // The rebuild preserves api.ts's reverse dependents.
    assert.deepEqual(index2.files.find((f) => f.file === "src/api.ts")?.dependents, [
      "src/auth.ts",
      "src/dashboard.ts",
    ]);
  });

  it("refreshes reverse edges on edit/add/delete and reuses unchanged entries", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "b.ts"), "export const b = 2;", "utf-8");
    const first = buildProjectIndex(cwd);
    const reused = first.stats?.reused ?? 0;

    // c.ts imports both; rebuild → both gain c as a dependent, unchanged
    // entries stay reused.
    writeFileSync(
      join(cwd, "src", "c.ts"),
      "import { a } from './a';\nimport { b } from './b';\nexport const c = a + b;",
      "utf-8",
    );
    const second = buildProjectIndex(cwd);
    const a2 = second.files.find((f) => f.file === "src/a.ts");
    const b2 = second.files.find((f) => f.file === "src/b.ts");
    assert.deepEqual(a2?.dependents, ["src/c.ts"]);
    assert.deepEqual(b2?.dependents, ["src/c.ts"]);
    assert.ok((second.stats?.reused ?? 0) >= reused, "unchanged files must be reused");

    // Deleting b.ts removes the reverse edge.
    rmSync(join(cwd, "src", "b.ts"));
    const third = buildProjectIndex(cwd);
    assert.ok(!third.files.some((f) => f.file === "src/b.ts"));
    const a3 = third.files.find((f) => f.file === "src/a.ts");
    assert.deepEqual(a3?.dependents, ["src/c.ts"]);
  });

  it("clears stale reverse edges when the sole importer is deleted", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "b.ts"), "import { a } from './a';\nexport const b = a;", "utf-8");
    const first = buildProjectIndex(cwd);
    assert.deepEqual(first.files.find((f) => f.file === "src/a.ts")?.dependents, ["src/b.ts"]);

    // Delete the only importer; a.ts keeps its cached entry (unchanged on
    // disk) but its dependents must be cleared on the rebuild.
    rmSync(join(cwd, "src", "b.ts"));
    const second = buildProjectIndex(cwd);
    assert.ok(!second.files.some((f) => f.file === "src/b.ts"));
    const a = second.files.find((f) => f.file === "src/a.ts");
    assert.equal(a?.dependents?.length ?? 0, 0, "stale dependents must be cleared");
  });

  it("does not create edges for imports escaping the project root", () => {
    mkdirSync(join(cwd, "src", "sub"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "sub", "x.ts"), "import { a } from '../../target';\nexport const x = a;", "utf-8");
    // No root-level target.ts exists — but even so, normalization must not
    // map '../../target' to a project file via dropped '..' segments.
    const index = buildProjectIndex(cwd);
    const a = index.files.find((f) => f.file === "src/a.ts");
    assert.equal(a?.dependents?.length ?? 0, 0);
  });

  it("resolves directory imports to index.tsx/index.jsx", () => {
    mkdirSync(join(cwd, "src", "widgets"), { recursive: true });
    writeFileSync(join(cwd, "src", "widgets", "index.tsx"), "export const w = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "main.tsx"), "import { w } from './widgets';\nvoid w;", "utf-8");
    const index = buildProjectIndex(cwd);
    const w = index.files.find((f) => f.file === "src/widgets/index.tsx");
    assert.deepEqual(w?.dependents, ["src/main.tsx"]);
  });

  it("resolves a root-level index via './'-style imports", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "index.ts"), "export const root = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "main.ts"), "import { root } from '../';\nvoid root;", "utf-8");
    const index = buildProjectIndex(cwd);
    const root = index.files.find((f) => f.file === "index.ts");
    assert.deepEqual(root?.dependents, ["src/main.ts"]);
  });

  it("collects static require() imports from .js/.cjs files", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "legacy.js"), "module.exports = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "main.cjs"), "const { x } = require('./legacy.js');\nmodule.exports = x;", "utf-8");
    const index = buildProjectIndex(cwd);
    const legacy = index.files.find((f) => f.file === "src/legacy.js");
    const main = index.files.find((f) => f.file === "src/main.cjs");
    assert.deepEqual(main?.imports, ["./legacy.js"]);
    assert.deepEqual(legacy?.dependents, ["src/main.cjs"]);
  });

  it("keeps explicit .ts specifiers exact (no fallback to .js)", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "dep.js"), "module.exports = 1;", "utf-8");
    // dep.ts does NOT exist; an explicit './dep.ts' import must not create a
    // false edge to dep.js.
    writeFileSync(join(cwd, "src", "main.ts"), "import x from './dep.ts';\nvoid x;", "utf-8");
    const index = buildProjectIndex(cwd);
    const dep = index.files.find((f) => f.file === "src/dep.js");
    assert.equal(dep?.dependents?.length ?? 0, 0, "explicit .ts specifiers must not resolve to .js");
  });

  it("collects import-equals require() declarations", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "legacy.ts"), "export const legacy = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "main.ts"), "import legacy = require('./legacy');\nvoid legacy;", "utf-8");
    const index = buildProjectIndex(cwd);
    const main = index.files.find((f) => f.file === "src/main.ts");
    const legacy = index.files.find((f) => f.file === "src/legacy.ts");
    assert.deepEqual(main?.imports, ["./legacy"]);
    assert.deepEqual(legacy?.dependents, ["src/main.ts"]);
  });

  it("rejects malformed imported dependency entries in persisted indexes", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;", "utf-8");
    const index = buildProjectIndex(cwd);
    saveProjectIndex(cwd, index);
    // Corrupt the persisted index: an imports field that is not a string array.
    const path = join(cwd, ".pi", "yoowai", "index.json");
    const saved = JSON.parse(readFileSync(path, "utf-8"));
    saved.files[0].imports = { bad: true };
    writeFileSync(path, JSON.stringify(saved), "utf-8");
    const loaded = loadProjectIndex(cwd);
    assert.equal(loaded, null, "malformed imports must fail validation, not throw");
  });

  it("resolves to .d.ts declaration files", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "types.d.ts"), "export type X = string;", "utf-8");
    writeFileSync(join(cwd, "src", "types.js"), "module.exports = {};", "utf-8");
    writeFileSync(
      join(cwd, "src", "main.ts"),
      "import type { X } from './types';\nconst x: X = 'a';\nvoid x;",
      "utf-8",
    );
    const index = buildProjectIndex(cwd);
    const types = index.files.find((f) => f.file === "src/types.d.ts");
    assert.deepEqual(types?.dependents, ["src/main.ts"], "extensionless imports must prefer the .d.ts declaration");
  });

  it("prefers index.ts over index.js for directory imports", () => {
    mkdirSync(join(cwd, "src", "components"), { recursive: true });
    writeFileSync(join(cwd, "src", "components", "index.ts"), "export const c = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "components", "index.js"), "module.exports = {};", "utf-8");
    writeFileSync(join(cwd, "src", "main.ts"), "import { c } from './components';\nvoid c;", "utf-8");
    const index = buildProjectIndex(cwd);
    const ts = index.files.find((f) => f.file === "src/components/index.ts");
    const js = index.files.find((f) => f.file === "src/components/index.js");
    assert.deepEqual(ts?.dependents, ["src/main.ts"]);
    assert.equal(js?.dependents?.length ?? 0, 0, "the TypeScript index file must win the collision");
  });

  it("prefers the TypeScript source for './dep.js' imports (NodeNext convention)", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "dep.ts"), "export const d = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "dep.js"), "module.exports = {};", "utf-8");
    writeFileSync(join(cwd, "src", "main.ts"), "import { d } from './dep.js';\nvoid d;", "utf-8");
    const index = buildProjectIndex(cwd);
    const ts = index.files.find((f) => f.file === "src/dep.ts");
    const js = index.files.find((f) => f.file === "src/dep.js");
    assert.deepEqual(ts?.dependents, ["src/main.ts"], "the TS source must win the .js-specifier collision");
    assert.equal(js?.dependents?.length ?? 0, 0);
  });

  it("maps '.jsx' specifiers to the TSX source only", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "dep.ts"), "export const d = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "dep.tsx"), "export const x = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "main.ts"), "import { x } from './dep.jsx';\nvoid x;", "utf-8");
    const index = buildProjectIndex(cwd);
    const tsx = index.files.find((f) => f.file === "src/dep.tsx");
    const ts = index.files.find((f) => f.file === "src/dep.ts");
    assert.deepEqual(tsx?.dependents, ["src/main.ts"], "'.jsx' must resolve to the .tsx source");
    assert.equal(ts?.dependents?.length ?? 0, 0);
  });

  it("keeps other explicit extensions (.mjs/.cjs) exact-only", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "dep.mjs.ts"), "export const d = 1;", "utf-8");
    // dep.mjs does NOT exist; './dep.mjs' must not fall back to dep.mjs.ts.
    writeFileSync(join(cwd, "src", "main.ts"), "import { d } from './dep.mjs';\nvoid d;", "utf-8");
    const index = buildProjectIndex(cwd);
    const fake = index.files.find((f) => f.file === "src/dep.mjs.ts");
    assert.equal(fake?.dependents?.length ?? 0, 0, "other explicit extensions must be exact-only");
  });

  it("rebuilds legacy entries that lack import edges", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "b.ts"), "import { a } from './a';\nexport const b = a;", "utf-8");
    const index = buildProjectIndex(cwd);
    // Simulate a legacy entry: same content, no imports field.
    for (const f of index.files) {
      delete (f as { imports?: string[] }).imports;
    }
    // Rebuild with the (mtime/size-equal) legacy entries present.
    const rebuilt = buildProjectIndex(cwd);
    const a = rebuilt.files.find((f) => f.file === "src/a.ts");
    // The legacy cache guard re-parses entries missing the imports field.
    assert.deepEqual(a?.dependents, ["src/b.ts"]);
  });

  it("save and load round-trips the index", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const x = 1;", "utf-8");

    const index = buildProjectIndex(cwd);
    saveProjectIndex(cwd, index);

    assert.ok(existsSync(join(cwd, ".pi", "yoowai", "index.json")), "index file should be saved");
    const loaded = loadProjectIndex(cwd);
    assert.deepEqual(loaded, index);
  });

  it("returns null when no index exists", () => {
    const loaded = loadProjectIndex(cwd);
    assert.equal(loaded, null);
  });

  it("rejects a persisted index that scanned files but indexed none (built without TypeScript)", () => {
    mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
    const emptyIndex = {
      generatedAt: new Date().toISOString(),
      files: [],
      stats: { scanned: 141, indexed: 0, skipped: 141, symbols: 0, tsUnavailable: true },
    };
    writeFileSync(join(cwd, ".pi", "yoowai", "index.json"), JSON.stringify(emptyIndex), "utf-8");

    assert.equal(loadProjectIndex(cwd), null);
  });

  it("keeps a legitimately empty index (all files skipped) instead of rebuilding every load", () => {
    mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
    const emptyIndex = {
      generatedAt: new Date().toISOString(),
      files: [],
      stats: { scanned: 141, indexed: 0, skipped: 141, symbols: 0 },
    };
    writeFileSync(join(cwd, ".pi", "yoowai", "index.json"), JSON.stringify(emptyIndex), "utf-8");

    const loaded = loadProjectIndex(cwd);
    assert.ok(loaded);
    assert.equal(loaded?.stats?.indexed, 0);
    assert.equal(loaded?.stats?.tsUnavailable, undefined);
  });

  it("ignores unsupported and generated files", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "main.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "style.css"), ".a {}", "utf-8");
    writeFileSync(join(cwd, "src", "data.json"), "{}", "utf-8");

    const index = buildProjectIndex(cwd);
    const files = index.files.map((f) => f.file);
    assert.ok(files.includes("src/main.ts"));
    assert.ok(!files.includes("src/style.css"));
    assert.ok(!files.includes("src/data.json"));
  });

  it("reports index stats", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "b.ts"), "export const b = 2;", "utf-8");

    const index = buildProjectIndex(cwd);
    assert.ok(index.stats);
    assert.equal(index.stats?.scanned, 2);
    assert.equal(index.stats?.indexed, 2);
    assert.equal(index.stats?.symbols, 2);
    assert.equal(index.stats?.skipped, 0);
  });

  it("includes untracked indexable files when git is available", { skip: !hasGit }, () => {
    initGitRepo(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "tracked.ts"), "export const tracked = 1;\n", "utf-8");
    execFileSync("git", ["add", "src/tracked.ts"], { cwd, ...GIT_OPTS });
    gitCommit(cwd);

    // New file, NOT staged — the create→review flow.
    writeFileSync(join(cwd, "src", "untracked.ts"), "export const untracked = 2;\n", "utf-8");

    const index = buildProjectIndex(cwd);
    const files = index.files.map((f) => f.file);
    assert.ok(files.includes("src/tracked.ts"));
    assert.ok(files.includes("src/untracked.ts"), "untracked indexable files must be indexed");
  });

  it("indexes untracked files when cwd is a subdirectory of a git repo", { skip: !hasGit }, () => {
    const repoRoot = join(cwd, "repo");
    mkdirSync(join(repoRoot, "src"), { recursive: true });
    initGitRepo(repoRoot);
    writeFileSync(join(repoRoot, "src", "tracked.ts"), "export const tracked = 1;\n", "utf-8");
    execFileSync("git", ["add", "src/tracked.ts"], { cwd: repoRoot, ...GIT_OPTS });
    gitCommit(repoRoot);

    // cwd is a subdirectory: no .git entry at cwd, but git still works.
    const subCwd = join(repoRoot, "src");
    writeFileSync(join(subCwd, "untracked.ts"), "export const untracked = 2;\n", "utf-8");

    const index = buildProjectIndex(subCwd);
    const files = index.files.map((f) => f.file);
    assert.ok(files.includes("tracked.ts"), "tracked file listed cwd-relative from a subdirectory");
    assert.ok(files.includes("untracked.ts"), "untracked file indexed from a repo subdirectory");
  });

  it("never leaks non-indexable tracked files into the index", { skip: !hasGit }, () => {
    initGitRepo(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "app.ts"), "export const app = 1;\n", "utf-8");
    writeFileSync(join(cwd, "src", "styles.css"), ".a { color: red }\n", "utf-8");
    writeFileSync(join(cwd, "README.md"), "# readme\n", "utf-8");
    execFileSync("git", ["add", "src/app.ts", "src/styles.css", "README.md"], { cwd, ...GIT_OPTS });
    gitCommit(cwd);
    // An untracked non-indexable file exercises the untracked branch's filter.
    writeFileSync(join(cwd, "src", "notes.md"), "# notes\n", "utf-8");

    const index = buildProjectIndex(cwd);
    const files = index.files.map((f) => f.file);
    assert.deepEqual(files, ["src/app.ts"], "only indexable files may enter the index");
  });

  it("reuses unchanged files from existing index", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;", "utf-8");
    writeFileSync(join(cwd, "src", "b.ts"), "export const b = 2;", "utf-8");

    const first = buildProjectIndex(cwd);
    saveProjectIndex(cwd, first);

    // Modify only one file.
    writeFileSync(join(cwd, "src", "b.ts"), "export const b = 3;", "utf-8");

    const second = buildProjectIndex(cwd);
    assert.equal(second.stats?.reused, 1);
    assert.equal(second.files.length, 2);
    const a = second.files.find((f) => f.file === "src/a.ts");
    assert.equal(a?.symbols[0]?.name, "a");
    const b = second.files.find((f) => f.file === "src/b.ts");
    assert.equal(b?.symbols[0]?.name, "b");
  });

  it("cleans up temp dir", () => {
    rmSync(cwd, { recursive: true, force: true });
  });
});
