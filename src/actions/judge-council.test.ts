import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import { setSdkGetModelOverride, setSdkStreamSimpleOverride } from "../secondary-model.js";
import { setAgentDirForTests, getAgentDir } from "../pi-paths.js";
import { loadYoowaiConfig } from "../config.js";
import { runJudgeCouncil } from "./judge-council.js";
import type { JudgeResult, ReviewVerdict, YoowaiConfig } from "../types.js";

const tmpDirs: string[] = [];
const originalAgentDir = getAgentDir();
// Isolate tests from any real global ~/.pi/agent/settings.json.
const emptyAgentDir = mkdtempSync(join(tmpdir(), "wai-council-agent-"));
setAgentDirForTests(() => emptyAgentDir);

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

function writeSettings(cwd: string, judgeCouncil: unknown[]): void {
  const piDir = join(cwd, ".pi");
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    join(piDir, "settings.json"),
    JSON.stringify({
      "pi-yoowai": {
        secondary: { provider: "synth", id: "synth-model", apiKey: "sk-test", thinking: "off" },
        judgeCouncil,
      },
    }),
    "utf-8",
  );
}

function judgeJson(verdict: ReviewVerdict, extra: Record<string, unknown> = {}): string {
  const result: JudgeResult = {
    verdict,
    issues: [],
    suggestions: [],
    consensus: verdict === "pass",
    summary: `${verdict} from member`,
    ...extra,
  };
  return JSON.stringify(result);
}

function fakeSdkModel(provider: string, modelId: string): Model<Api> {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider,
    baseUrl: "https://example.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
    contextWindow: 128000,
    maxTokens: 4096,
  } as Model<Api>;
}

function fakeSdkAssistantMessage(text: string): AssistantMessage {
  const usage: Partial<Usage> = { input: 10, output: 5 };
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "synth",
    model: "synth-model",
    usage: {
      input: usage.input,
      output: usage.output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: (usage.input ?? 0) + (usage.output ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AssistantMessage;
}

function fakeSdkStream(
  message: AssistantMessage,
  delayMs = 0,
): import("@earendil-works/pi-ai").AssistantMessageEventStream {
  return {
    result: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return message;
    },
    [Symbol.asyncIterator]: async function* () {
      yield { type: "done", reason: "stop", message };
    },
  } as unknown as import("@earendil-works/pi-ai").AssistantMessageEventStream;
}

function failingSdkStream(error: string): import("@earendil-works/pi-ai").AssistantMessageEventStream {
  return {
    result: async () => {
      throw new Error(error);
    },
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        throw new Error(error);
      },
    }),
  } as unknown as import("@earendil-works/pi-ai").AssistantMessageEventStream;
}

const noopProgress = (): void => {};

function councilOptions(cwd: string, config: YoowaiConfig): Parameters<typeof runJudgeCouncil>[0] {
  return {
    cwd,
    config,
    description: "test task",
    system: "system prompt",
    user: "user prompt",
    synthesizer: config.secondary,
    progress: noopProgress,
  };
}

