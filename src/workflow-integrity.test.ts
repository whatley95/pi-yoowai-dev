import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorkspace } from "./workspace-fingerprint.js";
import {
  setPlan,
  getState,
  dropSessionState,
  applyReviewOutcome,
  syncWorkspaceChanges,
  recordFileEdit,
} from "./session-state.js";
import { executeWaiDone } from "./actions/done.js";
import { executeWaiReview } from "./actions/review.js";
import { executeWaiJudge } from "./actions/judge.js";
import { triggerAutoReview } from "./integration/lifecycle.js";
import { getAgentDir, setAgentDirForTests } from "./pi-paths.js";
import { gitSpawnEnv } from "./git-env.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildPlanView } from "./plan-view.js";
import type { WaiToolResult } from "./types.js";

const root = mkdtempSync(join(tmpdir(), "wai-integrity-"));
const originalAgentDir = getAgentDir();
before(() => {
  const agent = join(root, "agent");
  mkdirSync(agent);
  setAgentDirForTests(() => agent);
});
after(() => {
  setAgentDirForTests(() => originalAgentDir);
  rmSync(root, { recursive: true, force: true });
});

function repo(): string {
  const cwd = mkdtempSync(join(root, "repo-"));
  const git = (args: string[]) => execFileSync("git", args, { cwd, env: gitSpawnEnv(), stdio: "pipe" });
  git(["init"]);
  writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
  writeFileSync(join(cwd, "subject.js"), "export const value = 1;\n");
  writeFileSync(join(cwd, "check.js"), "process.exit(1);\n");
  git(["add", "."]);
  git([
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "base",
  ]);
  mkdirSync(join(cwd, ".pi"));
  settings(cwd, {});
  return cwd;
}

function settings(cwd: string, overrides: Record<string, unknown>): void {
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      "pi-yoowai": {
        secondary: { provider: "openai", id: "gpt-4o-mini", backend: "http", apiKey: "test", maxRetries: 0 },
        reviewLevel: "min",
        toolUseLoop: false,
        verifyDoneClaims: false,
        preReviewCommands: [],
        autoJudge: false,
        ...overrides,
      },
    }),
  );
}

const plan = { summary: "change value", todo: ["implement value"], acceptanceCriteria: ["value is correct"] };
const review = { verdict: "pass" as const, consensus: true, issues: [], suggestions: [] };
function pass(cwd: string): void {
  const workspace = captureWorkspace(cwd);
  assert.equal(workspace.status, "ready");
  assert.equal(
    applyReviewOutcome(cwd, {
      action: "review",
      review,
      workspaceFingerprint: workspace.status === "ready" ? workspace.fingerprint : undefined,
    }),
    true,
  );
}

test("content fingerprints detect same-size changes with restored timestamps and ignore runtime writes", () => {
  const cwd = repo();
  const before = captureWorkspace(cwd);
  const stat = statSync(join(cwd, "subject.js"));
  writeFileSync(join(cwd, "subject.js"), "export const value = 2;\n");
  utimesSync(join(cwd, "subject.js"), stat.atime, stat.mtime);
  assert.notDeepEqual(captureWorkspace(cwd), before);
  const changed = captureWorkspace(cwd);
  writeFileSync(join(cwd, ".pi", "log.json"), "runtime state");
  assert.deepEqual(captureWorkspace(cwd), changed);
});

test("shell/editor edits invalidate persisted approval and block completion", async () => {
  const cwd = repo();
  setPlan(cwd, plan);
  pass(cwd);
  dropSessionState(cwd);
  writeFileSync(join(cwd, "subject.js"), "export const value = 3;\n");
  const result = await executeWaiDone(cwd);
  assert.equal(result.blocked, true);
  assert.equal(getState(cwd).completedSteps, 0);
  dropSessionState(cwd);
  assert.equal(getState(cwd).reviewBlocked, true);
  pass(cwd);
  assert.equal((await executeWaiDone(cwd)).completedStep, 1);
});

