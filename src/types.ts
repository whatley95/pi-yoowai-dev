export type WaiAction =
  "plan" | "review" | "suggest" | "recommend" | "judge" | "scan" | "test" | "security" | "done" | "planUpdate";

/** Tasks that can have a per-model override in settings.json.
 *  planUpdate intentionally shares the plan model, so it is not selectable separately.
 *  The reviewMin/reviewMed/reviewHigh tasks let each explicit review-depth tool
 *  (wai_review_min/med/high) use its own model; they fall back to the review
 *  task override, then the base secondary model. */
export type WaiModelTask =
  | "plan"
  | "review"
  | "reviewMin"
  | "reviewMed"
  | "reviewHigh"
  | "suggest"
  | "recommend"
  | "judge"
  | "scan"
  | "test"
  | "security"
  | "done"
  | "explain"
  | "vision";

/** Review depth preset. Higher levels spend more tokens and catch deeper issues. */
export type ReviewLevel = "min" | "med" | "high";

import type { BackendType } from "./types/secondary-model.js";
export type {
  BackendType,
  SdkCacheRetention,
  SdkTransport,
  SecondaryModelConfig,
  ProviderApiInfo,
} from "./types/secondary-model.js";
export type { DocsConfig, WebSearchConfig, WebSearchProvider } from "./types/docs.js";

/** A named model preset: a partial config applied to `secondary` and/or `taskModels` via `/wai-preset`. */
export interface YoowaiPreset {
  secondary?: Partial<import("./types/secondary-model.js").SecondaryModelConfig>;
  taskModels?: Partial<Record<WaiModelTask, Partial<import("./types/secondary-model.js").SecondaryModelConfig>>>;
}

