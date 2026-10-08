import type { ExtensionAPI, ContextEvent } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatLanguageDirective, loadYoowaiConfig, resolveJudgeCouncilMembers } from "../config.js";
import { loadConventions } from "../conventions.js";
import { selectLearnedFacts, formatLearnedContext } from "../wai-learn.js";
import type { YoowaiConfig } from "../types.js";
import { hasUiChanges } from "../design-ref.js";
import { formatWriterDesignGuidance } from "../design-ref-defaults.js";
import { getState, getEditTracker } from "../session-state.js";
import { getPastIssuesForFiles } from "../review-memory.js";
import { estimateTokens, tokenBudgetChars, truncateToTokenBudget } from "../token-budget.js";
import {
  buildPlanReviewReminder,
  GIT_COMMIT_GUIDANCE,
  PLAN_ALIGNMENT_GUIDANCE,
  SVN_CAPTURE_GUIDANCE,
} from "../workflow-guidance.js";

const executingCwds = new Map<string, { count: number }>();

/** Mark whether a wai tool is currently executing for the given cwd.
 *  The context injector skips injection while a wai tool is running to avoid
 *  self-referential context. */
export function setWaiToolExecuting(cwd: string, executing: boolean): void {
  if (executing) {
    const active = executingCwds.get(cwd) ?? { count: 0 };
    active.count++;
    executingCwds.set(cwd, active);
  } else {
    const active = executingCwds.get(cwd);
    if (active && --active.count <= 0) executingCwds.delete(cwd);
  }
}

/** The disposer only touches its own generation, even after session replacement. */
export function beginWaiToolExecution(cwd: string): () => void {
  setWaiToolExecuting(cwd, true);
  const active = executingCwds.get(cwd)!;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    if (executingCwds.get(cwd) === active) setWaiToolExecuting(cwd, false);
  };
}

export function clearWaiToolExecution(cwd: string): void {
  executingCwds.delete(cwd);
}

type ContextMessage = ContextEvent["messages"][number];

function isUserStringMessage(
  message: ContextMessage,
): message is Extract<ContextMessage, { role: "user" }> & { content: string } {
  return message.role === "user" && typeof message.content === "string";
}

function getPlanSummary(cwd: string): string {
  const state = getState(cwd);
  if (!state.plan || state.totalSteps === 0) return "";

  const lines = [
    `Plan: ${state.plan.summary}`,
    `Progress: ${state.completedSteps}/${state.totalSteps} steps completed`,
  ];
  if (state.completedSteps < state.totalSteps) {
    const current = state.plan.todo[state.completedSteps];
    const desc = typeof current === "string" ? current : current?.description;
    if (desc) lines.push(`Current step: ${desc}`);
  }
  return lines.join("\n");
}

function getConventionsText(cwd: string): string {
  const conventions = loadConventions(cwd);
  if (!conventions) return "";
  const parts = [`Stack: ${conventions.stack}`, `Naming: ${conventions.naming}`, `Structure: ${conventions.structure}`];
  if (conventions.patterns.length > 0) {
    parts.push(`Patterns: ${conventions.patterns.join("; ")}`);
  }
  return parts.join("\n");
}

