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

/** Common prefix shared across all yoo system prompts to improve provider cache hit rates.
 *  Action-specific role, schema, and rules are appended after this prefix. */
const COMMON_SYSTEM_PREFIX = `${PAIR_PROGRAMMER_PERSONA}

You are operating in a structured pair-programming workflow. Follow these principles in every response:
- Be concise, direct, and actionable.
- Ground your reasoning in the provided context.
- Do not invent files, failures, or evidence not shown.
- Respect project conventions when they are provided.`;

function finalJsonBlock(schema: string, nativeJson = false): string {
  if (nativeJson) {
    return `Return only valid JSON matching this schema. Do not include markdown fences, explanatory text, or commentary outside the JSON object.

JSON schema:
${schema}

Rules:
- The response must be a single JSON object parseable by JSON.parse.
- Do not put comments or trailing commas inside the JSON.`;
  }
  return `You may write brief Markdown analysis first.

End your response with this exact section:

## Result
\`\`\`json
${schema}
\`\`\`

Rules for the final JSON block:
- The fenced JSON block is the machine-readable result parsed by the tool.
- The JSON must match the schema exactly.
- Do not put comments or trailing commas inside the JSON.
- Do not include any text after the closing JSON fence.`;
}

function buildPlanPromptImpl(task: string, conventions?: string, snapshot?: string): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const snapshotBlock = snapshot ? `\n\n<project_snapshot>\n${snapshot}\n</project_snapshot>` : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}

You are creating a structured plan for the developer. Break the task into an actionable, ordered todo list with clear acceptance criteria for each step.

${finalJsonBlock(`{
  "summary": "one-sentence summary of the overall plan",
  "todo": [
    { "description": "step 1", "priority": "high", "dependsOn": [] },
    { "description": "step 2", "priority": "medium", "dependsOn": [1] },
    "step 3"
  ],
  "acceptanceCriteria": ["criterion 1: when X happens Y should occur", "criterion 2: ..."]
}`)}

Rules:
- todo items must be concrete, verifiable, and ordered (what to do, not how to think about it)
- Use objects when priorities or dependencies matter; plain strings are also accepted
- priority must be one of: high, medium, low. Omit when unclear.
- dependsOn is a 1-based list of earlier step numbers this step cannot start until after
- acceptance criteria must be testable (specific checks, not vague goals)
- Each todo item should be one small unit of work — the main agent should complete it in 1-2 turns
- Aim for 5-8 todo items (more is acceptable for large refactors, but keep steps small and actionable)
- Aim for 5 acceptance criteria
- Stay scoped to the requested task; do not add unrelated refactoring, cleanup, or extra features
- Respect the project conventions shown above when choosing file names, structure, and patterns
- Use the project snapshot to ground the plan in the actual codebase. Prefer existing file paths/patterns from the snapshot. If a step requires a new file, explain why.
${EVIDENCE_RULES}`,

    user: `Create a plan for this task:\n\n${task}${conventionsBlock}${snapshotBlock}`,
  };
}

const REVIEW_RUBRIC = `Review rubric — check ALL of the following categories:

1. ERROR HANDLING: Missing try/catch, null/undefined checks, boundary conditions, empty input handling
2. IMPORTS & REFERENCES: Broken imports, undefined variables, wrong exports, missing module references
3. CONVENTIONS: Violates project naming patterns, file structure, or coding style
4. LOGIC: Type mismatches, race conditions, off-by-one errors, incorrect assumptions
5. COMPLETENESS: Does the code actually implement what was described? Are all acceptance criteria met? If the description or plan contradicts the actual code, trust the code and treat the plan as stale.

For each issue found, provide a concrete, actionable fix suggestion. Do NOT suggest fixes that you cannot derive from the code shown.`;

const EVIDENCE_RULES = `EVIDENCE REQUIREMENTS:
- Every issue, finding, or judgment must cite specific supporting evidence: a file path, line number, diff hunk, convention, or external doc.
- If you cannot point to supporting context, downgrade the severity or omit the claim.
- Do not invent files, failures, lines, or evidence not shown in the provided context.
- Respect project conventions; do NOT flag a pattern as wrong if it matches the conventions shown.`;

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

export function buildReviewUserContext(args: {
  description: string;
  diff: string;
  fileContents: FileContentContext[];
  vcs?: string;
  criteria?: string;
  currentStep?: string;
  sessionContext?: string;
  conventionsText?: string;
  preReviewOutput?: string;
  memoryContext?: string;
  truncated?: boolean;
  droppedFiles?: string[];
  budgetNote?: string;
}): string {
  const {
    description,
    diff,
    fileContents,
    vcs,
    criteria,
    currentStep,
    sessionContext,
    conventionsText,
    preReviewOutput,
    memoryContext,
    truncated,
    droppedFiles,
    budgetNote,
  } = args;

  const criteriaBlock = criteria ? `\n\n<acceptance_criteria>\n${criteria}\n</acceptance_criteria>` : "";
  const currentStepBlock = currentStep ? `\n\nCurrent plan step being reviewed:\n${currentStep}` : "";
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

  return `Review this code change. The developer says:\n\n${description}${vcsLine}${currentStepBlock}\n\n<diff>\n${diff}\n</diff>${fileContentsBlock}${criteriaBlock}${sessionBlock}${conventionsBlock}${preReviewBlock}${memoryBlock}${truncationNotice}${droppedBlock}${budgetBlock}`;
}

function buildAdaptiveReviewPromptImpl(
  description: string,
  diff: string,
  fileContents: FileContentContext[],
  options: {
    vcs?: string;
    criteria?: string;
    currentStep?: string;
    sessionContext?: string;
    conventionsText?: string;
    preReviewOutput?: string;
    memoryContext?: string;
    truncated?: boolean;
    droppedFiles?: string[];
    budgetNote?: string;
    nativeJson?: boolean;
  } = {},
): { system: string; user: string } {
  const {
    vcs,
    criteria,
    currentStep,
    sessionContext,
    conventionsText,
    preReviewOutput,
    memoryContext,
    truncated,
    droppedFiles,
    budgetNote,
    nativeJson,
  } = options;

  return {
    system: `${COMMON_SYSTEM_PREFIX}

You are reviewing the latest code change as the developer's pair. Catch bugs, mistakes, and quality issues they missed.

${REVIEW_RUBRIC}

You are provided with a diff and, when available, the full contents of changed files. Use the full file contents to verify context outside the diff; do not flag something as missing if you can see it in the full file.

