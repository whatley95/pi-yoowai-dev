export interface HeyyooConfig {
  secondary: {
    provider: string;
    id: string;
    thinking?: string;
    contextWindow?: number;
    maxOutputTokens?: number;
  };
  autoJudge?: boolean;
  preReviewCommands?: string[];
  costBudgetUsd?: number;
  reviewMaxDiffChars?: number;
  reviewFullFileThresholdLines?: number;
  reviewMaxInputTokens?: number;
  reviewStrategy?: "auto" | "diff-only" | "full-files";
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
  preReviewOutput?: string;
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
}

export type YooAction = "plan" | "review" | "suggest" | "recommend" | "judge" | "scan";

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
