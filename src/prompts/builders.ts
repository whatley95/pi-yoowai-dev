import type { JudgeResult, PlanResult, PlanTodoItem, ReviewAssignment } from "../types.js";
import { planStepDescription } from "../types.js";

const PAIR_PROGRAMMER_PERSONA = `You are a senior pair programmer sitting next to the developer. You are collaborative, direct, and focused on shipping correct, maintainable code. You explain your reasoning briefly but stay actionable.`;

/** Common prefix shared across all wai system prompts to improve provider cache hit rates.
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

/** Render the developer-provided instruction block for an action prompt.
 *  Placed right after the common prefix so the fixed role/contract text stays
 *  last in the system prompt. Returns "" when there is nothing to inject. */
function formatInstructionsBlock(instructionsText: string): string {
  if (!instructionsText) return "";
  return `\n\n<user_instructions>\n${instructionsText}\n</user_instructions>\n\nThese are developer-provided instructions for this action. Follow them unless they conflict with the rules and output contract below — the contract wins.`;
}

export interface PlanUpdateContext {
  plan: PlanResult;
  completedSteps: number;
}

function buildPlanPromptImpl(
  task: string,
  conventions?: string,
  snapshot?: string,
  instructionsText = "",
  updateContext?: PlanUpdateContext,
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const snapshotBlock = snapshot ? `\n\n<project_snapshot>\n${snapshot}\n</project_snapshot>` : "";
  const existingPlanBlock = updateContext
    ? `\n\n<existing_plan>\n${JSON.stringify(updateContext, null, 2)}\n</existing_plan>`
    : "";
  const updateRules = updateContext
    ? `\n- Update the existing plan using the requested change; retain the original task goals and acceptance criteria unless the developer explicitly supersedes them.
- Preserve the already-completed leading steps verbatim and in order, including their dependencies, unless the requested change invalidates them. Revise the remaining steps to reflect the evidence and requested change.
- Never place new or unfinished work inside the completed prefix to reuse its progress. Changed outcomes or newly incomplete prerequisites require verification again.
- Preserve every existing step's id when retaining that step. Omit id for new work; Wai assigns new identities. Do not reuse an existing id for a different outcome.
- Make the smallest requested edit. Do not reword unchanged outcome descriptions, remove unrelated steps, or regenerate completed work. Use the optional title for a cosmetic label change; description remains the required outcome/completion check.
- Keep dependency numbers pointing to the same prerequisites after any insertion/removal/reorder. Only earlier steps may be dependencies.
- Return the complete updated plan as JSON; partial plans and truncated output are not applied.`
    : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText)}

You are ${updateContext ? "updating an existing" : "creating a"} structured plan for the developer. Break the task into an actionable, ordered todo list with clear completion checks for each step.

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
- An optional title is a short display label. The description defines the required outcome and completion check; renaming the title does not change that requirement.
- priority must be one of: high, medium, low. Omit when unclear.
- dependsOn is a 1-based list of earlier step numbers this step cannot start until after
- acceptance criteria must be testable (specific checks, not vague goals)
- Size the plan to the task: use only as many steps and acceptance criteria as needed, without filler or a fixed count.
- Write steps as observable outcomes with a concrete completion check in the description. Keep each step small enough to implement and verify as one coherent batch.
- Separate confirmed requirements from implementation assumptions. Do not hard-code an endpoint, method, file, or design choice that the developer or provided code has not established; make inspection/confirmation part of the relevant step when needed.
- Express preservation requirements as acceptance criteria across the relevant implementation steps, rather than a standalone step that appears to require unrelated code changes.
- Equivalent implementations that satisfy the requested outcome are acceptable; do not turn an unverified implementation suggestion into a mandatory requirement.
- Account for work already present in the snapshot; plan the remaining change instead of assuming every feature must be built from scratch.
- Stay scoped to the requested task; do not add unrelated refactoring, cleanup, or extra features
- Respect the project conventions shown above when choosing file names, structure, and patterns
- Use the project snapshot to ground the plan in the actual codebase. Prefer existing file paths/patterns from the snapshot. If a step requires a new file, explain why.${updateRules}
${EVIDENCE_RULES}`,

    user: `${updateContext ? "Update the existing plan for this requested change" : "Create a plan for this task"}:\n\n${task}${existingPlanBlock}${conventionsBlock}${snapshotBlock}`,
  };
}

const REVIEW_RUBRIC = `Review rubric — check ALL of the following categories:

