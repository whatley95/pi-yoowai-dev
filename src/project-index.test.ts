import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
