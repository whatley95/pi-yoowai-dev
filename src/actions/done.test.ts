import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { executeWaiDone } from "./done.js";
import { setPlan, getState } from "../session-state.js";
import { recordFileEdit, applyReviewOutcome, dropSessionState } from "../session-state.js";
import type { PlanResult } from "../types.js";
import { startStubServer, closeStubServer, bodyText, writeSettings } from "./integration-harness.js";

function tempCwd(): string {
  return mkdtempSync(join(tmpdir(), "wai-done-test-"));
}

function writeConfig(cwd: string, verifyDoneClaims = false): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  // These tests exercise claim verification, not the done gate — disable the
  // gate explicitly since requireReviewBeforeDone now defaults to true.
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({ "pi-yoowai": { verifyDoneClaims, requireReviewBeforeDone: false } }),
    "utf-8",
  );
}

function writeGateConfig(cwd: string, requireReviewBeforeDone: boolean): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({ "pi-yoowai": { verifyDoneClaims: false, requireReviewBeforeDone } }),
    "utf-8",
  );
}

const plan: PlanResult = {
  summary: "demo",
  todo: ["step one", "step two", "step three"],
  acceptanceCriteria: [],
};

const hasSvn = (() => {
  try {
    execFileSync("svn", ["--version", "--quiet"], { stdio: "pipe" });
    execFileSync("svnadmin", ["--version", "--quiet"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

test(
  "SVN done verification uses the working-copy BASE when repository HEAD has advanced",
  { skip: !hasSvn },
  async (t) => {
    const root = tempCwd();
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repository = join(root, "repository");
    const cwd = join(root, "working-copy");
    const other = join(root, "other-copy");
    execFileSync("svnadmin", ["create", repository], { stdio: "pipe" });
    const url = pathToFileURL(repository).href;
    execFileSync("svn", ["checkout", url, cwd], { stdio: "pipe" });
    writeFileSync(join(cwd, "file.txt"), "LOCAL_BASE\n");
    execFileSync("svn", ["add", "file.txt"], { cwd, stdio: "pipe" });
    execFileSync("svn", ["commit", "-m", "initial"], { cwd, stdio: "pipe" });
    execFileSync("svn", ["checkout", url, other], { stdio: "pipe" });
    writeFileSync(join(other, "file.txt"), "REMOTE_HEAD\n");
    execFileSync("svn", ["commit", "-m", "remote change"], { cwd: other, stdio: "pipe" });
    writeFileSync(join(cwd, "file.txt"), "LOCAL_CHANGE\n");
    const stub = await startStubServer({ payload: { satisfied: true, reason: "complete" } });
    t.after(() => closeStubServer(stub.server));
    const model = { provider: "openai", id: "gpt-4o-mini", apiKey: "test", backend: "http", baseUrl: stub.url };
    writeSettings(cwd, {
      secondary: model,
      taskModels: { done: model },
      verifyDoneClaims: true,
      requireReviewBeforeDone: false,
      costBudgetUsd: 1,
      maxContinuations: 0,
    });
    setPlan(cwd, plan);
    recordFileEdit(cwd);
    const result = await executeWaiDone(cwd);
    assert.equal(result.verified, true, result.verificationReason ?? "Expected verified SVN completion");
    assert.equal(result.completedStep, 1);
    const prompt = bodyText(stub.bodies, 0);
    assert.ok(prompt.includes("LOCAL_BASE"));
    assert.ok(prompt.includes("LOCAL_CHANGE"));
    assert.ok(!prompt.includes("REMOTE_HEAD"), "done must verify local edits against the checked-out revision");
  },
);

test("done verification blocks an incomplete diff before calling a model", async () => {
  const cwd = tempCwd();
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  writeFileSync(join(cwd, "file.txt"), "original\n");
  execFileSync("git", ["add", "file.txt"], { cwd, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"], {
    cwd,
    stdio: "ignore",
  });
  writeFileSync(join(cwd, "file.txt"), "changed\n".repeat(1000));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      "pi-yoowai": { verifyDoneClaims: true, requireReviewBeforeDone: false, reviewMaxDiffChars: 100 },
    }),
  );
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd);
  assert.equal(result.blocked, true);
  assert.match(result.verificationReason ?? "", /Incomplete diff/);
  assert.equal(getState(cwd).completedSteps, 0);
  assert.equal(getState(cwd).editsSinceLastDone, 1);
});

test("executeWaiDone returns message when no plan exists", async () => {
  const cwd = tempCwd();
  writeConfig(cwd);
  const result = await executeWaiDone(cwd);
  assert.equal(result.totalSteps, 0);
  assert.ok(result.message.includes("No active wai plan"));
});

test("executeWaiDone advances current step when verification is disabled", async () => {
  const cwd = tempCwd();
  writeConfig(cwd, false);
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd);
  assert.equal(result.completedStep, 1);
  // Verification is disabled, so `verified` must not be claimed as true.
  assert.equal(result.verified, undefined);
});

