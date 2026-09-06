import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCAFFOLD_TARGETS,
  WaiScaffoldError,
  detectFacts,
  runWaiScaffold,
  setWaiScaffoldTemplateRootForTests,
  substitutePlaceholders,
} from "./wai-scaffold.js";
import { saveConventions } from "./conventions.js";

/** Snapshot a directory tree (relative paths + bytes) for byte-compare. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (existsSync(p)) {
        try {
          const st = statSync(p);
          if (st.isDirectory()) {
            out[`${r}/`] = ""; // directory entries recorded too
            walk(p, r);
          } else {
            out[r] = readFileSync(p, "utf8");
          }
        } catch {
          out[r] = "<unreadable>";
        }
      }
    }
  };
  walk(dir, "");
  return out;
}

describe("detectFacts", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-scaffold-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("detects Flutter from a canonical SDK dependency and Dart conventions", () => {
    writeFileSync(join(cwd, "pubspec.yaml"), "name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf-8");
    const facts = detectFacts(cwd);
    assert.equal(facts.stack, "Flutter (Dart)");
    assert.equal(facts.language, "Dart");
    assert.equal(facts.testCommand, "flutter test");
    assert.equal(facts.analyzeCommand, "flutter analyze");
  });

  it("detects Node from package.json scripts and expresses packageManager", () => {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "demo", packageManager: "pnpm", scripts: { test: "vitest run", lint: "eslint ." } }),
      "utf-8",
    );
    const facts = detectFacts(cwd);
    assert.equal(facts.stack, "Node (pnpm)");
    assert.equal(facts.testCommand, "vitest run");
    assert.equal(facts.analyzeCommand, "eslint .");
  });

  it("commented or unrelated flutter text must NOT classify as Flutter", () => {
    writeFileSync(
      join(cwd, "pubspec.yaml"),
      "# flutter: sdk\nname: pure_dart\ndependencies:\n  # flutter: sdk\n  http: ^1.0.0\ndev_dependencies:\n  lints: ^4.0.0\n",
      "utf-8",
    );
    const facts = detectFacts(cwd);
    assert.equal(facts.stack, "Dart", "commented flutter text must stay Dart");
    assert.equal(facts.testCommand, "dart test");
  });

  it("a conventions stack mentioning Flutter cannot promote a plain pubspec (manifest-authoritative)", () => {
    writeFileSync(join(cwd, "pubspec.yaml"), "name: plain_dart\ndependencies:\n  http: ^1.0.0\n", "utf-8");
    const conventionsDir = join(cwd, ".pi", "yoowai");
    mkdirSync(conventionsDir, { recursive: true });
    writeFileSync(
      join(conventionsDir, "conventions.json"),
      JSON.stringify({
        stack: "Flutter mentioned in a comment",
        naming: "camelCase",
        structure: "lib/",
        patterns: [],
        entryPoints: [],
        scripts: [],
        generatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const facts = detectFacts(cwd);
    assert.equal(facts.stack, "Dart", "manifest evidence wins over a keywords-match convention");
    assert.equal(facts.testCommand, "dart test");
    assert.equal(facts.analyzeCommand, "dart analyze");
  });

  it("shorthand 'flutter: sdk' (non-canonical, non-nested) is NOT Flutter", () => {
    writeFileSync(join(cwd, "pubspec.yaml"), "name: demo\ndependencies:\n  flutter: sdk\n", "utf-8");
    const facts = detectFacts(cwd);
    assert.equal(facts.stack, "Dart");
    assert.equal(facts.testCommand, "dart test");
  });

  it("a plain Dart pubspec plus a Node conventions stack falls back to the manifest", () => {
    writeFileSync(join(cwd, "pubspec.yaml"), "name: plain\ndependencies:\n  http: ^1.0.0\n", "utf-8");
    const dir = join(cwd, ".pi", "yoowai");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "conventions.json"),
      JSON.stringify({
        stack: "Node",
        naming: "camelCase",
        structure: "lib/",
        patterns: [],
        entryPoints: [],
        scripts: [],
        generatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const facts = detectFacts(cwd);
    assert.equal(facts.stack, "Dart", "Node conventions disagree with a Dart pubspec");
    assert.equal(facts.testCommand, "dart test");
  });

  it("trailing YAML comments on the canonical shape still classify as Flutter", () => {
    writeFileSync(
      join(cwd, "pubspec.yaml"),
      "name: app # the app\ndependencies: # main section\n  flutter: # framework\n    sdk: flutter # bundled SDK\n",
      "utf-8",
    );
    const facts = detectFacts(cwd);
    assert.equal(facts.stack, "Flutter (Dart)");
    assert.equal(facts.testCommand, "flutter test");
  });

  it("a canonical Flutter pubspec wins a conflicting non-Flutter conventions stack", () => {
    writeFileSync(join(cwd, "pubspec.yaml"), "name: app\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf-8");
    const conventionsDir = join(cwd, ".pi", "yoowai");
    mkdirSync(conventionsDir, { recursive: true });
    writeFileSync(
      join(conventionsDir, "conventions.json"),
      JSON.stringify({
        stack: "Node",
        naming: "camelCase",
        structure: "lib/",
        patterns: [],
        entryPoints: [],
        scripts: [],
        generatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const facts = detectFacts(cwd);
    assert.equal(facts.stack, "Flutter (Dart)", "manifest Flutter beats a contradicting convention");
    assert.equal(facts.testCommand, "flutter test");
  });

  it("an explicit Flutter conventions stack (no pubspec) implies Dart language without Flutter commands", () => {
    const conventionsDir = join(cwd, ".pi", "yoowai");
    mkdirSync(conventionsDir, { recursive: true });
    writeFileSync(
      join(conventionsDir, "conventions.json"),
      JSON.stringify({
        stack: "Flutter",
        naming: "camelCase",
        structure: "lib/",
        patterns: [],
        entryPoints: [],
        scripts: [],
        generatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const facts = detectFacts(cwd);
    assert.equal(facts.language, "Dart", "Flutter implies Dart");
    assert.equal(facts.testCommand, undefined, "no test command without any manifest");
    assert.equal(facts.analyzeCommand, undefined, "no analyze command without any manifest");
  });

  it("'Prototype-based JavaScript' conventions text is not TypeScript", () => {
    const conventionsDir = join(cwd, ".pi", "yoowai");
    mkdirSync(conventionsDir, { recursive: true });
    writeFileSync(
      join(conventionsDir, "conventions.json"),
      JSON.stringify({
        stack: "Prototype-based JavaScript",
        naming: "camelCase",
        structure: "src/",
        patterns: [],
        entryPoints: [],
        scripts: [],
        generatedAt: new Date().toISOString(),
      }),
      "utf-8",
    );
    const facts = detectFacts(cwd);
    assert.equal(facts.language, undefined, "no TS language without an explicit TypeScript token");
  });

  it("indented/nested fake dependencies or sdk entries are NOT Flutter", () => {
    // Nested dependencies under another top-level mapping is not the manifest section.
    writeFileSync(
      join(cwd, "pubspec.yaml"),
      "name: nested_dx\nfoo:\n  dependencies:\n    flutter:\n      sdk: flutter\n",
      "utf-8",
    );
    assert.equal(detectFacts(cwd).testCommand, "dart test", "nested dependencies is ignored");
    // flutter nested under another dependency (not immediate child of dependencies).
    writeFileSync(
      join(cwd, "pubspec.yaml"),
      "name: nested_sdk\ndependencies:\n  http: ^1.0.0\n  other:\n    flutter:\n      sdk: flutter\n",
      "utf-8",
    );
    assert.equal(detectFacts(cwd).testCommand, "dart test", "flutter nested under another dependency is ignored");
  });

  it("pubspec WITHOUT a Flutter SDK dependency is plain Dart (dart test / dart analyze)", () => {
    writeFileSync(join(cwd, "pubspec.yaml"), "name: pure_dart\ndependencies:\n  http: ^1.0.0\n", "utf-8");
    const facts = detectFacts(cwd);
    assert.equal(facts.stack, "Dart");
    assert.equal(facts.language, "Dart");
    assert.equal(facts.testCommand, "dart test");
    assert.equal(facts.analyzeCommand, "dart analyze");
  });

  it("conventions.stack wins over manifest-derived stack", () => {
    writeFileSync(join(cwd, "pubspec.yaml"), "name: demo\n", "utf-8");
    saveConventions(cwd, {
      naming: "camelCase",
      structure: "lib/",
      patterns: [],
      stack: "Riverpod + Dart",
      entryPoints: [],
      scripts: [],
      generatedAt: new Date().toISOString(),
    });
    const facts = detectFacts(cwd);
    assert.equal(facts.stack, "Riverpod + Dart");
    assert.equal(facts.language, "Dart");
  });

  it("no manifests → no substitutions (facts stay empty)", () => {
    const facts = detectFacts(cwd);
    assert.equal(facts.stack, undefined);
    assert.equal(facts.testCommand, undefined);
  });
});

describe("substitutePlaceholders", () => {
  it("substitutes known keys, leaves unknown keys and unrelated braces untouched", () => {
    const text = "stack: {{stack}} lang: {{language}} unknown: {{contractPath}} braces: {keep} {{reviewCommand}}";
    const { text: out, unresolvedCount } = substitutePlaceholders(text, {
      stack: "Flutter (Dart)",
      language: "Dart",
      testCommand: "flutter test",
      analyzeCommand: "flutter analyze",
    });
    assert.ok(out.includes("stack: Flutter (Dart)"));
    assert.ok(out.includes("lang: Dart"));
    assert.ok(out.includes("{{contractPath}}"), "unknown key preserved");
    assert.ok(out.includes("{keep}"), "unrelated braces preserved");
    assert.equal(unresolvedCount, 2, "{{contractPath}} + {{reviewCommand}} remain (unknown keys)");
  });

  it("recognized keys without evidence render <FILL ME> (never a raw token)", () => {
    const { text, fillMeCount } = substitutePlaceholders("{{stack}}|{{testCommand}}|{{contractPath}}", {});
    assert.ok(!text.includes("{{stack}}"), "{{stack}} replaced by FILL ME");
    assert.ok(!text.includes("{{testCommand}}"), "{{testCommand}} replaced by FILL ME");
    assert.ok(text.includes("{{contractPath}}"), "unknown key preserved");
    assert.equal(fillMeCount, 2, "both recognized-but-missing keys counted");
  });

  it("deterministic: identical inputs produce identical output", () => {
    const facts = { stack: "Node", language: "TypeScript", testCommand: "npm test", analyzeCommand: "tsc --noEmit" };
    const a = substitutePlaceholders("{{stack}}|{{testCommand}}|{{contractPath}}", facts);
    const b = substitutePlaceholders("{{stack}}|{{testCommand}}|{{contractPath}}", facts);
    assert.deepEqual(a, b);
  });
});

describe("runWaiScaffold", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-scaffold-run-"));
    writeFileSync(join(cwd, "pubspec.yaml"), "name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n", "utf-8");
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("preview writes nothing even with malformed conventions metadata", () => {
    const piDir = join(cwd, ".pi");
    mkdirSync(join(piDir, "yoowai"), { recursive: true });
    writeFileSync(join(piDir, "yoowai", "conventions.json"), "{not json", "utf-8");
    const before = snapshot(cwd);
    const result = runWaiScaffold(cwd, { targets: ["skill"] });
    assert.equal(result.mode, "preview");
    // Full-tree snapshot (files + directory entries + bytes) unchanged.
    assert.deepEqual(snapshot(cwd), before, "preview is read-only: nothing created, rewritten, or removed");
  });

  it("preview by default: proposes contents, writes NOTHING", () => {
    const before = snapshot(cwd);
    const result = runWaiScaffold(cwd, { targets: ["skill", "review"] });
    assert.equal(result.mode, "preview");
    assert.equal(result.files.length, 2);
    const skill = result.files.find((f) => f.target === "skill")!;
    const review = result.files.find((f) => f.target === "review")!;
    assert.ok(skill.content?.includes("Flutter (Dart)"), "skill preview contains substituted stack");
    assert.ok(review.content?.includes("flutter test"), "review preview contains substituted test command");
    assert.ok(!existsSync(join(cwd, ".pi")), "no .pi directory created in preview");
    assert.deepEqual(snapshot(cwd), before, "no file or directory change");
    assert.deepEqual(result.created, []);
    assert.deepEqual(result.skipped, []);
  });

  it("apply creates all four with exclusive creation; repeat apply skips all", () => {
    const result = runWaiScaffold(cwd, { targets: [...SCAFFOLD_TARGETS], apply: true });
    assert.equal(result.created.length, 4);
    assert.equal(result.skipped.length, 0);
    for (const f of result.files) assert.equal(f.action, "created");
    assert.ok(existsSync(join(cwd, ".pi/skills/engineering-standards/SKILL.md")));
    assert.ok(existsSync(join(cwd, ".pi/yoowai/instructions/review.md")));
    assert.ok(existsSync(join(cwd, ".pi/yoowai/instructions/security.md")));
    assert.ok(existsSync(join(cwd, ".pi/yoowai/instructions/test.md")));

    const before = snapshot(cwd);
    const second = runWaiScaffold(cwd, { targets: [...SCAFFOLD_TARGETS], apply: true });
    assert.equal(second.created.length, 0);
    assert.equal(second.skipped.length, 4);
    assert.ok(second.files.every((f) => f.action === "skipped"));
    assert.deepEqual(snapshot(cwd), before, "existing files remain byte-identical");
  });

  it("pre-existing file is skipped and untouched", () => {
    const dest = join(cwd, ".pi/skills/engineering-standards");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "SKILL.md"), "my authored standards", "utf-8");
    const result = runWaiScaffold(cwd, { targets: ["skill"], apply: true });
    assert.deepEqual(result.created, []);
    assert.equal(result.skipped.length, 1);
    assert.equal(readFileSync(join(dest, "SKILL.md"), "utf-8"), "my authored standards");
  });

  it("rejects unknown and empty targets before any write", () => {
    const before = snapshot(cwd);
    assert.throws(() => runWaiScaffold(cwd, { targets: [] }), WaiScaffoldError);
    assert.throws(() => runWaiScaffold(cwd, { targets: ["bogus" as never] }), WaiScaffoldError);
    assert.deepEqual(snapshot(cwd), before, "validation failure changes nothing");
    assert.ok(!existsSync(join(cwd, ".pi")), "no .pi created on validation failure");
  });

  it("fill-me placeholders are counted per file and total (manifest-less repo)", () => {
    // No manifest → recognized keys become <FILL ME>; unknown keys stay {{...}}.
    const plain = mkdtempSync(join(tmpdir(), "wai-scaffold-plain-"));
    try {
      const result = runWaiScaffold(plain, { targets: [...SCAFFOLD_TARGETS] });
      let total = 0;
      for (const f of result.files) {
        const fillCount = (f.content ?? "").match(/<FILL ME/g)?.length ?? 0;
        assert.equal(f.fillMeCount, fillCount, "fillMe matches content");
        total += f.fillMeCount;
        // Each per-file unresolvedCount must equal the raw {{...}} markers
        // actually present in the RENDERED content (not just the reported sum).
        const rawMarkers = (f.content ?? "").match(/\{\{[A-Za-z0-9_.-]+\}\}/g)?.length ?? 0;
        assert.equal(f.unresolvedCount, rawMarkers, "unresolved matches remaining raw markers");
      }
      assert.equal(result.fillMeTotal, total);
      assert.ok(total > 0, "fill-me placeholders remain in a manifest-less repo");
      const unresolvedSum = result.files.reduce((n, f) => n + f.unresolvedCount, 0);
      assert.equal(result.unresolvedTotal, unresolvedSum, "unresolvedTotal sums per-file counts");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("security template renders no raw {{analyzeCommand}} when undetected", () => {
    const plain = mkdtempSync(join(tmpdir(), "wai-scaffold-sec-"));
    try {
      const result = runWaiScaffold(plain, { targets: ["security"] });
      const content = result.files[0].content ?? "";
      assert.ok(!content.includes("{{analyzeCommand}}"), "no raw marker when analyzeCommand is missing");
      assert.match(content, /<FILL ME/, "explicit fill marker with the hint");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("works from an unrelated process cwd (package-root templates)", () => {
    // REAL cwd independence: chdir to a separate temp dir, pass the project
    // dir to runWaiScaffold, exercise ALL targets, restore in finally.
    const other = mkdtempSync(join(tmpdir(), "wai-scaffold-other-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(other);
      const result = runWaiScaffold(cwd, { targets: [...SCAFFOLD_TARGETS], apply: true });
      assert.equal(result.created.length, SCAFFOLD_TARGETS.length, "all targets created from unrelated cwd");
    } finally {
      process.chdir(prevCwd);
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("preflight: a missing template for a later target fails BEFORE any write", () => {
    const fakeRoot = mkdtempSync(join(tmpdir(), "wai-scaffold-root-"));
    try {
      // Copy only 3 of the 4 packaged templates + reproduce the layout.
      const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
      for (const t of ["skill", "review", "security"]) {
        const src = join(
          pkgRoot,
          "templates",
          t === "skill" ? "skills/engineering-standards.SKILL.md.example" : `instructions/${t}.md.example`,
        );
        const rel =
          t === "skill"
            ? "templates/skills/engineering-standards.SKILL.md.example"
            : `templates/instructions/${t}.md.example`;
        const dest = join(fakeRoot, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, readFileSync(src, "utf-8"));
      }
      // test.md.example is MISSING in the fake root.
      setWaiScaffoldTemplateRootForTests(fakeRoot);
      const before = snapshot(cwd);
      assert.throws(
        () => runWaiScaffold(cwd, { targets: ["skill", "test"], apply: true }),
        (err: unknown) => err instanceof WaiScaffoldError && /test.md.example/.test(err.message),
        "the error must name the missing test template",
      );
      assert.ok(!existsSync(join(cwd, ".pi")), "preflight failure leaves no .pi behind");
      assert.deepEqual(snapshot(cwd), before, "no partial write before the missing template is found");
    } finally {
      setWaiScaffoldTemplateRootForTests(undefined);
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("a non-EEXIST write failure is surfaced, not reported as skipped", () => {
    // .pi exists as a regular FILE → mkdirSync fails (ENOTDIR/EEXIST) and the
    // error must propagate as WaiScaffoldError, never as a skipped file.
    writeFileSync(join(cwd, ".pi"), "not a directory", "utf-8");
    assert.throws(() => runWaiScaffold(cwd, { targets: ["review"], apply: true }), WaiScaffoldError);
  });

  it("a filesystem-root cwd does not reject contained destinations (preview only)", () => {
    // Drive root on Windows / / elsewhere — PREVIEW only (no writes).
    const driveRoot = process.platform === "win32" ? process.cwd().slice(0, 3) : "/";
    assert.doesNotThrow(() => runWaiScaffold(driveRoot, { targets: ["review"] }));
  });

  it("destinations never escape the project (symlink ancestor guard)", () => {
    const outside = mkdtempSync(join(tmpdir(), "wai-scaffold-outside-"));
    try {
      const pi = join(cwd, ".pi");
      mkdirSync(pi, { recursive: true });
      symlinkSync(outside, join(pi, "yoowai"), "dir");
      assert.throws(
        () => runWaiScaffold(cwd, { targets: ["review"], apply: true }),
        (err: unknown) => err instanceof WaiScaffoldError && /resolves outside the project/.test(err.message),
        "the error must come from the symlink containment guard",
      );
      // Nothing may have been written through the symlink into the outside dir.
      const outsideFiles = readdirSync(outside);
      assert.deepEqual(outsideFiles, [], "no file created outside the project");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
