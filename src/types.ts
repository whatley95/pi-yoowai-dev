export type YooAction = "plan" | "review" | "suggest" | "recommend" | "judge" | "scan";

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
  taskModels?: Partial<Record<YooAction, Partial<SecondaryModelConfig>>>;
  autoJudge?: boolean;
  preReviewCommands?: string[];
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
}

export interface PlanResult {
  todo: string[];
  acceptanceCriteria: string[];
  summary: string;
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
  /** Yoo action to resolve a per-task model override from settings. */
  task?: YooAction;
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
