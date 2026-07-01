import { Value } from "@sinclair/typebox/value";
import type {
  PlanResult,
  ReviewResult,
  ReviewIssue,
  SuggestResult,
  RecommendResult,
  JudgeResult,
  Conventions,
} from "./types.js";
import {
  PlanResultSchema,
  ReviewResultSchema,
  SuggestResultSchema,
  RecommendResultSchema,
  JudgeResultSchema,
  ConventionsSchema,
} from "./schemas.js";

const PAIR_PROGRAMMER_PERSONA = `You are a senior pair programmer sitting next to the developer. You are collaborative, direct, and focused on shipping correct, maintainable code. You explain your reasoning briefly but stay actionable.`;

export function buildPlanPrompt(task: string, conventions?: string): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";

  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

You are creating a structured plan for the developer. Break the task into an actionable, ordered todo list with clear acceptance criteria for each step.

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences:
{
  "summary": "one-sentence summary of the overall plan",
  "todo": ["step 1", "step 2", "step 3"],
  "acceptanceCriteria": ["criterion 1: when X happens Y should occur", "criterion 2: ..."]
}

Rules:
- todo items must be concrete, verifiable, and ordered (what to do, not how to think about it)
- acceptance criteria must be testable (specific checks, not vague goals)
- Each todo item should be one small unit of work — the main agent should complete it in 1-2 turns
- Maximum 5-8 todo items
- Maximum 5 acceptance criteria
- Respect the project conventions shown above when choosing file names, structure, and patterns
- Do NOT include commentary, explanations, or any text outside the JSON`,

    user: `Create a plan for this task:\n\n${task}${conventionsBlock}`,
  };
}

const REVIEW_RUBRIC = `Review rubric — check ALL of the following categories:

1. ERROR HANDLING: Missing try/catch, null/undefined checks, boundary conditions, empty input handling
2. IMPORTS & REFERENCES: Broken imports, undefined variables, wrong exports, missing module references
3. CONVENTIONS: Violates project naming patterns, file structure, or coding style
4. LOGIC: Type mismatches, race conditions, off-by-one errors, incorrect assumptions
5. COMPLETENESS: Does the code actually implement what was described? Are all acceptance criteria met?

