import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildReviewEvidencePack } from "./evidence-pack.js";
import { estimateTokens } from "../token-budget.js";
import { buildProjectIndex, saveProjectIndex } from "../project-index.js";

function initGit(cwd: string): void {
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "t@t.t"], { cwd });
  execFileSync("git", ["config", "user.name", "t"], { cwd });
}

describe("buildReviewEvidencePack", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "evidence-pack-"));
    initGit(cwd);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("disabled at budget 0: no entries, no repo reads needed", () => {
    const result = buildReviewEvidencePack(cwd, { budgetTokens: 0, changedFiles: ["a.ts"] });
    assert.deepEqual(result.entries, []);
    assert.equal(result.text, "");
    assert.equal(result.truncated, false);
  });

  it("includes symbol lines and dependent import sites from the index", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "api.ts"), "export function getToken(): string { return 't'; }\n", "utf-8");
    writeFileSync(
      join(cwd, "src", "auth.ts"),
      "import { getToken } from './api';\nexport const token = getToken();\n",
      "utf-8",
    );
    saveProjectIndex(cwd, buildProjectIndex(cwd));

    const result = buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["src/api.ts"] });
    const symbols = result.entries.filter((e) => e.kind === "symbol" && e.file === "src/api.ts");
    assert.ok(
      symbols.some((e) => /getToken/.test(e.text)),
      "symbol line present",
    );
    const sites = result.entries.filter((e) => e.kind === "import-site");
    assert.ok(
      sites.some((e) => e.file === "src/auth.ts" && e.line !== undefined),
      "dependent AST import site present",
    );
    assert.ok(result.text.includes("<evidence_pack>"), "rendered block");
  });

  it("finds co-located and importing test files (tracked only)", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "auth.dart"), "class Auth {}\n", "utf-8");
    // co-located test
    writeFileSync(join(cwd, "src", "auth_test.dart"), "void main() {}\n", "utf-8");
    // importing test elsewhere
    mkdirSync(join(cwd, "test"), { recursive: true });
    writeFileSync(join(cwd, "test", "auth_test.dart"), "import '../src/auth.dart';\n", "utf-8");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", ".gitignore"), "", "utf-8");
    execFileSync("git", ["add", "-A"], { cwd });

    const result = buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["src/auth.dart"] });
    const tests = result.entries.filter((e) => e.kind === "test");
    assert.ok(
      tests.some((e) => e.file === "src/auth_test.dart"),
      "co-located test discovered",
    );
    assert.ok(
      tests.some((e) => e.file === "test/auth_test.dart"),
      "importing test discovered",
    );
  });

  it("flags contract candidates by filename heuristics near changed files", () => {
    mkdirSync(join(cwd, "api"), { recursive: true });
    writeFileSync(join(cwd, "api", "dto.dart"), "class UserDto {}\n", "utf-8");
    writeFileSync(join(cwd, "api", "route_handler.dart"), "void route() {}\n", "utf-8");
    writeFileSync(join(cwd, "api", "keep.txt"), "no\n", "utf-8");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", ".gitignore"), ".pi/\n", "utf-8");
    execFileSync("git", ["add", "-A"], { cwd });

    const result = buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["api/dto.dart"] });
    const contracts = result.entries.filter((e) => e.kind === "contract");
    assert.ok(
      contracts.some((e) => e.file.includes("route_handler")),
      "route candidate found",
    );
    assert.ok(!contracts.some((e) => e.file.endsWith("keep.txt")), "non-contract ext excluded");
  });

  it("notes when no contract candidates are found", () => {
    writeFileSync(join(cwd, "a.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd });
    const result = buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["a.txt"] });
    assert.ok(
      result.notes.some((n) => /no contract candidates/.test(n)),
      "no-pair note present",
    );
  });

  it("truncates at a tiny budget, reports notes, and never throws without an index", () => {
    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd });
    const tiny = buildReviewEvidencePack(cwd, { budgetTokens: 5, changedFiles: ["a.ts"] });
    assert.ok(
      tiny.notes.some((n) => /budget hit|dropped/.test(n) || /no index/i.test(n)),
      "truncation note",
    );
    assert.ok(tiny.truncated || tiny.entries.length === 0);
    // No index at all → no throw.
    assert.doesNotThrow(() => buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["missing.ts"] }));
  });

  it("non-TS repo degrades gracefully (no index → file-based notes only)", () => {
    writeFileSync(join(cwd, "main.dart"), "void main() {}\n");
    execFileSync("git", ["add", "-A"], { cwd });
    const result = buildReviewEvidencePack(cwd, { budgetTokens: 2000, changedFiles: ["main.dart"] });
    assert.ok(
      result.notes.some((n) => /no index|skipped/i.test(n)),
      "graceful note for missing index",
    );
  });
});

