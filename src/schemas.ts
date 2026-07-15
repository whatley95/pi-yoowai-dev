import { Type } from "@sinclair/typebox";

export const PlanStepSchema = Type.Object(
  {
    description: Type.String(),
    priority: Type.Optional(Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")])),
    dependsOn: Type.Optional(Type.Array(Type.Number())),
  },
  { additionalProperties: false },
);

export const PlanResultSchema = Type.Object(
  {
    todo: Type.Array(Type.Union([Type.String(), PlanStepSchema])),
    acceptanceCriteria: Type.Array(Type.String()),
    summary: Type.String(),
  },
  { additionalProperties: false },
);

export const ReviewIssueSchema = Type.Object(
  {
    severity: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    file: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    line: Type.Optional(Type.Union([Type.Number(), Type.Null(), Type.String()])),
    issue: Type.String(),
    suggestion: Type.String(),
  },
  { additionalProperties: false },
);

export const ReviewResultSchema = Type.Object(
  {
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("needs-work"), Type.Literal("blocked")]),
    issues: Type.Array(ReviewIssueSchema),
    suggestions: Type.Array(Type.String()),
    consensus: Type.Boolean(),
    planProgress: Type.Optional(Type.String()),
    nextStep: Type.Optional(Type.String()),
    escalated: Type.Optional(Type.Boolean()),
    autoJudged: Type.Optional(Type.Boolean()),
    truncated: Type.Optional(Type.Boolean()),
    droppedFiles: Type.Optional(Type.Array(Type.String())),
    contextLimited: Type.Optional(Type.Boolean()),
    planStale: Type.Optional(Type.Boolean()),
    completedSteps: Type.Optional(Type.Number()),
  },
  { additionalProperties: false },
);

export const ApproachSchema = Type.Object(
  {
    title: Type.String(),
    description: Type.String(),
    pros: Type.Array(Type.String()),
    cons: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const SuggestResultSchema = Type.Object(
  {
    approaches: Type.Array(ApproachSchema),
  },
  { additionalProperties: false },
);

export const RecommendResultSchema = Type.Object(
  {
    nextStep: Type.String(),
    reasoning: Type.String(),
    alternatives: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const JudgeResultSchema = Type.Object(
  {
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("needs-work"), Type.Literal("blocked")]),
    issues: Type.Array(ReviewIssueSchema),
    suggestions: Type.Array(Type.String()),
    consensus: Type.Boolean(),
    summary: Type.String(),
    truncated: Type.Optional(Type.Boolean()),
    droppedFiles: Type.Optional(Type.Array(Type.String())),
    contextLimited: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const ConventionsSchema = Type.Object(
  {
    naming: Type.String(),
    structure: Type.String(),
    patterns: Type.Array(Type.String()),
    stack: Type.String(),
    testing: Type.Optional(Type.String()),
    orm: Type.Optional(Type.String()),
    ui: Type.Optional(Type.String()),
    styling: Type.Optional(Type.String()),
    buildTool: Type.Optional(Type.String()),
    ci: Type.Optional(Type.String()),
    packageManager: Type.Optional(Type.String()),
    entryPoints: Type.Array(Type.String()),
    scripts: Type.Array(Type.String()),
    publicApi: Type.Optional(Type.Array(Type.String())),
    commonPatterns: Type.Optional(Type.Array(Type.String())),
    styleSample: Type.Optional(Type.String()),
    agENTSmd: Type.Optional(Type.String()),
    generatedAt: Type.String(),
  },
  { additionalProperties: false },
);

export const TestFindingSchema = Type.Object(
  {
    severity: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    file: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    line: Type.Optional(Type.Union([Type.Number(), Type.Null(), Type.String()])),
    issue: Type.String(),
    suggestion: Type.String(),
    category: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: false },
);

export const MissingTestSchema = Type.Object(
  {
    file: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    reason: Type.String(),
  },
  { additionalProperties: false },
);

export const TestResultSchema = Type.Object(
  {
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("needs-work"), Type.Literal("blocked")]),
    findings: Type.Array(TestFindingSchema),
    missingTests: Type.Array(MissingTestSchema),
    summary: Type.String(),
  },
  { additionalProperties: false },
);

export const SecurityFindingSchema = Type.Object(
  {
    severity: Type.Union([Type.Literal("critical"), Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    file: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    line: Type.Optional(Type.Union([Type.Number(), Type.Null(), Type.String()])),
    issue: Type.String(),
    suggestion: Type.String(),
    category: Type.String(),
  },
  { additionalProperties: false },
);

export const SecurityResultSchema = Type.Object(
  {
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("needs-review")]),
    findings: Type.Array(SecurityFindingSchema),
    summary: Type.String(),
  },
  { additionalProperties: false },
);