test("auto-review sees external untracked changes without write-tool events", async () => {
  const cwd = repo();
  setPlan(cwd, plan);
  pass(cwd);
  writeFileSync(join(cwd, "new.js"), "export const fresh = true;\n");
  let calls = 0;
  const ctx = { cwd, ui: { notify() {}, setStatus() {}, setWidget() {} } } as unknown as ExtensionContext;
  await triggerAutoReview(ctx, async () => {
    calls++;
    const workspace = captureWorkspace(cwd);
    return {
      action: "review",
      review,
      workspaceFingerprint: workspace.status === "ready" ? workspace.fingerprint : undefined,
    };
  });
  assert.equal(calls, 1);
  assert.equal(getState(cwd).editsSinceLastReview, 0);
});

async function withModel(
  cwd: string,
  action: "review" | "judge" | "done",
  mutate: boolean,
  checks: boolean,
): Promise<void> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (mutate) writeFileSync(join(cwd, "subject.js"), "export const value = 9;\n");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...review,
                  summary: "Everything passes",
                  completedStepIds: [1],
                  satisfied: true,
                  reason: "complete",
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  settings(cwd, {
    secondary: {
      provider: "openai",
      id: "gpt-4o-mini",
      backend: "http",
      apiKey: "test",
      baseUrl: `http://127.0.0.1:${address.port}`,
      maxRetries: 0,
    },
    preReviewCommands: checks ? ["node check.js"] : [],
    verifyDoneClaims: action === "done",
    requireReviewBeforeDone: action !== "done",
  });
  try {
    const result: WaiToolResult =
      action === "review"
        ? await executeWaiReview(cwd, "review", { cwd } as ExtensionContext, {}, undefined, () => {})
        : action === "judge"
          ? await executeWaiJudge(cwd, "judge", undefined, () => {})
          : { action: "done", done: await executeWaiDone(cwd) };
    if (mutate) {
      assert.match(result.error ?? result.done?.verificationReason ?? "", /Workspace changed/);
      assert.equal(getState(cwd).completedSteps, 0);
      assert.equal(getState(cwd).lastReviewedCommit, undefined);
    } else {
      assert.equal(result.error, undefined);
      assert.equal((result.review ?? result.judge)?.verdict, "needs-work");
      if (action === "review") assert.equal(getState(cwd).completedSteps, 0);
      dropSessionState(cwd);
      const state = getState(cwd);
      assert.deepEqual(state.completionEvidence?.checks, [{ command: "node check.js", exitCode: 1 }]);
      assert.equal(state.completionEvidence?.criteria[0].status, "unverified");
      const view = buildPlanView(state, { calls: 1, costUsd: 0 }).join("\n");
      assert.match(view, /exit 1/);
      writeFileSync(join(cwd, "subject.js"), "export const value = 8;\n");
      syncWorkspaceChanges(cwd);
      assert.match(buildPlanView(getState(cwd), { calls: 1, costUsd: 0 }).join("\n"), /stale/);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("done verification cannot advance after code changes during its model call", async () => {
  const cwd = repo();
  setPlan(cwd, plan);
  writeFileSync(join(cwd, "subject.js"), "export const value = 2;\n");
  recordFileEdit(cwd);
  await withModel(cwd, "done", true, false);
  assert.equal(getState(cwd).editsSinceLastDone, 1);
});

test("a new plan cannot certify a dirty tree that had no write-tool events", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "subject.js"), "export const value = 4;\n");
  setPlan(cwd, plan);
  assert.equal((await executeWaiDone(cwd)).blocked, true);
  assert.equal(getState(cwd).completedSteps, 0);
});

for (const action of ["review", "judge"] as const) {
  test(`${action} cannot approve a tree changed while the model is running`, async () => {
    const cwd = repo();
    setPlan(cwd, plan);
    writeFileSync(join(cwd, "subject.js"), "export const value = 2;\n");
    recordFileEdit(cwd);
    await withModel(cwd, action, true, false);
  });
  test(`${action} cannot override failed checks and persists execution evidence`, async () => {
    const cwd = repo();
    setPlan(cwd, plan);
    writeFileSync(join(cwd, "subject.js"), "export const value = 2;\n");
    recordFileEdit(cwd);
    await withModel(cwd, action, false, true);
  });
}
