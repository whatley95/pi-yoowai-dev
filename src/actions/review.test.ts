import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEW_NO_MODEL_ERROR, executeWaiReview, planAdvanceFromReview } from "./review.js";
import { mergeReviewResults, dedupeIssues } from "./review-helpers.js";
import { resolveReviewTaskModel } from "../config.js";
import { resolveReviewSettings } from "../review-level.js";
import {
  getLastReviewedCommit,
  setLastReviewedCommit,
  getPendingReviewCommit,
  getReviewedFiles,
  recordReviewedFiles,
  setPlan,
  getState,
  dropSessionState,
} from "../session-state.js";
import { getAgentDir, setAgentDirForTests } from "../pi-paths.js";
import { gitSpawnEnv } from "../git-env.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewResult, ReviewIssue, YoowaiConfig } from "../types.js";

/** A valid ReviewResult with optional overrides (constructed directly, so
 *  consensus does NOT get re-derived like validateReviewResult would). */
function review(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    verdict: "pass",
    issues: [],
    suggestions: [],
    consensus: true,
    ...overrides,
  };
}

describe("executeWaiReview generic-path model resolution (cost-budget probe)", () => {
  const tmpDirs: string[] = [];
  const originalAgentDir = getAgentDir();
  let emptyAgentDir: string;

  before(() => {
    // Isolate from the real ~/.pi/agent/settings.json so the user's global
    // secondary/review task models cannot leak into this probe.
    emptyAgentDir = mkdtempSync(join(tmpdir(), "review-model-agent-"));
    setAgentDirForTests(() => emptyAgentDir);
  });

  after(() => {
    setAgentDirForTests(() => originalAgentDir);
    try {
      rmSync(emptyAgentDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it("generic wai review resolves the per-level model from the effective level", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-model-cwd-"));
    tmpDirs.push(cwd);
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "settings.json"),
      JSON.stringify({
        "pi-yoowai": {
          reviewLevel: "med",
          // Hard stop before any backend call: the probe asserts the review got
          // PAST the model gate via the reviewMed override and stopped at the
          // cost budget instead of calling a model.
          costBudgetUsd: 0,
          taskModels: {
            reviewMed: {
              provider: "openai",
              id: "gpt-4o-mini",
              backend: "http",
              baseUrl: "http://127.0.0.1:9",
            },
          },
          // Deliberately NO secondary and NO review task: the old caller
          // (resolveReviewTaskModel(config, undefined)) would fall back to the
          // empty review task and return the gate error before any work.
        },
      }),
      "utf-8",
    );

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "contract probe", ctx, {}, undefined, () => {});

    assert.ok(result.error, "expected an error result");
    assert.notEqual(
      result.error,
      REVIEW_NO_MODEL_ERROR,
      "the review resolved no model at all — per-level resolution regressed",
    );
    assert.ok(
      result.error.toLowerCase().includes("budget"),
      `expected the cost-budget stop (proves the model gate was passed via reviewMed), got: ${result.error}`,
    );
  });
});

describe("executeWaiReview model resolution (effective level drives per-level model)", () => {
  // Pins the caller contract in executeWaiReview: the generic `wai review`
  // resolves the effective level first (config.reviewLevel ?? model-derived),
  // then resolves the model from that level — so taskModels.reviewMed/reviewHigh
  // are honored on the generic path, not just by the explicit tools.
  const config: YoowaiConfig = {
    secondary: { provider: "opencode-go", id: "glm-5.2" },
    reviewLevel: "med",
    taskModels: {
      review: { provider: "kimi-coding", id: "k3-256k", thinking: "high" },
      reviewMed: { provider: "kimi-coding", id: "k3-256k", thinking: "low" },
      reviewHigh: { provider: "openai", id: "gpt-5", thinking: "max" },
    },
  };

  it("generic review (no tool override) uses the per-level model matching the configured level", () => {
    const level = resolveReviewSettings(config, undefined).level;
    assert.equal(level, "med");
    const model = resolveReviewTaskModel(config, level);
    assert.equal(model.provider, "kimi-coding");
    assert.equal(model.id, "k3-256k");
    assert.equal(model.thinking, "low"); // reviewMed wins over the review task's high
  });

  it("an explicit tool override wins over the configured level when its entry exists", () => {
    const level = resolveReviewSettings(config, "high").level;
    const model = resolveReviewTaskModel(config, level);
    assert.equal(model.provider, "openai"); // reviewHigh beats reviewMed + review task
    assert.equal(model.id, "gpt-5");
    assert.equal(model.thinking, "max");
  });

  it("explicit override falls back to the review task when the per-level entry is missing", () => {
    const level = resolveReviewSettings(config, "min").level;
    const model = resolveReviewTaskModel(config, level);
    assert.equal(model.id, "k3-256k"); // no reviewMin entry → review task
    assert.equal(model.thinking, "high");
  });

  it("configs without per-level entries are unchanged (fallback to the review task)", () => {
    const plain: YoowaiConfig = {
      secondary: { provider: "opencode-go", id: "glm-5.2" },
      reviewLevel: "med",
      taskModels: { review: { provider: "kimi-coding", id: "k3-256k", thinking: "high" } },
    };
    const level = resolveReviewSettings(plain, undefined).level;
    const model = resolveReviewTaskModel(plain, level);
    assert.equal(model.id, "k3-256k");
    assert.equal(model.thinking, "high");
  });
});

describe("planAdvanceFromReview (guarded auto-completion)", () => {
  it("consensus advances by the relative completedSteps count", () => {
    assert.deepEqual(planAdvanceFromReview(review({ completedSteps: 2 }), true, false), { count: 2 });
    assert.deepEqual(planAdvanceFromReview(review(), true, false), { count: 1 });
  });

  it("stepComplete advances exactly one step on a pass, even with minor issues", () => {
    // A pass with a low-severity nit: consensus is false, but the model
    // explicitly confirmed the current step's work is finished and covered.
    const result = review({
      consensus: false,
      stepComplete: true,
      issues: [{ severity: "low", issue: "nit", suggestion: "polish" }],
    });
    assert.deepEqual(planAdvanceFromReview(result, true, false), { count: 1 });
  });

  it("a bare pass without consensus or stepComplete does not advance", () => {
    assert.equal(planAdvanceFromReview(review({ consensus: false, stepComplete: false }), true, false), null);
    assert.equal(planAdvanceFromReview(review({ consensus: false }), true, false), null);
  });

  it("needs-work never advances, even with stepComplete", () => {
    const result = review({ verdict: "needs-work", consensus: false, stepComplete: true });
    assert.equal(planAdvanceFromReview(result, true, false), null);
  });

  it("no plan or an already-complete plan never advances", () => {
    assert.equal(planAdvanceFromReview(review(), false, false), null);
    assert.equal(planAdvanceFromReview(review(), true, true)!.count, 0);
    assert.equal(planAdvanceFromReview(review({ consensus: false, stepComplete: true }), true, true)!.count, 0);
  });
});

describe("mergeReviewResults plan-tracker signals", () => {
  it("stepComplete requires every sub-review; planStale fires on any", () => {
    const merged = mergeReviewResults([
      review({ stepComplete: true, planStale: false }),
      review({ stepComplete: true, planStale: true }),
    ]);
    assert.equal(merged.stepComplete, true);
    assert.equal(merged.planStale, true);

    const merged2 = mergeReviewResults([
      review({ stepComplete: true, planStale: false }),
      review({ stepComplete: false, planStale: false }),
    ]);
    assert.equal(merged2.stepComplete, false);
    assert.equal(merged2.planStale, false);
  });

  it("empty results never claim a step complete", () => {
    const merged = mergeReviewResults([]);
    assert.equal(merged.stepComplete, false);
    assert.equal(merged.planStale, false);
  });
});

