import { Value } from "@sinclair/typebox/value";
import type {
  PlanResult,
  ReviewResult,
  ReviewIssue,
  SuggestResult,
  RecommendResult,
  JudgeResult,
  Conventions,
  TestResult,
  SecurityResult,
  PlanTodoItem,
} from "./types.js";
import { planStepDescription } from "./types.js";
import {
  PlanResultSchema,
  ReviewResultSchema,
  SuggestResultSchema,
  RecommendResultSchema,
  JudgeResultSchema,
  ConventionsSchema,
  TestResultSchema,
  SecurityResultSchema,
} from "./schemas.js";

const PAIR_PROGRAMMER_PERSONA = `You are a senior pair programmer sitting next to the developer. You are collaborative, direct, and focused on shipping correct, maintainable code. You explain your reasoning briefly but stay actionable.`;

function buildPlanPromptImpl(task: string, conventions?: string): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";

  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

You are creating a structured plan for the developer. Break the task into an actionable, ordered todo list with clear acceptance criteria for each step.

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences, no wrapper object like { "response": "..." }:
{
  "summary": "one-sentence summary of the overall plan",
  "todo": [
    { "description": "step 1", "priority": "high", "dependsOn": [] },
    { "description": "step 2", "priority": "medium", "dependsOn": [1] },
    "step 3"
  ],
  "acceptanceCriteria": ["criterion 1: when X happens Y should occur", "criterion 2: ..."]
}

Rules:
- todo items must be concrete, verifiable, and ordered (what to do, not how to think about it)
- Use objects when priorities or dependencies matter; plain strings are also accepted
- priority must be one of: high, medium, low. Omit when unclear.
- dependsOn is a 1-based list of earlier step numbers this step cannot start until after
- acceptance criteria must be testable (specific checks, not vague goals)
- Each todo item should be one small unit of work — the main agent should complete it in 1-2 turns
- Maximum 5-8 todo items
- Maximum 5 acceptance criteria
- Respect the project conventions shown above when choosing file names, structure, and patterns
- CRITICAL: Your output is parsed by JSON.parse. Markdown, explanations, or wrapper objects will cause a parse failure.
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

const MAX_CACHED_PROMPT_SIZE = 50_000;
const promptCacheClearers: Array<() => void> = [];

export function clearPromptCache(): void {
  for (const clear of promptCacheClearers) {
    clear();
  }
}

function memoizePromptBuilder<TArgs extends unknown[]>(
  fn: (...args: TArgs) => { system: string; user: string },
  maxEntries = 50,
): (...args: TArgs) => { system: string; user: string } {
  const cache = new Map<string, { system: string; user: string }>();
  promptCacheClearers.push(() => cache.clear());
  return (...args: TArgs) => {
    let key: string;
    try {
      key = JSON.stringify(args);
    } catch {
      // Non-serializable args (circular refs, BigInt, etc.) bypass the cache.
      const result = fn(...args);
      return { system: result.system, user: result.user };
    }
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return { system: hit.system, user: hit.user };
    }
    const result = fn(...args);
    const resultSize = key.length + result.system.length + result.user.length;
    if (resultSize <= MAX_CACHED_PROMPT_SIZE) {
      while (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (typeof oldest === "string") cache.delete(oldest);
      }
      cache.set(key, result);
    }
    return { system: result.system, user: result.user };
  };
}

export interface FileContentContext {
  file: string;
  content: string;
  mode: "full" | "outline";
}

function buildAdaptiveReviewPromptImpl(
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

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences, no wrapper object like { "response": "..." }:
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
- CRITICAL: Your output is parsed by JSON.parse. Markdown, explanations, or wrapper objects will cause a parse failure and the review will be discarded.
- Be strict but fair — flag real problems, not preferences`,

    user: `Review this code change. The developer says:\n\n${description}${vcsLine}\n\n<diff>\n${diff}\n</diff>${fileContentsBlock}${criteriaBlock}${sessionBlock}${conventionsBlock}${preReviewBlock}${memoryBlock}${truncationNotice}${droppedBlock}${budgetBlock}`,
  };
}

function buildScanPromptImpl(): { system: string; user: string } {
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

Omit optional fields you cannot infer. Be concise and evidence-based. Do not include commentary outside the JSON.
CRITICAL: Your output is parsed by JSON.parse. Markdown, explanations, or wrapper objects will cause a parse failure.`,

    user: "Analyze the following project file list and key configuration files, then infer the naming conventions, structure, patterns, and tech stack.",
  };
}

function buildSuggestPromptImpl(question: string, conventions?: string): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";

  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

