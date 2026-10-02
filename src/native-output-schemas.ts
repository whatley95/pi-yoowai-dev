import { Type, type TSchema, type TObject } from "@sinclair/typebox";
import {
  PlanResultSchema,
  ReviewResultSchema,
  JudgeResultSchema,
  SuggestResultSchema,
  RecommendResultSchema,
  TestResultSchema,
  SecurityResultSchema,
  ConventionsSchema,
} from "./schemas.js";

const strings = () => Type.Array(Type.String());
const optional = Type.Optional;
const object = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: true });

export const RecoverySchema = object({
  reason: Type.String(),
  message: Type.String(),
  nextAction: Type.String(),
  retry: Type.Union([Type.Literal("after-change"), Type.Literal("manual"), Type.Literal("transient")]),
  affectedFiles: optional(strings()),
});

export const WorkflowSchema = object({
  completedSteps: Type.Integer({ minimum: 0 }),
  totalSteps: Type.Integer({ minimum: 0 }),
  currentStep: optional(Type.String()),
  pendingEdits: Type.Integer({ minimum: 0 }),
  reviewPending: Type.Boolean(),
});

const review = object({
  ...Type.Partial(ReviewResultSchema).properties,
  inconclusive: optional(Type.Boolean()),
  inputIncomplete: optional(Type.Boolean()),
  scopeLimited: optional(Type.Boolean()),
  checksFailed: optional(Type.Boolean()),
});
const workflowOutput = object({
  action: optional(Type.String()),
  error: optional(Type.String()),
  plan: optional(PlanResultSchema),
  review: optional(review),
  advisor: optional(object({ advice: Type.String() })),
  suggest: optional(SuggestResultSchema),
  recommend: optional(RecommendResultSchema),
  judge: optional(object({ ...Type.Partial(JudgeResultSchema).properties, ...review.properties })),
  test: optional(TestResultSchema),
  security: optional(SecurityResultSchema),
  scan: optional(
    object({ conventions: optional(ConventionsSchema), files: optional(strings()), cached: optional(Type.Boolean()) }),
  ),
  done: optional(
    object({
      completedStep: Type.Integer(),
      totalSteps: Type.Integer(),
      allDone: Type.Boolean(),
      message: Type.String(),
      blocked: optional(Type.Boolean()),
      verified: optional(Type.Boolean()),
      verificationReason: optional(Type.String()),
      error: optional(Type.String()),
      nextStep: optional(Type.String()),
    }),
  ),
  recovery: optional(RecoverySchema),
  workflow: optional(WorkflowSchema),
  workspaceFingerprint: optional(Type.String()),
  elapsedMs: optional(Type.Number()),
  level: optional(Type.Union([Type.Literal("min"), Type.Literal("med"), Type.Literal("high")])),
});