test("executeWaiDone advances when there are no edits since last done", async () => {
  const cwd = tempCwd();
  writeConfig(cwd, true);
  setPlan(cwd, plan);
  const result = await executeWaiDone(cwd);
  assert.equal(result.completedStep, 1);
  // No edits since last done means verification is skipped, so `verified` is not claimed.
  assert.equal(result.verified, undefined);
});

test("executeWaiDone marks up to an explicit target without claim verification", async () => {
  const cwd = tempCwd();
  // Verification is enabled and there are unrecorded edits, but an explicit
  // target is a tracker correction, not a done-claim — it must not be gated.
  writeConfig(cwd, true);
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd, 2);
  assert.equal(result.completedStep, 2);
  assert.equal(result.verified, undefined);
  assert.ok(result.message.includes("Marked steps up to 2"));
});

test("executeWaiDone regresses the tracker when the explicit target is lower", async () => {
  const cwd = tempCwd();
  writeConfig(cwd, true);
  setPlan(cwd, plan);
  await executeWaiDone(cwd, 3);
  const result = await executeWaiDone(cwd, 1);
  assert.equal(result.completedStep, 1);
  assert.equal(result.allDone, false);
  assert.ok(result.message.includes("regressed to step 1"));
});

test("executeWaiDone resets the tracker with an explicit zero target", async () => {
  const cwd = tempCwd();
  writeConfig(cwd, true);
  setPlan(cwd, plan);
  await executeWaiDone(cwd, 2);
  const result = await executeWaiDone(cwd, 0);
  assert.equal(result.completedStep, 0);
  assert.equal(result.allDone, false);
});

test("executeWaiDone blocks completion with unreviewed edits when requireReviewBeforeDone is enabled", async () => {
  const cwd = tempCwd();
  writeGateConfig(cwd, true);
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd);
  assert.equal(result.completedStep, 0);
  assert.equal(result.allDone, false);
  assert.equal(result.blocked, true);
  assert.ok(result.message.includes("2 file edit(s) have not been reviewed"));
  // The tracker must not advance while blocked.
  assert.equal(getState(cwd).completedSteps, 0);
});

test("executeWaiDone force override completes and records the step as not reviewed", async () => {
  const cwd = tempCwd();
  writeGateConfig(cwd, true);
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd, undefined, undefined, true);
  assert.equal(result.completedStep, 1);
  assert.equal(result.blocked, undefined);
  // A forced completion is a manual mark, not a reviewed one.
  assert.equal(getState(cwd).reviewedSteps[0], false);
});

test("executeWaiDone does not gate tracker corrections (explicit target at or below progress)", async () => {
  const cwd = tempCwd();
  writeGateConfig(cwd, true);
  setPlan(cwd, plan);
  const forced = await executeWaiDone(cwd, 2, undefined, true);
  assert.equal(forced.completedStep, 2);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd, 1);
  assert.equal(result.completedStep, 1);
  assert.equal(result.blocked, undefined);
});

