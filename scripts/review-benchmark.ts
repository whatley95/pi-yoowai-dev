import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BENCHMARK_CASES, scoreBenchmark } from "../src/review-benchmark.js";
import { gitSpawnEnv } from "../src/git-env.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--fixtures") {
    console.log(JSON.stringify(BENCHMARK_CASES, null, 2));
    return;
  }
  if (args[0] === "--score" && args[1]) {
    const report = JSON.parse(readFileSync(args[1], "utf8"));
    console.log(JSON.stringify(scoreBenchmark(report.observations), null, 2));
    return;
  }
  if (args.length !== 3 || args[0] !== "--live" || args[1] !== "--output")
    throw new Error("Usage: npm run benchmark -- --fixtures | --score <report.json> | --live --output <report.json>");
  const { loadYoowaiConfig } = await import("../src/config.js");
  const { executeWaiReview } = await import("../src/actions/review.js");
  const { getSessionCost } = await import("../src/cost-tracker.js");
  const source = loadYoowaiConfig(process.cwd());
  if (!source.secondary.provider || !source.secondary.id)
    throw new Error("Configure a secondary model before running the live benchmark.");
  const observations = [];
  let totalSpent = 0;
  const root = mkdtempSync(join(tmpdir(), "wai-benchmark-"));
  try {
    for (const fixture of BENCHMARK_CASES) {
      const cwd = join(root, fixture.id);
      mkdirSync(cwd);
      const git = (args: string[]) => execFileSync("git", args, { cwd, env: gitSpawnEnv(), stdio: "pipe" });
      git(["init"]);
      writeFileSync(join(cwd, ".gitignore"), ".pi/\n");
      writeFileSync(join(cwd, "subject.js"), fixture.before);
      git(["add", "."]);
      git([
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Benchmark",
        "-c",
        "user.email=benchmark@example.com",
        "commit",
        "-m",
        "baseline",
      ]);
      writeFileSync(join(cwd, "subject.js"), fixture.after);
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
          "pi-yoowai": {
            ...source,
            autoJudge: false,
            reviewLevel: "min",
            preReviewCommands: [],
            autoPreReviewCommands: false,
            toolUseLoop: false,
            parallelReview: false,
            costBudgetUsd:
              source.costBudgetUsd === undefined || source.costBudgetUsd < 0
                ? undefined
                : Math.max(0, source.costBudgetUsd - totalSpent),
          },
        }),
        { mode: 0o600 },
      );
      const start = performance.now();
      let result;
      try {
        result = await executeWaiReview(
          cwd,
          "Review this change for concrete correctness and security defects.",
          { cwd } as Parameters<typeof executeWaiReview>[2],
          {},
          undefined,
          () => {},
        );
      } catch (err) {
        result = { error: String(err) };
      }
      const costUsd = getSessionCost(cwd).costUsd;
      totalSpent += costUsd;
      observations.push({
        caseId: fixture.id,
        adjudicated: false,
        detectedDefectIds: [],
        falsePositiveCount: 0,
        elapsedMs: performance.now() - start,
        costUsd,
        error: result.error,
        result,
      });
    }
    writeFileSync(
      args[2],
      JSON.stringify(
        {
          corpusVersion: 1,
          reviewLevel: "min",
          model: {
            provider: source.secondary.provider,
            id: source.secondary.id,
            thinking: source.secondary.thinking,
            backend: source.secondary.backend,
          },
          instructions:
            "Read each result against npm run benchmark -- --fixtures. Label detectedDefectIds and falsePositiveCount, then set adjudicated:true. Do not count speculative style advice as a true bug.",
          observations,
        },
        (_key, value) => (_key === "apiKey" ? undefined : value),
        2,
      ),
      { mode: 0o600 },
    );
    console.log(`Saved ${observations.length} cases. Human adjudication is required before scoring.`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
