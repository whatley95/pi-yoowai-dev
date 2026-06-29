export interface HeyyooConfig {
  secondary: {
    provider: string;
    id: string;
    thinking?: string;
  };
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

export type YooAction = "plan" | "review" | "suggest" | "recommend" | "judge";

export interface YooToolParams {
  plan?: string;
  review?: string;
  suggest?: string;
  recommend?: string;
  judge?: string;
}

export interface YooToolResult {
  action: YooAction;
  plan?: PlanResult;
  review?: ReviewResult;
  suggest?: SuggestResult;
  recommend?: RecommendResult;
  judge?: JudgeResult;
  error?: string;
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
}
