import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DESIGN_SKILL_TOPICS, buildDesignSkillPaths, registerDesignSkillDiscovery } from "./skills.js";
import { DESIGN_REF_TOPIC_DESCRIPTIONS } from "../design-ref.js";
import { DefaultResourceLoader, loadSkills } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** An intact copy of a single skill topic. */
function makeTopic(root: string, topic: string): void {
  const dir = join(root, topic);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${topic}\ndescription: ${topic} test skill\n---\n# ${topic}\n`);
}

// Exact legacy-root structure check: outside when the relative path leaves
// the root (..-only), or is absolute (cross-volume on Windows).
function isOutsideLegacyRoot(candidate: string, legacyRoot: string): boolean {
  const rel = relative(legacyRoot, candidate);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

describe("buildDesignSkillPaths", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wai-skills-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns all 9 allowlisted topics as cwd-independent absolute dirs with SKILL.md", () => {
    const root = join(cwd, "design-refs");
    for (const topic of DESIGN_SKILL_TOPICS) makeTopic(root, topic);

    const { skillPaths, warnings } = buildDesignSkillPaths({ designRefsRoot: root });
    assert.equal(warnings.length, 0);
    assert.equal(skillPaths.length, 9, "all nine topics discovered");
    const names = skillPaths.map((p) => p.split(/[\\/]/).pop());
    assert.deepEqual(names, [...DESIGN_SKILL_TOPICS], "allowlist order + exact set");
    assert.equal(new Set(skillPaths).size, 9, "unique paths");
    for (const dir of skillPaths) {
      assert.ok(existsSync(dir), `dir exists: ${dir}`);
      assert.ok(existsSync(join(dir, "SKILL.md")), `SKILL.md exists: ${dir}`);
    }
    // cwd independence: the packaged layout is found regardless of the process
    // cwd — chdir to a temp dir and use the DEFAULT root (import.meta.url).
    const other = mkdtempSync(join(tmpdir(), "wai-skills-other-"));
    const prevCwd = process.cwd();
    try {
      process.chdir(other);
      const fromElsewhere = buildDesignSkillPaths();
      // The default root is the PACKAGED design-refs (repo layout, same depth
      // as the module) — independent of the process cwd.
      const packagedRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "design-refs");
      const expected = [...DESIGN_SKILL_TOPICS].map((t) => join(packagedRoot, t));
      assert.deepEqual(fromElsewhere.skillPaths, expected, "default root is cwd-independent");
    } finally {
      process.chdir(prevCwd);
      rmSync(other, { recursive: true, force: true });
    }
    // Never the legacy setup destination (~/.pi/agent/skills).
    const legacyRoot = join(homedir(), ".pi", "agent", "skills");
    for (const dir of skillPaths) {
      assert.ok(isOutsideLegacyRoot(dir, legacyRoot), `no path under ~/.pi/agent/skills: ${dir}`);
    }
  });

  it("matches the topic allowlists in design-ref.ts and scripts/setup.js", () => {
    // design-ref.ts descriptions must exactly cover the SKILL topics.
    const described = Object.keys(DESIGN_REF_TOPIC_DESCRIPTIONS).sort();
    const skills = [...DESIGN_SKILL_TOPICS].sort();
    assert.deepEqual(described, skills, "design-ref.ts descriptions cover the skill topics");
    // setup.js allowlist parity: parse the DECLARED array and compare exactly.
    const setup = readFileSafe("scripts/setup.js");
    const arrayMatch = setup.match(/const\s+DESIGN_SKILL_TOPICS\s*=\s*\[([^\]]*)\]/);
    assert.ok(arrayMatch, "setup.js declares DESIGN_SKILL_TOPICS");
    const declared = ((arrayMatch?.[1] ?? "").match(/["'][^"']+["']/g) ?? []).map((t) => t.slice(1, -1));
    assert.deepEqual(declared.sort(), [...DESIGN_SKILL_TOPICS].sort(), "setup.js allowlist matches exactly");
    assert.equal(new Set(declared).size, declared.length, "setup.js allowlist has no duplicates");
  });

  it("skips a missing topic with a warning and keeps the valid ones", () => {
    const root = join(cwd, "design-refs");
    makeTopic(root, "animate");
    makeTopic(root, "apple-design");

    // root has 2 of the 9 topics.
    const { skillPaths, warnings } = buildDesignSkillPaths({ designRefsRoot: root });
    assert.deepEqual(
      skillPaths.map((p) => p.split(/[\\/]/).pop()),
      ["animate", "apple-design"],
    );
    assert.equal(warnings.length, 7, "seven missing topics warned");
    assert.match(warnings[0], /not found/);
  });

  it("missing root yields empty paths and one warning per topic", () => {
    const missing = join(cwd, "does-not-exist");
    const { skillPaths, warnings } = buildDesignSkillPaths({ designRefsRoot: missing });
    assert.deepEqual(skillPaths, []);
    assert.equal(warnings.length, DESIGN_SKILL_TOPICS.length);
  });

  it("a throwing existence check warns and never escapes", () => {
    const root = join(cwd, "design-refs");
    mkdirSync(root, { recursive: true });
    let calls = 0;
    const result = buildDesignSkillPaths({
      designRefsRoot: root,
      isSkillDir: () => {
        calls++;
        throw new Error("boom");
      },
    });
    assert.equal(calls, DESIGN_SKILL_TOPICS.length);
    assert.deepEqual(result.skillPaths, []);
    assert.equal(result.warnings.length, DESIGN_SKILL_TOPICS.length);
    assert.match(result.warnings[0], /failed/);
  });

  it("a throwing warning sink never escapes discovery", () => {
    const root = join(cwd, "design-refs");
    makeTopic(root, "animate");
    makeTopic(root, "apple-design");
    // Sink throws for every message — the harden seam must be exercised, not
    // vacuously skipped: count invocations.
    let sinkCalls = 0;
    const result = buildDesignSkillPaths({
      designRefsRoot: root,
      warn: () => {
        sinkCalls++;
        throw new Error("sink boom");
      },
    });
    assert.equal(sinkCalls, 7, "the sink is called once per warning");
    assert.equal(result.skillPaths.length, 2, "discovery still returns valid paths");
    assert.equal(result.warnings.length, 7);
  });

  it("the fixed allowlist yields unique paths (no duplicate registrations)", () => {
    const root = join(cwd, "design-refs");
    for (const topic of DESIGN_SKILL_TOPICS) makeTopic(root, topic);
    const { skillPaths } = buildDesignSkillPaths({ designRefsRoot: root });
    assert.equal(new Set(skillPaths).size, skillPaths.length, "handler-visible paths are unique");
    // Collision semantics on the host are deterministic: first-loaded wins and
    // duplicates produce diagnostics (verified in host skills.js addSkills) —
    // legacy copies take precedence over extension paths, never a crash.
  });
});