1. ERROR HANDLING: Missing try/catch, null/undefined checks, boundary conditions, empty input handling
2. IMPORTS & REFERENCES: Broken imports, undefined variables, wrong exports, missing module references
3. CONVENTIONS: Violates project naming patterns, file structure, or coding style
4. LOGIC: Type mismatches, race conditions, off-by-one errors, incorrect assumptions
5. COMPLETENESS: Does the code implement the described change and the acceptance criteria relevant to this review? Explicit developer requirements remain authoritative. An unfinished step or missing review context does not make the plan stale; assess only what the supplied evidence establishes.

For each issue found, provide a concrete, actionable fix suggestion. Do NOT suggest fixes that you cannot derive from the code shown.`;

const EVIDENCE_RULES = `EVIDENCE REQUIREMENTS:
- Every issue, finding, or judgment must cite specific supporting evidence: a file path, line number, diff hunk, convention, or external doc.
- If you cannot point to supporting context, downgrade the severity or omit the claim.
- Do not invent files, failures, lines, or evidence not shown in the provided context.
- Respect project conventions; do NOT flag a pattern as wrong if it matches the conventions shown.`;

const PLAN_STALE_RULE =
  "Treat a plan as stale only when positive evidence shows that an implementation assumption or tracker position has been superseded by an established developer decision or the actual project structure. Cite the conflicting plan text, observed file/code, and reason in suggestions before proposing an update. " +
  "Unfinished work, an unchanged preservation check, another step's changes, a partial/per-file/incremental diff, or missing context are not evidence of staleness. Equivalent implementations that satisfy the requested outcome do not require a plan rewrite. " +
  "Do not silently replace an explicit developer requirement with internally consistent code that violates it; report the evidenced code defect instead. When uncertain, do not declare staleness; explain the uncertainty without blocking otherwise sound code.";

/** Scope-guard rules shared by the diff-based prompts (review/test/security).
 *  The structure and the plan-stale rule live in exactly one place so fixes
 *  propagate to every prompt; the per-action wording stays explicit. */
function diffScopeRules(args: { diffScope: string; noDiffScope: string; stepScope: string }): string {
  return [args.diffScope, args.noDiffScope, args.stepScope, PLAN_STALE_RULE].map((rule) => `- ${rule}`).join("\n");
}

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

export function formatReviewAssignment(assignment?: ReviewAssignment): string {
  if (!assignment) return "";
  if (assignment.integration)
    return "\n\n<review_assignment>\nIntegration check after all assigned patch segments were reviewed. Compare their findings and the supplied source context for interactions across segments/files. Segment summaries are model assessments, not substitute source evidence. Request precise source ranges for unresolved interactions and report coverageGaps when necessary evidence cannot be obtained. Do not re-review unrelated changes. Assess overall plan completion separately from code quality.\n</review_assignment>";
  const scope = assignment.hunk
    ? `Assigned patch segment ${assignment.hunk.index} of ${assignment.hunk.count} in ${JSON.stringify(assignment.files)}. Segments retain absolute old/new line coordinates and may overlap for context.`
    : `Assigned files: ${JSON.stringify(assignment.files)}.`;
  const coverage =
    assignment.batchCount > 1
      ? "This call reviews only its assigned changes; other batches review the remaining files or hunks, and Wai combines their results. Their absence from this prompt is expected and is not a coverage gap in this batch."
      : "This is the only batch; assess all assigned changes.";
  return `\n\n<review_assignment>\nBatch ${assignment.batchIndex} of ${assignment.batchCount}. ${scope}\nThe developer's description describes the overall task. ${coverage} Use the supplied diff as the authoritative captured change; do not re-fetch the entire working-tree diff merely to cover other batches. Inspect related code only for concrete impact of the assigned changes. Assess code quality separately from completion of the overall plan step.\n</review_assignment>`;
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
  decisionsText?: string;
  priorRoundContext?: string;
  relatedContext?: string;
  codemap?: string;
  evidencePack?: string;
  designRefText?: string;
  truncated?: boolean;
  droppedFiles?: string[];
  omittedFileContents?: string[];
  budgetNote?: string;
  focusFiles?: string[];
  assignmentText?: string;
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
    decisionsText,
    priorRoundContext,
    relatedContext,
    codemap,
    evidencePack,
    designRefText,
    truncated,
    droppedFiles,
    omittedFileContents,
    budgetNote,
    focusFiles,
    assignmentText,
  } = args;

  const criteriaBlock = criteria ? `\n\n<acceptance_criteria>\n${criteria}\n</acceptance_criteria>` : "";
  const currentStepBlock = currentStep
    ? `\n\nCurrent plan step being reviewed:\n${currentStep}\nThis is tracker context; the supplied diff may cover only part of the step. Missing work is not evidence that the plan is stale.`
    : "";
  const sessionBlock = sessionContext ? `\n\n<session_context>\n${sessionContext}\n</session_context>` : "";
  const conventionsBlock = conventionsText
    ? `\n\n<project_conventions>\n${conventionsText}\n</project_conventions>`
    : "";
  const preReviewBlock = preReviewOutput ? `\n\n<pre_review_output>\n${preReviewOutput}\n</pre_review_output>` : "";
  const memoryBlock = memoryContext ? `\n\n<memory>\n${memoryContext}\n</memory>` : "";
  const decisionsBlock = decisionsText ? `\n\n<decisions>\n${decisionsText}\n</decisions>` : "";
  const priorRoundBlock = priorRoundContext
    ? `\n\n<prior_review_context>\n${priorRoundContext}\n</prior_review_context>`
    : "";
  const relatedBlock = relatedContext ? `\n\n<related_files>\n${relatedContext}\n</related_files>` : "";
  const codemapBlock = codemap ? `\n\n<project_symbol_map>\n${codemap}\n</project_symbol_map>` : "";
  const evidencePackBlock = evidencePack ? `\n\n${evidencePack}` : "";
  const designRefBlock = designRefText ? `\n\n<design_rules>\n${designRefText}\n</design_rules>` : "";

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
  const omittedContentsBlock = omittedFileContents?.length
    ? `\n\nSupplemental full file contents were not included for: ${omittedFileContents.join(", ")}. Their captured patches are still in scope. Use the supplied patch and available context; request precise additional ranges only when necessary. If required evidence remains unavailable, report contextLimited and coverageGaps.`
    : "";

  const truncationNotice = truncated
    ? "\n\n⚠️ NOTE: The diff was truncated because it was too large. Review only what's visible."
    : "";

  const budgetBlock = budgetNote ? `\n\n${budgetNote}` : "";
  const vcsLine = vcs ? `\n\nVersion control: ${vcs}` : "";
  const focusBlock =
    focusFiles && focusFiles.length > 0
      ? `\n\n<focus_files>\nFiles edited as part of the current plan step (primary review target, but the full diff still matters for cross-file impact): ${focusFiles.join(", ")}\n</focus_files>`
      : "";

  return `${assignmentText ? `${assignmentText}\n\n` : ""}Review this code change. The developer says:\n\n${description}${vcsLine}${currentStepBlock}\n\n<diff>\n${diff}\n</diff>${fileContentsBlock}${criteriaBlock}${sessionBlock}${conventionsBlock}${preReviewBlock}${memoryBlock}${decisionsBlock}${priorRoundBlock}${relatedBlock}${codemapBlock}${evidencePackBlock}${designRefBlock}${truncationNotice}${droppedBlock}${omittedContentsBlock}${budgetBlock}${focusBlock}`;
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
    decisionsText?: string;
    priorRoundContext?: string;
    relatedContext?: string;
    codemap?: string;
    evidencePack?: string;
    designRefText?: string;
    truncated?: boolean;
    droppedFiles?: string[];
    omittedFileContents?: string[];
    budgetNote?: string;
    nativeJson?: boolean;
    focusFiles?: string[];
    levelInstructions?: string;
    instructionsText?: string;
    assignment?: ReviewAssignment;
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
    decisionsText,
    priorRoundContext,
    relatedContext,
    codemap,
    evidencePack,
    designRefText,
    truncated,
    droppedFiles,
    omittedFileContents,
    budgetNote,
    nativeJson,
    focusFiles,
    levelInstructions,
    instructionsText,
    assignment,
  } = options;

  // Plan-related rules only make sense when a plan step is actually shown;
  // without one they dangle and can push the model toward a conservative
  // non-pass verdict it cannot justify with issues.
  const planRules = currentStep
    ? `- Set "planStale": true only for an evidenced, superseded plan assumption or tracker position under the plan-staleness rule below; otherwise set it to false.
- Only the current plan step is supplied. Set "completedSteps" to 1 when that step is fully complete and covered; otherwise use 0. Do not infer completion of unseen later steps.
- A correct partial change can pass code review while the plan step remains unfinished. Keep "stepComplete": false and "completedSteps": 0 in that case; do not manufacture a non-pass verdict or mark the plan stale merely to keep the step open.
- Set "stepComplete" to true ONLY when the current plan step's work is genuinely finished AND this review fully covered it (all of its edited files were in scope and no remaining work belongs to the step); otherwise set it to false. Do not use it to advance steps whose work is only partially done.`
    : `- There is no active plan for this review. Set "planStale" to false, "stepComplete" to false, and "completedSteps" to 0; judge the change on its own merits against the developer's description.`;

  return {
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText ?? "")}