The developer is asking for advice on a technical choice. Offer practical, balanced options.

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences, no wrapper object like { "response": "..." }:
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
- CRITICAL: Your output is parsed by JSON.parse. Markdown, explanations, or wrapper objects will cause a parse failure.
- Do NOT include commentary outside the JSON`,

    user: `I need advice on:\n\n${question}${conventionsBlock}`,
  };
}

function buildRecommendPromptImpl(
  situation: string,
  planTodo?: PlanTodoItem[],
  conventions?: string,
): { system: string; user: string } {
  const planContext = planTodo?.length
    ? `\n\nCurrent plan (check items already done):\n${planTodo
        .map((t, i) => `${i + 1}. ${planStepDescription(t)}`)
        .join("\n")}`
    : "";

  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";

  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

Advise the developer on what to do next. Be decisive and actionable.

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences, no wrapper object like { "response": "..." }:
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
- Respect the project conventions shown above when choosing file names, structure, and patterns
- CRITICAL: Your output is parsed by JSON.parse. Markdown, explanations, or wrapper objects will cause a parse failure.`,

    user: `Here's where I'm at:\n\n${situation}${planContext}${conventionsBlock}\n\nWhat should I do next?`,
  };
}

function buildTestPromptImpl(
  description: string,
  diff: string,
  fileContents: FileContentContext[],
  testOutput: string,
  conventions?: string,
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const fileContentsBlock =
    fileContents.length > 0
      ? `\n\n<file_contents>\n${fileContents.map((f) => `--- ${f.file} (${f.mode}) ---\n${f.content}`).join("\n\n")}\n</file_contents>`
      : "";
  const testOutputBlock = testOutput
    ? `\n\n<test_output>\n${testOutput}\n</test_output>`
    : "\n\nNo test command output was provided. Analyze the diff statically for test coverage and quality.";

  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

You are reviewing the latest code change specifically for test coverage, test quality, and test failures.

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences, no wrapper object like { "response": "..." }:
{
  "verdict": "pass" | "needs-work" | "blocked",
  "findings": [
    { "severity": "high" | "medium" | "low", "file": "path/to/file.ts", "line": 42, "issue": "what's wrong", "suggestion": "how to fix it", "category": "failing-test" | "missing-test" | "test-quality" | "coverage" }
  ],
  "missingTests": [
    { "file": "src/feature.ts", "reason": "explain what behavior needs a test" }
  ],
  "summary": "one-paragraph assessment"
}

Rules:
- "verdict" is "pass" only if the diff has adequate tests and no failing tests
- "verdict" is "blocked" if tests are failing in a way that prevents merging
- "verdict" is "needs-work" for missing tests or low-quality tests that should be improved
- "findings" should include failing tests, brittle tests, missing assertions, or tests that do not verify the described behavior
- "missingTests" should list concrete production files whose changed behavior lacks a corresponding test
- Be specific and evidence-based; do not invent files or failures not shown in the test output or diff
- Respect project conventions when suggesting test file names or patterns
- CRITICAL: Your output is parsed by JSON.parse. Markdown, explanations, or wrapper objects will cause a parse failure.`,

    user: `Review this change for test coverage and quality. The developer says:\n\n${description}\n\n<diff>\n${diff}\n</diff>${fileContentsBlock}${testOutputBlock}${conventionsBlock}`,
  };
}

function buildSecurityPromptImpl(
  description: string,
  diff: string,
  fileContents: FileContentContext[],
  conventions?: string,
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const fileContentsBlock =
    fileContents.length > 0
      ? `\n\n<file_contents>\n${fileContents.map((f) => `--- ${f.file} (${f.mode}) ---\n${f.content}`).join("\n\n")}\n</file_contents>`
      : "";

  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

You are performing a security audit of the latest code change. Look for common vulnerabilities and risky patterns.

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences, no wrapper object like { "response": "..." }:
{
  "verdict": "pass" | "needs-review",
  "findings": [
    { "severity": "critical" | "high" | "medium" | "low", "file": "path/to/file.ts", "line": 42, "issue": "what's wrong", "suggestion": "how to fix it", "category": "secrets" | "injection" | "auth" | "access-control" | "validation" | "dependencies" | "crypto" | "logging" | "other" }
  ],
  "summary": "one-paragraph security assessment"
}

Rules:
- "verdict" is "pass" only if no findings are high or critical
- "verdict" is "needs-review" if any medium+ finding exists
- Each finding must include a specific, actionable remediation suggestion
- Categories must be one of: secrets, injection, auth, access-control, validation, dependencies, crypto, logging, other
- Do not flag speculative risks with no evidence in the provided diff or files
- Pay special attention to: hardcoded secrets, SQL/command injection, unsafe eval, missing input validation, insecure auth, permissive CORS, dependency upgrades, and logging sensitive data
- CRITICAL: Your output is parsed by JSON.parse. Markdown, explanations, or wrapper objects will cause a parse failure.`,

    user: `Audit this change for security issues. The developer says:\n\n${description}\n\n<diff>\n${diff}\n</diff>${fileContentsBlock}${conventionsBlock}`,
  };
}

