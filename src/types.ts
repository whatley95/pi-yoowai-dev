export type YooAction =
  "plan" | "review" | "suggest" | "recommend" | "judge" | "scan" | "test" | "security" | "done" | "planUpdate";

/** Tasks that can have a per-model override in settings.json. Includes yoo tool actions plus separate tools like explain. */
export type YooModelTask = YooAction | "explain";

import type { BackendType } from "./types/secondary-model.js";
export type {
  BackendType,
  SdkCacheRetention,
  SdkTransport,
  SecondaryModelConfig,
  ProviderApiInfo,
} from "./types/secondary-model.js";
export type { DocsConfig, WebSearchConfig, WebSearchProvider } from "./types/docs.js";

export interface HeyyooConfig {
  secondary: import("./types/secondary-model.js").SecondaryModelConfig;
  /** Per-task model overrides. Any omitted field falls back to `secondary`. */
  taskModels?: Partial<Record<YooModelTask, Partial<import("./types/secondary-model.js").SecondaryModelConfig>>>;
  autoJudge?: boolean;
  preReviewCommands?: string[];
  /** Custom command to run for yoo.test analysis (e.g. "npm test"). If omitted, yoo.test will auto-detect or fall back to static diff analysis. */
  testCommand?: string;
  costBudgetUsd?: number;
  reviewMaxDiffChars?: number;
  reviewFullFileThresholdLines?: number;
  reviewMaxInputTokens?: number;
  reviewStrategy?: "auto" | "diff-only" | "full-files";
  verifyByDefault?: boolean;
  /** Run a second model pass that critiques review/judge results for unsupported claims. Default false. */
  selfVerify?: boolean;
  /** Allow the secondary model to request file reads or allowlisted commands before answering. Default false. */
  toolUseLoop?: boolean | number;
  /** Run a separate review call per changed file in parallel. Boolean enables default concurrency; number sets max concurrency. */
  parallelReview?: boolean | number;
  /** Run a deeper project scan by reading representative source files. Boolean enables default sampling; number sets max files to read. */
  deepScan?: boolean | number;
  /** Per-model token-budget overrides. Key is the model id (e.g. "qwen3.7-max"). */
  modelInfo?: Record<string, { contextWindow?: number; maxOutputTokens?: number }>;
  /** Optional documentation sources and web-search settings for yoo.suggest/recommend/explain. */
  docs?: import("./types/docs.js").DocsConfig;
  /** Timeout in ms for child pi process calls (default 300000 = 5 min). */
  processTimeoutMs?: number;
  /** Timeout in ms per model in /yoo test (default 120000 = 2 min). */
  testTimeoutMs?: number;
}

export interface PlanStep {
  description: string;
  priority?: "high" | "medium" | "low";
  dependsOn?: number[];
}

export type PlanTodoItem = string | PlanStep;

export interface PlanResult {
  todo: PlanTodoItem[];
  acceptanceCriteria: string[];
  summary: string;
}

export function isPlanStep(item: PlanTodoItem): item is PlanStep {
  return typeof item === "object" && item !== null && typeof item.description === "string";
}

export function planStepDescription(item: PlanTodoItem): string {
  return isPlanStep(item) ? item.description : item;
}

export interface ReviewIssue {
  severity: "high" | "medium" | "low";
  file?: string;
  line?: number;
  issue: string;
  suggestion: string;
}

export type ReviewVerdict = "pass" | "needs-work" | "blocked";

export interface ReviewResult {
  verdict: ReviewVerdict;
  issues: ReviewIssue[];
  suggestions: string[];
  consensus: boolean;
  planProgress?: string;
  nextStep?: string;
  escalated?: boolean;
  autoJudged?: boolean;
  truncated?: boolean;
  droppedFiles?: string[];
  contextLimited?: boolean;
  planStale?: boolean;
  completedSteps?: number;
}

export interface Approach {
  title: string;
  description: string;
  pros: string[];
  cons: string[];
}

export interface SuggestResult {
  approaches: Approach[];
}

export interface RecommendResult {
  nextStep: string;
  reasoning: string;
  alternatives: string[];
}

export interface JudgeResult extends ReviewResult {
  summary: string;
}

export interface TestFinding {
  severity: "high" | "medium" | "low";
  file?: string;
  line?: number;
  issue: string;
  suggestion: string;
  category?: string;
}