const fact = object({
  fact: Type.String(),
  timestamp: Type.String(),
  id: optional(Type.String()),
  category: optional(Type.String()),
  source: optional(Type.String()),
  kind: optional(Type.String()),
  lastVerifiedAt: optional(Type.String()),
});
const symbol = object({
  name: Type.String(),
  kind: Type.String(),
  line: Type.Number(),
  exported: Type.Boolean(),
  signature: optional(Type.String()),
});
const file = object({
  file: Type.String(),
  symbols: Type.Array(symbol),
  imports: optional(strings()),
  dependents: optional(strings()),
});
const textAnalysis = object({
  summary: Type.String(),
  details: Type.String(),
  relatedFiles: optional(strings()),
  imagePath: optional(Type.String()),
  mimeType: optional(Type.String()),
});
const index = object({
  topic: optional(Type.String()),
  error: optional(Type.String()),
  guidance: optional(Type.String()),
  plan: optional(
    object({
      summary: optional(Type.String()),
      todo: optional(PlanResultSchema.properties.todo),
      completedSteps: Type.Integer(),
      totalSteps: Type.Integer(),
      acceptanceCriteria: optional(strings()),
    }),
  ),
  memory: optional(Type.String()),
  memoryEntries: optional(
    Type.Array(
      object({
        file: Type.String(),
        issues: Type.Array(
          object({
            severity: Type.String(),
            issue: Type.String(),
            suggestion: Type.String(),
            timestamp: Type.String(),
            occurrences: optional(strings()),
          }),
        ),
      }),
    ),
  ),
  learned: optional(Type.Array(fact)),
  learnedSummary: optional(Type.String()),
  index: optional(object({ generatedAt: Type.String(), files: Type.Array(file) })),
  indexSummary: optional(Type.String()),
  indexUpdated: optional(Type.Boolean()),
  conventions: optional(ConventionsSchema),
  cost: optional(
    object({
      calls: Type.Integer(),
      inputTokens: Type.Number(),
      outputTokens: Type.Number(),
      costUsd: Type.Number(),
      updatedAt: Type.String(),
    }),
  ),
  logs: optional(strings()),
  selection: optional(
    object({
      memory: optional(object({ matched: Type.Integer(), returned: Type.Integer() })),
      learned: optional(object({ matched: Type.Integer(), returned: Type.Integer() })),
      index: optional(
        object({
          totalFiles: Type.Integer(),
          matchedFiles: Type.Integer(),
          returnedFiles: Type.Integer(),
          matchedSymbols: Type.Integer(),
          returnedSymbols: Type.Integer(),
          limited: Type.Boolean(),
        }),
      ),
    }),
  ),
});

const outputs: Record<string, TObject> = {
  wai: workflowOutput,
  wai_review_min: workflowOutput,
  wai_review_med: workflowOutput,
  wai_review_high: workflowOutput,
  wai_index: index,
  wai_explain: object({ error: optional(Type.String()), explain: optional(textAnalysis) }),
  wai_vision: object({ error: optional(Type.String()), vision: optional(textAnalysis) }),
  wai_learn: object({
    error: optional(Type.String()),
    action: optional(Type.String()),
    learned: optional(Type.Array(fact)),
    stale: optional(Type.Array(fact)),
    reaffirmed: optional(Type.Boolean()),
    reason: optional(Type.String()),
    renewed: optional(Type.Integer()),
    verify: optional(
      Type.Array(
        object({
          fact,
          status: Type.String(),
          reasons: strings(),
          verified: optional(Type.Boolean()),
        }),
      ),
    ),
  }),
  wai_scaffold: object({
    error: optional(Type.String()),
    mode: optional(Type.String()),
    targets: optional(strings()),
    created: optional(strings()),
    skipped: optional(strings()),
    unresolvedTotal: optional(Type.Integer()),
    fillMeTotal: optional(Type.Integer()),
    files: optional(
      Type.Array(
        object({
          target: Type.String(),
          path: Type.String(),
          action: Type.String(),
          content: optional(Type.String()),
          unresolvedCount: Type.Integer(),
          fillMeCount: Type.Integer(),
        }),
      ),
    ),
  }),
  wai_design_ref: object({
    error: optional(Type.String()),
    topic: optional(Type.String()),
    doc: optional(Type.String()),
    content: optional(Type.String()),
    topics: optional(strings()),
    documents: optional(
      Type.Array(object({ topic: Type.String(), docs: strings(), description: optional(Type.String()) })),
    ),
  }),
};

/** Additive schemas preserve error-only results and future metadata fields. */
export function getNativeOutputSchema(name: string): TSchema {
  if (!outputs[name]) return object({});
  return object({
    ...outputs[name].properties,
    cost:
      outputs[name].properties.cost ??
      optional(
        object({
          estimatedInputTokens: Type.Number(),
          estimatedOutputTokens: Type.Number(),
          estimatedCostUsd: Type.Number(),
          sessionCostUsd: Type.Number(),
        }),
      ),
    model: optional(
      object({
        provider: Type.String(),
        id: Type.String(),
        thinking: optional(Type.String()),
        backend: optional(Type.String()),
      }),
    ),
  });
}