You are reviewing the latest code change as the developer's pair. Catch bugs, mistakes, and quality issues they missed.

Evidence discipline: distinguish observed findings from suspicions. Claims about gate results (typecheck, lint, tests) must be labeled "(assumed — not run)" unless that command actually ran during this review; only executed command output counts as observed evidence — any failure you have not executed is a suspicion, not a fact.

${levelInstructions ? `${levelInstructions}\n\n` : ""}${REVIEW_RUBRIC}

You are provided with a diff and, when available, the full contents of changed files. Use the full file contents to verify context outside the diff; do not flag something as missing if you can see it in the full file.

${assignment ? "The review_assignment defines this call's scope. Other assigned batches are reviewed separately; judge this batch without demanding their diffs. A complete assigned diff plus relevant context can be sufficient even when unchanged file contents are outlined or large. Lockfiles and generated metadata do not require every unchanged record to be read; still verify changed dependencies, constraints and related source contracts. Request precise missing ranges when necessary, including relevant dependency metadata for lockfile changes.\n" : ""}

${finalJsonBlock(
  `{
  "verdict": "needs-work",
  "issues": [
    { "severity": "medium", "file": "path/to/file.ts", "line": 42, "issue": "what's wrong", "suggestion": "how to fix it" }
  ],
  "suggestions": ["improvement 1", "improvement 2"],
  "consensus": false,
  "contextLimited": false,
  "coverageGaps": [],
  "planStale": false,
  "stepComplete": false,
  "completedSteps": 0
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
- If evidence necessary to assess the assigned change is unavailable, set "contextLimited": true, list the concrete missing files or ranges in "coverageGaps", and use "needs-work" with consensus false. Missing evidence is not a code defect; do not invent actionable issues. Other batches and unrelated unchanged code are not coverage gaps.
${planRules}
- Each issue must include a specific, actionable suggestion
- "file" and "line" are optional but strongly preferred when you can identify the exact location
- Respect the project conventions shown above; do NOT flag a pattern as wrong if it matches the conventions
${designRefText ? "- Apply the design rules shown above when reviewing UI code; do not flag a pattern that follows them.\n" : ""}- Pay attention to pre-review command output (lint/test/typecheck). Failures there are real issues ONLY for files changed in this diff; ignore pre-existing warnings in unrelated files.
- Memory shows past issues in the same files. If a past issue appears again, flag it as regression.
${priorRoundContext ? "- Prior-round context lists files reviewed earlier in this step that are NOT part of the current diff. Their logic was implemented and reviewed in earlier rounds — do NOT flag it as missing unless you see concrete evidence it is broken.\n" : ""}- CRITICAL: Only flag issues you can see evidence for. If a property, method, template, or style exists in the provided full file contents, do NOT flag it as missing. When unsure, prefer "pass" or "low" severity over guessing.
${diffScopeRules({
  diffScope:
    "When reviewing a code change (a diff is provided), only flag issues in files that are part of that change. Do NOT flag pre-existing problems in unrelated files.",
  noDiffScope:
    "When no diff is provided and the developer asks you to review a specific function/file, review exactly that requested scope.",
  stepScope:
    "If a current plan step is shown above, only evaluate acceptance criteria that are relevant to that step. Do NOT flag work from other plan steps as missing.",
})}
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
      decisionsText,
      priorRoundContext,
      relatedContext,
      codemap,
      evidencePack,
      designRefText,
      truncated,
      droppedFiles,
      omittedFileContents,
      budgetNote,
      focusFiles,
      assignmentText: formatReviewAssignment(assignment),
    }),
  };
}

function buildScanPromptImpl(nativeJson = false, instructionsText = ""): { system: string; user: string } {
  return {
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText)}

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

/** Plain-text pair-programming advisor prompt: direct, opinionated advice.
 *  No JSON contract — the answer is conversational, like asking a senior dev.
 *  instructionsText is injected the same way as in the other prompts. */
function buildAdvisorPromptImpl(
  question: string,
  conventions?: string,
  relevantFiles?: FileContentContext[],
  instructionsText = "",
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const filesBlock =
    relevantFiles && relevantFiles.length > 0
      ? `\n\n<relevant_files>\n${relevantFiles.map((f) => `--- ${f.file} (${f.mode}) ---\n${f.content}`).join("\n\n")}\n</relevant_files>`
      : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText)}

You are the developer's pair-programming advisor. Answer the question directly and conversationally, like a senior engineer sitting next to them. Be opinionated: state a clear recommendation up front, then the reasoning. Push back when the developer's plan is a bad idea. Keep it short — a few sentences to a short paragraph unless the question genuinely needs more.

Rules:
- Start with a direct recommendation or answer, not a preamble
- Be specific and concrete; reference the conventions and relevant files when they are provided
- If you disagree with the developer's approach, say so plainly and explain why
- If the question needs more context to answer well, say what is missing
- If the relevant files do not cover the question, say so and answer from conventions and general knowledge
- Do not include a structured list of options with pros/cons unless the question asks for one
- Do not include commentary outside the advice`,

    user: `Advise the developer:\n\n${question}${conventionsBlock}${filesBlock}`,
  };
}