describe("dedupeIssues (parallel-review cross-batch dedup)", () => {
  const issue = (overrides: Partial<ReviewIssue>): ReviewIssue => ({
    severity: "medium",
    file: "src/a.ts",
    line: 5,
    issue: "Bad name",
    suggestion: "rename it",
    ...overrides,
  });

  it("collapses exact repeats (same file, line, normalized text)", () => {
    const kept = dedupeIssues([
      issue({}),
      issue({}),
      issue({ issue: "  bad   NAME " }), // whitespace/case-insensitive repeat
    ]);
    assert.equal(kept.length, 1);
  });

  it("keeps two genuinely different issues on the same line", () => {
    const kept = dedupeIssues([issue({ issue: "Bad name" }), issue({ issue: "Unused import" })]);
    assert.equal(kept.length, 2);
  });

  it("keeps the same text on different files or lines", () => {
    const kept = dedupeIssues([
      issue({ file: "src/a.ts", line: 5 }),
      issue({ file: "src/b.ts", line: 5 }),
      issue({ file: "src/a.ts", line: 9 }),
    ]);
    assert.equal(kept.length, 3);
  });

  it("uses file-based keying with an empty line slot when line is missing", () => {
    const kept = dedupeIssues([
      issue({ file: "src/a.ts", line: undefined }),
      issue({ file: "src/b.ts", line: undefined, issue: "General note" }),
      issue({ file: "src/b.ts", line: undefined, issue: "General note" }),
    ]);
    assert.equal(kept.length, 2); // both texts survive once, the b.ts repeat collapses
    assert.deepEqual(
      kept.map((i) => i.issue),
      ["Bad name", "General note"],
    );
  });

  it("falls back to normalized text alone only when file is also missing", () => {
    const kept = dedupeIssues([
      issue({ file: undefined, line: undefined, issue: "General note" }),
      issue({ file: undefined, line: undefined, issue: "General note" }),
      issue({ file: undefined, line: undefined, issue: "Other note" }),
    ]);
    assert.equal(kept.length, 2); // the repeat collapses; the distinct text survives
    assert.deepEqual(
      kept.map((i) => i.issue),
      ["General note", "Other note"],
    );

    // A file-less issue never collapses a file-anchored one with the same text.
    const kept2 = dedupeIssues([
      issue({ file: "src/a.ts", line: undefined, issue: "General note" }),
      issue({ file: undefined, line: undefined, issue: "General note" }),
    ]);
    assert.equal(kept2.length, 2);
  });

  it("keeps the same text on different files when line is missing (file participates in the key)", () => {
    const kept = dedupeIssues([
      issue({ file: "src/a.ts", line: undefined, issue: "General note" }),
      issue({ file: "src/b.ts", line: undefined, issue: "General note" }),
      issue({ file: "src/a.ts", line: undefined, issue: "General note" }),
    ]);
    assert.equal(kept.length, 2); // a.ts and b.ts both survive; the a.ts repeat collapses
  });

  it("keeps the worst severity when a duplicate is reported at different severities", () => {
    const kept = dedupeIssues([issue({ severity: "low" }), issue({ severity: "high" })]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.severity, "high");

    const kept2 = dedupeIssues([issue({ severity: "high" }), issue({ severity: "low" })]);
    assert.equal(kept2[0]?.severity, "high"); // earlier high is kept, not downgraded
  });

  it("preserves encounter order", () => {
    const kept = dedupeIssues([
      issue({ file: "src/a.ts", issue: "first" }),
      issue({ file: "src/b.ts", issue: "second" }),
      issue({ file: "src/a.ts", issue: "first" }),
    ]);
    assert.deepEqual(
      kept.map((i) => i.issue),
      ["first", "second"],
    );
  });

  it("mergeReviewResults dedupes issues across batches while keeping verdict semantics", () => {
    const merged = mergeReviewResults([
      review({ issues: [issue({})] }),
      review({ issues: [issue({}), issue({ issue: "Unused import" })] }),
    ]);
    assert.equal(merged.issues.length, 2);
    // Verdict comes from the batch verdict fields, not issue counts.
    assert.equal(merged.verdict, "pass");
    assert.equal(merged.consensus, false); // issues still block consensus

    const failing = mergeReviewResults([
      review({ issues: [issue({})] }),
      review({ verdict: "needs-work", issues: [issue({})], consensus: false }),
    ]);
    assert.equal(failing.issues.length, 1);
    assert.equal(failing.verdict, "needs-work"); // worst-of unaffected by dedup
  });
});