${finalJsonBlock(
  `{
  "verdict": "needs-work",
  "issues": [
    { "severity": "medium", "file": "path/to/file.ts", "line": 42, "issue": "what's wrong", "suggestion": "how to fix it" }
  ],
  "suggestions": ["improvement 1", "improvement 2"],
  "consensus": false,
  "planStale": false,
  "completedSteps": 1
}`,
  nativeJson,
)}

Rules:
- "verdict" must be one of: "pass", "needs-work", "blocked"
- issue "severity" must be one of: "high", "medium", "low"
- "verdict" is "pass" only if ALL rubric categories are clean — no issues at any severity
- "verdict" is "blocked" if the code is fundamentally broken or cannot work as described
- "verdict" is "needs-work" for anything in between
- "consensus" is true when verdict is "pass" AND issues is empty
- Set "planStale": true if the current plan step contradicts the actual code and the code is internally consistent. Do not flag the code as wrong solely because it differs from the plan.
- Set "completedSteps" to the number of plan steps (including the current step) that the diff fully completes. If only the current step is done, use 1.
- Each issue must include a specific, actionable suggestion
- "file" and "line" are optional but strongly preferred when you can identify the exact location
- Respect the project conventions shown above; do NOT flag a pattern as wrong if it matches the conventions
- Pay attention to pre-review command output (lint/test/typecheck). Failures there are real issues ONLY for files changed in this diff; ignore pre-existing warnings in unrelated files.
- Memory shows past issues in the same files. If a past issue appears again, flag it as regression.
- CRITICAL: Only flag issues you can see evidence for. If a property, method, template, or style exists in the provided full file contents, do NOT flag it as missing. When unsure, prefer "pass" or "low" severity over guessing.
- When reviewing a code change (a diff is provided), only flag issues in files that are part of that change. Do NOT flag pre-existing problems in unrelated files.
- When no diff is provided and the developer asks you to review a specific function/file, review exactly that requested scope.
- If a current plan step is shown above, only evaluate acceptance criteria that are relevant to that step. Do NOT flag work from other plan steps as missing.
- If the current plan step contradicts the actual code (e.g., describes a different endpoint, method, parameter, or design than what is implemented), treat the plan as stale. Trust the code and note that the plan should be updated. Do not flag the code as wrong solely because it differs from the plan.
- Be strict but fair — flag real problems, not preferences
${EVIDENCE_RULES}`,

    user: buildReviewUserContext({
      description,
      diff,
      fileContents,
      vcs,
      criteria,
      currentStep,
      sessionContext,
      conventionsText,
      preReviewOutput,
      memoryContext,
      truncated,
      droppedFiles,
      budgetNote,
    }),
  };
}

function buildScanPromptImpl(nativeJson = false): { system: string; user: string } {
  return {
    system: `${COMMON_SYSTEM_PREFIX}

You are analyzing the codebase to extract conventions and architecture patterns. This context will ground future pair-programming sessions.

${finalJsonBlock(
  `{
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
}`,
  nativeJson,
)}

Omit optional fields you cannot infer. Be concise and evidence-based.`,

    user: "Analyze the following project file list and key configuration files, then infer the naming conventions, structure, patterns, and tech stack.",
  };
}

function buildSuggestPromptImpl(
  question: string,
  conventions?: string,
  nativeJson = false,
  docContext = "",
  fileContents: FileContentContext[] = [],
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const docsBlock = docContext ? `\n\n${docContext}` : "";
  const filesBlock =
    fileContents.length > 0
      ? `\n\n<relevant_files>\n${fileContents.map((f) => `--- ${f.file} (${f.mode}) ---\n${f.content}`).join("\n\n")}\n</relevant_files>`
      : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}

The developer is asking for advice on a technical choice. Offer practical, balanced options. Use the external documentation and relevant files when they are provided.

${finalJsonBlock(
  `{
  "approaches": [
    { "title": "approach name", "description": "what it is", "pros": ["pro 1", "pro 2"], "cons": ["con 1"] }
  ]
}`,
  nativeJson,
)}

Rules:
- Provide 2-3 concrete approaches
- Each approach must have at least one pro and one con
- Be specific — no vague advice like "use a better pattern"
- Keep suggestions focused on the specific question; do not broaden to unrelated architecture changes
- Respect the project conventions shown above when evaluating approaches
- Ground your answer in the external documentation and relevant files when they are provided
- If the relevant files do not cover the question, say so and base your answer on conventions and docs only
${EVIDENCE_RULES}`,

    user: `I need advice on:\n\n${question}${conventionsBlock}${docsBlock}${filesBlock}`,
  };
}

function buildRecommendPromptImpl(
  situation: string,
  planTodo?: PlanTodoItem[],
  conventions?: string,
  nativeJson = false,
  docContext = "",
  fileContents: FileContentContext[] = [],
  currentStep?: string,
  memoryContext = "",
): { system: string; user: string } {
  const planContext = planTodo?.length
    ? `\n\nCurrent plan (check items already done):\n${planTodo
        .map((t, i) => `${i + 1}. ${planStepDescription(t)}`)
        .join("\n")}`
    : "";

  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const docsBlock = docContext ? `\n\n${docContext}` : "";
  const filesBlock =
    fileContents.length > 0
      ? `\n\n<relevant_files>\n${fileContents.map((f) => `--- ${f.file} (${f.mode}) ---\n${f.content}`).join("\n\n")}\n</relevant_files>`
      : "";
  const currentStepBlock = currentStep ? `\n\nCurrent plan step:\n${currentStep}` : "";
  const memoryBlock = memoryContext ? `\n\n<memory>\n${memoryContext}\n</memory>` : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}

Advise the developer on what to do next. Be decisive and actionable. Use the external documentation, relevant files, and recent review memory when they are provided.

${finalJsonBlock(
  `{
  "nextStep": "concrete, actionable next step",
  "reasoning": "why this is the right step",
  "alternatives": ["alternative 1", "alternative 2"]
}`,
  nativeJson,
)}

