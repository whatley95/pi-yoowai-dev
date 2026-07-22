import type { ExtensionAPI, ContextEvent } from "@earendil-works/pi-coding-agent";
import { loadYoowaiConfig } from "../config.js";
import { loadConventions } from "../conventions.js";
import { getState, getEditTracker } from "../session-state.js";
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
  if (editState.editsSinceLastReview >= reviewThreshold) {
    parts.push(
      `WORKFLOW REMINDER: you have made ${editState.editsSinceLastReview} file edit(s) since the last review. ` +
        `Call \`wai({ review: "..." })\` to review the changes before continuing.`,
    );
  }

  if (parts.length === 0) return "";
  return `\n\n<wai_context>\n${parts.join("\n\n")}\n</wai_context>`;
}

function truncateBlock(block: string, maxTokens: number): string {
  if (estimateTokens(block) <= maxTokens) return block;

  // Try removing conventions first while preserving plan + reminder.
  const conventionsMatch = block.match(/<project_conventions>[\s\S]*?<\/project_conventions>/);
  if (conventionsMatch) {
    const withoutConventions = block.replace(conventionsMatch[0], "").replace(/\n\n+/g, "\n\n");
    if (estimateTokens(withoutConventions) <= maxTokens) {
      return withoutConventions;
    }
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