export interface YoowaiConfig {
  secondary: import("./types/secondary-model.js").SecondaryModelConfig;
  /** Per-task model overrides. Any omitted field falls back to `secondary`. */
  taskModels?: Partial<Record<WaiModelTask, Partial<import("./types/secondary-model.js").SecondaryModelConfig>>>;
  /** Council of models that judge in parallel when `wai.judge` runs; their verdicts are synthesized into one final judgment.
   *  Each entry is a partial secondary config (a "provider/model-id" string in settings is normalized to `{ provider, id }`),
   *  merged over `secondary` the same way `taskModels` overrides resolve. Prefer different model families per member.
   *  Fewer than 2 valid members disables the council. Default: empty (single-model judge). */
  judgeCouncil?: Array<Partial<import("./types/secondary-model.js").SecondaryModelConfig>>;
  /** Named model presets applied via `/wai-preset <name>`. */
  presets?: Record<string, YoowaiPreset>;
  /** Fallback secondary models to try if the primary model fails. Each fallback is tried in order. */
  secondaryFallback?: import("./types/secondary-model.js").SecondaryModelConfig[];
  autoJudge?: boolean;
  preReviewCommands?: string[];
  /** Custom command to run for wai.test analysis (e.g. "npm test"). If omitted, wai.test will auto-detect or fall back to static diff analysis. */
  testCommand?: string;
  costBudgetUsd?: number;
  reviewMaxDiffChars?: number;
  reviewFullFileThresholdLines?: number;
  reviewMaxInputTokens?: number;
  reviewMaxConventionsTokens?: number;
  reviewMaxMemoryTokens?: number;
  reviewStrategy?: "auto" | "diff-only" | "full-files";
  /** Review depth preset. Defaults to a model-derived value; individual review budgets override the preset. */
  reviewLevel?: ReviewLevel;
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
  /** Optional documentation sources and web-search settings for wai.suggest/recommend/explain. */
  docs?: import("./types/docs.js").DocsConfig;
  /** Timeout in ms for child pi process calls (default 300000 = 5 min). */
  processTimeoutMs?: number;
  /** Timeout in ms per model in /wai test (default 120000 = 2 min). */
  testTimeoutMs?: number;
  /** Maximum continuation calls when a secondary-model response is length-truncated (default 3). */
  maxContinuations?: number;
  /** Verify wai.done claims against the diff before advancing the tracker. Default true. */
  verifyDoneClaims?: boolean;
  /** Number of file edits since last review before showing a workflow reminder. Default 3. */
  reviewReminderEdits?: number;
  /** Inject active plan, conventions, and workflow reminders into every user message. Default true. */
  autoInjectContext?: boolean;
  /** Maximum tokens of injected context per message. Default 800. */
  contextInjectMaxTokens?: number;
  /** Token budget for the project symbol map injected into review/judge prompts. Default 1500; 0 disables. */
  codemapMaxTokens?: number;
  /** Token budget for user-curated design rules injected into review/judge prompts for UI files. Default 800; 0 disables. */
  designRefMaxTokens?: number;
  /** Render wai audit entries (plan, review, judge, etc.) with a custom TUI entry renderer. Default true. */
  entryRenderer?: boolean;
  /** Register keyboard shortcuts for common wai actions (review, done, status). Default true. */
  shortcuts?: boolean;
  /** Show a compact plan-progress widget above the editor. Default true. */
  planWidget?: boolean;
  /** Register the configured secondary model as a Pi provider named "wai". Default false. */
  registerProvider?: boolean;
  /** Consecutive turn_ends with unreviewed edits pending before the workflow steer escalates to an explicit stop directive. Default 3. */
  steerEscalationThreshold?: number;
  /** Block wai.done from marking steps complete while unreviewed edits are pending (overridable with force). Default false. */
  requireReviewBeforeDone?: boolean;
  /** Automatically run wai.review when the agent settles with unreviewed edits pending, before any auto-judge. Default false. */
  autoReviewOnSettle?: boolean;
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
  /** Non-pass verdict with zero issues — truncated or off-scope response; not actionable, not a pass, not a failed round. */
  inconclusive?: boolean;
  planProgress?: string;
  nextStep?: string;
  escalated?: boolean;
  autoJudged?: boolean;
  truncated?: boolean;
  droppedFiles?: string[];
  contextLimited?: boolean;
  planStale?: boolean;
  /** True only when the review explicitly confirms the CURRENT plan step's work is finished and fully reviewed. Drives guarded auto-completion. */
  stepComplete?: boolean;
  completedSteps?: number;
  fixPlan?: string[];
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

export interface JudgeCouncilMemberOutcome {
  /** "provider:id" label of the council member. */
  model: string;
  /** The member's verdict; undefined when the member failed. */
  verdict?: ReviewVerdict;
  /** Set when the member call failed or its response was unparseable. */
  error?: string;
}

export interface JudgeCouncilSummary {
  members: JudgeCouncilMemberOutcome[];
  /** True when a synthesizer model merged the verdicts; false when the deterministic fallback merge was used. */
  synthesized: boolean;
}

export interface JudgeResult extends ReviewResult {
  summary: string;
  completedStepIds?: number[];
  /** Steps the tracker marks complete that the code does NOT actually satisfy. */
  incompleteStepIds?: number[];
  planUpdateSuggested?: boolean;
  planUpdateReason?: string;
  unreviewedEdits?: boolean;
  /** Present when the judgment was produced by a judge council (see `judgeCouncil` config). */
  council?: JudgeCouncilSummary;
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

export interface YoowaiSessionState {
  plan?: PlanResult;
  completedSteps: number;
  totalSteps: number;
  reviewRounds: number[];
  reviewedSteps: boolean[];
  /** Set after autoJudge has run for a completed plan, so it does not fire twice. */
  judgeCompleted?: boolean;
  editsSinceLastReview: number;
  editsSinceLastDone: number;
  /** Files edited since the last review (mirrors editsSinceLastReview), used for reminder file lists. */
  editedFiles?: string[];
  /** Turns that ended with unreviewed edits pending and no review call in between. Reset when a review runs. */
  unreviewedTurns?: number;
  /** Cumulative edits that were still unreviewed when session state flushed to disk. */
  unreviewedEditsTotal?: number;
  /** Internal marker: editsSinceLastReview value already folded into unreviewedEditsTotal, so repeated flushes do not double count. */
  unreviewedEditsFlushed?: number;
  lastSteerAt?: number;
  lastReviewedCommit?: string;
  /** reviewRounds[completedSteps] value when the last plan-stale suggestion was surfaced; suppresses repeats within the same review round. */
  planStaleSuggestedRound?: number;
}

export interface WaiToolParams {
  plan?: string;
  review?: string;
  suggest?: string;
  recommend?: string;
  judge?: string;
  scan?: boolean;
  scanDeep?: boolean;
  test?: string;
  security?: string;
  done?: string | number | boolean;
  planUpdate?: string | boolean;
  /** For done: override the requireReviewBeforeDone gate and mark the step complete without a review. */
  force?: boolean;
  files?: string[];
  exclude?: string[];
  revision?: string;
  since?: string;
  vcs?: "git" | "svn";
  untracked?: boolean;
  verify?: boolean;
  docs?: string[];
}

export interface WaiToolResult {
  action: WaiAction;
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
  /** Effective review level (min/med/high) when the action is a review.
   *  Drives the level marker in TUI call titles, progress lines, and verdicts. */
  level?: ReviewLevel;
  cost?: UsageCost;
  /** Wall-clock time the wai tool took to produce this result, in milliseconds. */
  elapsedMs?: number;
  /** The secondary model that produced this result. */
  model?: StageProfile;
  /** Continuation metadata surfaced when the response was assembled from
   *  multiple continuation calls after a length-truncated initial response. */
  continuation?: {
    /** Number of continuation rounds executed (0 = no rounds ran; check status for whether output was truncated). */
    rounds: number;
    /** Whether the final output is stitched from complete responses or
     *  still truncated after hitting the continuation cap. */
    status: "stitched" | "truncated-after-cap";
  };
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
  /** Wai task to resolve a per-task model override from settings. */
  task?: WaiModelTask;
  /** Explicit per-call secondary config (e.g. a judge council member). Takes precedence over
   *  taskModels/secondary resolution; auth, backend dispatch, retries, and cost budget still apply. */
  secondaryOverride?: import("./types/secondary-model.js").SecondaryModelConfig;
  /** When true, request native structured JSON output if the provider supports it. */
  structuredOutput?: boolean;
  /** Optional callback invoked with accumulated generated text during SDK streaming. */
  onStreamProgress?: (text: string) => void;
  /** Enable a bounded tool-use loop so the model can request file reads or allowlisted commands before answering. */
  enableToolLoop?: boolean;
  /** Maximum tool-use iterations when enableToolLoop is true. Defaults to 3. */
  maxToolIterations?: number;
  /** Images to attach to the user message (base64). SDK backend only; the model
   *  must declare image input support in Pi's catalog. */
  images?: VisionImage[];
}

/** A base64-encoded image attached to a secondary-model call. */
export interface VisionImage {
  data: string;
  mimeType: string;
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

export interface VisionResult {
  summary: string;
  details: string;
  imagePath: string;
  mimeType: string;
}

export interface DoneResult {
  completedStep: number;
  totalSteps: number;
  nextStep?: string;
  allDone: boolean;
  message: string;
  verified?: boolean;
  verificationReason?: string;
  /** True when requireReviewBeforeDone blocked completion because unreviewed edits are pending. */
  blocked?: boolean;
}
