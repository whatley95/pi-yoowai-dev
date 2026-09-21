/**
 * review-min-replay — A/B validation harness for the reviewMin model swap.
 *
 * Compares two reviewMin task-model configurations (luna @ xhigh vs
 * sol @ medium) on identical fixture diffs using the REAL review pipeline
 * (executeWaiReview), so verdicts, findings, durations, and costs are
 * measured end-to-end — not mocked.
 *
 * Prerequisites:
 *   - OpenAI Codex authentication available to Pi (auth.json or env), since
 *     both configurations resolve through the openai-codex provider.
 *   - Node >= 22 with the repo's devDependencies installed (tsx).
 *   - Network access to the provider. THIS SCRIPT MAKES REAL PAID MODEL
 *     CALLS (6 by default: 3 fixtures x 2 configs). It is opt-in and is NOT
 *     wired into package.json test scripts or CI.
 *
 * Usage:
 *   npx tsx scripts/review-min-replay.ts --config both     (default)
 *   npx tsx scripts/review-min-replay.ts --config sol
 *   npx tsx scripts/review-min-replay.ts --config luna
 *
 * Fixtures (ground truth is known to this script, never sent to the model):
 *   clean        — behavior-preserving refactor (rename + doc comment)     → expect pass
 *   off-by-one   — sumTo loop changed from < to <=                          → expect needs-work
 *   null-check   — formatName drops the guard the initial version had       → expect needs-work
 *
 * Isolation: every run gets its own temporary git repository (fresh session
 * state, per-cwd settings with the taskModel override). The project checkout
 * is never touched, nothing is committed outside temp dirs, and temp dirs are
 * removed on success, failure, or interruption (SIGINT via finally).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeWaiReview } from "../src/actions/review.js";
import { initGitRepo, prepareRepo, writeSettings } from "../src/actions/integration-harness.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SecondaryModelConfig } from "../src/types/secondary-model.js";

type ConfigName = "luna" | "sol";
type CaseId = "case-1" | "case-2" | "case-3";

const MODEL_CONFIGS: Record<ConfigName, SecondaryModelConfig> = {
  luna: { provider: "openai-codex", id: "gpt-5.6-luna", thinking: "xhigh" },
  sol: { provider: "openai-codex", id: "gpt-5.6-sol", thinking: "medium" },
};

const INITIAL_FILES: Record<string, string> = {
  "math.ts": [
    "/** Sum of integers strictly below n. Example: sumTo(5) === 10. */",
    "export function sumTo(n: number): number {",
    "  let total = 0;",
    "  for (let i = 1; i < n; i++) {",
    "    total += i;",
    "  }",
    "  return total;",
    "}",
    "",
    "export interface NamedUser {",
    "  name: string;",
    "}",
    "",
    "export function formatName(user: NamedUser | null): string {",
    '  if (!user) return "anonymous";',
    "  return user.name.toUpperCase();",
    "}",
  ].join("\n"),
};

const FIXTURE_DIFFS: Array<{
  caseId: CaseId;
  name: string;
  changed: Record<string, string>;
  expect: "pass" | "needs-work";
  bug: string;
}> = [
  {
    caseId: "case-1",
    name: "clean",
    expect: "pass",
    bug: "none — behavior-preserving refactor",
    changed: {
      "math.ts": [
        "export function sumTo(n: number): number {",
        "  // Sum every integer below n (behavior preserved).",
        "  let accumulator = 0;",
        "  for (let i = 1; i < n; i++) {",
        "    accumulator += i;",
        "  }",
        "  return accumulator;",
        "}",
        "",
        "export interface NamedUser {",
        "  name: string;",
        "}",
        "",
        "export function formatName(user: NamedUser | null): string {",
        '  if (!user) return "anonymous";',
        "  return user.name.toUpperCase();",
        "}",
      ].join("\n"),
    },
  },
  {
    caseId: "case-2",
    name: "off-by-one",
    expect: "needs-work",
    bug: "sumTo loop now includes n (<= instead of <), contradicting the docstring contract in the same diff",
    changed: {
      "math.ts": [
        "/** Sum of integers strictly below n. Example: sumTo(5) === 10. */",
        "export function sumTo(n: number): number {",
        "  let total = 0;",
        "  for (let i = 1; i <= n; i++) {",
        "    total += i;",
        "  }",
        "  return total;",
        "}",
        "",
        "export interface NamedUser {",
        "  name: string;",
        "}",
        "",
        "export function formatName(user: NamedUser | null): string {",
        '  if (!user) return "anonymous";',
        "  return user.name.toUpperCase();",
        "}",
      ].join("\n"),
    },
  },
  {
    caseId: "case-3",
    name: "null-check",
    expect: "needs-work",
    bug: "formatName dropped the null guard (runtime crash on null)",
    changed: {
      "math.ts": [
        "export function sumTo(n: number): number {",
        "  let total = 0;",
        "  for (let i = 1; i < n; i++) {",
        "    total += i;",
        "  }",
        "  return total;",
        "}",
        "",
        "export interface NamedUser {",
        "  name: string;",
        "}",
        "",
        "export function formatName(user: NamedUser | null): string {",
        "  return user.name.toUpperCase();",
        "}",
      ].join("\n"),
    },
  },
];