test("executeWaiDone does not gate when requireReviewBeforeDone is disabled", async () => {
  const cwd = tempCwd();
  writeGateConfig(cwd, false);
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd);
  assert.equal(result.completedStep, 1);
  assert.equal(result.blocked, undefined);
});

test("a failed review stays completion-blocking across restart until a whole-tree pass", async () => {
  const cwd = tempCwd();
  writeGateConfig(cwd, true);
  setPlan(cwd, plan);
  applyReviewOutcome(cwd, {
    action: "review",
    review: {
      verdict: "needs-work",
      issues: [{ severity: "high", issue: "broken", suggestion: "fix" }],
      suggestions: [],
      consensus: false,
    },
  });
  dropSessionState(cwd);
  assert.equal((await executeWaiDone(cwd, "all")).blocked, true);
  const pass = {
    action: "review" as const,
    review: {
      verdict: "pass" as const,
      issues: [],
      suggestions: [],
      consensus: true,
    },
  };
  applyReviewOutcome(cwd, pass, { files: ["one.ts"] });
  assert.equal((await executeWaiDone(cwd)).blocked, true);
  applyReviewOutcome(cwd, pass);
  assert.equal((await executeWaiDone(cwd)).completedStep, 1);
});

test("verification unavailable blocks advancement and force explicitly bypasses it", async () => {
  const cwd = tempCwd();
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      "pi-yoowai": {
        secondary: { provider: "openai", id: "gpt-4o-mini", apiKey: "test", backend: "http" },
        verifyDoneClaims: true,
        requireReviewBeforeDone: false,
        costBudgetUsd: 0,
      },
    }),
  );
  setPlan(cwd, plan);
  recordFileEdit(cwd);
  const result = await executeWaiDone(cwd);
  assert.equal(result.blocked, true);
  assert.equal(getState(cwd).completedSteps, 0);
  assert.equal(getState(cwd).editsSinceLastDone, 1);
  const forced = await executeWaiDone(cwd, undefined, undefined, true);
  assert.equal(forced.completedStep, 1);
  assert.equal(forced.verified, undefined);
  assert.equal(getState(cwd).reviewedSteps[0], false);
});

for (const fixture of [
  {
    name: "invalid",
    content: "No structured verification result",
    finishReason: "stop",
    reason: /Invalid done-verification response/,
  },
  {
    name: "truncated",
    content: JSON.stringify({ satisfied: true, reason: "complete" }),
    finishReason: "length",
    reason: /Incomplete done-verification response/,
  },
]) {
  test(`a ${fixture.name} model verification response cannot silently complete a step`, async () => {
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [{ message: { content: fixture.content }, finish_reason: fixture.finishReason }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      const cwd = tempCwd();
      execFileSync("git", ["init"], { cwd, stdio: "ignore" });
      writeFileSync(join(cwd, "file.txt"), "before\n");
      execFileSync("git", ["add", "file.txt"], { cwd, stdio: "ignore" });
      execFileSync(
        "git",
        [
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "base",
        ],
        { cwd, stdio: "ignore" },
      );
      writeFileSync(join(cwd, "file.txt"), "after\n");
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
          "pi-yoowai": {
            secondary: {
              provider: "openai",
              id: "gpt-4o-mini",
              apiKey: "test",
              backend: "http",
              baseUrl: `http://127.0.0.1:${address.port}`,
            },
            verifyDoneClaims: true,
            requireReviewBeforeDone: false,
            costBudgetUsd: 1,
            maxContinuations: 0,
          },
        }),
      );
      setPlan(cwd, plan);
      recordFileEdit(cwd);
      const result = await executeWaiDone(cwd);
      assert.equal(result.blocked, true);
      assert.match(result.verificationReason ?? "", fixture.reason);
      assert.equal(getState(cwd).completedSteps, 0);
      assert.equal(getState(cwd).editsSinceLastDone, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