describe("registerDesignSkillDiscovery", () => {
  function makePi(): { handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>; pi: ExtensionAPI } {
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = {
      on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      },
    } as unknown as ExtensionAPI;
    return { handlers, pi };
  }

  it("registers exactly one resources_discover handler and returns the packaged paths", () => {
    const { handlers, pi } = makePi();
    registerDesignSkillDiscovery(pi);
    const registered = handlers.get("resources_discover") ?? [];
    assert.equal(registered.length, 1, "exactly one resources_discover handler");

    const result = registered[0](
      { type: "resources_discover", cwd: process.cwd(), reason: "startup" },
      { cwd: process.cwd() },
    ) as { skillPaths: string[] };
    assert.equal(result.skillPaths.length, 9, "packaged layout exposes all nine topics");
    // Precise legacy-destination exclusion: nothing equal to or beneath
    // ~/.pi/agent/skills.
    const legacyRoot = join(homedir(), ".pi", "agent", "skills");
    for (const dir of result.skillPaths) {
      assert.ok(existsSync(join(dir, "SKILL.md")), `packaged SKILL.md: ${dir}`);
      assert.ok(isOutsideLegacyRoot(dir, legacyRoot), `no path under ~/.pi/agent/skills: ${dir}`);
    }
  });

  it("a failing warning delivery never escapes the registered handler", () => {
    const { handlers, pi } = makePi();
    let sinkCalls = 0;
    const tempRoot = mkdtempSync(join(tmpdir(), "wai-skills-handler-"));
    const layout = join(tempRoot, "design-refs");
    makeTopic(layout, "animate");
    try {
      registerDesignSkillDiscovery(pi, {
        designRefsRoot: layout,
        warn: () => {
          sinkCalls++;
          throw new Error("sink boom");
        },
      });
      const registered = handlers.get("resources_discover") ?? [];
      assert.equal(registered.length, 1);

      let result: { skillPaths: string[] } | undefined;
      assert.doesNotThrow(() => {
        result = registered[0](
          { type: "resources_discover", cwd: process.cwd(), reason: "startup" },
          { cwd: process.cwd() },
        ) as { skillPaths: string[] };
      });
      assert.equal(sinkCalls, 8, "every missing topic warned through the throwing sink");
      assert.equal(result?.skillPaths.length, 1, "valid paths still returned");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("host loadSkills: legacy copies win and collisions produce diagnostics (no crash)", () => {
    assert.equal(typeof loadSkills, "function", "pinned host must export loadSkills");
    const tempRoot = mkdtempSync(join(tmpdir(), "wai-skills-host-"));
    try {
      const agentDir = join(tempRoot, "agent");
      mkdirSync(join(agentDir, "skills", "animate"), { recursive: true });
      writeFileSync(
        join(agentDir, "skills", "animate", "SKILL.md"),
        `---\nname: animate\ndescription: LEGACY copy\n---\n# legacy\n`,
      );
      const extensionSkills = join(tempRoot, "ext");
      makeTopic(extensionSkills, "animate");

      const result = loadSkills({
        cwd: tempRoot,
        agentDir,
        skillPaths: [extensionSkills],
        includeDefaults: true,
      });
      const animate = result.skills.filter((s) => s.name === "animate");
      assert.equal(animate.length, 1, "exactly one skill per name — no duplicate exposure");
      assert.equal(animate[0].filePath, join(agentDir, "skills", "animate", "SKILL.md"));
      assert.match(animate[0].description, /LEGACY/, "user/legacy copy is the winner (first-loaded wins)");
      const collision = result.diagnostics.some(
        (d) =>
          typeof d === "object" &&
          (d as { type?: string }).type === "collision" &&
          JSON.stringify(d).includes("animate"),
      );
      assert.ok(collision, "a collision diagnostic records the loser");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("host loader: the packaged design skills load through the REAL resource loader", () => {
    assert.equal(typeof DefaultResourceLoader, "function", "pinned host must export DefaultResourceLoader");
    const tempRoot = mkdtempSync(join(tmpdir(), "wai-skills-host-contract-"));
    try {
      const { handlers, pi } = makePi();
      // Default registration: the handler resolves the REAL vendored layout.
      registerDesignSkillDiscovery(pi);
      const registered = handlers.get("resources_discover") ?? [];
      assert.equal(registered.length, 1);
      const { skillPaths } = registered[0](
        { type: "resources_discover", cwd: tempRoot, reason: "startup" },
        { cwd: tempRoot },
      ) as { skillPaths: string[] };

      // Feed the handler output through Pi's real loader (the same consumer
      // path the host uses for extension-discovered resources).
      const loader = new DefaultResourceLoader({
        cwd: tempRoot,
        agentDir: join(tempRoot, "agent-empty"),
        noExtensions: true,
      });
      loader.extendResources({
        skillPaths: skillPaths.map((path) => ({
          path,
          metadata: { source: "test-extension", scope: "project" as const, origin: "package" as const },
        })),
      });
      const loaded = loader.getSkills();
      const names = loaded.skills.map((s) => s.name).sort();
      assert.deepEqual(names, [...DESIGN_SKILL_TOPICS].sort(), "real vendored skills load by exact name");
      assert.equal(loaded.skills.length, 9, "no duplicates through the host loader");
      assert.equal(
        loaded.diagnostics.filter((d) => (d as { type?: string }).type === "collision").length,
        0,
        "no collisions for the packaged-only layout",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("npm package ships the module and all nine skill files", () => {
    const pkg = new Set(runNpmPackDryRun().map((p) => p.replace(/\\/g, "/")));
    assert.ok(pkg.has("src/integration/skills.ts"), "module ships at package root");
    for (const topic of DESIGN_SKILL_TOPICS) {
      assert.ok(pkg.has(`design-refs/${topic}/SKILL.md`), `design-refs/${topic}/SKILL.md ships at package root`);
    }
  });
});

function readFileSafe(rel: string): string {
  try {
    return readFileSync(join(process.cwd(), rel), "utf-8");
  } catch {
    return "";
  }
}

/** npm pack --dry-run --json listing of packaged files (fails loudly when
 *  npm/JSON parsing breaks — this is a packaging-contract test). */
function runNpmPackDryRun(): string[] {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const out = execFileSync(npmCmd, ["pack", "--dry-run", "--json"], {
    cwd: process.cwd(),
    encoding: "utf-8",
    shell: process.platform === "win32",
  });
  const parsed = JSON.parse(out) as Array<{ files?: Array<{ path?: string }> }>;
  return (parsed[0]?.files ?? []).map((f) => f.path ?? "");
}