function buildSuggestPromptImpl(
  question: string,
  conventions?: string,
  nativeJson = false,
  docContext = "",
  fileContents: FileContentContext[] = [],
  instructionsText = "",
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const docsBlock = docContext ? `\n\n${docContext}` : "";
  const filesBlock =
    fileContents.length > 0
      ? `\n\n<relevant_files>\n${fileContents.map((f) => `--- ${f.file} (${f.mode}) ---\n${f.content}`).join("\n\n")}\n</relevant_files>`
      : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText)}

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
  instructionsText = "",
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
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText)}

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
  instructionsText = "",
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
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText)}

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
${diffScopeRules({
  diffScope:
    "When reviewing a code change (a diff is provided), only flag test issues in files that are part of that change. Do NOT flag pre-existing test failures or missing tests in unrelated files.",
  noDiffScope:
    "When no diff is provided and the developer asks about a specific function/file, evaluate exactly that requested scope.",
  stepScope:
    "If a current plan step is shown above, only evaluate test coverage relevant to that step. Do NOT flag missing tests for work from other plan steps.",
})}
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
  instructionsText = "",
): { system: string; user: string } {
  const conventionsBlock = conventions ? `\n\n<project_conventions>\n${conventions}\n</project_conventions>` : "";
  const fileContentsBlock =
    fileContents.length > 0
      ? `\n\n<file_contents>\n${fileContents.map((f) => `--- ${f.file} (${f.mode}) ---\n${f.content}`).join("\n\n")}\n</file_contents>`
      : "";
  const currentStepBlock = currentStep ? `\n\nCurrent plan step being audited:\n${currentStep}` : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText)}

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
${diffScopeRules({
  diffScope:
    "When auditing a code change (a diff is provided), only flag security findings in files that are part of that change. Do NOT flag pre-existing vulnerabilities in unrelated files.",
  noDiffScope:
    "When no diff is provided and the developer asks about a specific function/file, audit exactly that requested scope.",
  stepScope:
    "If a current plan step is shown above, only evaluate security risks relevant to that step. Do NOT flag missing security work from other plan steps.",
})}
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
    codemap?: string;
    evidencePack?: string;
    designRefText?: string;
    diff?: string;
    fileContents?: FileContentContext[];
    truncated?: boolean;
    droppedFiles?: string[];
    budgetNote?: string;
    nativeJson?: boolean;
    instructionsText?: string;
  } = {},
): { system: string; user: string } {
  const {
    planTodo,
    acceptanceCriteria,
    reviewHistory,
    conventions,
    preReviewOutput,
    memoryContext,
    codemap,
    evidencePack,
    designRefText,
    diff,
    fileContents,
    truncated,
    droppedFiles,
    budgetNote,
    nativeJson,
    instructionsText,
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
  const codemapBlock = codemap ? `\n\n<project_symbol_map>\n${codemap}\n</project_symbol_map>` : "";
  const evidencePackBlock = evidencePack ? `\n\n${evidencePack}` : "";
  const designRefBlock = designRefText ? `\n\n<design_rules>\n${designRefText}\n</design_rules>` : "";

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
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText ?? "")}