For each issue found, provide a concrete, actionable fix suggestion. Do NOT suggest fixes that you cannot derive from the code shown.`;

export interface FileContentContext {
  file: string;
  content: string;
  mode: "full" | "outline";
}

export function buildAdaptiveReviewPrompt(
  description: string,
  diff: string,
  fileContents: FileContentContext[],
  options: {
    vcs?: string;
    criteria?: string;
    sessionContext?: string;
    conventionsText?: string;
    preReviewOutput?: string;
    memoryContext?: string;
    truncated?: boolean;
    droppedFiles?: string[];
    budgetNote?: string;
  } = {},
): { system: string; user: string } {
  const {
    vcs,
    criteria,
    sessionContext,
    conventionsText,
    preReviewOutput,
    memoryContext,
    truncated,
    droppedFiles,
    budgetNote,
  } = options;

  const criteriaBlock = criteria ? `\n\n<acceptance_criteria>\n${criteria}\n</acceptance_criteria>` : "";
  const sessionBlock = sessionContext ? `\n\n<session_context>\n${sessionContext}\n</session_context>` : "";
  const conventionsBlock = conventionsText
    ? `\n\n<project_conventions>\n${conventionsText}\n</project_conventions>`
    : "";
  const preReviewBlock = preReviewOutput ? `\n\n<pre_review_output>\n${preReviewOutput}\n</pre_review_output>` : "";
  const memoryBlock = memoryContext ? `\n\n<memory>\n${memoryContext}\n</memory>` : "";

  const fileContentsBlock =
    fileContents.length > 0
      ? `\n\n<file_contents>\n${fileContents
          .map((f) => `--- ${f.file} (${f.mode}) ---\n${f.content}`)
          .join("\n\n")}\n</file_contents>`
      : "";

  const droppedBlock =
    droppedFiles && droppedFiles.length > 0
      ? `\n\n⚠️ Some changed files were omitted due to token budget: ${droppedFiles.join(", ")}`
      : "";

  const truncationNotice = truncated
    ? "\n\n⚠️ NOTE: The diff was truncated because it was too large. Review only what's visible."
    : "";

  const budgetBlock = budgetNote ? `\n\n${budgetNote}` : "";
  const vcsLine = vcs ? `\n\nVersion control: ${vcs}` : "";

  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

You are reviewing the latest code change as the developer's pair. Catch bugs, mistakes, and quality issues they missed.

${REVIEW_RUBRIC}

You are provided with a diff and, when available, the full contents of changed files. Use the full file contents to verify context outside the diff; do not flag something as missing if you can see it in the full file.

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences:
{
  "verdict": "pass" | "needs-work" | "blocked",
  "issues": [
    { "severity": "high" | "medium" | "low", "file": "path/to/file.ts", "line": 42, "issue": "what's wrong", "suggestion": "how to fix it" }
  ],
  "suggestions": ["improvement 1", "improvement 2"],
  "consensus": true | false
}

Rules:
- "verdict" is "pass" only if ALL rubric categories are clean — no issues at any severity
- "verdict" is "blocked" if the code is fundamentally broken or cannot work as described
- "verdict" is "needs-work" for anything in between
- "consensus" is true when verdict is "pass" AND issues is empty
- Each issue must include a specific, actionable suggestion
- "file" and "line" are optional but strongly preferred when you can identify the exact location
- Respect the project conventions shown above; do NOT flag a pattern as wrong if it matches the conventions
- Pay attention to pre-review command output (lint/test/typecheck). Failures there are real issues.
- Memory shows past issues in the same files. If a past issue appears again, flag it as regression.
- CRITICAL: Only flag issues you can see evidence for. If a property, method, template, or style exists in the provided full file contents, do NOT flag it as missing. When unsure, prefer "pass" or "low" severity over guessing.
- Be strict but fair — flag real problems, not preferences`,

    user: `Review this code change. The developer says:\n\n${description}${vcsLine}\n\n<diff>\n${diff}\n</diff>${fileContentsBlock}${criteriaBlock}${sessionBlock}${conventionsBlock}${preReviewBlock}${memoryBlock}${truncationNotice}${droppedBlock}${budgetBlock}`,
  };
}

export function buildScanPrompt(): { system: string; user: string } {
  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

You are analyzing the codebase to extract conventions and architecture patterns. This context will ground future pair-programming sessions.

Return ONLY a JSON object with this exact structure:
{
  "naming": "dominant naming convention (e.g. camelCase, PascalCase, snake_case)",
  "structure": "project structure summary (e.g. src/, app/, lib/, tests/)",
  "patterns": ["observed pattern 1", "observed pattern 2"],
  "stack": "detected tech stack",
  "testing": "test framework if detectable (e.g. jest, vitest)",
  "orm": "ORM if detectable (e.g. prisma, drizzle)",
  "ui": "UI framework if detectable (e.g. react, vue)",
  "styling": "styling approach if detectable (e.g. tailwindcss, css modules)",
  "buildTool": "build tool if detectable (e.g. vite, webpack)",
  "ci": "CI provider if detectable (e.g. github-actions)",
  "packageManager": "package manager if detectable (e.g. npm, pnpm)",
  "entryPoints": ["src/index.ts"],
  "scripts": ["build: ...", "test: ..."]
}

Omit optional fields you cannot infer. Be concise and evidence-based. Do not include commentary outside the JSON.`,

    user: "Analyze the following project file list and key configuration files, then infer the naming conventions, structure, patterns, and tech stack.",
  };
}

export function buildSuggestPrompt(question: string, conventions?: string): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";

  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

The developer is asking for advice on a technical choice. Offer practical, balanced options.

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences:
{
  "approaches": [
    { "title": "approach name", "description": "what it is", "pros": ["pro 1", "pro 2"], "cons": ["con 1"] }
  ]
}

Rules:
- Provide 2-3 concrete approaches
- Each approach must have at least one pro and one con
- Be specific — no vague advice like "use a better pattern"
- Respect the project conventions shown above when evaluating approaches
- Do NOT include commentary outside the JSON`,

    user: `I need advice on:\n\n${question}${conventionsBlock}`,
  };
}

