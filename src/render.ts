import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { formatCost } from "./cost-tracker.js";
import { loadYoowaiConfig } from "./config.js";
import { resolveReviewLevel } from "./review-level.js";
import type { WaiToolParams, WaiToolResult, ReviewIssue, StageProfile, ReviewLevel, UsageCost } from "./types.js";

/** Local theme interface compatible with the real Pi Theme shape. */
interface Theme {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
}

/** Local render context compatible with the real ToolRenderContext shape. */
interface ToolRenderContext {
  lastComponent?: unknown;
  /** Working directory of the session, when available; used to resolve the
   *  effective review level for call titles. */
  cwd?: string;
}

interface ProgressDetails {
  action?: string;
  inProgress?: boolean;
  progressMessage?: string;
  stage?: number;
  total?: number;
}

function isTextComponent(value: unknown): value is Text {
  return (
    value instanceof Text ||
    (!!value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).setText === "function" &&
      typeof (value as Record<string, unknown>).render === "function")
  );
}

function getTextComponent(context?: ToolRenderContext): Text {
  const last = context?.lastComponent;
  if (isTextComponent(last)) {
    return last;
  }
  return new Text("", 0, 0);
}

function resolveToolResult(result: AgentToolResult<WaiToolResult>): {
  result: (WaiToolResult & ProgressDetails) | undefined;
  isError: boolean;
} {
  const candidate = result.details as (WaiToolResult & ProgressDetails) | undefined;
  return { result: candidate ?? undefined, isError: false };
}

function formatCostText(cost?: UsageCost): string | undefined {
  if (!cost) return undefined;
  const inTokens = formatTokenCount(cost.estimatedInputTokens);
  const outTokens = formatTokenCount(cost.estimatedOutputTokens);
  const value = formatCost(cost.estimatedCostUsd);
  return `${inTokens} in · ${outTokens} out · ${value}`;
}

