import { it } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { buildPiIsolationArgs, probePiCliVersion } from "./pi-backend.js";
import { getPiHostVersion } from "../integration/host-capabilities.js";

it("keeps secondary CLI tools read-only and gates MCP isolation on the launched CLI version", () => {
  for (const version of [undefined, "unknown", "0.82.1", "1.0.0", "1.0.3", "1.1.0-beta"]) {
    const args = buildPiIsolationArgs(version);
    assert.equal(args.includes("--no-mcp"), false);
    assert.ok(args.includes("--no-skills") && args.includes("--no-prompt-templates"));
    assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
  }
  for (const version of ["1.0.4", "1.1.0", "pi 1.1.0", "v2.0.0"]) {
    assert.ok(buildPiIsolationArgs(version).includes("--no-mcp"));
  }
});

it("parses the read-only fallback loadout with the real installed Pi CLI parser", () => {
  // Both the peer floor and modern hosts understand the shared isolation flags.
  const parsed = parseArgs(buildPiIsolationArgs());
  assert.deepEqual(parsed.tools, ["read", "grep", "find", "ls"]);
  assert.equal(parsed.noExtensions, true);
  assert.equal(parsed.noSkills, true);
  assert.equal(parsed.noPromptTemplates, true);
  const current = buildPiIsolationArgs(getPiHostVersion());
  if (current.includes("--no-mcp")) {
    assert.equal((parseArgs(current) as unknown as { noMcp: boolean }).noMcp, true);
  }
});

it("probes the launched executable once, shares concurrent probes, and handles a failed probe", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "wai-cli-version-"));
  try {
    const script = join(cwd, "version.cjs");
    const count = join(cwd, "count.txt");
    writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(count)}, 'x'); console.log('1.1.0');`);
    const target = { command: process.execPath, prefixArgs: [script] };
    assert.deepEqual(await Promise.all([probePiCliVersion(target), probePiCliVersion(target)]), ["1.1.0", "1.1.0"]);
    assert.equal(await probePiCliVersion(target), "1.1.0");
    assert.equal(readFileSync(count, "utf8"), "x");
    assert.equal(
      await probePiCliVersion({ command: process.execPath, prefixArgs: [join(cwd, "missing.cjs")] }),
      undefined,
    );
  } finally {
    assert.equal(dirname(realpathSync(cwd)), realpathSync(tmpdir()));
    rmSync(cwd, { recursive: true, force: true });
  }
});