You are performing a final holistic review of completed work before the developer ships it. You are given the actual diff and changed file contents, so judge the code directly rather than trusting the review history alone.

${REVIEW_RUBRIC}

Additionally, check:
6. PLAN COMPLETENESS: Does the completed work satisfy the original task outcomes and relevant acceptance criteria? Distinguish a superseded implementation assumption from an unmet developer requirement and from unfinished work.
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
  "planStale": false,
  "completedStepIds": [1, 2],
  "planUpdateSuggested": false,
  "planUpdateReason": ""
}`,
  nativeJson,
)}

Rules:
- "verdict" must be one of: "pass", "needs-work", "blocked"
- issue "severity" must be one of: "high", "medium", "low"
- "consensus" is true only when verdict is "pass" AND issues is empty
- ${PLAN_STALE_RULE}
- "completedStepIds" (optional): a list of 1-based plan step IDs that the current diff fully satisfies. Only include steps you are confident about. They must be contiguous from step 1 (e.g., [1,2,3] is valid; [1,3] is not). Do not include steps beyond the current diff or future work.
- "incompleteStepIds" (optional): 1-based plan step IDs that the tracker marks complete but the shown code does NOT actually satisfy. Only list steps you are confident are not done, with cited evidence. Because steps are sequential, the tracker is rolled back to just before the earliest incomplete step. Omit when the tracker looks correct.
- "planUpdateSuggested" (optional): set to true only for an evidenced stale plan under the rule above. Explain the conflicting plan text, observed code, and reason in "planUpdateReason".
- Provide a real summary that captures the overall quality, not filler
- Judge only against the original plan and acceptance criteria; do not introduce new requirements that were not part of the plan
- Judge the completed code on its own merits. If the current changes satisfy multiple plan steps at once, that is fine.
- Unstarted or in-progress plan steps do not block a pass verdict. Only block if a completed step is unreviewed AND the code itself has issues.
- You may note tracker gaps (unreviewed or unmarked steps) as a non-blocking observation, not as a blocking issue.
- When the diff/file contents are truncated, do not treat missing context as a defect; judge only what is shown
${designRefText ? "- Apply the design rules shown above when reviewing UI code; do not flag a pattern that follows them.\n" : ""}${EVIDENCE_RULES}`,

    user: `Judge this completed work:\n\n${description}${planBlock}${criteriaBlock}${historyBlock}${diffBlock}${fileContentsBlock}${conventionsBlock}${preReviewBlock}${memoryBlock}${evidencePackBlock}${codemapBlock}${designRefBlock}${truncationNotice}${droppedBlock}${budgetBlock}`,
  };
}

