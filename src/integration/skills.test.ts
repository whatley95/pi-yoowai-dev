import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  loadSkills,
  formatSkillsForPrompt,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PACKAGED_SKILLS, getPackagedSkillsRoot } from "../skill-guidance.js";
import { registerSkillReadTracking, getSkillDiagnostics, formatSkillDiagnostics } from "./skills.js";

const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "wai-skills-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const root = dirname(getPackagedSkillsRoot());
async function resources(cwd: string, skills?: string[]) {
  const entry = skills ? { source: root, skills } : root;
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: join(cwd, "agent"),
    settingsManager: SettingsManager.inMemory({ packages: [entry] }),
    noExtensions: true,
  });
  await loader.reload();
  return loader.getSkills();
}

describe("native packaged skills", () => {
  it("loads the packaged Wai skills through Pi's actual package manifest", async () => {
    const result = await resources(temp());
    assert.deepEqual(result.skills.map((skill) => skill.name).sort(), [...PACKAGED_SKILLS].sort());
    assert.deepEqual(result.diagnostics, []);
    const catalog = formatSkillsForPrompt(result.skills);
    for (const skill of result.skills) {
      assert.equal(skill.disableModelInvocation, false);
      assert.ok(catalog.includes(skill.name));
      assert.ok(catalog.includes(skill.filePath));
      const content = readFileSync(skill.filePath, "utf8");
      for (const [, ref] of content.matchAll(/\]\(([^)]+)\)/g)) {
        if (!ref.includes("://"))
          assert.ok(existsSync(join(dirname(skill.filePath), ref)), skill.name + " missing " + ref);
      }
    }
  });
  it("honors empty native skill filters", async () => {
    assert.deepEqual((await resources(temp(), [])).skills, []);
  });
  it("honors per-skill exclusions without rediscovering the excluded skill", async () => {
    const result = await resources(temp(), ["!skills/wai-skill-design/SKILL.md"]);
    assert.equal(result.skills.length, PACKAGED_SKILLS.length - 1);
    assert.ok(!result.skills.some((skill) => skill.name === "wai-skill-design"));
  });
  it("does not load references as extra skill entries", async () => {
    const result = await resources(temp());
    assert.equal(new Set(result.skills.map((skill) => skill.name)).size, PACKAGED_SKILLS.length);
  });
  it("preserves a user's same-name skill and exposes Pi's collision diagnostic", () => {
    const cwd = temp(),
      agentDir = join(cwd, "agent");
    const copy = join(agentDir, "skills", "wai-skill-design");
    mkdirSync(copy, { recursive: true });
    writeFileSync(
      join(copy, "SKILL.md"),
      "---\nname: wai-skill-design\ndescription: User project guidance\n---\nUser rules.\n",
    );
    const result = loadSkills({
      cwd,
      agentDir,
      includeDefaults: true,
      skillPaths: [join(getPackagedSkillsRoot(), "wai-skill-design", "SKILL.md")],
    });
    assert.equal(result.skills.filter((skill) => skill.name === "wai-skill-design").length, 1);
    assert.equal(result.skills.find((skill) => skill.name === "wai-skill-design")?.filePath, join(copy, "SKILL.md"));
    assert.ok(result.diagnostics.some((item) => item.type === "collision"));
  });
  it("ships every entry, reference and attribution in the npm package", () => {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          process.env.npm_execpath || join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
          "pack",
          "--dry-run",
          "--json",
          "--ignore-scripts",
        ],
        { cwd: root, encoding: "utf8" },
      ),
    ) as Array<{ files: Array<{ path: string }> }>;
    const shipped = new Set(result[0].files.map((file) => file.path));
    for (const name of PACKAGED_SKILLS) assert.ok(shipped.has("skills/" + name + "/SKILL.md"));
    assert.ok(shipped.has("skills/wai-skill-design/references/motion.md"));
    assert.ok(shipped.has("skills/wai-skill-design/LICENSE"));
    assert.ok(shipped.has("design-refs/LICENSE"));
  });
});

describe("skill diagnostics", () => {
  it("observes successful reads, contains no resource-discovery bypass, and resets at session boundaries", () => {
    const cwd = temp();
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const pi = {
      on(event: string, fn: (event: unknown, ctx: unknown) => unknown) {
        const current = handlers.get(event) ?? [];
        current.push(fn);
        handlers.set(event, current);
      },
    } as unknown as ExtensionAPI;
    registerSkillReadTracking(pi);
    assert.equal(handlers.has("resources_discover"), false);
    const dispatch = (name: string, event: unknown) => handlers.get(name)?.forEach((fn) => fn(event, { cwd }));
    dispatch("session_start", {});
    const path = join(getPackagedSkillsRoot(), "wai-skill-design", "SKILL.md");
    dispatch("tool_result", { toolName: "read", input: { path }, isError: true });
    dispatch("tool_result", { toolName: "read", input: { path: join(cwd, "outside.md") }, isError: false });
    assert.deepEqual(getSkillDiagnostics(cwd).observedReads, []);
    dispatch("tool_result", { toolName: "read", input: { path }, isError: false });
    assert.equal(getSkillDiagnostics(cwd).observedReads[0].skill, "wai-skill-design");
    dispatch("tool_result", {
      toolName: "wai_design_ref",
      input: { topic: "wai-skill-design", doc: "references/motion.md" },
      isError: false,
    });
    assert.equal(getSkillDiagnostics(cwd).observedReads[1].document, "references/motion.md");
    assert.match(formatSkillDiagnostics(cwd), /Reads do not prove compliance/);
    dispatch("session_shutdown", {});
    assert.deepEqual(getSkillDiagnostics(cwd).observedReads, []);
  });
  it("reports existing override/legacy files without modifying them", () => {
    const cwd = temp(),
      skills = join(cwd, ".pi", "skills");
    for (const name of ["animate", "wai-debug"]) {
      mkdirSync(join(skills, name), { recursive: true });
      writeFileSync(join(skills, name, "SKILL.md"), "local content");
    }
    const result = getSkillDiagnostics(cwd);
    assert.ok(result.legacyCopies.includes(join(skills, "animate", "SKILL.md")));
    assert.ok(result.overrides.includes(join(skills, "wai-debug", "SKILL.md")));
    assert.equal(readFileSync(join(skills, "animate", "SKILL.md"), "utf8"), "local content");
  });
});
