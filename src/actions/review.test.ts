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
    const respond = (res: ServerResponse) => {
      active -= 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ verdict: "pass", issues: [], suggestions: [], consensus: true }),
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
});