export interface JudgeCouncilMemberVerdict {
  /** "provider:id" label of the council member. */
  model: string;
  result: JudgeResult;
}

function buildJudgeCouncilSynthesisPromptImpl(
  description: string,
  members: JudgeCouncilMemberVerdict[],
  nativeJson = false,
): { system: string; user: string } {
  const memberBlocks = members
    .map(
      (m, i) =>
        `=== Judge ${i + 1}: ${m.model} (verdict: ${m.result.verdict}) ===\n${JSON.stringify(m.result, null, 2)}`,
    )
    .join("\n\n");

  return {
    system: `${COMMON_SYSTEM_PREFIX}

You are the synthesizer for a council of judge models that independently reviewed the same completed work. Merge their judgments into one final, decisive judgment.

${finalJsonBlock(
  `{
  "verdict": "needs-work",
  "issues": [
    { "severity": "medium", "file": "path/to/file.ts", "line": 42, "issue": "what's wrong", "suggestion": "how to fix it" }
  ],
  "suggestions": ["improvement 1"],
  "consensus": false,
  "summary": "one-paragraph holistic assessment of the completed work",
  "planStale": false,
  "completedStepIds": [1, 2],
  "planUpdateSuggested": false,
  "planUpdateReason": ""
}`,
  nativeJson,
)}

Rules:
- "verdict" must be one of: "pass", "needs-work", "blocked"
- issue "severity" must be one of: "high", "medium", "low"
- On disagreement, failure wins: if any member voted "blocked", the final verdict is "blocked"; otherwise if any member voted "needs-work", the final verdict is "needs-work". You may override a dissenting verdict only when the dissenter is clearly wrong given the other members' evidence — say so in the summary when you do.
- "consensus" is true only when verdict is "pass" AND issues is empty
- Deduplicate issues raised by multiple members into a single entry. When only one member raised an issue, prefix its "issue" text with that member's [provider:id] label so the dissent is visible.
- "summary" must state the agreement level across the council (e.g. "all 3 judges agree", "2 of 3 judges passed") before the holistic assessment.
- "completedStepIds": include only plan step IDs that every member listed; omit when members disagree.
- Do not invent new issues that no member raised.
${EVIDENCE_RULES}`,

    user: `The developer's task:\n\n${description}\n\nThe council's individual judgments:\n\n${memberBlocks}\n\nSynthesize these into one final judgment JSON.`,
  };
}