export interface MissingTest {
  file?: string;
  reason: string;
}

export interface TestResult {
  verdict: "pass" | "needs-work" | "blocked";
  findings: TestFinding[];
  missingTests: MissingTest[];
  summary: string;
}

export interface SecurityFinding {
  severity: "critical" | "high" | "medium" | "low";
  file?: string;
  line?: number;
  issue: string;
  suggestion: string;
  category: string;
}

export interface SecurityResult {
  verdict: "pass" | "needs-review";
  findings: SecurityFinding[];
  summary: string;
}

export interface HeyyooSessionState {
  plan?: PlanResult;
  completedSteps: number;
  totalSteps: number;
  reviewRounds: number[];
  reviewedSteps: boolean[];
  /** Set after autoJudge has run for a completed plan, so it does not fire twice. */
  judgeCompleted?: boolean;
  editsSinceLastReview: number;
  editsSinceLastDone: number;
  lastSteerAt?: number;
}

export interface YooToolParams {
  plan?: string;
  review?: string;
  suggest?: string;
  recommend?: string;
  judge?: string;
  scan?: boolean;
  test?: string;
  security?: string;
  done?: string | number;
  planUpdate?: string;
  files?: string[];
  exclude?: string[];
  revision?: string;
  since?: string;
  vcs?: "git" | "svn";
  untracked?: boolean;
  verify?: boolean;
  docs?: string[];
}

export interface YooToolResult {
  action: YooAction;
  plan?: PlanResult;
  review?: ReviewResult;
  suggest?: SuggestResult;
  recommend?: RecommendResult;
  judge?: JudgeResult;
  scan?: ScanResult;
  test?: TestResult;
  security?: SecurityResult;
  done?: DoneResult;
  error?: string;
  cost?: UsageCost;
  /** Wall-clock time the yoo tool took to produce this result, in milliseconds. */
  elapsedMs?: number;
  /** The secondary model that produced this result. */
  model?: StageProfile;
  inProgress?: boolean;
  progressMessage?: string;
  verificationRequested?: boolean;
}

export interface UsageCost {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCostUsd: number;
  sessionCostUsd: number;
}

export interface StageProfile {
  provider: string;
  id: string;
  thinking?: string;
  /** Connection backend used for this call: sdk, http, or pi. */
  backend?: BackendType;
}

export interface CallSecondaryModelOptions {
  signal?: AbortSignal;
  thinking?: string;
  cwd?: string;
  /** Session manager to inherit a sanitized snapshot of the parent conversation. */
  sessionManager?: {
    getHeader(): unknown;
    getBranch(): unknown[];
  };
  /** File paths to prioritize when selecting inherited session context (e.g. changed files for a review). */
  relevantPaths?: string[];
  /** Yoo task to resolve a per-task model override from settings. */
  task?: YooModelTask;
  /** When true, request native structured JSON output if the provider supports it. */
  structuredOutput?: boolean;
  /** Optional callback invoked with accumulated generated text during SDK streaming. */
  onStreamProgress?: (text: string) => void;
  /** Enable a bounded tool-use loop so the model can request file reads or allowlisted commands before answering. */
  enableToolLoop?: boolean;
  /** Maximum tool-use iterations when enableToolLoop is true. Defaults to 3. */
  maxToolIterations?: number;
}

export interface MemoryEntry {
  file: string;
  issues: Array<{ severity: ReviewIssue["severity"]; issue: string; suggestion: string; timestamp: string }>;
}

export interface Conventions {
  naming: string;
  structure: string;
  patterns: string[];
  stack: string;
  testing?: string;
  orm?: string;
  ui?: string;
  styling?: string;
  buildTool?: string;
  ci?: string;
  packageManager?: string;
  entryPoints: string[];
  scripts: string[];
  /** Exported symbols across the project index (e.g. `src/foo.ts: doThing`). */
  publicApi?: string[];
  /** Recurring code patterns inferred from the project index (e.g. `async function`, `try/catch`). */
  commonPatterns?: string[];
  styleSample?: string;
  agENTSmd?: string;
  generatedAt: string;
}

export interface ScanResult {
  conventions: Conventions;
  files: string[];
}

export interface ExplainResult {
  summary: string;
  details: string;
  relatedFiles?: string[];
}

export interface DoneResult {
  completedStep: number;
  totalSteps: number;
  nextStep?: string;
  allDone: boolean;
  message: string;
}