Rules:
- Return exactly ONE recommended step — be decisive
- The step must be concrete and immediately actionable
- Reasoning must explain the trade-off
- Provide 1-2 alternatives that were considered but rejected
- Stay within the current task/plan; do not recommend unrelated work or scope expansion
- Respect the project conventions shown above when choosing file names, structure, and patterns
- Ground your recommendation in the external documentation and relevant files when they are provided
- If the relevant files do not cover the situation, say so and base your recommendation on the plan, conventions, and docs
${EVIDENCE_RULES}`,

    user: `Here's where I'm at:\n\n${situation}${planContext}${currentStepBlock}${conventionsBlock}${docsBlock}${filesBlock}${memoryBlock}\n\nWhat should I do next?`,
  };
}

function buildTestPromptImpl(
  description: string,
  diff: string,
  fileContents: FileContentContext[],
  testOutput: string,
  conventions?: string,
  nativeJson = false,
  currentStep?: string,
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const fileContentsBlock =
    fileContents.length > 0
      ? `\n\n<file_contents>\n${fileContents.map((f) => `--- ${f.file} (${f.mode}) ---\n${f.content}`).join("\n\n")}\n</file_contents>`
      : "";
  const testOutputBlock = testOutput
    ? `\n\n<test_output>\n${testOutput}\n</test_output>`
    : "\n\nNo test command output was provided. Analyze the diff statically for test coverage and quality.";
  const currentStepBlock = currentStep ? `\n\nCurrent plan step being reviewed:\n${currentStep}` : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}

You are reviewing the latest code change specifically for test coverage, test quality, and test failures.

${finalJsonBlock(
  `{
  "verdict": "needs-work",
  "findings": [
    { "severity": "medium", "file": "path/to/file.ts", "line": 42, "issue": "what's wrong", "suggestion": "how to fix it", "category": "missing-test" }
  ],
  "missingTests": [
    { "file": "src/feature.ts", "reason": "explain what behavior needs a test" }
  ],
  "summary": "one-paragraph assessment"
}`,
  nativeJson,
)}

Rules:
- "verdict" must be one of: "pass", "needs-work", "blocked"
- finding "severity" must be one of: "high", "medium", "low"
- finding "category" must be one of: "failing-test", "missing-test", "test-quality", "coverage"
- "verdict" is "pass" only if the diff has adequate tests and no failing tests
- "verdict" is "blocked" if tests are failing in a way that prevents merging
- "verdict" is "needs-work" for missing tests or low-quality tests that should be improved
- "findings" should include failing tests, brittle tests, missing assertions, or tests that do not verify the described behavior
- "missingTests" should list concrete production files whose changed behavior lacks a corresponding test
- Be specific and evidence-based; do not invent files or failures not shown in the test output or diff
- When reviewing a code change (a diff is provided), only flag test issues in files that are part of that change. Do NOT flag pre-existing test failures or missing tests in unrelated files.
- When no diff is provided and the developer asks about a specific function/file, evaluate exactly that requested scope.
- If a current plan step is shown above, only evaluate test coverage relevant to that step. Do NOT flag missing tests for work from other plan steps.
- If the current plan step contradicts the actual code (e.g., describes a different endpoint, method, parameter, or design than what is implemented), treat the plan as stale. Trust the code and note that the plan should be updated. Do not flag the code as wrong solely because it differs from the plan.
- "missingTests" should list only production files whose behavior is changed by the diff and lack a corresponding test.
- Respect project conventions when suggesting test file names or patterns
${EVIDENCE_RULES}`,

    user: `Review this change for test coverage and quality. The developer says:\n\n${description}${currentStepBlock}\n\n<diff>\n${diff}\n</diff>${fileContentsBlock}${testOutputBlock}${conventionsBlock}`,
  };
}

function buildSecurityPromptImpl(
  description: string,
  diff: string,
  fileContents: FileContentContext[],
  conventions?: string,
  nativeJson = false,
  currentStep?: string,
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const fileContentsBlock =
    fileContents.length > 0
      ? `\n\n<file_contents>\n${fileContents.map((f) => `--- ${f.file} (${f.mode}) ---\n${f.content}`).join("\n\n")}\n</file_contents>`
      : "";
  const currentStepBlock = currentStep ? `\n\nCurrent plan step being audited:\n${currentStep}` : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}

You are performing a security audit of the latest code change. Look for common vulnerabilities and risky patterns.

${finalJsonBlock(
  `{
  "verdict": "needs-review",
  "findings": [
    { "severity": "medium", "file": "path/to/file.ts", "line": 42, "issue": "what's wrong", "suggestion": "how to fix it", "category": "validation" }
  ],
  "summary": "one-paragraph security assessment"
}`,
  nativeJson,
)}

