import {
  PLAN_GUIDANCE,
  PLAN_ALIGNMENT_GUIDANCE,
  REVIEW_SCOPE_GUIDANCE,
  REVIEW_PROGRESS_GUIDANCE,
  INCONCLUSIVE_REVIEW_GUIDANCE,
  COMMIT_GUIDANCE,
  GIT_COMMIT_GUIDANCE,
  COMPLETION_EVIDENCE_GUIDANCE,
  FINAL_COUNCIL_GUIDANCE,
} from "./workflow-guidance.js";

/** Detailed instructions remain available on old hosts and through the wai namespace. */
export const WAI_TOOL_GUIDANCE = {
  wai: [
    PLAN_GUIDANCE,
    PLAN_ALIGNMENT_GUIDANCE,
    "Use wai({ plan: '<task description>' }) before starting non-trivial implementation. The secondary model creates a structured todo list with acceptance criteria.",
    "Use wai({ review: '<change description>' }) after every cohesive code change. Resolve actionable findings and re-run review until it passes with complete coverage. If a finding is wrong, refute it with concrete evidence (file/line, test output, docs) instead of changing correct code; use verify:true for high-stakes disagreements and ask the user when needed.",
    "A 'code change' = a cohesive edit batch / one plan step's worth of edits — review once per batch before moving on (not after every keystroke). Fixes after feedback are a new batch and need review. A focused pass closes only that scope; whole-tree certification must include all pending changes.",
    REVIEW_SCOPE_GUIDANCE,
    "Prefer wai({ review: '<change description>' }) for normal review so configured defaults and optional risk routing can apply. Choose an explicit wai_review_min/med/high only for an intentional depth override. When selecting high, name the concrete risk and relevant behavior in the description; do not select high merely for a final review, retry, large file, strong model, or high thinking setting. Selection reasons in levelSelection explain local routing; they do not prove safety or coverage.",
    "Pick review depth by the change's risk and complexity: med is the balanced default for normal features and bugfixes or when unsure; min is for clearly low-risk docs, comments, config, tests-only, or tiny mechanical changes (renames, version bumps); high requires a concrete risk such as auth, secrets, payments, migrations, public API behavior, concurrency, algorithms, state machines, intricate control flow, or cross-module refactors. File count, model family, and thinking level alone do not justify high. A small security-sensitive change can still require high. Plain `wai review` uses automatic selection (med by default, optional risk routing) unless a fixed pi-yoowai.reviewLevel is configured; explicit wai_review_min/med/high tools always override automatic selection.",
    "Use wai with scan:true immediately when opening a project for the first time. Stored conventions improve all future reviews and plans. Add scanDeep:true on that first scan to also sample source files and build the project symbol index.",
    "Scan reuses matching inputs for 24 hours without a model call. Set scanRefresh:true to explicitly re-run the scan model; a reused deep scan still refreshes the symbol graph.",
    "Use wai({ advisor: '<question>' }) for quick judgment calls before committing to an approach or when stuck. When the question needs a structured comparison of alternatives, use suggest instead.",
    "Use wai({ suggest: '<question>' }) for structured alternative approaches with evidence. If stuck or looping, consult suggest or advisor before asking the user for implementation guidance.",
    "When the user asks a non-trivial architectural or design question where multiple valid approaches exist, call wai.suggest before answering. For simple factual questions you can verify yourself (reading files, running commands), answer directly without wai.",
    "Use wai({ recommend: '<next-step question>' }) when deciding what to do next. If you have spent more than one turn without clear progress, call wai.recommend.",
    "Use wai({ test: '<testing question>' }) for a dedicated assessment of missing tests, failing tests, or test quality. This assessment does not replace executing the required checks.",
    "Use wai({ security: '<change description>' }) when the change involves auth, input handling, secrets, dependencies, or another security-sensitive area. Scope focused audits with files:[...] if needed.",
    FINAL_COUNCIL_GUIDANCE,
    "An errored, incomplete, or inconclusive review does not certify completion or clear the review gate. Resolve model availability, budget, or input failures before advancing the workflow; report an unresolved blocker instead of looping on retries.",
    INCONCLUSIVE_REVIEW_GUIDANCE,
    "Run relevant/fast project checks (typecheck, lint, targeted tests) before each batch review, then the project's full prescribed check suite once on the complete diff before the final whole-tree review and any optional council assessment. Include concise result summaries — not full log dumps.",
    "Workflow order: plan → implement → checks and focused review as needed → fix confirmed findings → complete whole-tree review → inspect returned plan progress → optional configured council assessment. Use done only for a reviewed step that has not already advanced.",
    REVIEW_PROGRESS_GUIDANCE,
    "If plan progress drifts, inspect the plan and code before correcting it with done:<step number>. Lower numbers regress progress and 0 resets it; use done:'all' only when every step is actually complete. Use force only for an explicitly requested manual override and report it as manual completion. Judge can re-sync progress from completedStepIds/incompleteStepIds.",
    COMMIT_GUIDANCE,
    GIT_COMMIT_GUIDANCE,
    COMPLETION_EVIDENCE_GUIDANCE,
    "For small plan edits use planUpdate:{operations:[...]} with edit/add/remove/move operations, using current 1-based step numbers or stable IDs from wai_index({topic:'plan'}). edit.title changes only a display label; edit.description/dependencies changes the required outcome and reopens affected progress. add.after:0 inserts first; move.to is the final position. References resolve against the current list at each operation. Unchanged completed work retains review records. Use planUpdate:'<changed decision and remaining work>' for a model-assisted revision, or planUpdate:{undo:true} to undo the last update. Changed acceptance criteria conservatively reopen completed work; switching focus never marks skipped work done.",
    "Enable autoJudge with configured council members to automatically run final council assessment when the last plan step completes. Empty council disables it even when autoJudge is true.",

    "Configure preReviewCommands in settings.json to run lint/test/typecheck before each review and include output in the prompt.",
    "Use `verify: true` when a wai finding is surprising, high-stakes, or unclear. The main agent must then confirm or refute the finding with evidence before acting.",
    "The secondary model should be a DIFFERENT model family than the main model to catch blind spots. Configure in settings.json under pi-yoowai.secondary.",
    "Only one action (plan/advisor/review/suggest/recommend/judge/scan/test/security/done/planUpdate) per call. Do not combine them.",
    "When stuck, confused, or looping, stop and use a wai tool. Do not spin in place or guess.",
  ],
  wai_review_min: [
    "Use wai_review_min for small, low-risk changes where a quick sanity check is enough.",
    "The tool uses the MINIMAL review level: it skips architecture, deep edge cases, and cross-file analysis.",
    "Pass files:[...] to scope the review, or verify:true when a finding is surprising.",
  ],
  wai_review_med: [
    "Prefer generic wai({review:'...'}) for normal changes so configured routing applies. Use wai_review_med when intentionally requesting the balanced depth regardless of routing.",
    "The tool uses the STANDARD review level: it checks logic, correctness, tests, conventions, and cross-file impact.",
    "Pass files:[...] to scope the review, or verify:true for high-stakes disagreements.",
  ],
  wai_review_high: [
    "Use wai_review_high for an identified complex, risky, or security-sensitive change. State the concrete risk in description. A final review or retry alone does not justify high; diagnose incomplete evidence through recovery.",
    "The tool uses the DEEP review level: it examines architecture, security, edge cases, error handling, concurrency, and API contracts.",
    "Pass files:[...] to scope the review, or verify:true for high-stakes findings.",
  ],
  wai_index: [
    "Call wai_index when you need a quick overview of the project conventions, active plan, or recent review issues.",
    "Use topic 'conventions' to learn the project's stack, naming, structure, and patterns.",
    "Use topic 'plan' to see the current todo list and progress.",
    "Use topic 'memory' with files:[...] to see past review issues for specific files.",
    "Use topic 'cost' to check estimated spend in the current session.",
    "Use topic 'logs' to see recent wai errors or warnings.",
    "Use topic 'index' to see the project symbol index built by wai scan-deep or wai_index update.",
    "Use topic 'learned' to see facts recorded with wai_learn.",
    "Prefer a specific topic, files, and query over topic 'all' during ongoing work to avoid repeatedly returning unrelated context.",
    "Set update:true to rebuild the symbol index on demand.",
    "wai_index does not call a model. Symbol-index reads refresh an existing stale graph locally; update:true also builds a missing index.",
  ],
  wai_explain: [
    "Call wai_explain when you see an error you do not fully understand.",
    "Use wai_explain to get a concise explanation of a code snippet, function, or file.",
    "Pass files:[...] so the model can see full context around the target.",
    "Use context to add extra background (e.g. 'this is thrown during wai scan').",
  ],
  wai_vision: [
    "Call wai_vision when the user references a screenshot, UI mockup, diagram, error capture, or PDF document in the project.",
    "Pass a focused question (e.g. 'does this UI match the design rules?') to get actionable analysis instead of a generic caption.",
    "Use context to add background (e.g. 'this is the settings dialog after my change').",
  ],
  wai_learn: [
    "Call wai_learn to record project-specific facts, decisions, or quirks the main agent should remember.",
    "Use a category to group related facts (e.g. 'auth', 'build', 'conventions').",
    "Keep facts concise and actionable.",
    "Include a project-relative source file for factual claims. Stored memory is context; verify it against current code before acting on it.",
    "Recorded facts appear in wai_index topic 'learned'.",
    "Fresh learned facts are automatically selected by task and source-file relevance for the main agent, within its context budget. Fresh decisions are also selected for review prompts.",
    "Use verify:true for structural reference checks; these do not renew freshness or prove a behavioral claim.",
    "Add deep:true to verify with the secondary model for higher accuracy (costs tokens per fact).",
  ],
  wai_scaffold: [
    "Call wai_scaffold WITHOUT apply to preview the proposed files first; show the user the preview and get approval before calling it again with apply:true.",
    "Targets: skill (.pi/skills/engineering-standards/SKILL.md), review/security/test (.pi/yoowai/instructions/<action>.md) — pass an array of the ones wanted.",
    "The tool fills only factual placeholders from the conventions scan and manifests. Recognized keys WITHOUT evidence render as <FILL ME: key — evidence: ...> (never raw); only UNKNOWN template keys stay as {{key}} and count as unresolved.",
    "Existing files are NEVER overwritten (exclusive creation) — report skipped files to the user.",
    "After scaffolding, fill the unresolved markers explicitly by reading the repo (a /wai-fill completion command is planned; do not invent values).",
    "No model calls, no command execution, no writes without apply:true.",
  ],
  wai_design_ref: [
    "Call wai_design_ref when building, reviewing, or improving UI/animation code to get detailed design guidance.",
    "Call without a topic to list the available topics and their docs.",
    "Start with topic 'wai-skill-design' for the adapted skill, then read a relevant references/*.md doc. Original topic names remain available as upstream source material.",
    "Pass doc to read a specific document of a topic (e.g. topic 'improve-animations', doc 'AUDIT.md').",
    "The distilled baseline rules are already injected automatically for UI files; use this tool for depth.",
    "When details.truncated is true, continue from details.nextOffset using offset; do not treat the first page as complete. maxTokens bounds each page.",
  ],
};