function formatCostLine(result: WaiToolResult): string | undefined {
  return formatCostText(result.cost);
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function modelSuffix(model?: StageProfile): string {
  if (!model?.provider || !model.id) return "";
  const thinking = model.thinking && model.thinking.toLowerCase() !== "off" ? ` (${model.thinking})` : "";
  const backend = model.backend ? ` [${model.backend}]` : "";
  return ` · ${model.provider}:${model.id}${thinking}${backend}`;
}

function severityColor(severity: ReviewIssue["severity"]): string {
  switch (severity) {
    case "high":
      return "error";
    case "medium":
      return "yellow";
    default:
      return "dim";
  }
}

function severityIcon(severity: ReviewIssue["severity"]): string {
  switch (severity) {
    case "high":
      return "🔴";
    case "medium":
      return "🟡";
    default:
      return "💡";
  }
}

export function renderCall(args: WaiToolParams, theme: Theme, context?: ToolRenderContext, level?: ReviewLevel): Text {
  const p = args;
  // The generic wai tool has no level param; the effective level is resolved
  // from config for display (guarded — a config error only loses the marker).
  if (p.review && !level && context?.cwd) {
    try {
      level = resolveReviewLevel(loadYoowaiConfig(context.cwd));
    } catch {
      // display-only; ignore
    }
  }
  let label: string;
  if (p.plan) label = `wai plan: ${truncate(String(p.plan), 80)}`;
  else if (p.review) label = `wai review${level ? ` (${level})` : ""}: ${truncate(String(p.review), 80)}`;
  else if (p.suggest) label = `wai suggest: ${truncate(String(p.suggest), 80)}`;
  else if (p.recommend) label = `wai recommend: ${truncate(String(p.recommend), 80)}`;
  else if (p.judge) label = `wai judge: ${truncate(String(p.judge), 80)}`;
  else if (p.scan) label = "wai scan";
  else if (p.test) label = `wai test: ${truncate(String(p.test), 80)}`;
  else if (p.security) label = `wai security: ${truncate(String(p.security), 80)}`;
  else label = "wai";

  const text = getTextComponent(context);
  text.setText(theme.fg("accent", label));
  return text;
}

/** Render a call to one of the explicit review-depth tools (wai_review_min/med/high),
 *  whose params are `{ description, files?, ... }` instead of the wai action shape. */
export function renderReviewToolCall(
  level: string,
  args: { description?: string },
  theme: Theme,
  context?: ToolRenderContext,
): Text {
  const label = args.description
    ? `wai review (${level}): ${truncate(String(args.description), 80)}`
    : `wai review (${level})`;
  const text = getTextComponent(context);
  text.setText(theme.fg("accent", label));
  return text;
}

/** Render a call to the wai_index tool. */
export function renderIndexCall(
  args: { topic?: string; update?: boolean },
  theme: Theme,
  context?: ToolRenderContext,
): Text {
  const topic = typeof args.topic === "string" && args.topic ? args.topic : "all";
  const label = `wai index: ${topic}${args.update ? " (update)" : ""}`;
  const text = getTextComponent(context);
  text.setText(theme.fg("accent", label));
  return text;
}

/** Render a call to the wai_explain tool. */
export function renderExplainCall(args: { target?: string }, theme: Theme, context?: ToolRenderContext): Text {
  const target = typeof args.target === "string" ? args.target : "";
  const label = `wai explain: ${truncate(target, 80) || "…"}`;
  const text = getTextComponent(context);
  text.setText(theme.fg("accent", label));
  return text;
}

/** Render a call to the wai_learn tool (record or verify). */
export function renderLearnCall(
  args: { fact?: string; verify?: boolean; deep?: boolean; query?: string },
  theme: Theme,
  context?: ToolRenderContext,
): Text {
  let label: string;
  if (args.verify) {
    const query = typeof args.query === "string" && args.query ? truncate(args.query, 60) : "";
    label = `wai learn verify${args.deep ? " (deep)" : ""}${query ? `: ${query}` : ""}`;
  } else {
    label = `wai learn: ${truncate(typeof args.fact === "string" ? args.fact : "", 80) || "…"}`;
  }
  const text = getTextComponent(context);
  text.setText(theme.fg("accent", label));
  return text;
}

/** Render a call to the wai_design_ref tool. */
export function renderDesignRefCall(
  args: { topic?: string; doc?: string },
  theme: Theme,
  context?: ToolRenderContext,
): Text {
  const topic = typeof args.topic === "string" && args.topic ? args.topic : "topics";
  const doc = typeof args.doc === "string" && args.doc ? ` ${args.doc}` : "";
  const text = getTextComponent(context);
  text.setText(theme.fg("accent", `wai design-ref: ${topic}${doc}`));
  return text;
}

export function renderResult(
  result: AgentToolResult<WaiToolResult>,
  opts: ToolRenderResultOptions,
  theme: Theme,
  context?: ToolRenderContext,
): Text {
  const { result: r } = resolveToolResult(result);
  const text = getTextComponent(context);

  if (!r || r.error) {
    const message = r?.error ? `wai error: ${r.error}` : "wai error";
    text.setText(theme.fg("error", message));
    return text;
  }

  if (r.inProgress || opts.isPartial) {
    const stage = typeof r.stage === "number" && typeof r.total === "number" ? `[${r.stage}/${r.total}] ` : "";
    const message = r.progressMessage || "wai is thinking…";
    text.setText(
      theme.fg("dim", `wai ${r.action ? r.action + " " : ""}${r.level ? `(${r.level}) ` : ""}${stage}${message}`),
    );
    return text;
  }

  const lines: string[] = [];
  const costLine = formatCostLine(r);
  if (costLine) {
    lines.push(theme.fg("dim", costLine));
  }

  if (r.plan) {
    lines.push(theme.fg("accent", `wai plan${modelSuffix(r.model)}`));
    lines.push(`  ${r.plan.todo.length} step(s) planned`);
    lines.push(`  ${theme.fg("dim", r.plan.summary)}`);
  }

  if (r.review) {
    const icon = r.review.verdict === "pass" ? "✓" : r.review.verdict === "blocked" ? "✗" : "⚠";
    const color = r.review.verdict === "pass" ? "green" : r.review.verdict === "blocked" ? "error" : "yellow";
    lines.push(
      theme.fg(color, `wai review${r.level ? ` (${r.level})` : ""} ${icon} ${r.review.verdict}${modelSuffix(r.model)}`),
    );

    if (r.review.contextLimited || r.review.truncated || (r.review.droppedFiles && r.review.droppedFiles.length > 0)) {
      const warnings: string[] = [];
      if (r.review.truncated) warnings.push("diff truncated");
      if (r.review.droppedFiles && r.review.droppedFiles.length > 0)
        warnings.push(`${r.review.droppedFiles.length} file(s) omitted`);
      if (r.review.contextLimited) warnings.push("context limited");
      lines.push(`  ${theme.fg("yellow", `⚠ large change: ${warnings.join(" · ")}`)}`);
    }

    if (r.review.issues.length > 0) {
      lines.push(`  ${theme.fg("dim", `${r.review.issues.length} issue(s) found:`)}`);
      for (const issue of r.review.issues.slice(0, 10)) {
        const color = severityColor(issue.severity);
        const loc = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "unknown";
        lines.push(`    ${theme.fg(color, `${severityIcon(issue.severity)} ${loc}`)}: ${truncate(issue.issue, 70)}`);
      }
      if (r.review.issues.length > 10) {
        lines.push(`    ${theme.fg("dim", `… and ${r.review.issues.length - 10} more`)}`);
      }
    }

    if (r.review.consensus) {
      lines.push(`  ${theme.fg("green", "consensus: both agents agree")}`);
      if (r.review.planProgress) lines.push(`  ${theme.fg("dim", r.review.planProgress)}`);
      if (r.review.nextStep) lines.push(`  ${theme.fg("bold", `next: ${r.review.nextStep}`)}`);
      if (r.review.autoJudged) {
        lines.push(`  ${theme.fg("green", "auto-judge: final review passed")}`);
      }
    }

    if (r.review.escalated) {
      lines.push(`  ${theme.fg("error", "escalated: 3+ review failures")}`);
    }
  }

  if (r.suggest) {
    lines.push(theme.fg("accent", `wai suggest${modelSuffix(r.model)}`));
    for (const a of r.suggest.approaches) {
      lines.push(`  • ${theme.fg("bold", a.title)}`);
    }
  }

  if (r.recommend) {
    lines.push(theme.fg("accent", `wai recommend${modelSuffix(r.model)}`));
    lines.push(`  → ${r.recommend.nextStep}`);
  }

  if (r.test) {
    const icon = r.test.verdict === "pass" ? "✓" : r.test.verdict === "blocked" ? "✗" : "⚠";
    const color = r.test.verdict === "pass" ? "green" : r.test.verdict === "blocked" ? "error" : "yellow";
    lines.push(theme.fg(color, `wai test ${icon} ${r.test.verdict}${modelSuffix(r.model)}`));
    if (r.test.missingTests.length > 0) {
      lines.push(`  ${theme.fg("dim", `${r.test.missingTests.length} missing test(s)`)}`);
    }
    if (r.test.findings.length > 0) {
      lines.push(`  ${theme.fg("dim", `${r.test.findings.length} finding(s)`)}`);
    }
  }

  if (r.security) {
    const icon = r.security.verdict === "pass" ? "✓" : "⚠";
    const color = r.security.verdict === "pass" ? "green" : "error";
    lines.push(theme.fg(color, `wai security ${icon} ${r.security.verdict}${modelSuffix(r.model)}`));
    if (r.security.findings.length > 0) {
      lines.push(`  ${theme.fg("dim", `${r.security.findings.length} security finding(s)`)}`);
    }
  }

  if (r.judge) {
    const icon = r.judge.verdict === "pass" ? "✓" : r.judge.verdict === "blocked" ? "✗" : "⚠";
    const color = r.judge.verdict === "pass" ? "green" : r.judge.verdict === "blocked" ? "error" : "yellow";
    lines.push(theme.fg(color, `wai judge ${icon} ${r.judge.verdict}${modelSuffix(r.model)}`));

    if (r.judge.contextLimited || r.judge.truncated || (r.judge.droppedFiles && r.judge.droppedFiles.length > 0)) {
      const warnings: string[] = [];
      if (r.judge.truncated) warnings.push("diff truncated");
      if (r.judge.droppedFiles && r.judge.droppedFiles.length > 0)
        warnings.push(`${r.judge.droppedFiles.length} file(s) omitted`);
      if (r.judge.contextLimited) warnings.push("context limited");
      lines.push(`  ${theme.fg("yellow", `⚠ large change: ${warnings.join(" · ")}`)}`);
    }

    lines.push(`  ${theme.fg("dim", r.judge.summary)}`);
    if (r.judge.issues.length > 0) {
      lines.push(`  ${theme.fg("dim", `${r.judge.issues.length} remaining issue(s)`)}`);
    }
    if (r.judge.consensus) {
      lines.push(`  ${theme.fg("green", "consensus: both agents agree — work is complete")}`);
    }
  }

  if (r.scan) {
    lines.push(theme.fg("accent", `wai scan${modelSuffix(r.model)}`));
    lines.push(`  ${r.scan.files.length} file(s) scanned`);
    lines.push(`  ${theme.fg("dim", `${r.scan.conventions.stack} • ${r.scan.conventions.naming}`)}`);
  }

  text.setText(lines.filter(Boolean).join("\n"));
  return text;
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + "...";
}

/** Render the result of an auxiliary tool (wai_index / wai_explain / wai_learn):
 *  error line, in-progress line, then title + cost + a preview of the returned
 *  text content. The row name is the registered tool name, so learn shows
 *  "wai learn" even when the progress reporter ran under the explain action. */
export function renderAuxResult(
  name: "index" | "explain" | "learn" | "design-ref",
  result: AgentToolResult<unknown>,
  opts: ToolRenderResultOptions,
  theme: Theme,
  context?: ToolRenderContext,
): Text {
  const details = (result.details ?? {}) as Record<string, unknown> & ProgressDetails;
  const text = getTextComponent(context);

  if (details.error) {
    text.setText(theme.fg("error", `wai ${name} error: ${String(details.error)}`));
    return text;
  }

  if (details.inProgress || opts.isPartial) {
    const stage =
      typeof details.stage === "number" && typeof details.total === "number"
        ? `[${details.stage}/${details.total}] `
        : "";
    const message = typeof details.progressMessage === "string" ? details.progressMessage : "is thinking…";
    text.setText(theme.fg("dim", `wai ${name} ${stage}${message}`));
    return text;
  }

  const lines: string[] = [];
  const costLine = formatCostText(details.cost as UsageCost | undefined);
  if (costLine) lines.push(theme.fg("dim", costLine));

  if (name === "index") {
    const topic = typeof details.topic === "string" ? details.topic : "all";
    lines.push(theme.fg("accent", `wai index: ${topic}${details.indexUpdated ? " (updated)" : ""}`));
  } else if (name === "explain") {
    lines.push(theme.fg("accent", `wai explain${modelSuffix(details.model as StageProfile | undefined)}`));
  } else if (name === "design-ref") {
    const topic = typeof details.topic === "string" ? details.topic : "topics";
    lines.push(theme.fg("accent", `wai design-ref: ${topic}`));
  } else if (Array.isArray(details.verify)) {
    lines.push(theme.fg("green", `wai learn verify ✓ · ${details.verify.length} fact(s)`));
  } else if (Array.isArray(details.learned)) {
    lines.push(theme.fg("green", "wai learn ✓ recorded"));
  } else {
    lines.push(theme.fg("green", "wai learn ✓"));
  }

  const block = result.content?.find((c) => c.type === "text");
  if (block && typeof block.text === "string" && block.text.length > 0) {
    const contentLines = block.text.split("\n").filter((l) => l.trim().length > 0);
    const preview = contentLines.slice(0, 8).map((l) => theme.fg("dim", `  ${l}`));
    if (contentLines.length > 8) {
      preview.push(`  ${theme.fg("dim", `… and ${contentLines.length - 8} more line(s)`)}`);
    }
    lines.push(...preview);
  }

  text.setText(lines.filter(Boolean).join("\n"));
  return text;
}