Rules:
- "verdict" must be one of: "pass", "needs-review"
- finding "severity" must be one of: "critical", "high", "medium", "low"
- finding "category" must be one of: "secrets", "injection", "auth", "access-control", "validation", "dependencies", "crypto", "logging", "other"
- "verdict" is "pass" only if no findings are high or critical
- "verdict" is "needs-review" if any medium+ finding exists
- Each finding must include a specific, actionable remediation suggestion
- Categories must be one of: secrets, injection, auth, access-control, validation, dependencies, crypto, logging, other
- Do not flag speculative risks with no evidence in the provided diff or files
- When auditing a code change (a diff is provided), only flag security findings in files that are part of that change. Do NOT flag pre-existing vulnerabilities in unrelated files.
- When no diff is provided and the developer asks about a specific function/file, audit exactly that requested scope.
- If a current plan step is shown above, only evaluate security risks relevant to that step. Do NOT flag missing security work from other plan steps.
- If the current plan step contradicts the actual code (e.g., describes a different endpoint, method, parameter, or design than what is implemented), treat the plan as stale. Trust the code and note that the plan should be updated. Do not flag the code as wrong solely because it differs from the plan.
- Pay special attention to: hardcoded secrets, SQL/command injection, unsafe eval, missing input validation, insecure auth, permissive CORS, dependency upgrades, and logging sensitive data
${EVIDENCE_RULES}`,

    user: `Audit this change for security issues. The developer says:\n\n${description}${currentStepBlock}\n\n<diff>\n${diff}\n</diff>${fileContentsBlock}${conventionsBlock}`,
  };
}

function buildJudgePromptImpl(
  description: string,
  options: {
    planTodo?: PlanTodoItem[];
    acceptanceCriteria?: string[];
    reviewHistory?: string;
    conventions?: string;
    preReviewOutput?: string;
    memoryContext?: string;
    diff?: string;
    fileContents?: FileContentContext[];
    truncated?: boolean;
    droppedFiles?: string[];
    budgetNote?: string;
    nativeJson?: boolean;
  } = {},
): { system: string; user: string } {
  const {
    planTodo,
    acceptanceCriteria,
    reviewHistory,
    conventions,
    preReviewOutput,
    memoryContext,
    diff,
    fileContents,
    truncated,
    droppedFiles,
    budgetNote,
    nativeJson,
  } = options;

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

  const diffBlock = diff ? `\n\n<diff>\n${diff}\n</diff>` : "";
  const fileContentsBlock =
    fileContents && fileContents.length > 0
      ? `\n\n<file_contents>\n${fileContents.map((f) => `--- ${f.file} (${f.mode}) ---\n${f.content}`).join("\n\n")}\n</file_contents>`
      : "";

  const droppedBlock =
    droppedFiles && droppedFiles.length > 0
      ? `\n\n⚠️ Some changed files were omitted due to token budget: ${droppedFiles.join(", ")}`
      : "";

  const truncationNotice = truncated
    ? "\n\n⚠️ NOTE: The diff was truncated because it was too large. Judge only what's visible."
    : "";

  const budgetBlock = budgetNote ? `\n\n${budgetNote}` : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}

You are performing a final holistic review of completed work before the developer ships it. You are given the actual diff and changed file contents, so judge the code directly rather than trusting the review history alone.

${REVIEW_RUBRIC}

Additionally, check:
6. PLAN COMPLETENESS: Does the completed work satisfy all items in the original plan that are addressed by the current code? If the original plan contradicts the final code and the code is internally consistent, the plan is stale — judge the code on its own merits and note that the plan should be updated.
7. REVIEW HISTORY: Look at the review_history below. Completed plan steps should ideally have been reviewed, but unstarted or in-progress steps do not block the verdict. Only block if a completed step is unreviewed AND the code itself is suspect.
8. COHERENCE: Do all pieces work together? Is there anything contradictory?

${finalJsonBlock(
  `{
  "verdict": "needs-work",
  "issues": [
    { "severity": "medium", "file": "path/to/file.ts", "line": 42, "issue": "what's wrong", "suggestion": "how to fix it" }
  ],
  "suggestions": ["improvement 1"],
  "consensus": false,
  "summary": "one-paragraph holistic assessment of the completed work",
  "planStale": false
}`,
  nativeJson,
)}

Rules:
- "verdict" must be one of: "pass", "needs-work", "blocked"
- issue "severity" must be one of: "high", "medium", "low"
- "consensus" is true only when verdict is "pass" AND issues is empty
- Set "planStale": true if the original plan contradicts the final code and the code is internally consistent. Judge the code on its own merits and note that the plan should be updated.
- Provide a real summary that captures the overall quality, not filler
- Judge only against the original plan and acceptance criteria; do not introduce new requirements that were not part of the plan
- If the original plan contradicts the actual code and the code is internally consistent, treat the plan as stale. Judge the code on its own merits and note that the plan should be updated.
- Judge the completed code on its own merits. If the current changes satisfy multiple plan steps at once, that is fine.
- Unstarted or in-progress plan steps do not block a pass verdict. Only block if a completed step is unreviewed AND the code itself has issues.
- You may note tracker gaps (unreviewed or unmarked steps) as a non-blocking observation, not as a blocking issue.
- When the diff/file contents are truncated, do not treat missing context as a defect; judge only what is shown
${EVIDENCE_RULES}`,

    user: `Judge this completed work:\n\n${description}${planBlock}${criteriaBlock}${historyBlock}${diffBlock}${fileContentsBlock}${conventionsBlock}${preReviewBlock}${memoryBlock}${truncationNotice}${droppedBlock}${budgetBlock}`,
  };
}

function buildVerifyPromptImpl(
  originalContext: string,
  originalResult: string,
  task: "review" | "judge",
): { system: string; user: string } {
  return {
    system: `${COMMON_SYSTEM_PREFIX}

You are critiquing a ${task} result produced by another language model. Your job is to remove or downgrade any claim that is not supported by the original context.

Rules:
- Read the original context carefully. It contains the diff, file contents, conventions, and other data the first model saw.
- Read the ${task} result. For every issue, finding, suggestion, or judgment, ask: "Is there specific evidence in the original context that supports this?"
- Remove any issue/finding/suggestion that has no supporting evidence.
- Downgrade severity (high→medium, medium→low) if the evidence is weak or indirect.
- Do NOT add new issues that were not in the original result.
- Do NOT change a verdict from "pass" to "needs-work" or "blocked" unless the original result itself contained unsupported claims that must be removed.
- If the original result is well-supported, return it unchanged.
- Preserve the original JSON schema and structure.

${EVIDENCE_RULES}`,

    user: `Original context provided to the ${task} model:\n\n${originalContext}\n\n---\n\n${task} result to verify:\n\n${originalResult}\n\n---\n\nReturn the corrected ${task} result. Remove or downgrade any unsupported claims. If everything is supported, return the original result unchanged.`,
  };
}

function buildExplainPromptImpl(
  target: string,
  context?: string,
  conventions?: string,
  indexSummary?: string,
  fileContents?: Array<{ file: string; content: string }>,
  docContext = "",
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const indexBlock = indexSummary ? `\n\n<project_index>\n${indexSummary}\n</project_index>` : "";
  const contextBlock = context ? `\n\n<context>\n${context}\n</context>` : "";
  const filesBlock =
    fileContents && fileContents.length > 0
      ? `\n\n<file_contents>\n${fileContents.map((f) => `--- ${f.file} ---\n${f.content}`).join("\n\n")}\n</file_contents>`
      : "";
  const docsBlock = docContext ? `\n\n${docContext}` : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}

Explain the provided code, error, diff, or file to the developer. Be concise but complete. Assume they are a senior engineer who wants to understand what is happening and why. Use the external documentation when it is provided.

