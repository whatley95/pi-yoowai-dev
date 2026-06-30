import type { PlanResult, ReviewResult, SuggestResult, RecommendResult, JudgeResult, Conventions } from "./types.js";

export function buildPlanPrompt(task: string, conventions?: string): { system: string; user: string } {
  const conventionsBlock = conventions
    ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>`
    : "";

  return {
    system: `You are a senior software architect and planning expert.

Your job is to break down a coding task into an actionable, ordered todo list with clear acceptance criteria for each step.

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

export function buildReviewPrompt(
  description: string,
  diff: string,
  truncated: boolean,
  vcs?: string,
  acceptanceCriteria?: string[],
  sessionContext?: string,
  conventions?: string,
  preReviewOutput?: string,
  memoryContext?: string,
): { system: string; user: string } {
  const criteriaBlock = acceptanceCriteria?.length
    ? `\n\nAcceptance criteria for this step:\n${acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
    : "";

  const sessionBlock = sessionContext
    ? `\n\n<session_context>\nRecent conversation relevant to this change:\n${sessionContext}\n</session_context>`
    : "";

  const conventionsBlock = conventions
    ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>`
    : "";

  const preReviewBlock = preReviewOutput
    ? `\n\n<pre_review_output>\n${preReviewOutput}\n</pre_review_output>`
    : "";

  const memoryBlock = memoryContext
    ? `\n\n<memory>\n${memoryContext}\n</memory>`
    : "";

  const truncationNotice = truncated
    ? "\n\n⚠️ NOTE: The diff was truncated because it was too large. Review only what's visible."
    : "";

  const vcsLine = vcs ? `\n\nVersion control: ${vcs}` : "";

  return {
    system: `You are a rigorous code reviewer. Your job is to catch bugs, mistakes, and quality issues that the developer missed.

${REVIEW_RUBRIC}

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
- Do NOT flag issues you cannot see evidence for in the diff
- Be strict but fair — flag real problems, not preferences`,

    user: `Review this code change. The developer says:\n\n${description}${vcsLine}\n\n<diff>\n${diff}\n</diff>${criteriaBlock}${sessionBlock}${conventionsBlock}${preReviewBlock}${memoryBlock}${truncationNotice}`,
  };
}

export function buildScanPrompt(): { system: string; user: string } {
  return {
    system: `You are analyzing a codebase to extract project conventions and architecture patterns.

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
  const conventionsBlock = conventions
    ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>`
    : "";

  return {
    system: `You are a senior developer giving practical advice.

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

export function buildRecommendPrompt(situation: string, planTodo?: string[], conventions?: string): { system: string; user: string } {
  const planContext = planTodo?.length
    ? `\n\nCurrent plan (check items already done):\n${planTodo.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    : "";

  const conventionsBlock = conventions
    ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>`
    : "";

  return {
    system: `You are an experienced pair programmer advising on what to do next.

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

  return {
    system: `You are a senior engineer performing a final holistic review of completed work.

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

    user: `Judge this completed work:\n\n${description}${planBlock}${criteriaBlock}${historyBlock}`,
  };
}

export function parseJsonResponse<T>(text: string): T | null {
  let cleaned = text.trim();

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch { /* continue */ }

  const objMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]) as T;
    } catch { /* continue */ }
  }

  return null;
}

export function validatePlanResult(data: unknown): PlanResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (!Array.isArray(r.todo) || !Array.isArray(r.acceptanceCriteria) || typeof r.summary !== "string") return null;
  return {
    todo: r.todo.map(String),
    acceptanceCriteria: r.acceptanceCriteria.map(String),
    summary: String(r.summary),
  };
}

export function validateReviewResult(data: unknown): ReviewResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  const verdict = r.verdict;
  if (verdict !== "pass" && verdict !== "needs-work" && verdict !== "blocked") return null;
  const issues = Array.isArray(r.issues)
    ? r.issues.filter((i: unknown) => i && typeof i === "object" && typeof (i as Record<string, unknown>).issue === "string")
               .map((i: Record<string, unknown>) => ({
                 severity: ["high", "medium", "low"].includes(String(i.severity)) ? String(i.severity) as "high" | "medium" | "low" : "medium",
                 file: typeof i.file === "string" ? i.file : undefined,
                 line: typeof i.line === "number" ? i.line : undefined,
                 issue: String(i.issue),
                 suggestion: typeof i.suggestion === "string" ? i.suggestion : "",
               }))
    : [];
  return {
    verdict,
    issues,
    suggestions: Array.isArray(r.suggestions) ? r.suggestions.map(String) : [],
    consensus: verdict === "pass" && issues.length === 0 && r.consensus === true,
  };
}

export function validateSuggestResult(data: unknown): SuggestResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (!Array.isArray(r.approaches)) return null;
  return {
    approaches: r.approaches
      .filter((a: unknown) => a && typeof a === "object" && typeof (a as Record<string, unknown>).title === "string")
      .map((a: Record<string, unknown>) => ({
        title: String(a.title),
        description: typeof a.description === "string" ? a.description : "",
        pros: Array.isArray(a.pros) ? a.pros.map(String) : [],
        cons: Array.isArray(a.cons) ? a.cons.map(String) : [],
      })),
  };
}

export function validateRecommendResult(data: unknown): RecommendResult | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (typeof r.nextStep !== "string" || typeof r.reasoning !== "string") return null;
  return {
    nextStep: r.nextStep,
    reasoning: r.reasoning,
    alternatives: Array.isArray(r.alternatives) ? r.alternatives.map(String) : [],
  };
}

export function validateJudgeResult(data: unknown): JudgeResult | null {
  const base = validateReviewResult(data);
  if (!base) return null;
  const r = data as Record<string, unknown>;
  return {
    ...base,
    summary: typeof r.summary === "string" ? r.summary : "",
  };
}

export function validateConventionsResult(data: unknown): Conventions | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  if (typeof r.naming !== "string" || typeof r.structure !== "string" || typeof r.stack !== "string") return null;
  return {
    naming: r.naming,
    structure: r.structure,
    patterns: Array.isArray(r.patterns) ? r.patterns.map(String) : [],
    stack: r.stack,
    testing: typeof r.testing === "string" ? r.testing : undefined,
    orm: typeof r.orm === "string" ? r.orm : undefined,
    ui: typeof r.ui === "string" ? r.ui : undefined,
    styling: typeof r.styling === "string" ? r.styling : undefined,
    buildTool: typeof r.buildTool === "string" ? r.buildTool : undefined,
    ci: typeof r.ci === "string" ? r.ci : undefined,
    packageManager: typeof r.packageManager === "string" ? r.packageManager : undefined,
    entryPoints: Array.isArray(r.entryPoints) ? r.entryPoints.map(String) : [],
    scripts: Array.isArray(r.scripts) ? r.scripts.map(String) : [],
    styleSample: typeof r.styleSample === "string" ? r.styleSample : undefined,
    agENTSmd: typeof r.agENTSmd === "string" ? r.agENTSmd : undefined,
    generatedAt: new Date().toISOString(),
  };
}