describe("read-only + budget guarantees", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "evidence-pack-ro-"));
    initGit(cwd);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("quiet import-site path: a VALID seeded index plus pack collection changes nothing", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "api.ts"), "export function getToken(): string { return 't'; }\n", "utf-8");
    writeFileSync(
      join(cwd, "src", "auth.ts"),
      "import { getToken } from './api';\nexport const token = getToken();\n",
      "utf-8",
    );
    saveProjectIndex(cwd, buildProjectIndex(cwd));
    execFileSync("git", ["add", "-A"], { cwd });
    const before = snapshotBytes(cwd);
    // This exercises the quiet loader + quiet findImportSite path end-to-end
    // (success branch); the snapshot proves no write happens anywhere.
    const result = buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["src/api.ts"] });
    assert.ok(
      result.entries.some((e) => e.kind === "import-site"),
      "quiet import-site path produced evidence",
    );
    assert.deepEqual(snapshotBytes(cwd), before, "no write with a valid index + import-site evidence");
  });

  it("never creates or modifies ANY file during collection (content-hash snapshot)", () => {
    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n", "utf-8");
    // Seed an existing index so modification (not just creation) is detected.
    mkdirSync(join(cwd, ".pi", "yoowai"), { recursive: true });
    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n", "utf-8");
    writeFileSync(join(cwd, ".pi", "yoowai", "index.json"), '{"seeded":true}\n', "utf-8");
    execFileSync("git", ["add", "-A"], { cwd });
    const before = snapshotBytes(cwd);
    buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["a.ts"] });
    const after = snapshotBytes(cwd);
    assert.deepEqual(after, before, "no file created, deleted, or modified (content-level)");
  });

  it("the rendered pack stays within its token budget", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "big.dart"), "class Big {}\n");
    writeFileSync(join(cwd, "src", "big_test.dart"), "void main() {}\n");
    execFileSync("git", ["add", "-A"], { cwd });
    const budget = 40;
    const result = buildReviewEvidencePack(cwd, { budgetTokens: budget, changedFiles: ["src/big.dart"] });
    assert.ok(
      estimateTokens(result.text) <= budget,
      `rendered pack within budget (${estimateTokens(result.text)} <= ${budget})`,
    );
  });

  it("boundary budgets: exact-size pack accepted, one-token-short drops", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "z.dart"), "export const z = 1;\n");
    writeFileSync(join(cwd, "src", "z_test.dart"), "void main() {}\n");
    execFileSync("git", ["add", "-A"], { cwd });
    const full = buildReviewEvidencePack(cwd, { budgetTokens: 100000, changedFiles: ["src/z.dart"] });
    const exact = estimateTokens(full.text);
    const accepted = buildReviewEvidencePack(cwd, { budgetTokens: exact, changedFiles: ["src/z.dart"] });
    assert.equal(estimateTokens(accepted.text), exact, "exact-size budget accepts the pack");
    const drop = buildReviewEvidencePack(cwd, { budgetTokens: exact - 1, changedFiles: ["src/z.dart"] });
    assert.ok(estimateTokens(drop.text) <= exact - 1, "one-token-short budget drops (block stays within)");
  });

  it("duplicate basenames in different directories resolve to the exact import target", () => {
    mkdirSync(join(cwd, "src", "a"), { recursive: true });
    mkdirSync(join(cwd, "src", "b"), { recursive: true });
    mkdirSync(join(cwd, "test"), { recursive: true });
    writeFileSync(join(cwd, "src", "a", "foo.dart"), "class FooA {}\n", "utf-8");
    writeFileSync(join(cwd, "src", "b", "foo.dart"), "class FooB {}\n", "utf-8");
    // The test imports ONLY src/a/foo.dart.
    writeFileSync(join(cwd, "test", "foo_test.dart"), "import '../src/a/foo.dart';\nvoid main() {}\n", "utf-8");
    execFileSync("git", ["add", "-A"], { cwd });

    const forA = buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["src/a/foo.dart"] });
    const forB = buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["src/b/foo.dart"] });
    assert.ok(
      forA.entries.some((e) => e.kind === "test" && e.file === "test/foo_test.dart"),
      "the test importing src/a/foo.dart matches for src/a/foo.dart",
    );
    assert.ok(
      !forB.entries.some((e) => e.kind === "test" && e.file === "test/foo_test.dart"),
      "the same test must NOT match for the sibling src/b/foo.dart",
    );
    // Package imports never establish pairs.
    mkdirSync(join(cwd, "test2"), { recursive: true });
    writeFileSync(join(cwd, "test2", "bar_test.dart"), "import 'package:other/foo.dart';\nvoid main() {}\n", "utf-8");
    execFileSync("git", ["add", "-A"], { cwd });
    const forA2 = buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["src/a/foo.dart"] });
    assert.ok(
      !forA2.entries.some((e) => e.kind === "test" && e.file === "test2/bar_test.dart"),
      "package imports must not establish project pairs",
    );
  });

  it("comments and plain strings do not classify a file as importing (syntax-constrained)", () => {
    mkdirSync(join(cwd, "lib"), { recursive: true });
    mkdirSync(join(cwd, "test"), { recursive: true });
    writeFileSync(join(cwd, "lib", "auth.dart"), "class Auth {}\n", "utf-8");
    // Non-co-located test whose ONLY references are a comment and a plain string.
    writeFileSync(
      join(cwd, "test", "auth_test.dart"),
      "void main() {}\n// import '../lib/auth.dart';\nconst s = 'auth.dart';\n",
      "utf-8",
    );
    execFileSync("git", ["add", "-A"], { cwd });
    const result = buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["lib/auth.dart"] });
    const tests = result.entries.filter((e) => e.kind === "test");
    assert.ok(!tests.some((e) => e.file === "test/auth_test.dart"), "comment/string-only test must not qualify");
  });

  it("entries carry typed metadata (startLine/source/side)", () => {
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "api.ts"), "export function getToken(): string { return 't'; }\n", "utf-8");
    saveProjectIndex(cwd, buildProjectIndex(cwd));
    const result = buildReviewEvidencePack(cwd, { budgetTokens: 4000, changedFiles: ["src/api.ts"] });
    for (const e of result.entries) {
      assert.equal(typeof e.startLine, "number");
      assert.equal(typeof e.endLine, "number");
      assert.ok(e.source === "index" || e.source === "file-list");
      assert.ok(e.side === "current" || e.side === "unknown");
    }
  });
});

function snapshotBytes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      // .git internals are plumbing, not project state — excluded.
      if (r === ".git" || r.startsWith(".git/")) continue;
      if (statSync(p).isDirectory()) walk(p, r);
      else out[r] = readFileSync(p, "utf8");
    }
  };
  walk(dir, "");
  return out;
}