Rules:
- Start with a one-sentence summary
- Break down the important parts clearly
- If this is an error, explain the root cause and how to fix it
- If this is code, explain the intent, inputs, outputs, and any non-obvious behavior
- If this is a diff or merge conflict, explain the conflicting versions and trade-offs. Do NOT claim the conflict is resolved or that files have been edited.
- Phrase any recommendations as suggestions, not as completed actions.
- Do NOT include a "Next Steps" section that implies work has already been done.
- Reference specific files, functions, or line numbers when available
- Ground your explanation in the external documentation when it is provided
- Do NOT include commentary outside the explanation`,

    user: `Explain this:\n\n${target}${contextBlock}${conventionsBlock}${indexBlock}${filesBlock}${docsBlock}`,
  };
}

export const buildPlanPrompt = memoizePromptBuilder(buildPlanPromptImpl);
export const buildExplainPrompt = memoizePromptBuilder(buildExplainPromptImpl);
// Review prompts include large, highly-dynamic diffs and file contents, so caching them
// adds memory pressure and key-serialization cost for near-zero hit rates.
export const buildAdaptiveReviewPrompt = buildAdaptiveReviewPromptImpl;
export const buildScanPrompt = buildScanPromptImpl;
export const buildSuggestPrompt = memoizePromptBuilder(buildSuggestPromptImpl);
export const buildRecommendPrompt = memoizePromptBuilder(buildRecommendPromptImpl);
export const buildTestPrompt = buildTestPromptImpl;
export const buildSecurityPrompt = buildSecurityPromptImpl;
export const buildJudgePrompt = memoizePromptBuilder(buildJudgePromptImpl);
export const buildVerifyPrompt = buildVerifyPromptImpl;

export function parseJsonResponse<T>(text: string): T | null {
  // Strip BOM and normalize line endings.
  const cleaned = text.replace(/^\uFEFF/, "").trim();

  // Try the whole text first (strict, then lenient repair).
  const parsed: unknown = tryParseJson(cleaned);

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

  // Prefer the explicit structured-output section used by the prompts.
  const resultFence = cleaned.match(/(?:^|\n)##\s*Result\s*\n+```(?:json)?\s*([\s\S]*?)```/i);
  if (resultFence) {
    const candidate = tryParseJson(resultFence[1].trim());
    if (candidate !== undefined) return candidate as T;
  }

  // Try each markdown code fence.
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRegex.exec(cleaned)) !== null) {
    const candidate = tryParseJson(fenceMatch[1].trim());
    if (candidate !== undefined) return candidate as T;
  }

  // Try inline backtick fences, but only for content that looks like JSON.
  const inlineRegex = /`([\s\S]*?)`/g;
  let inlineMatch: RegExpExecArray | null;
  while ((inlineMatch = inlineRegex.exec(cleaned)) !== null) {
    const trimmed = inlineMatch[1].trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    const candidate = tryParseJson(trimmed);
    if (candidate !== undefined) return candidate as T;
  }

  // Find the largest balanced JSON object in the text, respecting strings.
  const json = extractLargestJsonObject(cleaned);
  if (json) {
    const candidate = tryParseJson(json);
    if (candidate !== undefined) return candidate as T;
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

/**
 * Lenient repair of near-valid JSON produced by LLMs. String-aware single pass:
 * strips line and block comments, normalizes single-quoted strings to double quotes,
 * quotes bare object keys, and drops trailing commas. Only invoked when JSON.parse
 * fails, so mangling non-JSON prose is harmless (it simply still won't parse).
 */
function repairJson(input: string): string {
  let out = "";
  let i = 0;
  const n = input.length;
  const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c: string): boolean => /[\w$]/.test(c);
  const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  while (i < n) {
    const ch = input[i];
    if (isWs(ch)) {
      out += ch;
      i++;
      continue;
    }
    // Line comment // ... \n
    if (ch === "/" && input[i + 1] === "/") {
      i += 2;
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    // Block comment /* ... */
    if (ch === "/" && input[i + 1] === "*") {
      i += 2;
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // String literal (double or single quoted).
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += '"';
      i++;
      while (i < n) {
        const c = input[i];
        if (c === "\\") {
          // Inside single-quoted strings, unescape \' to ' (\' is invalid JSON).
          if (quote === "'" && input[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          out += c;
          if (i + 1 < n) {
            out += input[i + 1];
            i += 2;
          } else {
            i++;
          }
          continue;
        }
        if (c === quote) {
          out += '"';
          i++;
          break;
        }
        // Escape embedded double quotes when the source used single quotes.
        if (c === '"' && quote === "'") {
          out += '\\"';
          i++;
          continue;
        }
        out += c;
        i++;
      }
      continue;
    }
    // Bare identifier: could be a key (ident followed by optional ws then ':') or a literal.
    if (isIdentStart(ch)) {
      let j = i;
      let ident = "";
      while (j < n && isIdentPart(input[j])) {
        ident += input[j];
        j++;
      }
      let k = j;
      while (k < n && isWs(input[k])) k++;
      if (input[k] === ":") {
        out += '"' + ident + '"';
        i = j;
        continue;
      }
      out += ident;
      i = j;
      continue;
    }
    // Trailing comma before } or ]: drop it.
    if (ch === ",") {
      let k = i + 1;
      while (k < n && isWs(input[k])) k++;
      if (input[k] === "}" || input[k] === "]") {
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Try strict JSON.parse first, then a lenient repair pass. Returns undefined if both fail. */
function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to repair */
  }
  try {
    return JSON.parse(repairJson(text));
  } catch {
    return undefined;
  }
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

export function getTestValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(TestResultSchema, data);
}

export function getSecurityValidationErrors(data: unknown): Array<{ path: string; message: string; value: unknown }> {
  return formatValidationErrors(SecurityResultSchema, data);
}

function markdownBullets(text: string): string[] {
  const bullets: string[] = [];
  const bulletRegex = /^[-*•]\s+(.+)$/gim;
  let match: RegExpExecArray | null;
  while ((match = bulletRegex.exec(text)) !== null) {
    const line = match[1].trim();
    if (line) bullets.push(line);
  }
  return bullets;
}

function firstMarkdownParagraph(text: string): string {
  return (
    text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/^#+\s+/gm, "").trim())
      .find((p) => p.length > 0) ?? ""
  );
}

/** Extract the body of a markdown section headed by `## Heading` / `### Heading` (case-insensitive). */
function extractSection(text: string, headingPattern: string): string {
  const re = new RegExp(`^#{2,4}\\s+(?:${headingPattern})\\s*$`, "im");
  const match = re.exec(text);
  if (!match) return "";
  const start = match.index! + match[0].length;
  const nextHeading = text.slice(start).match(/\n#{2,4}\s+/);
  const end = nextHeading ? start + nextHeading.index! : text.length;
  return text.slice(start, end).trim();
}

interface ParsedMarkdownTable {
  headers: string[];
  rows: string[][];
}

/** Parse GitHub-flavoured markdown tables (`| col | col |` rows). Returns all tables concatenated. */
function parseMarkdownTables(text: string): ParsedMarkdownTable[] {
  const tables: ParsedMarkdownTable[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|/.test(lines[i]) && lines[i].includes("|", lines[i].indexOf("|") + 1)) {
      const tableLines: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        tableLines.push(lines[i]);
        i++;
      }
      if (tableLines.length >= 2) {
        const splitRow = (row: string): string[] =>
          row
            .replace(/^\s*\|/, "")
            .replace(/\|\s*$/, "")
            .split("|")
            .map((c) => c.trim());
        const headers = splitRow(tableLines[0]);
        // Skip the separator row (| --- | --- |).
        const dataStart = /^\s*\|?\s*[-:]+/.test(tableLines[1]) ? 2 : 1;
        const rows = tableLines.slice(dataStart).map(splitRow);
        if (headers.length > 1 && rows.length > 0) tables.push({ headers, rows });
      }
    } else {
      i++;
    }
  }
  return tables;
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Find the column index whose header best matches one of the candidates. */
function findColumn(headers: string[], candidates: string[]): number {
  const norm = headers.map(normalizeHeader);
  for (const candidate of candidates) {
    const c = normalizeHeader(candidate);
    const idx = norm.findIndex((h) => h === c || (h.length > 2 && h.includes(c)));
    if (idx >= 0) return idx;
  }
  return -1;
}