export const CODEMODE_MEMORY_GUIDANCE =
  "Query wai_index by topic, files, query, and limit (1-100). Selection counts disclose omissions. In codemode inspect memoryEntries, learned, and index.files and print only relevant " +
  "facts, plan progress, or symbols; do not repeatedly print the whole index. Memory is context, not verified evidence. " +
  "Store small IDs, cursors, or summaries, never image data or full source files.";

export const CODEMODE_IMAGE_GUIDANCE =
  "For a requested design reference, Pi 1.0 codemode can discover an image model with models.getAvailableOfType('image') " +
  "and call models.generateImages(model, {input:[{type:'text',text:prompt}]}). Check stopReason/errorMessage. " +
  "Show image blocks with image(block), and pass one directly to tools.wai_vision({image:block,question,context}) " +
  "for critique. Never print/store base64. Image generation uses Pi session credentials/costs; wai_vision uses wai's " +
  "configured vision model and budget. Generate only for requested visual work; a generated reference is not evidence " +
  "that the implemented UI matches it.";

WAI_TOOL_GUIDANCE.wai_index.push(CODEMODE_MEMORY_GUIDANCE);
WAI_TOOL_GUIDANCE.wai_index.push(
  "Use topic:'guidance' for packaged-skill diagnostics, observed successful reads, selected secondary criteria, and legacy-copy/collision paths. Availability/read observation does not prove activation or compliance.",
);
WAI_TOOL_GUIDANCE.wai_vision.push(CODEMODE_IMAGE_GUIDANCE);