function parseArgs(argv: string[]): ConfigName[] {
  // Support both "--config sol" and "--config=sol" forms.
  const equalsForm = argv.find((a) => a.startsWith("--config="));
  const configIdx = argv.indexOf("--config");
  const spaceFormValue = configIdx >= 0 ? argv[configIdx + 1] : undefined;
  const unknown = argv.filter((a) => a.startsWith("--") && a !== "--config" && !a.startsWith("--config="));
  if (unknown.length > 0) {
    console.error(`Unknown flag(s): ${unknown.join(", ")}. Use --config luna | sol | both.`);
    process.exit(2);
  }
  // Bare "--config" — including as the last arg — must NOT silently default
  // to both (that would start six paid model calls).
  if (configIdx >= 0 && (spaceFormValue === undefined || spaceFormValue.startsWith("--"))) {
    console.error("--config requires a value: luna | sol | both");
    process.exit(2);
  }
  const raw = (
    equalsForm !== undefined ? equalsForm.slice("--config=".length) : (spaceFormValue ?? "both")
  ).toLowerCase();
  if (raw === "luna" || raw === "sol") return [raw];
  if (raw === "both") return ["luna", "sol"];
  console.error(`Unknown --config "${raw}". Use luna | sol | both.`);
  process.exit(2);
}

function makeContext(cwd: string): ExtensionContext {
  return { cwd } as unknown as ExtensionContext;
}

async function main(): Promise<void> {
  const configs = parseArgs(process.argv.slice(2));
  const tempDirs: string[] = [];

  const cleanup = () => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  type Run = {
    config: ConfigName;
    caseId: CaseId;
    name: string;
    expect: string;
    verdict: string;
    findings: number;
    seconds: number;
    cost: string;
    matched: boolean;
    error?: string;
  };
  const runs: Run[] = [];

  try {
    for (const configName of configs) {
      for (const fixture of FIXTURE_DIFFS) {
        const cwd = mkdtempSync(join(tmpdir(), `wai-replay-${configName}-${fixture.caseId}-`));
        tempDirs.push(cwd);
        initGitRepo(cwd);
        prepareRepo(cwd, INITIAL_FILES, fixture.changed);
        // Per-run settings: the reviewMin override drives the model for the
        // min level; nothing else is changed. Isolated per temp cwd.
        writeSettings(cwd, {
          reviewLevel: "min",
          taskModels: { reviewMin: MODEL_CONFIGS[configName] },
          costBudgetUsd: 5,
        });

        const started = Date.now();
        try {
          const result = await executeWaiReview(
            cwd,
            `Review the latest change to math.ts (${fixture.caseId}).`,
            makeContext(cwd),
            { level: "min" },
            undefined,
            () => {},
          );
          const seconds = Math.round((Date.now() - started) / 1000);
          if (result.error) {
            runs.push({
              config: configName,
              caseId: fixture.caseId,
              name: fixture.name,
              expect: fixture.expect,
              verdict: "error",
              findings: 0,
              seconds,
              cost: "unavailable",
              matched: false,
              error: result.error.slice(0, 120),
            });
            continue;
          }
          const review = result.review;
          const verdict = review?.verdict ?? "unknown";
          const costUsd = result.cost?.sessionCostUsd;
          const matched = verdict === fixture.expect;
          runs.push({
            config: configName,
            caseId: fixture.caseId,
            name: fixture.name,
            expect: fixture.expect,
            verdict,
            findings: review?.issues?.length ?? 0,
            seconds,
            cost: typeof costUsd === "number" ? `$${costUsd.toFixed(4)}` : "unavailable",
            matched,
          });
        } catch (err) {
          runs.push({
            config: configName,
            caseId: fixture.caseId,
            name: fixture.name,
            expect: fixture.expect,
            verdict: "threw",
            findings: 0,
            seconds: Math.round((Date.now() - started) / 1000),
            cost: "unavailable",
            matched: false,
            error: err instanceof Error ? err.message.slice(0, 120) : String(err),
          });
        }
      }
    }
  } finally {
    cleanup();
  }

  // Comparison table.
  console.log("\n=== reviewMin A/B replay (blind: model sees only opaque case IDs) ===");
  console.log(
    [
      "config".padEnd(6),
      "case".padEnd(9),
      "fixture".padEnd(12),
      "expect".padEnd(12),
      "verdict".padEnd(12),
      "issues",
      "secs",
      "cost",
      "match",
      "error",
    ].join("  "),
  );
  for (const run of runs) {
    console.log(
      [
        run.config.padEnd(6),
        run.caseId.padEnd(9),
        run.name.padEnd(12),
        run.expect.padEnd(12),
        run.verdict.padEnd(12),
        String(run.findings).padEnd(6),
        String(run.seconds).padEnd(4),
        run.cost.padEnd(12),
        run.matched ? "OK" : "MISMATCH",
        run.error ?? "",
      ].join("  "),
    );
  }
  const okCount = runs.filter((r) => r.matched && !r.error).length;
  console.log(`\nMatched expectations: ${okCount}/${runs.length}`);
  console.log("Reminder: min/med/high runs are not independent confirmations — one model, one context each.");
}

void main();
