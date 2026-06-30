import { Type } from "@sinclair/typebox";

export const PlanResultSchema = Type.Object(
  {
    todo: Type.Array(Type.String()),
    acceptanceCriteria: Type.Array(Type.String()),
    summary: Type.String(),
  },
  { additionalProperties: false },
);

export const ReviewIssueSchema = Type.Object(
  {
    severity: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
    file: Type.Optional(Type.String()),
    line: Type.Optional(Type.Number()),
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

export const JudgeResultSchema = Type.Intersect(
  [
    ReviewResultSchema,
    Type.Object(
      {
        summary: Type.String(),
      },
      { additionalProperties: false },
    ),
  ],
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
    styleSample: Type.Optional(Type.String()),
    agENTSmd: Type.Optional(Type.String()),
    generatedAt: Type.String(),
  },
  { additionalProperties: false },
);
