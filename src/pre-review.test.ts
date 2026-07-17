import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPreReviewCommands, formatPreReviewOutput } from "./pre-review.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("pre-review", () => {
  it("runs an allowlisted command successfully", async () => {
    const results = await runPreReviewCommands(process.cwd(), ["npm --version"]);
    assert.equal(results.length, 1);
    assert.equal(results[0].exitCode, 0);
    assert.ok(results[0].output.length > 0);
  });

  it("returns non-zero exit code for failing commands", async () => {
    const results = await runPreReviewCommands(process.cwd(), ["tsc --noEmit --project /nonexistent/tsconfig.json"]);
    assert.equal(results.length, 1);
    assert.ok(results[0].exitCode !== 0);
  });

  it("rejects shell metacharacters", async () => {
    const results = await runPreReviewCommands(process.cwd(), ["npm; rm -rf /"]);
    // The command is rejected, but runPreReviewCommands catches and returns exitCode 1
    assert.equal(results.length, 1);
    assert.ok(results[0].exitCode !== 0);
  });

  it("rejects non-allowlisted commands", async () => {
    const results = await runPreReviewCommands(process.cwd(), ["rm -rf /"]);
    assert.equal(results.length, 1);
    assert.ok(results[0].exitCode !== 0);
  });

  it("allows svn commands", async () => {
    const results = await runPreReviewCommands(process.cwd(), ["svn status"]);
    assert.equal(results.length, 1);
    // The svn binary may not be installed on every machine, but the command
    // must pass the allowlist regardless.
    assert.doesNotMatch(results[0].output, /not in the allowlist/);
  });

  it("rejects interpreter inline-eval flags", async () => {
    const results = await runPreReviewCommands(process.cwd(), ["node -e console.log(1)"]);
    assert.equal(results.length, 1);
    assert.ok(results[0].exitCode !== 0);
  });

  it("rejects node -c flag", async () => {
    const results = await runPreReviewCommands(process.cwd(), ["node -c 'console.log(1)'"]);
    assert.equal(results.length, 1);
    assert.ok(results[0].exitCode !== 0);
  });

  it("rejects npx with unknown package", async () => {
    const results = await runPreReviewCommands(process.cwd(), ["npx some-unknown-pkg-xyz"]);
    assert.equal(results.length, 1);
    assert.ok(results[0].exitCode !== 0);
  });

  it("rejects newlines in commands", async () => {
    const results = await runPreReviewCommands(process.cwd(), ["npm test\nrm -rf /"]);
    assert.equal(results.length, 1);
    assert.ok(results[0].exitCode !== 0);
  });

  it("allows node with a safe relative script", async () => {
    const tmpDir = join(tmpdir(), `pre-review-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const scriptPath = join(tmpDir, "test-script.js");
    writeFileSync(scriptPath, "console.log('hello from script');\n");
    try {
      const results = await runPreReviewCommands(tmpDir, ["node test-script.js"]);
      assert.equal(results.length, 1);
      assert.equal(results[0].exitCode, 0);
      assert.match(results[0].output, /hello from script/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs multiple commands in parallel", async () => {
    const results = await runPreReviewCommands(process.cwd(), ["npm --version", "npm --version"]);
    assert.equal(results.length, 2);
    assert.equal(results[0].exitCode, 0);
    assert.equal(results[1].exitCode, 0);
  });

  it("formatPreReviewOutput returns empty string for no results", () => {
    assert.equal(formatPreReviewOutput([]), "");
  });

  it("formatPreReviewOutput formats results with command and exit code", () => {
    const output = formatPreReviewOutput([{ command: "npm test", output: "all good", exitCode: 0 }]);
    assert.match(output, /\$ npm test \(exit 0\)/);
    assert.match(output, /all good/);
  });

  it("formatPreReviewOutput handles empty command output", () => {
    const output = formatPreReviewOutput([{ command: "tsc --noEmit", output: "", exitCode: 0 }]);
    assert.match(output, /\(no output\)/);
  });
});
