import { it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildPiIsolationArgs, callPiBackend, probePiCliVersion, setPiSpawnResolver } from "./pi-backend.js";
import { getPiHostVersion } from "../integration/host-capabilities.js";

afterEach(() => setPiSpawnResolver(null));

it("preserves partial JSON responses and their length signal when the subprocess exits 0 or 1", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "wai-cli-truncation-"));
  try {
    const script = join(cwd, "truncated.cjs");
    const count = join(cwd, "count.txt");
    for (const exitCode of [0, 1]) {
      writeFileSync(count, "");
      writeFileSync(
        script,
        `
        require('node:fs').appendFileSync(${JSON.stringify(count)}, 'x');
        console.log(JSON.stringify({type:'message_end', message:{
          role:'assistant', content:[{type:'text', text:'partial response'}], stopReason:'length',
          usage:{input:10, output:5, cost:0.001}
        }}));
        process.stderr.write('Response was truncated: the model reached its output token limit.');
        process.exitCode = ${exitCode};
      `,
      );
      setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script], version: "1.2.0" }));
      const result = await callPiBackend("openai", "test-model", "system", "user", { cwd });
      assert.equal(result.content, "partial response");
      assert.equal(result.truncated, true);
      assert.equal(result.usage.estimatedInputTokens, 10);
      assert.equal(result.usage.estimatedOutputTokens, 5);
      assert.equal(result.usage.estimatedCostUsd, 0.001);
      assert.equal(readFileSync(count, "utf8"), "x", "valid partial output must not be replayed as a process error");
    }
  } finally {
    assert.equal(dirname(realpathSync(cwd)), realpathSync(tmpdir()));
    rmSync(cwd, { recursive: true, force: true });
  }
});

it("distinguishes Pi 1.2 text-print truncation from the JSON mode used by Wai", { timeout: 30000 }, async (t) => {
  const [major, minor] = (getPiHostVersion() ?? "").split(".").map(Number);
  if (!(major > 1 || (major === 1 && minor >= 2))) {
    t.skip("Print-mode truncation exit semantics require Pi 1.2+");
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), "wai-real-print-mode-"));
  try {
    const script = join(cwd, "print-mode.cjs");
    const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
    // Exercise Pi's real print-mode implementation in a child process, with
    // only the session/provider response controlled to avoid a paid API call.
    writeFileSync(
      script,
      `
      (async () => {
        const {runPrintMode} = await import(${JSON.stringify(entry)});
        const message = {role:'assistant', content:[{type:'text', text:'partial response'}], stopReason:'length'};
        let listener;
        const session = {
          state: {messages:[message]},
          sessionManager: {getHeader:()=>undefined},
          agent: {subscribe:()=>()=>{}},
          bindExtensions: async()=>{},
          subscribe: (fn)=>{listener=fn; return ()=>{};},
          prompt: async()=>listener?.({type:'message_end',message})
        };
        const runtime = {session, setRebindSession:()=>{}, dispose:async()=>{}};
        const modeIndex = process.argv.indexOf('--mode');
        const mode = modeIndex < 0 ? 'text' : process.argv[modeIndex+1];
        process.exitCode = await runPrintMode(runtime, {mode, initialMessage:'go'});
      })().catch(error=>{console.error(error); process.exitCode=1;});
    `,
    );
    await assert.rejects(promisify(execFile)(process.execPath, [script], { windowsHide: true }), (error: unknown) => {
      const result = error as Error & { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 1);
      assert.match(result.stdout, /partial response/);
      assert.match(result.stderr, /Response was truncated/);
      return true;
    });
    setPiSpawnResolver(() => ({ command: process.execPath, prefixArgs: [script], version: "1.2.0" }));
    const result = await callPiBackend("openai", "test-model", "system", "user", { cwd });
    assert.equal(result.content, "partial response");
    assert.equal(result.truncated, true);
  } finally {
    assert.equal(dirname(realpathSync(cwd)), realpathSync(tmpdir()));
    rmSync(cwd, { recursive: true, force: true });
  }
});

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