const COMPACT_CORE = [
  "Use one wai action per call: plan before non-trivial work, review each cohesive edit batch, and run required checks. " +
    "Read wai_index({topic:'guidance'}) or describeNamespace('wai').instructions before first use for detailed workflow and tool guidance.",
  "Default to med for normal changes or uncertainty; use min for clearly low-risk edits and high for a concrete " +
    "security, data, contract, concurrency, or complexity risk. File count, model family, and thinking level alone " +
    "do not justify high. Prefer generic wai({review:'...'}) so configured routing applies; explicit depth tools are intentional overrides. " +
    "Name the concrete risk when selecting high; final review or retry alone does not justify it. Explicit tool/config review levels win.",
  FINAL_COUNCIL_GUIDANCE,
  "A scoped/historical pass, inconclusive result, omitted files, truncated input/output, or failed checks cannot certify " +
    "the whole tree. Include new files in a complete unscoped final review; inspect recovery before retrying unchanged input.",
  "Review may already advance the plan: inspect workflow.completedSteps or wai_index({topic:'plan'}) before done. " +
    "Partial work or an unchanged preservation criterion alone is not stale. Preserve explicit user requirements; " +
    "verify plan mismatches and findings against code/evidence. Force only on an explicit manual-override request.",
  "Run actual project checks and report their results, scope, coverage, and unresolved criteria. Commit only when " +
    "authorized, include intended new files, inspect commit contents, and preserve unrelated changes.",
];