function projectVcs(cwd: string): "git" | "svn" | undefined {
  let directory = cwd;
  while (true) {
    if (existsSync(join(directory, ".svn"))) return "svn";
    if (existsSync(join(directory, ".git"))) return "git";
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function buildContextBlock(cwd: string, config: YoowaiConfig, query: string): string {
  const planSummary = getPlanSummary(cwd);
  const conventionsText = getConventionsText(cwd);
  const editState = getEditTracker(cwd);
  const reviewThreshold = config.reviewReminderEdits ?? 3;

  const parts: string[] = [];
  // Language directive first so it is the sole content when nothing else is
  // active (the parts.length guard below would otherwise emit nothing).
  const languageDirective = formatLanguageDirective(config.language);
  if (languageDirective) parts.push(languageDirective);
  const vcs = projectVcs(cwd);
  if (vcs === "git") parts.push(GIT_COMMIT_GUIDANCE);
  if (vcs === "svn") parts.push(SVN_CAPTURE_GUIDANCE);
  if (vcs === "svn") {
    parts.push(
      "SVN WORKFLOW: wai reviews unversioned files, but svn commit omits files marked ?. " +
        "Before the final whole-tree review, inspect `svn status` and schedule intended new task files with " +
        "`svn add --parents -- <explicit file paths>`. Add only the intended source, tests, and assets; " +
        "do not bulk-add '.', .pi/, generated outputs, or unrelated files. Before an authorized commit, " +
        "verify intended new files show A. If you add files after review, run the whole-tree review again.",
    );
  }
  if (planSummary) parts.push(planSummary, PLAN_ALIGNMENT_GUIDANCE);
  if (conventionsText) parts.push(`<project_conventions>\n${conventionsText}\n</project_conventions>`);
  // Task/file relevance precedes recency; stale entries are omitted before
  // selection. Stored context is a hint, not verification of the current code.
  const learned = selectLearnedFacts(cwd, { query: `${query}\n${planSummary}`, files: editState.editedFiles });
  if (learned.length > 0) {
    const learnedBlock = `<project_knowledge>\n${formatLearnedContext(learned, 400)}\n</project_knowledge>`;
    if (learnedBlock.length > "<project_knowledge>\n\n</project_knowledge>".length) {
      parts.push(learnedBlock);
    }
  }
  // Surface the load-bearing design rules when unreviewed edits touch UI
  // files so the main agent writes UI code against them before review.
  if (hasUiChanges(cwd, editState.editedFiles)) {
    const designRules = formatWriterDesignGuidance(cwd, 300, editState.editedFiles);
    if (designRules) parts.push(`<design_rules>\n${designRules}\n</design_rules>`);
  }
  // Advisor notes: state-derived heads-up (no model calls) so the main agent
  // is reminded of recent review issues in the files it is actively editing.
  if (config.advisorNotes !== false && editState.editedFiles.length > 0) {
    const memoryContext = getPastIssuesForFiles(cwd, editState.editedFiles, query || undefined);
    if (memoryContext.trim()) {
      parts.push(`<advisor_notes>\n${memoryContext.trim()}\n</advisor_notes>`);
    }
  }
  if (editState.editsSinceLastReview >= reviewThreshold) {
    const state = getState(cwd);
    const planNudge =
      state.plan && state.completedSteps < state.totalSteps
        ? buildPlanReviewReminder(state.completedSteps, state.totalSteps)
        : "";
    const noPlanNudge =
      !state.plan || state.totalSteps === 0
        ? ` No active wai plan — if this is non-trivial work, create one first with \`wai({ plan: "..." })\`.`
        : "";
    parts.push(
      `WORKFLOW REMINDER: you have made ${editState.editsSinceLastReview} file edit(s) since the last review. ` +
        `Call \`wai({ review: "..." })\` to review the changes before continuing.${planNudge}${noPlanNudge}`,
    );
  }

  // A configured council offers an optional final assessment. An empty
  // council must not make a completed, reviewed plan look unfinished.
  const planState = getState(cwd);
  if (
    planState.plan &&
    planState.totalSteps > 0 &&
    planState.completedSteps >= planState.totalSteps &&
    !planState.judgeCompleted &&
    resolveJudgeCouncilMembers(config).length > 0 &&
    config.autoJudge !== true
  ) {
    parts.push(
      `PLAN COMPLETE: all ${planState.totalSteps} plan steps are marked done. ` +
        `Council members are configured. Optionally call \`wai({ judge: "..." })\` for a final holistic council assessment.`,
    );
  }

  if (parts.length === 0) return "";
  return `\n\n<wai_context>\n${parts.join("\n\n")}\n</wai_context>`;
}

/** Token-bound a fact list on whole-line boundaries (facts are short; the
 *  cap exists so a large learned store cannot crowd out higher-priority
 *  context). */
function truncateFacts(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    // Account for the joining newline: check the candidate WITH the next
    // line included before keeping it.
    const candidate = kept.length > 0 ? [...kept, line].join("\n") : line;
    if (estimateTokens(candidate) > maxTokens) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

function truncateBlock(block: string, maxTokens: number): string {
  if (estimateTokens(block) <= maxTokens) return block;

  // Reserve up to 20% (160 tokens) for the best-ranked whole facts instead
  // of dropping all learned knowledge whenever the block is oversized.
  const knowledge = block.match(/<project_knowledge>\n([\s\S]*?)\n<\/project_knowledge>/);
  if (knowledge) {
    const content = truncateFacts(knowledge[1], Math.min(160, Math.floor(maxTokens * 0.2)));
    block = block.replace(knowledge[0], content ? `<project_knowledge>\n${content}\n</project_knowledge>` : "");
    if (estimateTokens(block) <= maxTokens) return block;
  }
  for (const tag of ["design_rules", "project_conventions"]) {
    const match = block.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`));
    if (match) {
      const without = block.replace(match[0], "").replace(/\n\n+/g, "\n\n");
      if (estimateTokens(without) <= maxTokens) {
        return without;
      }
      block = without;
    }
  }

  // Still over budget: shrink the advisor-notes CONTENT (keeping the wrapper
  // tags balanced) before falling back to whole-block truncation, which could
  // cut inside a section and drop trailing reminders.
  const notesMatch = block.match(/<advisor_notes>([\s\S]*?)<\/advisor_notes>/);
  if (notesMatch) {
    const marker = "\n… (advisor notes truncated)";
    const overTokens = estimateTokens(block) - maxTokens;
    const inner = notesMatch[1];
    // Reserve room for the truncation marker so the capped block stays within
    // budget; the marker itself must not push the block back over.
    const maxInnerChars = Math.max(0, inner.length - tokenBudgetChars(overTokens) - marker.length);
    let cappedInner = inner;
    if (inner.length > maxInnerChars) {
      // The slice is UTF-16 based; strip a lone trailing high surrogate from
      // the PREFIX so an astral character (emoji etc.) at the boundary cannot
      // be split, then append the marker.
      let prefix = inner.slice(0, maxInnerChars);
      if (/[\uD800-\uDBFF]$/.test(prefix)) {
        prefix = prefix.slice(0, -1);
      }
      cappedInner = prefix + marker;
    }
    const withCappedNotes = block.replace(notesMatch[0], `<advisor_notes>${cappedInner}</advisor_notes>`);
    if (estimateTokens(withCappedNotes) <= maxTokens) {
      return withCappedNotes;
    }
    block = withCappedNotes;
  }

  // Mandatory workflow instructions still take precedence for tiny budgets.
  block = block.replace(/<project_knowledge>[\s\S]*?<\/project_knowledge>/, "");
  if (estimateTokens(block) <= maxTokens) return block;
  return truncateToTokenBudget(block, maxTokens);
}

/** Context estimates can be absent immediately after compaction. In that case,
 * keep the configured budget. Only optional sections shrink under pressure. */
function adaptOptionalContext(block: string, maxTokens: number, usage: unknown): string {
  const estimate = usage as { tokens?: unknown; contextWindow?: unknown } | undefined;
  if (
    typeof estimate?.tokens !== "number" ||
    !Number.isFinite(estimate.tokens) ||
    estimate.tokens < 0 ||
    typeof estimate.contextWindow !== "number" ||
    !Number.isFinite(estimate.contextWindow) ||
    estimate.contextWindow <= 0 ||
    estimate.tokens / estimate.contextWindow <= 0.75
  )
    return block;

  const sections = new Map<string, string>();
  let mandatory = block.replace(
    /<(project_knowledge|advisor_notes|design_rules|project_conventions)>[\s\S]*?<\/\1>/g,
    (section, tag: string) => {
      sections.set(tag, section.slice(tag.length + 2, -(tag.length + 3)).trim());
      return "";
    },
  );
  const knowledge = sections.get("project_knowledge")?.split("\n") ?? [];
  const decisions = knowledge.filter((line) => line.startsWith("- [decision] "));
  if (decisions.length)
    mandatory = mandatory.replace(
      "</wai_context>",
      `<project_knowledge>\n${decisions.join("\n")}\n</project_knowledge>\n</wai_context>`,
    );
  sections.set("project_knowledge", knowledge.filter((line) => !line.startsWith("- [decision] ")).join("\n"));
  mandatory = mandatory.replace(/\n\n+/g, "\n\n");

  // Full optional allowance at 75%, none at 95%. The headroom cap also
  // protects small context windows. This does not trigger compaction or
  // change the source payload/budget of the secondary review.
  const scale = Math.max(0, (0.95 - estimate.tokens / estimate.contextWindow) / 0.2);
  let remaining = Math.floor(
    Math.min(
      Math.max(0, maxTokens - estimateTokens(mandatory)) * scale,
      Math.max(0, estimate.contextWindow - estimate.tokens) * 0.05,
    ),
  );
  const selected: string[] = [];
  for (const tag of ["project_knowledge", "advisor_notes", "design_rules", "project_conventions"]) {
    let content = sections.get(tag);
    if (!content) continue;
    const wrapperTokens = estimateTokens(`<${tag}>\n\n</${tag}>\n\n`);
    if (tag === "project_knowledge") content = truncateFacts(content, Math.max(0, remaining - wrapperTokens));
    if (!content) continue;
    const section = `<${tag}>\n${content}\n</${tag}>\n\n`;
    const tokens = estimateTokens(section);
    if (tokens > remaining) continue;
    selected.push(section);
    remaining -= tokens;
  }
  return mandatory.replace("</wai_context>", `${selected.join("")}</wai_context>`);
}

export function registerContextInjector(pi: ExtensionAPI): void {
  pi.on("context", (event: ContextEvent, ctx) => {
    const config = loadYoowaiConfig(ctx.cwd);
    if (config.autoInjectContext === false) return;
    if (executingCwds.has(ctx.cwd)) return;
    if (!event.messages || event.messages.length === 0) return;

    const latestUser = event.messages.findLast(isUserStringMessage);
    const query =
      typeof latestUser?.content === "string"
        ? latestUser.content.replace(/<wai_context>[\s\S]*?<\/wai_context>/g, "")
        : "";
    let block = buildContextBlock(ctx.cwd, config, query);
    if (!block) return;

    const maxTokens = config.contextInjectMaxTokens ?? 800;
    let usage: unknown;
    try {
      usage = ctx.getContextUsage?.();
    } catch {
      // A host UI/context estimate failure must not remove workflow guidance.
    }
    block = adaptOptionalContext(block, maxTokens, usage);
    block = truncateBlock(block, maxTokens);

    // Prefer the last user message with string content.
    let targetIndex = -1;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      if (isUserStringMessage(event.messages[i])) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex === -1) targetIndex = event.messages.length - 1;

    const target = event.messages[targetIndex];
    if (target && target.role === "user" && typeof target.content === "string") {
      target.content += block;
    }
    // If the last message has array content or is not a user message, we skip
    // injection rather than append unstructured text to the wrong place.
  });
}