function severityFromString(value: string | undefined): "high" | "medium" | "low" {
  if (!value) return "low";
  const s = value.toLowerCase();
  if (/\bcritical\b|\bhigh\b|\berror\b|\bblock/.test(s)) return "high";
  if (/\bmedium\b|\bmoderate\b|\bwarn/.test(s)) return "medium";
  return "low";
}

function securitySeverityFromString(value: string | undefined): "critical" | "high" | "medium" | "low" {
  if (!value) return "low";
  const s = value.toLowerCase();
  if (/\bcritical\b/.test(s)) return "critical";
  if (/\bhigh\b|\berror\b/.test(s)) return "high";
  if (/\bmedium\b|\bmoderate\b|\bwarn/.test(s)) return "medium";
  return "low";
}

/** Parse a `file:line` or `file` location string into { file, line }. */
function parseFileLocation(value: string | undefined): { file?: string; line?: number } {
  if (!value) return {};
  const trimmed = value.trim().replace(/[`*]/g, "");
  const match = trimmed.match(/^(.+?)(?::(\d+))?(?::\d+)*$/);
  if (!match) return { file: trimmed };
  return { file: match[1], line: match[2] ? Number(match[2]) : undefined };
}

/**
 * Detect an explicit verdict line (`Verdict: pass`, `## Verdict: ✅ pass`,
 * `**Verdict:** needs-work`) before falling back to keyword heuristics.
 */
function detectVerdictExplicit(text: string): "pass" | "needs-work" | "blocked" | "needs-review" | null {
  const lower = text.toLowerCase();
  const verdictLine = lower.match(
    /\bverdict\b\s*[:-]?\s*[*_`]?\s*(pass|needs-work|needs review|needsreview|blocked|fail|fails|failing)/,
  );
  if (verdictLine) {
    const v = verdictLine[1];
    if (v === "pass") return "pass";
    if (v === "blocked" || v === "fail" || v === "fails" || v === "failing") return "blocked";
    if (v === "needs review" || v === "needsreview") return "needs-review";
    return "needs-work";
  }
  // Heading form: `## Verdict: ✅ pass` / `## Judgment: pass`.
  const heading = lower.match(
    /^#{1,4}\s+(?:verdict|judgment|review|result)\b[^\n]*?(pass|needs-work|needs review|needsreview|blocked)/m,
  );
  if (heading) {
    const v = heading[1];
    if (v === "pass") return "pass";
    if (v === "blocked") return "blocked";
    if (v === "needs review" || v === "needsreview") return "needs-review";
    return "needs-work";
  }
  return null;
}

/** Keyword heuristic for review/judge verdicts, guarded against false positives like "pass-through".
 *  Does NOT infer "blocked" from keywords in prose — that verdict must come from
 *  detectVerdictExplicit (an explicit `Verdict: blocked` line). Words like "broken", "blocked",
 *  or "cannot work" in descriptive prose are too easily false positives (e.g. "keeps developers
 *  from thinking their build config is broken" is a positive statement). The heuristic only
 *  infers "pass" or "needs-work".
 */
function heuristicReviewVerdict(lower: string): "pass" | "needs-work" {
  if (/\bneeds-work\b|\bneeds work\b/.test(lower)) return "needs-work";
  if (/(?:^|[^-\w])pass(?![\w-])|\bapproved\b|\blooks good\b|\blgtm\b/.test(lower)) return "pass";
  return "needs-work";
}

export function salvageReviewFromMarkdown(raw: string): ReviewResult | null {
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const explicit = detectVerdictExplicit(text);
  const verdict: ReviewResult["verdict"] =
    explicit === "pass" || explicit === "needs-work" || explicit === "blocked"
      ? explicit
      : heuristicReviewVerdict(lower);

  const issues: ReviewIssue[] = [];

  // Structured issues from markdown tables (| File | Severity | Issue | ... |).
  for (const table of parseMarkdownTables(text)) {
    const fileCol = findColumn(table.headers, ["file", "path", "location", "loc"]);
    const sevCol = findColumn(table.headers, ["severity", "risk", "priority"]);
    const issueCol = findColumn(table.headers, ["issue", "problem", "finding", "description", "concern", "what"]);
    const sugCol = findColumn(table.headers, ["suggestion", "fix", "recommendation", "action", "resolution"]);
    if (issueCol < 0) continue; // not an issues table
    for (const row of table.rows) {
      const issueText = row[issueCol]?.trim();
      if (!issueText) continue;
      const loc = fileCol >= 0 ? parseFileLocation(row[fileCol]) : {};
      issues.push({
        severity: severityFromString(sevCol >= 0 ? row[sevCol] : undefined),
        file: loc.file,
        line: loc.line,
        issue: issueText,
        suggestion: sugCol >= 0 ? (row[sugCol]?.trim() ?? "") : "",
      });
    }
  }

  // Bullets under an `### Issues` / `### Findings` section → structured issues.
  const issuesSection = extractSection(text, "issues|findings");
  if (issuesSection) {
    for (const bullet of markdownBullets(issuesSection)) {
      const locMatch = bullet.match(/^[`*]?(.+?)[`*]?(?:\s*[:\-—]\s*(.+))?$/);
      issues.push({
        severity: /high|critical/i.test(bullet) ? "high" : /medium|moderate/i.test(bullet) ? "medium" : "low",
        file: locMatch?.[1]?.trim(),
        issue: locMatch?.[2]?.trim() ?? bullet,
        suggestion: "",
      });
    }
  }

  // Suggestions: bullets under a `### Suggestions` section, else any loose bullets.
  let suggestions: string[];
  const suggestionsSection = extractSection(text, "suggestions");
  if (suggestionsSection) {
    suggestions = markdownBullets(suggestionsSection);
  } else if (issues.length === 0) {
    // No structured issues and no suggestions section: fall back to loose bullets, but filter
    // out lines that describe the diff rather than recommend an action.
    // First, strip file-listing sections so their bullets are never extracted.
    const strippedText = text.replace(
      /^#{1,4}\s+(?:files(?:\s+(?:affected|changed|modified))?|affected\s+files|changed\s+files|modified\s+files)\b[^\n]*(?:\n(?!#{1,4}\s).*)*/gim,
      "",
    );
    suggestions = markdownBullets(strippedText).filter((line) => {
      // Strip leading markdown bold/italic markers before checking.
      const l = line.toLowerCase().trim().replace(/[*_`]/g, "");
      if (l.startsWith("verdict")) return false;
      // Diff descriptions: "Old:", "New:", "Before:", "After:", "Was:", "Now:", etc.
      if (/^(old|new|before|after|was|now|current|previous|changed|change|from|to)\b[:\-—]/.test(l)) return false;
      // Bare URLs or code-only lines are descriptions, not suggestions.
      if (/^`?https?:\/\//.test(l)) return false;
      // Bare file names (optionally with a parenthetical note) are file listings, not suggestions.
      if (/^[\w/.-]+\.[a-z]{2,}(?:\s*\([^)]*\))?$/.test(l)) return false;
      return true;
    });
  } else {
    suggestions = [];
  }

  return {
    verdict,
    issues: issues.slice(0, 20),
    suggestions: suggestions.slice(0, 10),
    consensus: verdict === "pass" && issues.length === 0 && suggestions.length === 0,
  };
}

export function salvageJudgeFromMarkdown(raw: string): import("./types.js").JudgeResult | null {
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const explicit = detectVerdictExplicit(text);
  const verdict: import("./types.js").JudgeResult["verdict"] =
    explicit === "pass" || explicit === "needs-work" || explicit === "blocked"
      ? explicit
      : heuristicReviewVerdict(lower);

  // Reuse the review salvage for issues/suggestions structure.
  const reviewParts = salvageReviewFromMarkdown(raw);
  const issues = reviewParts?.issues ?? [];
  const suggestions = reviewParts?.suggestions ?? [];

  const summaryMatch = text.match(/(?:summary|assessment|overall)[\s:]*(.+?)(?=\n\n|$)/is);
  const summary = summaryMatch?.[1].trim() || firstMarkdownParagraph(text).slice(0, 1000) || text.slice(0, 300).trim();

  return {
    verdict,
    issues,
    suggestions: suggestions.slice(0, 10),
    consensus: verdict === "pass" && issues.length === 0 && suggestions.length === 0,
    summary,
  };
}

export function salvageSuggestFromMarkdown(raw: string): import("./types.js").SuggestResult | null {
  const text = raw.trim();
  if (!text) return null;

  const approaches: import("./types.js").Approach[] = [];
  const headingRegex = /^#{2,3}\s+(.+)$/gm;
  const headings: Array<{ title: string; index: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(text)) !== null) {
    headings.push({ title: match[1].trim(), index: match.index });
  }

  if (headings.length > 0) {
    for (let i = 0; i < headings.length; i++) {
      const start = headings[i].index + headings[i].title.length + 1;
      const end = i < headings.length - 1 ? headings[i + 1].index : text.length;
      const section = text.slice(start, end).trim();
      const paragraphs = section.split(/\n\s*\n/).map((p) => p.trim());
      const description = paragraphs[0] ?? "";

      const pros: string[] = [];
      const cons: string[] = [];
      const bulletRegex = /^[-*]\s+(.+)$/gm;
      let bullet: RegExpExecArray | null;
      while ((bullet = bulletRegex.exec(section)) !== null) {
        const line = bullet[1].trim();
        const lower = line.toLowerCase();
        if (lower.startsWith("con") || lower.startsWith("downside") || lower.startsWith("disadvantage")) {
          cons.push(line);
        } else {
          pros.push(line);
        }
      }

      approaches.push({
        title: headings[i].title,
        description,
        pros: pros.slice(0, 5),
        cons: cons.slice(0, 5),
      });
    }
  } else {
    const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim());
    const description = paragraphs[0] ?? text.slice(0, 300);
    const bullets: string[] = [];
    const bulletRegex = /^[-*]\s+(.+)$/gm;
    let bullet: RegExpExecArray | null;
    while ((bullet = bulletRegex.exec(text)) !== null) {
      bullets.push(bullet[1].trim());
    }
    approaches.push({
      title: "Suggested approach",
      description,
      pros: bullets.slice(0, 5),
      cons: [],
    });
  }

  if (approaches.length === 0) return null;
  return { approaches };
}

export function salvageRecommendFromMarkdown(raw: string): import("./types.js").RecommendResult | null {
  const text = raw.trim();
  if (!text) return null;

  const bullets = markdownBullets(text);
  const nextStepMatch = text.match(/(?:next\s*step|recommend(?:ation)?)[\s:]*\n?(.+?)(?=\n\n|$)/is);
  const reasoningMatch = text.match(/(?:reasoning|why)[\s:]*\n?(.+?)(?=\n\n|$)/is);
  const alternativesMatch = text.match(/(?:alternatives?|other options?)[\s:]*\n+([\s\S]*?)(?=\n#+\s|\n\n##|$)/i);
  const nextStep = nextStepMatch?.[1].replace(/^[-*•]\s+/, "").trim() || bullets[0] || firstMarkdownParagraph(text);
  const reasoning = reasoningMatch?.[1].trim() || firstMarkdownParagraph(text) || nextStep;
  const alternatives = alternativesMatch ? markdownBullets(alternativesMatch[1]) : bullets.slice(1, 3);

  if (!nextStep) return null;
  return {
    nextStep: nextStep.slice(0, 500),
    reasoning: reasoning.slice(0, 1000),
    alternatives: alternatives.slice(0, 3),
  };
}

export function salvageTestFromMarkdown(raw: string): import("./types.js").TestResult | null {
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const explicit = detectVerdictExplicit(text);
  let verdict: import("./types.js").TestResult["verdict"] = "needs-work";
  if (explicit === "blocked" || explicit === "needs-work" || explicit === "pass") {
    verdict = explicit;
  } else if (/\bblocked\b|\bfailing\b|\bfails\b|\bcannot merge\b/.test(lower)) {
    verdict = "blocked";
  } else if (
    /(?:^|[^-\w])pass\b|\badequate\b|\bcovered\b/.test(lower) &&
    !/\bneeds-work\b|\bmissing\b|\bfailing\b/.test(lower)
  ) {
    verdict = "pass";
  }

  const findings: import("./types.js").TestFinding[] = [];

  // Findings from markdown tables.
  for (const table of parseMarkdownTables(text)) {
    const fileCol = findColumn(table.headers, ["file", "path", "location"]);
    const sevCol = findColumn(table.headers, ["severity", "priority"]);
    const issueCol = findColumn(table.headers, ["finding", "issue", "problem", "description"]);
    const catCol = findColumn(table.headers, ["category", "type"]);
    const sugCol = findColumn(table.headers, ["suggestion", "fix", "action"]);
    if (issueCol < 0) continue;
    for (const row of table.rows) {
      const issueText = row[issueCol]?.trim();
      if (!issueText) continue;
      const loc = fileCol >= 0 ? parseFileLocation(row[fileCol]) : {};
      findings.push({
        severity: severityFromString(sevCol >= 0 ? row[sevCol] : undefined),
        file: loc.file,
        line: loc.line,
        issue: issueText,
        suggestion: sugCol >= 0 ? (row[sugCol]?.trim() ?? "") : "Address this test finding.",
        category: catCol >= 0 ? (row[catCol]?.trim() ?? undefined) : undefined,
      });
    }
  }

  const missingSection = text.match(/(?:missing\s*tests?)[\s:]*\n+([\s\S]*?)(?=\n#+\s|\n\n##|$)/i);
  const missingTests = (missingSection ? markdownBullets(missingSection[1]) : []).map((reason) => ({ reason }));

  // Bullets under a `### Findings` section (not already in a table).
  if (findings.length === 0) {
    const findingsSection = extractSection(text, "findings|issues");
    const bullets = markdownBullets(findingsSection || text).filter((b) => !missingTests.some((m) => m.reason === b));
    for (const issue of bullets.slice(0, 10)) {
      findings.push({
        severity: verdict === "blocked" ? "high" : "medium",
        issue,
        suggestion: "Address this test finding.",
        category: lower.includes("failing") || lower.includes("fails") ? "failing-test" : "test-quality",
      });
    }
  }

  return {
    verdict,
    findings: findings.slice(0, 20),
    missingTests: missingTests.slice(0, 10),
    summary: firstMarkdownParagraph(text).slice(0, 1000) || text.slice(0, 300),
  };
}

export function salvageSecurityFromMarkdown(raw: string): import("./types.js").SecurityResult | null {
  const text = raw.trim();
  if (!text) return null;

  const lower = text.toLowerCase();
  const explicit = detectVerdictExplicit(text);
  const hasSeriousFinding = /\bcritical\b|\bhigh\b|\bvulnerab|\binjection\b|\bsecret\b|\bauth\b/.test(lower);
  let verdict: import("./types.js").SecurityResult["verdict"];
  if (explicit === "pass") {
    verdict = hasSeriousFinding ? "needs-review" : "pass";
  } else if (explicit === "needs-review" || explicit === "needs-work") {
    verdict = "needs-review";
  } else {
    verdict =
      /(?:^|[^-\w])pass\b|\bno findings\b|\bno security issues\b/.test(lower) && !hasSeriousFinding
        ? "pass"
        : "needs-review";
  }

  const findings: import("./types.js").SecurityFinding[] = [];

  // Findings from markdown tables.
  for (const table of parseMarkdownTables(text)) {
    const fileCol = findColumn(table.headers, ["file", "path", "location"]);
    const sevCol = findColumn(table.headers, ["severity", "risk", "priority"]);
    const issueCol = findColumn(table.headers, ["finding", "issue", "problem", "description", "concern"]);
    const catCol = findColumn(table.headers, ["category", "type"]);
    const sugCol = findColumn(table.headers, ["suggestion", "fix", "remediation", "action"]);
    if (issueCol < 0) continue;
    for (const row of table.rows) {
      const issueText = row[issueCol]?.trim();
      if (!issueText) continue;
      const loc = fileCol >= 0 ? parseFileLocation(row[fileCol]) : {};
      const category = catCol >= 0 ? row[catCol]?.trim() || "other" : "other";
      findings.push({
        severity: securitySeverityFromString(sevCol >= 0 ? row[sevCol] : undefined),
        file: loc.file,
        line: loc.line,
        issue: issueText,
        suggestion:
          sugCol >= 0
            ? (row[sugCol]?.trim() ?? "Review and remediate this security finding.")
            : "Review and remediate this security finding.",
        category,
      });
    }
  }

  // Fall back to bullets when no tables were found.
  if (findings.length === 0) {
    for (const issue of markdownBullets(text).slice(0, 10)) {
      findings.push({
        severity: /critical/i.test(issue) ? "critical" : hasSeriousFinding ? "medium" : "low",
        issue,
        suggestion: "Review and remediate this security finding.",
        category: lower.includes("secret")
          ? "secrets"
          : lower.includes("injection")
            ? "injection"
            : lower.includes("auth")
              ? "auth"
              : "other",
      });
    }
  }

  return {
    verdict,
    findings: findings.slice(0, 20),
    summary: firstMarkdownParagraph(text).slice(0, 1000) || text.slice(0, 300),
  };
}

export function salvagePlanFromMarkdown(raw: string, fallbackTask: string): import("./types.js").PlanResult | null {
  const text = raw.trim();
  if (!text) return null;

  // Summary: first H1/H2 heading or first non-empty paragraph.
  const headingMatch = text.match(/^#+\s+(.+)$/m);
  const firstPara = text.split(/\n\s*\n/)[0]?.trim() ?? "";
  const summary = headingMatch?.[1].trim() || firstPara.slice(0, 200);

  // Todo: numbered lists (1. ...) or bullets (- / *).
  const todos: Array<string | { description: string }> = [];
  const numberedRegex = /^\d+\.\s+(.+)$/gm;
  const bulletRegex = /^[-*]\s+(?:\[.\]\s+)?(.+)$/gm;

  let match: RegExpExecArray | null;
  while ((match = numberedRegex.exec(text)) !== null) {
    const line = match[1].trim();
    if (line && !line.toLowerCase().startsWith("option ")) {
      todos.push(line);
    }
  }
  if (todos.length === 0) {
    while ((match = bulletRegex.exec(text)) !== null) {
      const line = match[1].trim();
      if (line && line.length > 5 && !line.toLowerCase().startsWith("option ")) {
        todos.push(line);
      }
    }
  }

  // Acceptance criteria: section after "Acceptance" heading.
  const criteria: string[] = [];
  const acSectionMatch = text.match(/(?:acceptance\s*(?:criteria)?)[\s:]*\n+([\s\S]*?)(?=\n#+\s|\n\n##|$)/i);
  if (acSectionMatch) {
    const acText = acSectionMatch[1];
    const acBulletRegex = /^[-*]\s+(.+)$/gm;
    while ((match = acBulletRegex.exec(acText)) !== null) {
      const line = match[1].trim();
      if (line) criteria.push(line);
    }
  }

  if (todos.length === 0 && summary.length < 10) {
    return null;
  }

  if (todos.length === 0) {
    todos.push(fallbackTask);
  }

  return {
    summary,
    todo: todos.slice(0, 10),
    acceptanceCriteria: criteria.slice(0, 5),
  };
}