function buildJudgePromptImpl(
  description: string,
  planTodo?: PlanTodoItem[],
  acceptanceCriteria?: string[],
  reviewHistory?: string,
  conventions?: string,
  preReviewOutput?: string,
  memoryContext?: string,
): { system: string; user: string } {
  const planBlock = planTodo?.length
    ? `\n\nOriginal plan:\n${planTodo.map((t, i) => `${i + 1}. ${planStepDescription(t)}`).join("\n")}`
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

Return ONLY a JSON object with this exact structure — no extra text, no markdown fences, no wrapper object like { "response": "..." }:
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
- Check the review_history — unreviewed steps are blocking
- CRITICAL: Your output is parsed by JSON.parse. Markdown, explanations, or wrapper objects will cause a parse failure.`,

    user: `Judge this completed work:\n\n${description}${planBlock}${criteriaBlock}${historyBlock}${conventionsBlock}${preReviewBlock}${memoryBlock}`,
  };
}

function buildExplainPromptImpl(
  target: string,
  context?: string,
  conventions?: string,
  indexSummary?: string,
  fileContents?: Array<{ file: string; content: string }>,
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const indexBlock = indexSummary ? `\n\n<project_index>\n${indexSummary}\n</project_index>` : "";
  const contextBlock = context ? `\n\n<context>\n${context}\n</context>` : "";
  const filesBlock =
    fileContents && fileContents.length > 0
      ? `\n\n<file_contents>\n${fileContents.map((f) => `--- ${f.file} ---\n${f.content}`).join("\n\n")}\n</file_contents>`
      : "";

  return {
    system: `${PAIR_PROGRAMMER_PERSONA}

Explain the provided code, error, diff, or file to the developer. Be concise but complete. Assume they are a senior engineer who wants to understand what is happening and why.

Rules:
- Start with a one-sentence summary
- Break down the important parts clearly
- If this is an error, explain the root cause and how to fix it
- If this is code, explain the intent, inputs, outputs, and any non-obvious behavior
- Reference specific files, functions, or line numbers when available
- Do NOT include commentary outside the explanation`,

    user: `Explain this:\n\n${target}${contextBlock}${conventionsBlock}${indexBlock}${filesBlock}`,
  };
}

export const buildPlanPrompt = memoizePromptBuilder(buildPlanPromptImpl);
export const buildExplainPrompt = memoizePromptBuilder(buildExplainPromptImpl);
// Review prompts include large, highly-dynamic diffs and file contents, so caching them
// adds memory pressure and key-serialization cost for near-zero hit rates.
export const buildAdaptiveReviewPrompt = buildAdaptiveReviewPromptImpl;
const SCAN_PROMPT = buildScanPromptImpl();
export const buildScanPrompt = () => ({ system: SCAN_PROMPT.system, user: SCAN_PROMPT.user });
export const buildSuggestPrompt = memoizePromptBuilder(buildSuggestPromptImpl);
export const buildRecommendPrompt = memoizePromptBuilder(buildRecommendPromptImpl);
export const buildTestPrompt = buildTestPromptImpl;
export const buildSecurityPrompt = buildSecurityPromptImpl;
export const buildJudgePrompt = memoizePromptBuilder(buildJudgePromptImpl);

export function parseJsonResponse<T>(text: string): T | null {
  // Strip BOM and normalize line endings.
  const cleaned = text.replace(/^\uFEFF/, "").trim();

  // Try the whole text first.
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = undefined;
  }

  // Unwrap common LLM wrapper objects like { "response": "..." }.
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed);
    if (keys.length === 1) {
      const key = keys[0];
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "string" && ["response", "answer", "result", "content", "data"].includes(key)) {
        const unwrapped = parseJsonResponse<T>(value);
        if (unwrapped !== null) return unwrapped;
      }
    }
  }

  if (parsed !== undefined) {
    try {
      return parsed as T;
    } catch {
      /* continue */
    }
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

  // Try inline backtick fences, but only for content that looks like JSON.
  const inlineRegex = /`([\s\S]*?)`/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineRegex.exec(cleaned)) !== null) {
    const trimmed = inlineMatch[1].trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      return JSON.parse(trimmed) as T;
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

// The secondary model sometimes returns null or descriptive text for issue fields.
// Remove those so downstream code always sees the expected types or nothing.
function normalizeIssueFields(issues: ReviewIssue[]): void {
  for (const issue of issues) {
    if (typeof issue.file !== "string") {
      delete issue.file;
    }
    if (typeof issue.line !== "number") {
      delete issue.line;
    }
  }
}

export function validateReviewResult(data: unknown): ReviewResult | null {
  const result = castOrNull<ReviewResult>(ReviewResultSchema, data);
  if (!result) return null;
  normalizeIssueFields(result.issues);
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
  normalizeIssueFields(result.issues);
  return result;
}

function normalizeTestFindingFields(findings: import("./types.js").TestFinding[]): void {
  for (const finding of findings) {
    if (typeof finding.file !== "string") {
      delete finding.file;
    }
    if (typeof finding.line !== "number") {
      delete finding.line;
    }
    if (typeof finding.category !== "string") {
      delete finding.category;
    }
  }
}

function normalizeSecurityFindingFields(findings: import("./types.js").SecurityFinding[]): void {
  for (const finding of findings) {
    if (typeof finding.file !== "string") {
      delete finding.file;
    }
    if (typeof finding.line !== "number") {
      delete finding.line;
    }
  }
}

function normalizeMissingTests(missing: import("./types.js").MissingTest[]): void {
  for (const item of missing) {
    if (typeof item.file !== "string") {
      delete item.file;
    }
  }
}

export function validateTestResult(data: unknown): TestResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const result = castOrNull<TestResult>(TestResultSchema, data);
  if (!result) return null;
  normalizeTestFindingFields(result.findings);
  normalizeMissingTests(result.missingTests);
  return result;
}

export function validateSecurityResult(data: unknown): SecurityResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const result = castOrNull<SecurityResult>(SecurityResultSchema, data);
  if (!result) return null;
  normalizeSecurityFindingFields(result.findings);
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

export function salvageReviewFromMarkdown(raw: string): ReviewResult | null {
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();

  let verdict: ReviewResult["verdict"] = "needs-work";
  if (/\bpass\b|\bapproved\b|\blooks good\b|\blgtm\b/.test(lower) && !/\bneeds-work\b|\bblocked\b/.test(lower)) {
    verdict = "pass";
  } else if (/\bblocked\b|\bcannot work\b|\bbroken\b/.test(lower)) {
    verdict = "blocked";
  }

  const suggestions: string[] = [];
  const bulletRegex = /^[-*•]\s+(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = bulletRegex.exec(text)) !== null) {
    const line = match[1].trim();
    if (line && !line.toLowerCase().startsWith("verdict")) {
      suggestions.push(line);
    }
  }

  // If there are no suggestions but the text has a clear "suggestion" section, capture sentences.
  if (suggestions.length === 0) {
    const sentenceRegex = /[A-Z][^.!?]*(?:suggest|recommend|consider|should|could|improvement)[^.!?]*[.!?]/gi;
    const sentenceMatches = text.match(sentenceRegex);
    if (sentenceMatches) {
      suggestions.push(...sentenceMatches.map((s) => s.trim()));
    }
  }

  return {
    verdict,
    issues: [],
    suggestions: suggestions.slice(0, 10),
    consensus: verdict === "pass" && suggestions.length === 0,
  };
}

export function salvageJudgeFromMarkdown(raw: string): import("./types.js").JudgeResult | null {
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  let verdict: import("./types.js").JudgeResult["verdict"] = "needs-work";
  if (/\bpass\b|\bapproved\b|\blooks good\b|\blgtm\b/.test(lower) && !/\bneeds-work\b|\bblocked\b/.test(lower)) {
    verdict = "pass";
  } else if (/\bblocked\b|\bcannot work\b|\bbroken\b/.test(lower)) {
    verdict = "blocked";
  }

  const suggestions: string[] = [];
  const bulletRegex = /^[-*•]\s+(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = bulletRegex.exec(text)) !== null) {
    const line = match[1].trim();
    if (line && !line.toLowerCase().startsWith("verdict")) {
      suggestions.push(line);
    }
  }

  const summaryMatch = text.match(/(?:summary|assessment|overall)[\s:]*(.+?)(?=\n\n|$)/is);
  const summary = summaryMatch?.[1].trim() ?? text.slice(0, 300).trim();

  return {
    verdict,
    issues: [],
    suggestions: suggestions.slice(0, 10),
    consensus: verdict === "pass" && suggestions.length === 0,
    summary,
  };
}