function buildVerifyPromptImpl(
  originalContext: string,
  originalResult: string,
  task: "review" | "judge",
  instructionsText = "",
): { system: string; user: string } {
  return {
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText)}

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
  instructionsText = "",
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
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText)}

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

function buildVisionPromptImpl(
  imagePath: string,
  question?: string,
  context?: string,
): { system: string; user: string } {
  const questionBlock = question
    ? `Question about the image:\n${question}`
    : "Analyze this image. Describe what it shows, focusing on anything relevant to the project (UI layout, error messages, diagrams, code).";
  const contextBlock = context ? `\n\n<context>\n${context}\n</context>` : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}

Analyze the attached image for the developer. Be concise but complete. Assume they are a senior engineer who wants actionable observations, not a generic caption.

Rules:
- Answer the question directly first, then add supporting detail
- If the image shows a UI, comment on layout, hierarchy, and anything that looks broken or inconsistent
- If the image shows an error or stack trace, explain the root cause and how to fix it
- If the image shows a diagram, restate the structure precisely (components and relationships)
- If the image shows code, transcribe the relevant parts exactly before analyzing
- Do NOT describe things that are not visible in the image
- Do NOT include commentary outside the analysis`,

    user: `Image file: ${imagePath}\n\n${questionBlock}${contextBlock}`,
  };
}

function buildPdfAnalysisPromptImpl(
  pdfPath: string,
  extractedText: string,
  pages: number,
  question?: string,
  context?: string,
  instructionsText = "",
): { system: string; user: string } {
  const questionBlock = question
    ? `Question about the document:\n${question}`
    : "Analyze this document. Summarize what it is, extract the key facts (parties, dates, amounts, identifiers, requirements), and note anything unusual.";
  const contextBlock = context ? `\n\n<context>\n${context}\n</context>` : "";

  return {
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText)}

Analyze the provided PDF document text for the developer. Be concise but complete. Assume they are a senior engineer who wants the facts, not a generic summary.

Rules:
- Answer the question directly first, then add supporting detail
- Extract concrete facts exactly as written: names, dates, amounts, invoice/order numbers, emails, addresses
- If the document is a spec or RFC, restate the requirements precisely
- If the text looks garbled or truncated (extraction artifacts), say so instead of guessing
- Do NOT invent content that is not in the extracted text
- Do NOT include commentary outside the analysis`,

    user: `PDF file: ${pdfPath} (${pages} page${pages === 1 ? "" : "s"})\n\n${questionBlock}${contextBlock}\n\n<pdf_text>\n${extractedText}\n</pdf_text>`,
  };
}

