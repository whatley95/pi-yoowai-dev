export type YooAction = "plan" | "review" | "suggest" | "recommend" | "judge" | "scan" | "test" | "security";

/** Tasks that can have a per-model override in settings.json. Includes yoo tool actions plus separate tools like explain. */
export type YooModelTask = YooAction | "explain";

export interface SecondaryModelConfig {
  provider: string;
  id: string;
  thinking?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Backend to use for secondary model calls. "pi" spawns the pi CLI; "http" uses direct provider HTTP. */
  backend?: "pi" | "http";
  /** Custom base URL for any OpenAI-compatible or Anthropic-compatible provider. */
  baseUrl?: string;
  /** Inline API key. Prefer auth.json or env vars; this is a fallback. */
  apiKey?: string;
  /** API style when using a custom baseUrl. Defaults to openai-compatible. */
  style?: "openai-compatible" | "anthropic";
  /** Custom auth header name when using baseUrl. Defaults to Authorization. */
  authHeader?: string;
  /** Custom auth prefix when using baseUrl. Defaults to "Bearer ". */
  authPrefix?: string;
}

export interface HeyyooConfig {
  secondary: SecondaryModelConfig;
  /** Per-task model overrides. Any omitted field falls back to `secondary`. */
  taskModels?: Partial<Record<YooModelTask, Partial<SecondaryModelConfig>>>;
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
  /** Run a separate review call per changed file in parallel. Boolean enables default concurrency; number sets max concurrency. */
  parallelReview?: boolean | number;
  /** Run a deeper project scan by reading representative source files. Boolean enables default sampling; number sets max files to read. */
  deepScan?: boolean | number;
  /** Per-model token-budget overrides. Key is the model id (e.g. "qwen3.7-max"). */
  modelInfo?: Record<string, { contextWindow?: number; maxOutputTokens?: number }>;
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
  reviewRounds: number;
  reviewedSteps: boolean[];
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
  files?: string[];
  exclude?: string[];
  revision?: string;
  since?: string;
  vcs?: "git" | "svn";
  untracked?: boolean;
  verify?: boolean;
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
  error?: string;
  cost?: UsageCost;
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
}

export interface ProviderApiInfo {
  style: "openai-compatible" | "anthropic";
  baseUrl: string;
  authHeader: string;
  authPrefix: string;
  queryAuthKey?: string;
  /** Whether the provider supports OpenAI-style response_format: { type: "json_object" }. */
  supportsJsonObject?: boolean;
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
