import type { ExtensionAPI, ContextEvent } from "@earendil-works/pi-coding-agent";
import { loadYoowaiConfig } from "../config.js";
import { loadConventions } from "../conventions.js";
import { findLearnedFacts } from "../wai-learn.js";
import { isUiFile } from "../design-ref.js";
import { formatWriterDesignGuidance } from "../design-ref-defaults.js";
import { getState, getEditTracker } from "../session-state.js";
import { getPastIssuesForFiles } from "../review-memory.js";
import { estimateTokens, truncateToTokenBudget } from "../token-budget.js";

const executingCwds = new Set<string>();

/** Mark whether a wai tool is currently executing for the given cwd.
 *  The context injector skips injection while a wai tool is running to avoid
 *  self-referential context. */
export function setWaiToolExecuting(cwd: string, executing: boolean): void {
  if (executing) {
    executingCwds.add(cwd);
  } else {
    executingCwds.delete(cwd);
  }
}

type ContextMessage = ContextEvent["messages"][number];

function isUserStringMessage(message: ContextMessage): boolean {
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

function buildContextBlock(cwd: string): string {
  const config = loadYoowaiConfig(cwd);
  const planSummary = getPlanSummary(cwd);
  const conventionsText = getConventionsText(cwd);
  const editState = getEditTracker(cwd);
  const reviewThreshold = config.reviewReminderEdits ?? 3;

  const parts: string[] = [];
  if (planSummary) parts.push(planSummary);
  if (conventionsText) parts.push(`<project_conventions>\n${conventionsText}\n</project_conventions>`);
  // Learned knowledge: newest-first facts + decisions (compact, token-bounded)
  // so the main agent starts each turn with project knowledge that persists
  // across sessions — no model calls.
  const learned = findLearnedFacts(cwd);
  if (learned.length > 0) {
    const factsText = learned
      .slice(0, 20)
      .map((f) => `- ${f.kind === "decision" ? "[decision] " : ""}${f.fact}`)
      .join("\n");
    const learnedBlock = `<project_knowledge>\n${truncateFacts(factsText, 400)}\n</project_knowledge>`;
    if (learnedBlock.length > "<project_knowledge>\n\n</project_knowledge>".length) {
      parts.push(learnedBlock);
    }
  }
  // Surface the load-bearing design rules when unreviewed edits touch UI
  // files so the main agent writes UI code against them before review.
  if (editState.editedFiles.some(isUiFile)) {
    const designRules = formatWriterDesignGuidance(cwd, 300);
    if (designRules) parts.push(`<design_rules>\n${designRules}\n</design_rules>`);
  }
  // Advisor notes: state-derived heads-up (no model calls) so the main agent
  // is reminded of recent review issues in the files it is actively editing.
  if (config.advisorNotes !== false && editState.editedFiles.length > 0) {
    const memoryContext = getPastIssuesForFiles(cwd, editState.editedFiles);
    if (memoryContext.trim()) {
      parts.push(`<advisor_notes>\n${memoryContext.trim()}\n</advisor_notes>`);
    }
  }
  if (editState.editsSinceLastReview >= reviewThreshold) {
    const state = getState(cwd);
    const planNudge =
      state.plan && state.completedSteps < state.totalSteps
        ? ` If this work completes the current plan step (${state.completedSteps + 1}/${state.totalSteps}), call \`wai({ done: true })\` after the review passes to keep the plan tracker in sync.`
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

  // Judge-pending nudge: the plan is fully marked done but never judged, and
  // autoJudge (off by default) will not run it. Without this the workflow
  // silently stops one step early.
  const planState = getState(cwd);
  if (
    planState.plan &&
    planState.totalSteps > 0 &&
    planState.completedSteps >= planState.totalSteps &&
    !planState.judgeCompleted &&
    config.autoJudge !== true
  ) {
    parts.push(
      `PLAN COMPLETE: all ${planState.totalSteps} plan steps are marked done. ` +
        `Call \`wai({ judge: "..." })\` for a final holistic review before declaring the work complete.`,
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
    if (estimateTokens(candidate) > maxTokens) break;
    kept.push(line);
  }
  return kept.join("\n");
}

function truncateBlock(block: string, maxTokens: number): string {
  if (estimateTokens(block) <= maxTokens) return block;

  // Drop the least critical sections first: project knowledge (learned
  // facts/decisions are useful but replaceable), then design rules, then
  // conventions — preserving plan, advisor notes, and reminders. Advisor
  // notes stay above conventions/design rules because they are
  // decision-relevant for the current edits (recent review issues in files
  // being touched).
  for (const tag of ["project_knowledge", "design_rules", "project_conventions"]) {
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
    const maxInnerChars = Math.max(0, inner.length - overTokens * 4 - marker.length);
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

  // Then truncate the remaining block.
  return truncateToTokenBudget(block, maxTokens);
}

export function registerContextInjector(pi: ExtensionAPI): void {
  pi.on("context", (event: ContextEvent, ctx) => {
    const config = loadYoowaiConfig(ctx.cwd);
    if (config.autoInjectContext === false) return;
    if (executingCwds.has(ctx.cwd)) return;
    if (!event.messages || event.messages.length === 0) return;

    let block = buildContextBlock(ctx.cwd);
    if (!block) return;

    const maxTokens = config.contextInjectMaxTokens ?? 800;
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