function buildStepVerificationPromptImpl(
  stepDescription: string,
  diff: string,
  instructionsText = "",
): { system: string; user: string } {
  return {
    system: `${COMMON_SYSTEM_PREFIX}${formatInstructionsBlock(instructionsText)}

You are verifying whether a code change satisfies a specific plan step. Be conservative.

Return only valid JSON matching this schema:
{
  "satisfied": true,
  "reason": "brief explanation"
}

Rules:
- "satisfied" is true only if the diff clearly and completely implements the step description.
- If the diff is partial, unrelated, or missing required pieces, set "satisfied" to false.
- "reason" should be one sentence explaining your decision.
- Do not include markdown fences or commentary outside the JSON object.`,

    user: `Plan step to verify:\n${stepDescription}\n\nDiff since the last plan update:\n${diff}\n\nDoes this diff fully satisfy the plan step?`,
  };
}

export const buildPlanPrompt = memoizePromptBuilder(buildPlanPromptImpl);
export const buildAdvisorPrompt = memoizePromptBuilder(buildAdvisorPromptImpl);
export const buildExplainPrompt = memoizePromptBuilder(buildExplainPromptImpl);
export const buildVisionPrompt = memoizePromptBuilder(buildVisionPromptImpl);
export const buildPdfAnalysisPrompt = memoizePromptBuilder(buildPdfAnalysisPromptImpl);
export const buildStepVerificationPrompt = buildStepVerificationPromptImpl;
// Review prompts include large, highly-dynamic diffs and file contents, so caching them
// adds memory pressure and key-serialization cost for near-zero hit rates.
export const buildAdaptiveReviewPrompt = buildAdaptiveReviewPromptImpl;
export const buildScanPrompt = buildScanPromptImpl;
export const buildSuggestPrompt = memoizePromptBuilder(buildSuggestPromptImpl);
export const buildRecommendPrompt = memoizePromptBuilder(buildRecommendPromptImpl);
export const buildTestPrompt = buildTestPromptImpl;
export const buildSecurityPrompt = buildSecurityPromptImpl;
export const buildJudgePrompt = memoizePromptBuilder(buildJudgePromptImpl);
export const buildJudgeCouncilSynthesisPrompt = buildJudgeCouncilSynthesisPromptImpl;
export const buildVerifyPrompt = buildVerifyPromptImpl;