export function buildRecommendPrompt(
  situation: string,
  planTodo?: string[],
  conventions?: string,
): { system: string; user: string } {
  const planContext = planTodo?.length
    ? `\n\nCurrent plan (check items already done):\n${planTodo.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    : "";

  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";

  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

Advise the developer on what to do next. Be decisive and actionable.

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences:
{
  "nextStep": "concrete, actionable next step",
  "reasoning": "why this is the right step",
  "alternatives": ["alternative 1", "alternative 2"]
}

Rules:
- Return exactly ONE recommended step — be decisive
- The step must be concrete and immediately actionable
- Reasoning must explain the trade-off
- Provide 1-2 alternatives that were considered but rejected
- Respect the project conventions shown above when choosing file names, structure, and patterns`,

    user: `Here's where I'm at:\n\n${situation}${planContext}${conventionsBlock}\n\nWhat should I do next?`,
  };
}

export function buildJudgePrompt(
  description: string,
  planTodo?: string[],
  acceptanceCriteria?: string[],
  reviewHistory?: string,
  conventions?: string,
  preReviewOutput?: string,
  memoryContext?: string,
): { system: string; user: string } {
  const planBlock = planTodo?.length
    ? `\n\nOriginal plan:\n${planTodo.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    : "";

  const criteriaBlock = acceptanceCriteria?.length
    ? `\n\nAcceptance criteria:\n${acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
    : "";

  const historyBlock = reviewHistory
    ? `\n\n<review_history>\nStep-by-step review results:\n${reviewHistory}\n</review_history>`
    : "";

  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const preReviewBlock = preReviewOutput ? `\n\n<pre_review_output>\n${preReviewOutput}\n</pre_review_output>` : "";
  const memoryBlock = memoryContext ? `\n\n<memory>\n${memoryContext}\n</memory>` : "";

  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

You are performing a final holistic review of completed work before the developer ships it.

${REVIEW_RUBRIC}

Additionally, check:
6. PLAN COMPLETENESS: Does the completed work satisfy all items in the original plan?
7. REVIEW HISTORY: Look at the review_history below. Every plan step should have been reviewed and passed before judging. If ANY step was not reviewed, that is a blocking issue.
8. COHERENCE: Do all pieces work together? Is there anything contradictory?

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences:
{
  "verdict": "pass" | "needs-work" | "blocked",
  "issues": [
    { "severity": "high" | "medium" | "low", "file": "path/to/file.ts", "line": 42, "issue": "what's wrong", "suggestion": "how to fix it" }
  ],
  "suggestions": ["improvement 1"],
  "consensus": true | false,
  "summary": "one-paragraph holistic assessment of the completed work"
}

Rules:
- "consensus" is true only when verdict is "pass" AND issues is empty
- Provide a real summary that captures the overall quality, not filler
- If any plan step is incomplete or unreviewed, that's a medium-severity issue
- Check the review_history — unreviewed steps are blocking`,

    user: `Judge this completed work:\n\n${description}${planBlock}${criteriaBlock}${historyBlock}${conventionsBlock}${preReviewBlock}${memoryBlock}`,
  };
}

export function parseJsonResponse<T>(text: string): T | null {
  // Strip BOM and normalize line endings.
  const cleaned = text.replace(/^\uFEFF/, "").trim();

  // Try the whole text first.
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    /* continue */
  }

  // Try each markdown code fence.
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(cleaned)) !== null) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as T;
    } catch {
      /* continue */
    }
  }

  // Try inline backtick fences.
  const inlineRegex = /`([\s\S]*?)`/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineRegex.exec(cleaned)) !== null) {
    try {
      return JSON.parse(inlineMatch[1].trim()) as T;
    } catch {
      /* continue */
    }
  }

  // Find the largest balanced JSON object in the text, respecting strings.
  const json = extractLargestJsonObject(cleaned);
  if (json) {
    try {
      return JSON.parse(json) as T;
    } catch {
      /* continue */
    }
  }

  return null;
}

function extractLargestJsonObject(text: string): string | null {
  let best: string | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = text.slice(start, i + 1);
          if (!best || candidate.length > best.length) {
            best = candidate;
          }
        }
      }
    }
  }
  return best;
}

function castOrNull<T>(schema: Parameters<typeof Value.Cast>[0], data: unknown): T | null {
  try {
    // Prefer a plain Check when the data already matches; Cast can fail or mutate unexpectedly
    // on some provider responses (e.g., extra fields, proxy objects).
    if (Value.Check(schema, data)) {
      return data as T;
    }
    const cast = Value.Cast(schema, data);
    if (Value.Check(schema, cast)) {
      return cast as T;
    }
  } catch {
    /* invalid */
  }
  return null;
}

export function validatePlanResult(data: unknown): PlanResult | null {
  return castOrNull<PlanResult>(PlanResultSchema, data);
}

// The secondary model sometimes returns null or descriptive text for the `line` field.
// Remove those so downstream code always sees a number or nothing.
function normalizeIssueLines(issues: ReviewIssue[]): void {
  for (const issue of issues) {
    if (typeof issue.line !== "number") {
      delete issue.line;
    }
  }
}

export function validateReviewResult(data: unknown): ReviewResult | null {
  const result = castOrNull<ReviewResult>(ReviewResultSchema, data);
  if (!result) return null;
  normalizeIssueLines(result.issues);
  // Consensus is meaningful only when the verdict is pass and no issues remain.
  result.consensus = result.verdict === "pass" && result.issues.length === 0;
  return result;
}

export function validateSuggestResult(data: unknown): SuggestResult | null {
  return castOrNull<SuggestResult>(SuggestResultSchema, data);
}

export function validateRecommendResult(data: unknown): RecommendResult | null {
  return castOrNull<RecommendResult>(RecommendResultSchema, data);
}

export function validateJudgeResult(data: unknown): JudgeResult | null {
  const result = castOrNull<JudgeResult>(JudgeResultSchema, data);
  if (!result) return null;
  normalizeIssueLines(result.issues);
  return result;
}

export function validateConventionsResult(data: unknown): Conventions | null {
  const result = castOrNull<Conventions>(ConventionsSchema, data);
  if (!result) return null;
  // Preserve an existing timestamp; only set a new one when the model omitted it.
  const incoming =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).generatedAt
      : undefined;
  result.generatedAt = typeof incoming === "string" ? incoming : new Date().toISOString();
  return result;
}

export function getJsonParseError(text: string): string | null {
  try {
    JSON.parse(text.trim());
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function formatValidationErrors(
  schema: Parameters<typeof Value.Errors>[0],
  data: unknown,
): Array<{ path: string; message: string; value: unknown }> {
  return [...Value.Errors(schema, data)].map((e) => ({
    path: e.path,
    message: e.message,
    value: e.value,
  }));
}

export function getReviewValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(ReviewResultSchema, data);
}

export function getSuggestValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(SuggestResultSchema, data);
}

export function getRecommendValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(RecommendResultSchema, data);
}

export function getJudgeValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(JudgeResultSchema, data);
}

export function getPlanValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(PlanResultSchema, data);
}