after(() => {
  setAgentDirForTests(() => originalAgentDir);
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  tmpDirs.length = 0;
  try {
    rmSync(emptyAgentDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

afterEach(() => {
  setSdkGetModelOverride(null);
  setSdkStreamSimpleOverride(null);
  setAgentDirForTests(() => emptyAgentDir);
});

describe("runJudgeCouncil", () => {
  it("returns null with fewer than 2 valid members", async () => {
    const cwd = makeTempDir("wai-council-skip-");
    writeSettings(cwd, ["alpha/model-a"]);
    const config = loadYoowaiConfig(cwd);

    let called = false;
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride(() => {
      called = true;
      return fakeSdkStream(fakeSdkAssistantMessage(judgeJson("pass")));
    });

    const outcome = await runJudgeCouncil(councilOptions(cwd, config));
    assert.equal(outcome, null);
    assert.equal(called, false);
  });

  it("fans out to all members in parallel and synthesizes their verdicts", async () => {
    const cwd = makeTempDir("wai-council-fanout-");
    writeSettings(cwd, ["alpha/model-a", "beta/model-b", "gamma/model-c"]);
    const config = loadYoowaiConfig(cwd);

    const calls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride((model) => {
      calls.push(model.id);
      if (model.id === "synth-model") {
        return fakeSdkStream(
          fakeSdkAssistantMessage(judgeJson("needs-work", { summary: "2 of 3 judges passed; merged judgment." })),
        );
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const message = fakeSdkAssistantMessage(judgeJson("pass"));
      return {
        result: async () => {
          // Hold the response briefly so overlapping member calls are observable.
          await new Promise((r) => setTimeout(r, 25));
          inFlight--;
          return message;
        },
        [Symbol.asyncIterator]: async function* () {
          yield { type: "done", reason: "stop", message };
        },
      } as unknown as import("@earendil-works/pi-ai").AssistantMessageEventStream;
    });

    const outcome = await runJudgeCouncil(councilOptions(cwd, config));
    assert.ok(outcome);
    assert.deepEqual(calls.sort(), ["model-a", "model-b", "model-c", "synth-model"]);
    assert.equal(maxInFlight, 3, "all three member calls should overlap");
    assert.equal(outcome.judge.verdict, "needs-work");
    assert.equal(outcome.judge.summary, "2 of 3 judges passed; merged judgment.");
    assert.equal(outcome.judge.council?.synthesized, true);
    assert.equal(outcome.judge.council?.members.length, 3);
    assert.ok(outcome.judge.council?.members.every((m) => m.verdict === "pass"));
    assert.ok(outcome.cost.estimatedCostUsd > 0 || outcome.cost.estimatedInputTokens > 0);
  });

  it("tolerates a failed member and synthesizes the survivors", async () => {
    const cwd = makeTempDir("wai-council-partial-");
    writeSettings(cwd, ["alpha/model-a", "beta/model-b", "gamma/model-c"]);
    const config = loadYoowaiConfig(cwd);

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride((model) => {
      if (model.id === "model-b") return failingSdkStream("boom");
      if (model.id === "synth-model") {
        return fakeSdkStream(fakeSdkAssistantMessage(judgeJson("pass", { summary: "survivors agree." })));
      }
      return fakeSdkStream(fakeSdkAssistantMessage(judgeJson("pass")));
    });

    const outcome = await runJudgeCouncil(councilOptions(cwd, config));
    assert.ok(outcome);
    assert.equal(outcome.judge.verdict, "pass");
    const failed = outcome.judge.council?.members.find((m) => m.model === "beta:model-b");
    assert.ok(failed?.error);
    assert.equal(failed?.verdict, undefined);
    assert.equal(outcome.judge.council?.members.filter((m) => !m.error).length, 2);
  });

  it("treats a member with no usable response as failed", async () => {
    const cwd = makeTempDir("wai-council-unparseable-");
    writeSettings(cwd, ["alpha/model-a", "beta/model-b"]);
    const config = loadYoowaiConfig(cwd);

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride((model) => {
      if (model.id === "model-b") return fakeSdkStream(fakeSdkAssistantMessage("   \n  "));
      if (model.id === "synth-model") {
        return fakeSdkStream(fakeSdkAssistantMessage(judgeJson("pass", { summary: "one judge passed." })));
      }
      return fakeSdkStream(fakeSdkAssistantMessage(judgeJson("pass")));
    });

    const outcome = await runJudgeCouncil(councilOptions(cwd, config));
    assert.ok(outcome);
    const failed = outcome.judge.council?.members.find((m) => m.model === "beta:model-b");
    assert.ok(failed?.error);
    assert.equal(failed?.verdict, undefined);
    assert.equal(outcome.judge.council?.members.filter((m) => !m.error).length, 1);
    assert.equal(outcome.judge.verdict, "pass");
  });

  it("returns null when all members fail, so the caller falls back to the single judge", async () => {
    const cwd = makeTempDir("wai-council-allfail-");
    writeSettings(cwd, ["alpha/model-a", "beta/model-b"]);
    const config = loadYoowaiConfig(cwd);

    const calls: string[] = [];
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride((model) => {
      calls.push(model.id);
      return failingSdkStream("boom");
    });

    const outcome = await runJudgeCouncil(councilOptions(cwd, config));
    assert.equal(outcome, null);
    assert.deepEqual(calls.sort(), ["model-a", "model-b"]);
  });

  it("merges verdicts with fail-wins through the synthesizer", async () => {
    const cwd = makeTempDir("wai-council-failwins-");
    writeSettings(cwd, ["alpha/model-a", "beta/model-b"]);
    const config = loadYoowaiConfig(cwd);

    let synthesisPrompt = "";
    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride((model, context) => {
      if (model.id === "model-a") return fakeSdkStream(fakeSdkAssistantMessage(judgeJson("pass")));
      if (model.id === "model-b") return fakeSdkStream(fakeSdkAssistantMessage(judgeJson("blocked")));
      synthesisPrompt = JSON.stringify(context);
      return fakeSdkStream(
        fakeSdkAssistantMessage(judgeJson("blocked", { summary: "1 of 2 judges blocked; fail wins." })),
      );
    });

    const outcome = await runJudgeCouncil(councilOptions(cwd, config));
    assert.ok(outcome);
    // The synthesizer received both members' verdicts (quotes are escaped inside the serialized context).
    assert.ok(synthesisPrompt.includes("alpha:model-a"));
    assert.ok(synthesisPrompt.includes("beta:model-b"));
    assert.ok(synthesisPrompt.includes('\\"verdict\\": \\"pass\\"'));
    assert.ok(synthesisPrompt.includes('\\"verdict\\": \\"blocked\\"'));
    assert.equal(outcome.judge.verdict, "blocked");
    assert.equal(outcome.judge.council?.members.map((m) => m.verdict).join(","), "pass,blocked");
  });

  it("falls back to a deterministic merge when synthesis fails", async () => {
    const cwd = makeTempDir("wai-council-detmerge-");
    writeSettings(cwd, ["alpha/model-a", "beta/model-b"]);
    const config = loadYoowaiConfig(cwd);

    setSdkGetModelOverride((provider, modelId) => fakeSdkModel(provider, modelId));
    setSdkStreamSimpleOverride((model) => {
      if (model.id === "model-a") {
        return fakeSdkStream(
          fakeSdkAssistantMessage(judgeJson("pass", { completedStepIds: [1, 2], suggestions: ["shared suggestion"] })),
        );
      }
      if (model.id === "model-b") {
        return fakeSdkStream(
          fakeSdkAssistantMessage(
            judgeJson("blocked", {
              issues: [{ severity: "high", file: "a.ts", issue: "broken", suggestion: "fix it" }],
              completedStepIds: [1],
              suggestions: ["shared suggestion"],
              consensus: false,
            }),
          ),
        );
      }
      // Synthesis returns nothing parseable.
      return fakeSdkStream(fakeSdkAssistantMessage("   \n  "));
    });

    const outcome = await runJudgeCouncil(councilOptions(cwd, config));
    assert.ok(outcome);
    assert.equal(outcome.judge.council?.synthesized, false);
    // Fail wins on disagreement.
    assert.equal(outcome.judge.verdict, "blocked");
    // Issues are unioned with the source member label.
    assert.equal(outcome.judge.issues.length, 1);
    assert.ok(outcome.judge.issues[0].issue.startsWith("[beta:model-b]"));
    // Suggestions deduplicated; completedStepIds intersected.
    assert.deepEqual(outcome.judge.suggestions, ["shared suggestion"]);
    assert.deepEqual(outcome.judge.completedStepIds, [1]);
    assert.equal(outcome.judge.consensus, false);
    assert.ok(outcome.judge.summary.includes("1 pass / 1 blocked"));
  });
});