describe("executeWaiReview diff-only budget guard (levels are strategy-only)", () => {
  const tmpDirs: string[] = [];
  const originalAgentDir = getAgentDir();
  let emptyAgentDir: string;
  let servers: Server[] = [];

  before(() => {
    // Isolate from the real ~/.pi/agent/settings.json so the user's global
    // secondary/task models cannot leak into these probes.
    emptyAgentDir = mkdtempSync(join(tmpdir(), "review-guard-agent-"));
    setAgentDirForTests(() => emptyAgentDir);
  });

  after(() => {
    setAgentDirForTests(() => originalAgentDir);
    for (const server of servers) {
      // Force-close keep-alive sockets so the test process cannot hang on
      // open connections after the suite finishes.
      server.closeAllConnections?.();
      server.close();
    }
    servers = [];
    try {
      rmSync(emptyAgentDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function gitAvailable(): boolean {
    try {
      execFileSync("git", ["--version"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }
  const hasGit = gitAvailable();

  function gitOpts() {
    return { stdio: "pipe" as const, env: gitSpawnEnv() };
  }

  function initGitRepo(dir: string): void {
    execFileSync("git", ["init"], { cwd: dir, ...gitOpts() });
    execFileSync("git", ["config", "user.email", "wai-test@example.com"], { cwd: dir, ...gitOpts() });
    execFileSync("git", ["config", "user.name", "wai test"], { cwd: dir, ...gitOpts() });
  }

  function commitAll(dir: string): void {
    execFileSync("git", ["add", "."], { cwd: dir, ...gitOpts() });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: dir, ...gitOpts() });
  }

  function makeRepoWithChange(change: string): string {
    const cwd = mkdtempSync(join(tmpdir(), "review-guard-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    // .pi/ is gitignored (as in real projects) so runtime state files written
    // by the tool never appear as untracked entries in range-based diffs.
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.txt"), "hello\n");
    commitAll(cwd);
    writeFileSync(join(cwd, "a.txt"), change);
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    return cwd;
  }

  /** Like makeRepoWithChange, but commits N files and then rewrites each. */
  function makeRepoWithMultiFileChange(files: Record<string, string>): string {
    const cwd = mkdtempSync(join(tmpdir(), "review-guard-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    for (const name of Object.keys(files)) {
      writeFileSync(join(cwd, name), "hello\n");
    }
    commitAll(cwd);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(cwd, name), content);
    }
    const piDir = join(cwd, ".pi");
    mkdirSync(piDir, { recursive: true });
    return cwd;
  }

  /** A locally stubbed OpenAI-compatible endpoint: counts requests, tracks the
   *  observed request concurrency, and returns a canned passing review.
   *  With holdForConcurrency set, responses are withheld until that many
   *  requests are in flight simultaneously (with a fail-safe release after
   *  10s) so tests can prove calls actually overlap rather than run
   *  sequentially. */
  async function startStubServer(options?: {
    holdForConcurrency?: number;
    verdict?: "pass" | "needs-work" | "blocked" | "inconclusive";
    failOnMarker?: string;
    stepComplete?: boolean;
  }): Promise<{ url: string; bodies: string[]; peakActive: () => number }> {
    const bodies: string[] = [];
    const held: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    let releaseTimer: NodeJS.Timeout | undefined;
    const releaseAll = () => {
      if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = undefined;
      }
      while (held.length > 0) held.shift()!();
    };
    const verdict = options?.verdict ?? "pass";
    const failOnMarker = options?.failOnMarker;
    const reviewPayload =
      verdict === "pass"
        ? {
            verdict,
            issues: [],
            suggestions: [],
            consensus: true,
            stepComplete: options?.stepComplete === true ? true : undefined,
          }
        : verdict === "blocked"
          ? {
              verdict,
              issues: [{ severity: "high", issue: "fundamentally broken", suggestion: "rewrite it" }],
              suggestions: [],
              consensus: false,
            }
          : verdict === "inconclusive"
            ? { verdict: "needs-work", issues: [], suggestions: [], consensus: false }
            : {
                verdict,
                issues: [{ severity: "medium", issue: "something is wrong", suggestion: "fix it" }],
                suggestions: [],
                consensus: false,
              };
    const respond = (res: ServerResponse) => {
      active -= 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(reviewPayload),
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      );
    };
    const server = await new Promise<Server>((resolve) => {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString("utf-8");
        });
        req.on("end", () => {
          bodies.push(body);
          active += 1;
          peak = Math.max(peak, active);
          if (failOnMarker && body.includes(failOnMarker)) {
            active -= 1;
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "stub failure" }));
            releaseAll();
            return;
          }
          const target = options?.holdForConcurrency;
          if (!target || active >= target) {
            respond(res);
            releaseAll();
          } else {
            held.push(() => respond(res));
            if (!releaseTimer) {
              releaseTimer = setTimeout(releaseAll, 10_000);
            }
          }
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub server has no port");
    return {
      url: `http://127.0.0.1:${address.port}`,
      bodies,
      peakActive: () => peak,
    };
  }

  function writeSettings(cwd: string, piYoowai: Record<string, unknown>): void {
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ "pi-yoowai": piYoowai }), "utf-8");
  }

  it("min level refuses an over-budget diff with guidance instead of truncating", { skip: !hasGit }, async () => {
    // ~100KB diff → ~25k estimated tokens, far above the tiny model budget.
    const bigLine = "x".repeat(200);
    const big = Array.from({ length: 500 }, (_, i) => `${i} ${bigLine}`).join("\n");
    const cwd = makeRepoWithChange(big);
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        // If the guard regressed and a model call happened, this dead port
        // fails the test with a connection error instead of the guidance.
        backend: "http",
        baseUrl: "http://127.0.0.1:9",
      },
    });

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "oversized diff probe", ctx, {}, undefined, () => {});

    assert.ok(result.error, "expected an error result");
    assert.match(result.error, /wai_review_med/);
    assert.match(result.error, /wai_review_high/);
    assert.match(result.error, /files:\[\.\.\.\]/);
    assert.match(result.error, /too large/);
  });

  it("min level reviews a fitting diff in exactly one model call with the full diff", { skip: !hasGit }, async () => {
    const marker = "UNDER_BUDGET_MARKER_12345";
    const small = `hello\n\n${marker}\n` + "y".repeat(2000) + "\n";
    const cwd = makeRepoWithChange(small);
    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "fitting diff probe", ctx, {}, undefined, () => {});

    assert.equal(bodies.length, 1, "expected exactly one model call");
    assert.ok(bodies[0].includes(marker), "the full diff must reach the model, not be truncated");
    assert.equal(result.review?.verdict, "pass");
  });

  it(
    "review.md instructions reach the model and changing them invalidates the review cache",
    { skip: !hasGit },
    async () => {
      const marker = "INSTRUCTION_REVIEW_MARKER_777";
      const small = `hello\n\n${marker}\n` + "q".repeat(500) + "\n";
      const cwd = makeRepoWithChange(small);
      const { url, bodies } = await startStubServer();
      writeSettings(cwd, {
        reviewLevel: "min",
        secondary: {
          provider: "openai",
          id: "gpt-4o-mini",
          thinking: "off",
          contextWindow: 8000,
          maxOutputTokens: 1024,
          backend: "http",
          baseUrl: url,
          apiKey: "test-key",
        },
      });

      // Instruction file lives at .pi/yoowai/instructions/review.md.
      const instructionsDir = join(cwd, ".pi", "yoowai", "instructions");
      mkdirSync(instructionsDir, { recursive: true });
      const instructionPath = join(instructionsDir, "review.md");
      writeFileSync(instructionPath, "ALWAYS_CHECK_AUTH_V1\n", "utf-8");

      const ctx = { cwd } as unknown as ExtensionContext;
      const first = await executeWaiReview(cwd, "instructions probe", ctx, {}, undefined, () => {});
      assert.equal(first.review?.verdict, "pass");
      assert.equal(bodies.length, 1, "first review must call the model once");
      const firstBody = JSON.parse(bodies[0]) as { messages?: Array<{ role: string; content: string }> };
      const firstSystem = firstBody.messages?.find((m) => m.role === "system")?.content ?? "";
      assert.ok(
        firstSystem.includes("<user_instructions>") && firstSystem.includes("ALWAYS_CHECK_AUTH_V1"),
        "the review.md instructions must be injected into the system prompt",
      );

      // Changing the instruction content must produce a different cache key,
      // so the second review calls the model again instead of hitting the
      // 1-hour TTL review cache. (Different length also defeats the loader's
      // mtime+size fingerprint cache on coarse-timestamp filesystems.)
      writeFileSync(instructionPath, "ALWAYS_CHECK_AUTH_V2_LONGER\n", "utf-8");
      const second = await executeWaiReview(cwd, "instructions probe", ctx, {}, undefined, () => {});
      assert.equal(second.review?.verdict, "pass");
      assert.equal(bodies.length, 2, "changed instructions must invalidate the review cache");
      const secondBody = JSON.parse(bodies[1]) as { messages?: Array<{ role: string; content: string }> };
      const secondSystem = secondBody.messages?.find((m) => m.role === "system")?.content ?? "";
      assert.ok(
        secondSystem.includes("ALWAYS_CHECK_AUTH_V2_LONGER"),
        "the second review must carry the updated instructions",
      );
      assert.ok(
        !secondSystem.includes("ALWAYS_CHECK_AUTH_V1"),
        "the second review must not carry the stale V1 instructions",
      );
    },
  );

  it(
    "identical re-review with pre-review commands configured is served from cache (no second model call)",
    { skip: !hasGit },
    async () => {
      const marker = "CACHE_HIT_MARKER_555";
      const small = `hello\n\n${marker}\n` + "z".repeat(500) + "\n";
      const cwd = makeRepoWithChange(small);
      const { url, bodies } = await startStubServer();
      writeSettings(cwd, {
        reviewLevel: "min",
        // Pre-review commands used to disable the review cache entirely; the
        // comprehensive key (command LIST, not output) keeps caching correct.
        preReviewCommands: ["npm --version"],
        secondary: {
          provider: "openai",
          id: "gpt-4o-mini",
          thinking: "off",
          contextWindow: 8000,
          maxOutputTokens: 1024,
          backend: "http",
          baseUrl: url,
          apiKey: "test-key",
        },
      });

      const ctx = { cwd } as unknown as ExtensionContext;
      const first = await executeWaiReview(cwd, "cache probe", ctx, {}, undefined, () => {});
      const second = await executeWaiReview(cwd, "cache probe", ctx, {}, undefined, () => {});

      assert.equal(bodies.length, 1, "second identical review must hit the cache, not call the model again");
      assert.equal(first.review?.verdict, "pass");
      assert.equal(second.review?.verdict, "pass");
    },
  );

  it(
    "min + explicit parallelReview runs one diff-only call per file with each file's own diff",
    { skip: !hasGit },
    async () => {
      const markerA = "PARALLEL_MARKER_A_111";
      const markerB = "PARALLEL_MARKER_B_222";
      const markerC = "PARALLEL_MARKER_C_333";
      const cwd = makeRepoWithMultiFileChange({
        "a.txt": `hello\n\n${markerA}\n` + "a".repeat(500) + "\n",
        "b.txt": `hello\n\n${markerB}\n` + "b".repeat(500) + "\n",
        "c.txt": `hello\n\n${markerC}\n` + "c".repeat(500) + "\n",
      });
      const { url, bodies, peakActive } = await startStubServer({ holdForConcurrency: 3 });
      writeSettings(cwd, {
        reviewLevel: "min",
        parallelReview: true,
        secondary: {
          provider: "openai",
          id: "gpt-4o-mini",
          thinking: "off",
          contextWindow: 8000,
          maxOutputTokens: 1024,
          backend: "http",
          baseUrl: url,
          apiKey: "test-key",
        },
      });

      const ctx = { cwd } as unknown as ExtensionContext;
      const result = await executeWaiReview(cwd, "parallel diff-only probe", ctx, {}, undefined, () => {});

      assert.equal(bodies.length, 3, "expected one model call per changed file");
      assert.equal(peakActive(), 3, "the three model calls must overlap (run concurrently)");
      for (const body of bodies) {
        const present = [markerA, markerB, markerC].filter((m) => body.includes(m));
        assert.equal(present.length, 1, `each request must carry exactly one file's diff: ${body.slice(0, 200)}`);
      }
      assert.equal(result.review?.verdict, "pass");
      assert.equal(result.review?.consensus, true);
    },
  );

  it(
    "min + explicit parallelReview fails closed when one file's diff alone exceeds the budget",
    { skip: !hasGit },
    async () => {
      // a.txt is ~100KB (~25k tokens) — far above the per-file budget; b.txt
      // is small. The dead-port backend proves no model call happens: a
      // regression would surface a connection error instead of the guidance.
      const bigLine = "x".repeat(200);
      const big = Array.from({ length: 500 }, (_, i) => `${i} ${bigLine}`).join("\n");
      const cwd = makeRepoWithMultiFileChange({
        "a.txt": `hello\n\n${big}`,
        "b.txt": "hello\n\nPARALLEL_OVERFLOW_SMALL_444\n",
      });
      writeSettings(cwd, {
        reviewLevel: "min",
        parallelReview: true,
        secondary: {
          provider: "openai",
          id: "gpt-4o-mini",
          thinking: "off",
          contextWindow: 8000,
          maxOutputTokens: 1024,
          backend: "http",
          baseUrl: "http://127.0.0.1:9",
        },
      });

      const ctx = { cwd } as unknown as ExtensionContext;
      const result = await executeWaiReview(cwd, "parallel overflow probe", ctx, {}, undefined, () => {});

      assert.ok(result.error, "expected an error result");
      assert.match(result.error, /a\.txt/);
      assert.match(result.error, /wai_review_med|wai_review_high/);
      assert.match(result.error, /files:\[\.\.\.\]/);
    },
  );

  it(
    "min without parallelReview on a multi-file overflow suggests enabling parallelReview",
    { skip: !hasGit },
    async () => {
      // Two files whose combined diff exceeds the budget, but parallelReview
      // is NOT configured: the error must mention enabling it as the escape
      // hatch (the single-file overflow test cannot exercise this branch).
      const bigLine = "x".repeat(200);
      const big = Array.from({ length: 300 }, (_, i) => `${i} ${bigLine}`).join("\n");
      const cwd = makeRepoWithMultiFileChange({
        "a.txt": `hello\n\n${big}`,
        "b.txt": `hello\n\n${big}`,
      });
      writeSettings(cwd, {
        reviewLevel: "min",
        secondary: {
          provider: "openai",
          id: "gpt-4o-mini",
          thinking: "off",
          contextWindow: 8000,
          maxOutputTokens: 1024,
          backend: "http",
          baseUrl: "http://127.0.0.1:9",
        },
      });

      const ctx = { cwd } as unknown as ExtensionContext;
      const result = await executeWaiReview(cwd, "multi-file no-parallel overflow probe", ctx, {}, undefined, () => {});

      assert.ok(result.error, "expected an error result");
      assert.match(result.error, /parallelReview/);
      assert.match(result.error, /wai_review_med/);
      assert.match(result.error, /files:\[\.\.\.\]/);
    },
  );

  it("the incremental baseline advances on pass and stays put on every other verdict", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-baseline-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    // Real projects gitignore .pi/; without this, the settings file written
    // below would dirty the tree and disable the clean-tree fallback.
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    const revParse = (rev: string): string =>
      execFileSync("git", ["rev-parse", rev], { cwd, ...gitOpts() })
        .toString()
        .trim();

    writeFileSync(join(cwd, "a.txt"), "MARKER_V1\n");
    commitAll(cwd); // C0
    // Round 1 committed → clean tree with NO baseline: the fresh-baseline
    // fallback reviews HEAD~1..HEAD. A needs-work verdict must leave the
    // baseline untouched and pin a pending anchor at the range start.
    writeFileSync(join(cwd, "a.txt"), "MARKER_V2\n");
    commitAll(cwd); // C1
    const c0 = revParse("HEAD~1");

    const failing = await startStubServer({ verdict: "needs-work" });
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: failing.url,
        apiKey: "test-key",
      },
    });

    const ctx = { cwd } as unknown as ExtensionContext;
    const failingResult = await executeWaiReview(cwd, "needs-work round", ctx, {}, undefined, () => {});
    assert.equal(failingResult.review?.verdict, "needs-work");
    assert.equal(failing.bodies.length, 1, "the needs-work server must be called (no cache hit)");
    assert.equal(getLastReviewedCommit(cwd), undefined, "a needs-work review must leave the baseline unchanged");
    assert.equal(getPendingReviewCommit(cwd), c0, "a needs-work review must pin the pending anchor at the range start");

    // Blocked also leaves the baseline untouched; the pending anchor keeps
    // the failed round inside the next review's range. The next round touches
    // a DIFFERENT file, so a.txt's failed change (MARKER_V2) must still reach
    // the model as the endpoint of the range.
    writeFileSync(join(cwd, "b.txt"), "MARKER_B2\n");
    commitAll(cwd); // C2
    const blocked = await startStubServer({ verdict: "blocked" });
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: blocked.url,
        apiKey: "test-key",
      },
    });
    const blockedResult = await executeWaiReview(cwd, "blocked round", ctx, {}, undefined, () => {});
    assert.equal(blockedResult.review?.verdict, "blocked");
    assert.equal(blocked.bodies.length, 1, "the blocked server must be called (no cache hit)");
    assert.equal(getLastReviewedCommit(cwd), undefined, "a blocked review must not advance the baseline");
    assert.equal(getPendingReviewCommit(cwd), c0, "a blocked review must not move the pending anchor");
    assert.ok(blocked.bodies[0].includes("MARKER_V2"), "the failed round must stay in the blocked review's range");
    assert.ok(blocked.bodies[0].includes("MARKER_B2"), "the new round must be in the blocked review's range");

    // A SCOPED review that fails must not move the global range state either:
    // it only certifies part of the tree.
    writeFileSync(join(cwd, "b.txt"), "MARKER_B3\n");
    commitAll(cwd); // C3
    const scoped = await startStubServer({ verdict: "needs-work" });
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: scoped.url,
        apiKey: "test-key",
      },
    });
    const scopedResult = await executeWaiReview(
      cwd,
      "scoped needs-work round",
      ctx,
      { files: ["a.txt"] },
      undefined,
      () => {},
    );
    assert.equal(scopedResult.review?.verdict, "needs-work");
    assert.equal(scoped.bodies.length, 1, "the scoped server must be called (no cache hit)");
    assert.equal(getLastReviewedCommit(cwd), undefined, "a failing scoped review must not move the baseline");
    assert.equal(getPendingReviewCommit(cwd), c0, "a failing scoped review must not move the pending anchor");

    // Inconclusive (needs-work with zero issues) also leaves the range state untouched.
    writeFileSync(join(cwd, "b.txt"), "MARKER_B4\n");
    commitAll(cwd); // C4
    const inconclusive = await startStubServer({ verdict: "inconclusive" });
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: inconclusive.url,
        apiKey: "test-key",
      },
    });
    const inconclusiveResult = await executeWaiReview(cwd, "inconclusive round", ctx, {}, undefined, () => {});
    assert.equal(inconclusiveResult.review?.verdict, "needs-work");
    assert.equal(inconclusive.bodies.length, 1, "the inconclusive server must be called (no cache hit)");
    assert.equal(inconclusiveResult.review?.inconclusive, true);
    assert.equal(getLastReviewedCommit(cwd), undefined, "an inconclusive review must not advance the baseline");
    assert.equal(getPendingReviewCommit(cwd), c0, "an inconclusive review must not move the pending anchor");

    // A SCOPED PASS must not advance the baseline or clear the pending anchor
    // either: it only certifies part of the tree.
    const scopedPass = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: scopedPass.url,
        apiKey: "test-key",
      },
    });
    const scopedPassResult = await executeWaiReview(
      cwd,
      "scoped pass round",
      ctx,
      { files: ["a.txt"] },
      undefined,
      () => {},
    );
    assert.equal(scopedPassResult.review?.verdict, "pass");
    assert.equal(scopedPass.bodies.length, 1, "the scoped-pass server must be called (no cache hit)");
    assert.equal(getLastReviewedCommit(cwd), undefined, "a passing scoped review must not advance the baseline");
    assert.equal(getPendingReviewCommit(cwd), c0, "a passing scoped review must not clear the pending anchor");

    // A whole-tree pass advances the baseline to HEAD and clears the anchor.
    writeFileSync(join(cwd, "a.txt"), "MARKER_V6\n");
    commitAll(cwd); // C5
    const passing = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: passing.url,
        apiKey: "test-key",
      },
    });

    const passingResult = await executeWaiReview(cwd, "passing round", ctx, {}, undefined, () => {});
    assert.equal(passingResult.review?.verdict, "pass");
    assert.equal(passing.bodies.length, 1, "the passing server must be called (no cache hit)");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, ...gitOpts() })
      .toString()
      .trim();
    assert.equal(getLastReviewedCommit(cwd), head, "a pass must advance the baseline to HEAD");
    assert.equal(getPendingReviewCommit(cwd), undefined, "a pass must clear the pending anchor");
  });

  it("a cached pass re-anchors the baseline after a reset", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-cache-baseline-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.txt"), "v1\n");
    commitAll(cwd);
    writeFileSync(join(cwd, "a.txt"), "v2\n");
    commitAll(cwd);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, ...gitOpts() })
      .toString()
      .trim();

    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });

    const ctx = { cwd } as unknown as ExtensionContext;
    const first = await executeWaiReview(cwd, "cache baseline probe", ctx, {}, undefined, () => {});
    assert.equal(first.review?.verdict, "pass");
    assert.equal(getLastReviewedCommit(cwd), head);

    // Simulate a plan/session reset; the identical re-review is served from
    // the cache and must re-anchor the baseline to the current HEAD so the
    // next review does not re-diff already-reviewed commits.
    setLastReviewedCommit(cwd, undefined);
    const second = await executeWaiReview(cwd, "cache baseline probe", ctx, {}, undefined, () => {});
    assert.equal(second.review?.verdict, "pass");
    assert.equal(bodies.length, 1, "the second identical review must hit the cache");
    assert.equal(getLastReviewedCommit(cwd), head, "a cached pass must re-anchor the baseline");
    // A cache hit must also re-record the reviewed files for prior context.
    assert.equal(getReviewedFiles(cwd)["a.txt"]?.verdict, "pass");
  });

  it("a root commit on a clean tree is reviewed via the empty-tree diff", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-root-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.ts"), "export const rootMarker = 7;\n");
    commitAll(cwd); // the ONLY commit (root)

    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "root commit probe", ctx, {}, undefined, () => {});
    assert.equal(result.review?.verdict, "pass");
    assert.equal(bodies.length, 1);
    assert.ok(bodies[0].includes("rootMarker"), "the root commit's content must reach the reviewer");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, ...gitOpts() })
      .toString()
      .trim();
    assert.equal(getLastReviewedCommit(cwd), head, "a passing root-commit review must anchor the baseline");
  });

  it("hunk-split reviews record the file with its merged verdict", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-hunk-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    const bigLine = "x".repeat(150);
    const block = (start: number) => Array.from({ length: 100 }, (_, i) => `${start + i} ${bigLine}`).join("\n");
    const gap = "\n\n\n\n\nunchanged\n\n\n\n\n";
    // The gap lines must exist in BOTH versions so git emits separate hunks
    // (context lines cannot be additions).
    const oldContent = `hello\n\n${block(0)}\n${gap}${block(100)}\n${gap}${block(200)}\n`;
    writeFileSync(join(cwd, "big.txt"), oldContent);
    commitAll(cwd);
    // Replace each block's lines (v2 content) → three hunks; ~11k tokens of
    // diff over the 8k model budget → hunk split.
    const newContent = `hello\n\n${block(10000)}\n${gap}${block(10100)}\n${gap}${block(10200)}\n`;
    writeFileSync(join(cwd, "big.txt"), newContent);

    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "med",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "hunk split probe", ctx, {}, undefined, () => {});
    assert.equal(result.review?.verdict, "pass");
    assert.ok(bodies.length > 1, `expected multiple hunk calls, got ${bodies.length}`);
    assert.equal(getReviewedFiles(cwd)["big.txt"]?.verdict, "pass");
  });

  it("a partial parallel batch failure must not advance the baseline or record a pass", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-incomplete-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, "a.ts"), "hello\n");
    writeFileSync(join(cwd, "b.ts"), "hello\n");
    writeFileSync(join(cwd, "c.ts"), "hello\n");
    commitAll(cwd);
    writeFileSync(join(cwd, "a.ts"), "PARALLEL_FAIL_MARKER_999\n");
    writeFileSync(join(cwd, "b.ts"), "hello\nb2\n");
    writeFileSync(join(cwd, "c.ts"), "hello\nc2\n");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, ...gitOpts() })
      .toString()
      .trim();

    const { url, bodies } = await startStubServer({ failOnMarker: "PARALLEL_FAIL_MARKER_999" });
    writeSettings(cwd, {
      reviewLevel: "min",
      parallelReview: true,
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        maxRetries: 0,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "incomplete parallel probe", ctx, {}, undefined, () => {});
    // The surviving batches all passed, but the review is incomplete: the
    // public verdict must NOT read as success.
    assert.equal(result.review?.verdict, "needs-work");
    assert.equal(result.review?.consensus, false, "a partial failure must break consensus");
    assert.ok(
      result.review?.suggestions.some((s) => s.includes("Review failed for 1 file")),
      "the failure must be surfaced",
    );
    // No baseline advancement; the pending anchor keeps the failed range in scope.
    assert.equal(getLastReviewedCommit(cwd), undefined, "an incomplete review must not advance the baseline");
    assert.equal(getPendingReviewCommit(cwd), head, "an incomplete review must pin the pending anchor");
    // maxRetries: 0 is honored end-to-end: one failed request (a.ts) + two
    // successful ones (b.ts, c.ts) per run.
    assert.equal(bodies.length, 3, "exactly one request per batch with maxRetries: 0");
    // Only the successfully reviewed batches are recorded.
    assert.equal(getReviewedFiles(cwd)["a.ts"], undefined, "the failed file must not be recorded as pass");
    assert.equal(getReviewedFiles(cwd)["b.ts"]?.verdict, "pass");
    assert.equal(getReviewedFiles(cwd)["c.ts"]?.verdict, "pass");

    // The incomplete review must NOT be cached: an identical retry re-runs
    // the model and still must not advance (3 more requests).
    const retry = await executeWaiReview(cwd, "incomplete parallel probe", ctx, {}, undefined, () => {});
    assert.equal(retry.review?.verdict, "needs-work");
    assert.equal(bodies.length, 6, "the retry must not be served from the review cache");
    assert.equal(getLastReviewedCommit(cwd), undefined, "the retry must still not advance the baseline");
    assert.equal(getPendingReviewCommit(cwd), head, "the retry must keep the pending anchor");
  });

  it(
    "an incomplete batch review must not advance the plan even when sub-reviews claim stepComplete",
    { skip: !hasGit },
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "review-incomplete-plan-repo-"));
      tmpDirs.push(cwd);
      initGitRepo(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, "a.ts"), "hello\n");
      writeFileSync(join(cwd, "b.ts"), "hello\n");
      commitAll(cwd);
      writeFileSync(join(cwd, "a.ts"), "PLAN_FAIL_MARKER_888\n");
      writeFileSync(join(cwd, "b.ts"), "hello\nb2\n");
      setPlan(cwd, { summary: "plan", todo: ["step one"], acceptanceCriteria: [] });

      const { url } = await startStubServer({ failOnMarker: "PLAN_FAIL_MARKER_888", stepComplete: true });
      writeSettings(cwd, {
        reviewLevel: "min",
        parallelReview: true,
        secondary: {
          provider: "openai",
          id: "gpt-4o-mini",
          thinking: "off",
          contextWindow: 8000,
          maxOutputTokens: 1024,
          maxRetries: 0,
          backend: "http",
          baseUrl: url,
          apiKey: "test-key",
        },
      });

      const ctx = { cwd } as unknown as ExtensionContext;
      const result = await executeWaiReview(cwd, "incomplete plan probe", ctx, {}, undefined, () => {});
      assert.equal(result.review?.verdict, "needs-work");
      assert.equal(getState(cwd).completedSteps, 0, "an incomplete review must not advance the plan tracker");
    },
  );

  it("prior-round context reaches the model and its digest drives the cache key", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-prior-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.ts"), "export function nameInput() { return 1; }\n");
    commitAll(cwd); // C0
    writeFileSync(join(cwd, "a.ts"), "export function nameInput() { return 2; }\n");
    commitAll(cwd); // C1 — round 1: a.ts reviewed and passed
    const c1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd, ...gitOpts() })
      .toString()
      .trim();

    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });

    const ctx = { cwd } as unknown as ExtensionContext;
    // Round 1 review (fresh baseline → last commit): establishes the
    // baseline and records a.ts with its pass verdict automatically.
    const roundOne = await executeWaiReview(cwd, "round one", ctx, {}, undefined, () => {});
    assert.equal(roundOne.review?.verdict, "pass");
    // The review itself must have recorded the round for prior context.
    assert.equal(getReviewedFiles(cwd)["a.ts"]?.verdict, "pass");

    // Round 2: only b.ts changes. The reviewer must learn that a.ts was
    // implemented and reviewed in round 1 instead of flagging it missing.
    writeFileSync(join(cwd, "b.ts"), "export const icon = 'x';\n");
    commitAll(cwd); // C2
    const roundTwo = await executeWaiReview(cwd, "prior context probe", ctx, {}, undefined, () => {});
    assert.equal(roundTwo.review?.verdict, "pass");
    assert.equal(bodies.length, 2);
    const roundTwoBody = JSON.parse(bodies[1]) as { messages?: Array<{ role: string; content: string }> };
    const roundTwoUser = roundTwoBody.messages?.find((m) => m.role === "user")?.content ?? "";
    assert.ok(roundTwoUser.includes("<prior_review_context>"), "prior context must reach the model");
    assert.ok(roundTwoUser.includes("a.ts — last review verdict: pass"), "the prior verdict line must reach the model");
    assert.ok(roundTwoUser.includes("nameInput"), "the prior outline must reach the model");

    // Identical re-review (same range, same prior digest): cache hit.
    setLastReviewedCommit(cwd, c1);
    const repeat = await executeWaiReview(cwd, "prior context probe", ctx, {}, undefined, () => {});
    assert.equal(repeat.review?.verdict, "pass");
    assert.equal(bodies.length, 2, "identical prior context must keep the cache key stable");

    // Changed prior verdict → different digest → cache miss → fresh call.
    recordReviewedFiles(cwd, ["a.ts"], "needs-work");
    setLastReviewedCommit(cwd, c1);
    const changed = await executeWaiReview(cwd, "prior context probe", ctx, {}, undefined, () => {});
    assert.equal(changed.review?.verdict, "pass");
    assert.equal(bodies.length, 3, "changed prior context must invalidate the cache");
    const changedBody = JSON.parse(bodies[2]) as { messages?: Array<{ role: string; content: string }> };
    const changedUser = changedBody.messages?.find((m) => m.role === "user")?.content ?? "";
    assert.ok(changedUser.includes("a.ts — last review verdict: needs-work"));
  });

  it("the baseline survives a restart via plan-store persistence", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-restart-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.txt"), "MARKER_A\n");
    commitAll(cwd); // C0
    writeFileSync(join(cwd, "a.txt"), "MARKER_B\n");
    commitAll(cwd); // C1 — accepted baseline after the first review
    const c1 = execFileSync("git", ["rev-parse", "HEAD"], { cwd, ...gitOpts() })
      .toString()
      .trim();

    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    const first = await executeWaiReview(cwd, "restart round one", ctx, {}, undefined, () => {});
    assert.equal(first.review?.verdict, "pass");
    assert.equal(getLastReviewedCommit(cwd), c1);

    // "Restart": drop the in-memory state and reload from disk.
    dropSessionState(cwd);
    assert.equal(getLastReviewedCommit(cwd), c1, "the baseline must survive a session restart");

    // Two more commits. The next review must diff from the persisted baseline
    // (both new commits in scope), not the fresh HEAD~1 fallback (one commit).
    writeFileSync(join(cwd, "b.txt"), "MARKER_C\n");
    commitAll(cwd); // C2
    writeFileSync(join(cwd, "c.txt"), "MARKER_D\n");
    commitAll(cwd); // C3
    const second = await executeWaiReview(cwd, "restart round two", ctx, {}, undefined, () => {});
    assert.equal(second.review?.verdict, "pass");
    const body = bodies[1];
    assert.ok(body.includes("MARKER_C"), "commit C2 must be in the restart review's range");
    assert.ok(body.includes("MARKER_D"), "commit C3 must be in the restart review's range");
  });

  it("a failed root-commit review pins the empty-tree anchor", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-root-pending-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.txt"), "ROOT_FAIL_MARKER\n");
    commitAll(cwd); // the ONLY commit (root)

    const { url, bodies } = await startStubServer({ verdict: "needs-work" });
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    const first = await executeWaiReview(cwd, "root fail round", ctx, {}, undefined, () => {});
    assert.equal(first.review?.verdict, "needs-work");
    assert.ok(bodies[0].includes("ROOT_FAIL_MARKER"), "the root commit must be reviewed");
    assert.ok(getPendingReviewCommit(cwd), "the empty-tree anchor must be pinned");
    assert.equal(getLastReviewedCommit(cwd), undefined);

    // A second commit must not drop the failed root round from the range.
    writeFileSync(join(cwd, "b.txt"), "ROOT_FOLLOWUP\n");
    commitAll(cwd);
    const second = await executeWaiReview(cwd, "root follow-up round", ctx, {}, undefined, () => {});
    assert.equal(second.review?.verdict, "needs-work");
    assert.ok(bodies[1].includes("ROOT_FAIL_MARKER"), "the failed root round must stay in range");
    assert.ok(bodies[1].includes("ROOT_FOLLOWUP"), "the follow-up must be in range");
  });

  it(
    "a dirty retry diffs against the pending anchor, keeping the failed round visible",
    { skip: !hasGit },
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "review-dirty-retry-repo-"));
      tmpDirs.push(cwd);
      initGitRepo(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
      writeFileSync(join(cwd, "a.txt"), "DIRTY_FAIL_MARKER\n");
      writeFileSync(join(cwd, "b.txt"), "B1\n");
      commitAll(cwd); // C0
      writeFileSync(join(cwd, "a.txt"), "DIRTY_FAIL_MARKER_2\n");
      commitAll(cwd); // C1 — the round that fails (a.txt only)

      const { url, bodies } = await startStubServer({ verdict: "needs-work" });
      writeSettings(cwd, {
        reviewLevel: "min",
        secondary: {
          provider: "openai",
          id: "gpt-4o-mini",
          thinking: "off",
          contextWindow: 8000,
          maxOutputTokens: 1024,
          backend: "http",
          baseUrl: url,
          apiKey: "test-key",
        },
      });
      const ctx = { cwd } as unknown as ExtensionContext;
      const first = await executeWaiReview(cwd, "dirty fail round", ctx, {}, undefined, () => {});
      assert.equal(first.review?.verdict, "needs-work");

      // Dirty retry: uncommitted work on a DIFFERENT tracked file — so the
      // failed round's change stays an endpoint of `git diff <pending>` and
      // remains visible. (`git diff <base>` never includes untracked files.)
      writeFileSync(join(cwd, "b.txt"), "DIRTY_WIP\n");
      const second = await executeWaiReview(cwd, "dirty retry round", ctx, {}, undefined, () => {});
      assert.equal(second.review?.verdict, "needs-work");
      assert.ok(bodies[1].includes("DIRTY_FAIL_MARKER_2"), "the failed committed round must stay in the dirty diff");
      assert.ok(bodies[1].includes("DIRTY_WIP"), "the uncommitted work must be in the dirty diff");
    },
  );

  it("a failed range after an accepted baseline still wins the next clean retry", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-pending-over-baseline-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.txt"), "MARKER_BASE\n");
    commitAll(cwd); // C0
    writeFileSync(join(cwd, "a.txt"), "MARKER_ACCEPTED\n");
    commitAll(cwd); // C1 — accepted baseline

    const { url } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    // Accept the baseline.
    const accepted = await executeWaiReview(cwd, "accept baseline round", ctx, {}, undefined, () => {});
    assert.equal(accepted.review?.verdict, "pass");
    const baseline = getLastReviewedCommit(cwd);
    assert.ok(baseline);

    // A later round fails (server switched to needs-work).
    writeFileSync(join(cwd, "b.txt"), "MARKER_FAILED_ROUND\n");
    commitAll(cwd); // C2
    const failing = await startStubServer({ verdict: "needs-work" });
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: failing.url,
        apiKey: "test-key",
      },
    });
    const failed = await executeWaiReview(cwd, "fail later round", ctx, {}, undefined, () => {});
    assert.equal(failed.review?.verdict, "needs-work");
    assert.equal(getLastReviewedCommit(cwd), baseline, "the accepted baseline must stay put");
    assert.ok(failing.bodies[0].includes("MARKER_FAILED_ROUND"));

    // Retry after ANOTHER commit: the failed round must still be in range.
    writeFileSync(join(cwd, "c.txt"), "MARKER_NEXT\n");
    commitAll(cwd); // C3
    const retry = await executeWaiReview(cwd, "retry failed round", ctx, {}, undefined, () => {});
    assert.equal(retry.review?.verdict, "needs-work");
    assert.ok(failing.bodies[1].includes("MARKER_FAILED_ROUND"), "the failed round must stay in the retry's range");
    assert.ok(failing.bodies[1].includes("MARKER_NEXT"), "the new commit must be in the retry's range");
  });

  it("a total single-batch failure pins the attempted range", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-single-fail-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.txt"), "SINGLE_FAIL_MARKER\n");
    commitAll(cwd); // C0
    writeFileSync(join(cwd, "a.txt"), "SINGLE_FAIL_MARKER_2\n");
    commitAll(cwd); // C1 — the range that will fail
    const c0 = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd, ...gitOpts() })
      .toString()
      .trim();

    const { url, bodies } = await startStubServer({ failOnMarker: "SINGLE_FAIL_MARKER_2" });
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        maxRetries: 0,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    const first = await executeWaiReview(cwd, "single batch fail round", ctx, {}, undefined, () => {});
    assert.ok(first.error, "the batch must fail");
    assert.equal(bodies.length, 1, "maxRetries: 0 → exactly one request per failed review");
    assert.equal(getLastReviewedCommit(cwd), undefined);
    assert.equal(getPendingReviewCommit(cwd), c0, "the attempted range must be pinned");

    // HEAD moves; the retry's range must still include the failed commit.
    writeFileSync(join(cwd, "b.txt"), "SINGLE_FAIL_NEXT\n");
    commitAll(cwd); // C2
    const second = await executeWaiReview(cwd, "single batch retry round", ctx, {}, undefined, () => {});
    assert.ok(second.error);
    // maxRetries: 0 is now honored end-to-end (config → http backend): each
    // failing review makes EXACTLY one request, proving the wiring.
    assert.equal(bodies.length, 2, "maxRetries: 0 must disable the backend's own retries");
    const retryBody = bodies[bodies.length - 1];
    assert.ok(retryBody.includes("SINGLE_FAIL_MARKER_2"), "the failed commit must stay in the retry's range");
    assert.ok(retryBody.includes("SINGLE_FAIL_NEXT"), "the new commit must be in the retry's range");
  });

  it("an inconclusive review does not pin the pending anchor", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-inconclusive-nopin-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.txt"), "v1\n");
    commitAll(cwd);
    writeFileSync(join(cwd, "a.txt"), "v2\n");
    commitAll(cwd);

    const { url } = await startStubServer({ verdict: "inconclusive" });
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "inconclusive no-pin round", ctx, {}, undefined, () => {});
    assert.equal(result.review?.verdict, "needs-work");
    assert.equal(result.review?.inconclusive, true);
    assert.equal(getPendingReviewCommit(cwd), undefined, "an inconclusive review must not pin the anchor");
    assert.equal(getLastReviewedCommit(cwd), undefined);
  });

  it("malformed persisted anchors degrade gracefully instead of breaking reviews", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-malformed-state-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.txt"), "MALFORMED_MARKER\n");
    commitAll(cwd); // C0
    writeFileSync(join(cwd, "a.txt"), "MALFORMED_MARKER_2\n");
    commitAll(cwd); // C1

    // Hand-edit the persisted state with unresolvable anchors.
    const stateDir = join(cwd, ".pi", "yoowai");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "plan.json"),
      JSON.stringify({
        lastReviewedCommit: "not-a-real-sha",
        pendingReviewCommit: "deadbeefdeadbeef",
        reviewedFiles: { "a.txt": { verdict: "pass", at: 1 } },
      }),
      "utf-8",
    );
    dropSessionState(cwd);

    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "malformed state probe", ctx, {}, undefined, () => {});
    assert.equal(result.review?.verdict, "pass");
    assert.ok(bodies[0].includes("MALFORMED_MARKER_2"), "the review must fall back to a valid range");
  });

  it("a capped multi-file diff is split per file so no changed file is dropped", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-capped-split-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.txt"), "a1\n");
    writeFileSync(join(cwd, "b.txt"), "b1\n");
    writeFileSync(join(cwd, "c.txt"), "c1\n");
    writeFileSync(join(cwd, "d.txt"), "d1\n");
    commitAll(cwd);
    // Each file gains ~800 chars with a unique marker; the combined diff
    // (~3.2k chars) exceeds the 2000-char cap → truncated. Per-file diffs
    // stay under the cap, so the parallel rebuild must cover everything.
    const filler = "y".repeat(780);
    writeFileSync(join(cwd, "a.txt"), `CAPPED_MARKER_A_111\n${filler}\n`);
    writeFileSync(join(cwd, "b.txt"), `CAPPED_MARKER_B_222\n${filler}\n`);
    writeFileSync(join(cwd, "c.txt"), `CAPPED_MARKER_C_333\n${filler}\n`);
    writeFileSync(join(cwd, "d.txt"), `CAPPED_MARKER_D_444\n${filler}\n`);

    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "med",
      reviewMaxDiffChars: 2000,
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "capped split probe", ctx, {}, undefined, () => {});
    assert.equal(result.review?.verdict, "pass");
    assert.equal(bodies.length, 4, "one parallel batch per changed file");
    // Every changed file's marker reaches SOME parallel request — the tail
    // files are no longer silently dropped by the combined-diff cap.
    const allBodies = bodies.join("");
    for (const marker of ["CAPPED_MARKER_A_111", "CAPPED_MARKER_B_222", "CAPPED_MARKER_C_333", "CAPPED_MARKER_D_444"]) {
      assert.ok(allBodies.includes(marker), `${marker} must reach a review batch`);
    }
    // Fully covered: no truncation downgrade, nothing dropped, no omission hint.
    assert.ok(!result.review?.inconclusive, "a fully covered parallel review must not be inconclusive");
    assert.ok(!result.review?.truncated, "a fully covered parallel review must not be flagged truncated");
    assert.deepEqual(result.review?.droppedFiles ?? [], []);
    assert.ok(!result.review?.suggestions.some((s) => s.includes("omitted")));
    // Rebuilt batches must not be TOLD their (complete) diff is truncated.
    assert.ok(
      !allBodies.includes("diff was truncated"),
      "complete per-file batches must not carry the truncation notice",
    );
  });

  it("a cap that cuts MID-FILE refetches the boundary file completely", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-capped-boundary-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.txt"), "a1\n");
    writeFileSync(join(cwd, "b.txt"), "b1\n");
    writeFileSync(join(cwd, "c.txt"), "c1\n");
    commitAll(cwd);
    // Combined diff ~1400 chars with cap 1000: git slices mid-b.txt, so the
    // boundary file's combined slice is truthy but INCOMPLETE — its tail
    // marker would be lost without the per-file refetch.
    writeFileSync(join(cwd, "a.txt"), `BOUNDARY_A\n` + "y".repeat(290) + "\n");
    writeFileSync(join(cwd, "b.txt"), `head\n` + "y".repeat(700) + `\nBOUNDARY_B_TAIL_999\n`);
    writeFileSync(join(cwd, "c.txt"), `BOUNDARY_C\n` + "y".repeat(290) + "\n");

    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "med",
      reviewMaxDiffChars: 1000,
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "capped boundary probe", ctx, {}, undefined, () => {});
    assert.equal(result.review?.verdict, "pass");
    assert.equal(bodies.length, 3, "one parallel batch per changed file");
    const allBodies = bodies.join("");
    assert.ok(allBodies.includes("BOUNDARY_A"), "file a must reach a batch");
    assert.ok(allBodies.includes("BOUNDARY_B_TAIL_999"), "the boundary file's TAIL marker must reach a batch");
    assert.ok(allBodies.includes("BOUNDARY_C"), "file c must reach a batch");
    assert.ok(!result.review?.inconclusive, "complete per-file coverage must keep the pass");
    assert.ok(!result.review?.truncated);
  });

  it("a pass on a truncated diff is downgraded to inconclusive and never cached", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-truncated-pass-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "big.txt"), "hello\n");
    commitAll(cwd);
    // ~5.5k tokens of diff: fits the model budget loosely enough to avoid the
    // diff-only guard (med = auto strategy) but exceeds the remaining diff
    // budget, forcing the single-call truncation path.
    const bigLine = "x".repeat(150);
    const big = Array.from({ length: 145 }, (_, i) => `${i} ${bigLine}`).join("\n");
    writeFileSync(join(cwd, "big.txt"), `hello\n\n${big}\n`);

    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "med",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });
    const ctx = { cwd } as unknown as ExtensionContext;
    const first = await executeWaiReview(cwd, "truncated pass probe", ctx, {}, undefined, () => {});
    assert.equal(first.review?.verdict, "needs-work", "a pass on a truncated diff must be downgraded");
    assert.equal(first.review?.inconclusive, true);
    assert.equal(getLastReviewedCommit(cwd), undefined, "a truncated pass must not advance the baseline");
    assert.ok(
      first.review?.suggestions.some((s) => s.includes("truncated")),
      "the downgrade must tell the user why",
    );

    // Identical retry: not served from the cache (inconclusive results are
    // never cached) — the model is called again.
    const second = await executeWaiReview(cwd, "truncated pass probe", ctx, {}, undefined, () => {});
    assert.equal(second.review?.verdict, "needs-work");
    assert.equal(bodies.length, 2, "an inconclusive result must not be cached");
  });

  it(
    "a pass with budget-dropped file CONTENTS stays a pass (the diff still covers the change)",
    { skip: !hasGit },
    async () => {
      // The file is huge (contents exceed the model budget → dropped), but the
      // DIFF is tiny: the change was fully reviewed, so the pass stands and is
      // only marked contextLimited with a hint.
      const cwd = mkdtempSync(join(tmpdir(), "review-drop-contract-repo-"));
      tmpDirs.push(cwd);
      initGitRepo(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
      // The big file (contents ~12k tokens) exists from the start; the CHANGE
      // is one line, so the diff is tiny and fully reviewed.
      const filler = Array.from({ length: 5000 }, () => "y".repeat(10)).join("\n");
      writeFileSync(join(cwd, "big.txt"), `hello\n${filler}\n`);
      commitAll(cwd);
      writeFileSync(join(cwd, "big.txt"), `DROPPED_CONTENTS_MARKER\n${filler}\n`);

      const { url } = await startStubServer();
      writeSettings(cwd, {
        // full-files strategy: the oversized file's CONTENTS are dropped for
        // the model budget, while its (tiny) diff is fully reviewed.
        reviewLevel: "high",
        secondary: {
          provider: "openai",
          id: "gpt-4o-mini",
          thinking: "off",
          contextWindow: 8000,
          maxOutputTokens: 1024,
          backend: "http",
          baseUrl: url,
          apiKey: "test-key",
        },
      });
      const ctx = { cwd } as unknown as ExtensionContext;
      const result = await executeWaiReview(cwd, "dropped contents probe", ctx, {}, undefined, () => {});
      assert.equal(result.review?.verdict, "pass", "a fully-diffed change with dropped contents is still a pass");
      assert.equal(result.review?.contextLimited, true);
      assert.ok(
        (result.review?.droppedFiles ?? []).includes("big.txt"),
        "the dropped file must be reported for transparency",
      );
      assert.ok(
        result.review?.suggestions.some((s) => s.includes("omitted")),
        "the context-limited hint must reach the user",
      );
    },
  );

  it(
    "a scoped truncated pass is downgraded and not cached (scoped reviews are self-contained)",
    { skip: !hasGit },
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "review-scoped-trunc-repo-"));
      tmpDirs.push(cwd);
      initGitRepo(cwd);
      mkdirSync(join(cwd, ".pi"), { recursive: true });
      writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
      writeFileSync(join(cwd, "a.txt"), "hello\n");
      commitAll(cwd);
      const big = Array.from({ length: 60 }, (_, i) => `${i} ` + "x".repeat(80)).join("\n");
      writeFileSync(join(cwd, "a.txt"), `hello\n${big}\n`);

      const { url, bodies } = await startStubServer();
      writeSettings(cwd, {
        reviewLevel: "min",
        reviewMaxDiffChars: 300,
        secondary: {
          provider: "openai",
          id: "gpt-4o-mini",
          thinking: "off",
          contextWindow: 8000,
          maxOutputTokens: 1024,
          backend: "http",
          baseUrl: url,
          apiKey: "test-key",
        },
      });
      const ctx = { cwd } as unknown as ExtensionContext;
      const first = await executeWaiReview(
        cwd,
        "scoped truncated probe",
        ctx,
        { files: ["a.txt"] },
        undefined,
        () => {},
      );
      assert.equal(first.review?.verdict, "needs-work", "a scoped truncated pass must be downgraded");
      assert.equal(first.review?.inconclusive, true);
      // Scoped reviews never touch range state (they are self-contained).
      assert.equal(getLastReviewedCommit(cwd), undefined);
      assert.equal(getPendingReviewCommit(cwd), undefined);
      // Not cached: an identical retry re-runs the model.
      const second = await executeWaiReview(
        cwd,
        "scoped truncated probe",
        ctx,
        { files: ["a.txt"] },
        undefined,
        () => {},
      );
      assert.equal(second.review?.verdict, "needs-work");
      assert.equal(bodies.length, 2, "a scoped coverage-inconclusive result must not be cached");
    },
  );

  it("a failed round stays in the next review's range via the pending anchor", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-pending-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.ts"), "export const a = 1;\n");
    commitAll(cwd); // C0
    writeFileSync(join(cwd, "a.ts"), "export const failedMarker = 42;\n");
    commitAll(cwd); // C1 — the round that will fail
    const c0 = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd, ...gitOpts() })
      .toString()
      .trim();

    const { url, bodies } = await startStubServer({ verdict: "needs-work" });
    writeSettings(cwd, {
      reviewLevel: "min",
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });

    const ctx = { cwd } as unknown as ExtensionContext;
    // Review 1: fresh-baseline fallback (HEAD~1 = C0) → C0..C1, needs-work.
    const first = await executeWaiReview(cwd, "failed round", ctx, {}, undefined, () => {});
    assert.equal(first.review?.verdict, "needs-work");
    assert.equal(getLastReviewedCommit(cwd), undefined, "the baseline must stay put on failure");
    assert.equal(getPendingReviewCommit(cwd), c0, "the pending anchor must pin the reviewed range start");
    assert.ok(bodies[0].includes("failedMarker"), "round 1 must review the failed commit");

    // Commit a follow-up (another file). The next review must STILL include
    // the failed round: a dynamic HEAD~1 (= C1 now) would skip it.
    writeFileSync(join(cwd, "b.ts"), "export const b = 2;\n");
    commitAll(cwd); // C2
    const second = await executeWaiReview(cwd, "follow-up round", ctx, {}, undefined, () => {});
    assert.equal(second.review?.verdict, "needs-work");
    assert.equal(getLastReviewedCommit(cwd), undefined);
    assert.equal(getPendingReviewCommit(cwd), c0, "the pending anchor survives until a pass");
    assert.ok(bodies[1].includes("failedMarker"), "the failed round must stay in the next review's range");
    assert.ok(bodies[1].includes("export const b = 2"), "the follow-up round must be in the range too");
  });

  it("priorReviewMaxTokens: 0 disables prior-round context", { skip: !hasGit }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "review-prior-disabled-repo-"));
    tmpDirs.push(cwd);
    initGitRepo(cwd);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".gitignore"), ".pi/\n", "utf-8");
    writeFileSync(join(cwd, "a.ts"), "export function nameInput() { return 1; }\n");
    commitAll(cwd);
    writeFileSync(join(cwd, "a.ts"), "export function nameInput() { return 2; }\n");
    commitAll(cwd);
    recordReviewedFiles(cwd, ["a.ts"], "pass");

    const { url, bodies } = await startStubServer();
    writeSettings(cwd, {
      reviewLevel: "min",
      priorReviewMaxTokens: 0,
      secondary: {
        provider: "openai",
        id: "gpt-4o-mini",
        thinking: "off",
        contextWindow: 8000,
        maxOutputTokens: 1024,
        backend: "http",
        baseUrl: url,
        apiKey: "test-key",
      },
    });

    const ctx = { cwd } as unknown as ExtensionContext;
    const result = await executeWaiReview(cwd, "prior disabled probe", ctx, {}, undefined, () => {});
    assert.equal(result.review?.verdict, "pass");
    const body = JSON.parse(bodies[0]) as { messages?: Array<{ role: string; content: string }> };
    const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
    assert.ok(!user.includes("<prior_review_context>"), "prior context must be disabled by priorReviewMaxTokens: 0");
  });
});