const DESCRIPTIONS: Record<string, string> = {
  wai: "Secondary-model planning, advice, review, testing assessment, security assessment, judgment, and plan progress. One action per call.",
  wai_review_min: "Lightweight second-opinion review for small, low-risk changes.",
  wai_review_med: "Default balanced second-opinion review for normal features and fixes.",
  wai_review_high: "Deep second-opinion review for an identified risk. Explain the concrete risk in description.",
  wai_index: "Query stored project context, plan progress, memory, learned facts, and symbols. No model call.",
  wai_explain: "Ask the secondary model to explain code, a file, or an error.",
  wai_vision: "Analyze an image/PDF path or an inline image block with the configured secondary vision model.",
  wai_learn: "Record, check, list stale, or explicitly reaffirm project facts and decisions.",
  wai_scaffold: "Preview or create project engineering guidance files; existing files are preserved.",
  wai_design_ref: "List or read curated UI and animation design guidance.",
};

export const WAI_NAMESPACE = {
  name: "wai",
  description: "Secondary-model pair programming and project knowledge.",
  instructions: Object.entries(WAI_TOOL_GUIDANCE)
    .map(([name, instructions]) => `${name}\n${instructions.map((line) => `- ${line}`).join("\n")}`)
    .join("\n\n"),
};

export function compactToolMetadata(
  name: string,
): { description: string; promptGuidelines: string[]; namespace: typeof WAI_NAMESPACE } | undefined {
  const description = DESCRIPTIONS[name];
  if (!description) return undefined;
  return {
    description,
    promptGuidelines:
      name === "wai"
        ? [...COMPACT_CORE]
        : [
            "See wai_index({topic:'guidance'}) or describeNamespace('wai').instructions before first use. Whole-tree review and completion checks " +
              "still apply; inspect structured results and recovery instead of inferring success from report text.",
          ],
    namespace: WAI_NAMESPACE,
  };
}
