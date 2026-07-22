import { Text } from "@earendil-works/pi-tui";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { formatCost } from "./cost-tracker.js";
import type { WaiToolParams, WaiToolResult, ReviewIssue, StageProfile } from "./types.js";

/** Local theme interface compatible with the real Pi Theme shape. */
interface Theme {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
}

/** Local render context compatible with the real ToolRenderContext shape. */
interface ToolRenderContext {
  lastComponent?: unknown;
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

function formatCostLine(result: WaiToolResult): string | undefined {
  if (!result.cost) return undefined;
  const inTokens = formatTokenCount(result.cost.estimatedInputTokens);
  const outTokens = formatTokenCount(result.cost.estimatedOutputTokens);
  const cost = formatCost(result.cost.estimatedCostUsd);
  return `${inTokens} in · ${outTokens} out · ${cost}`;
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

export function renderCall(args: WaiToolParams, theme: Theme, context?: ToolRenderContext): Text {
  const p = args;
  let label: string;
  if (p.plan) label = `wai plan: ${truncate(String(p.plan), 80)}`;
  else if (p.review) label = `wai review: ${truncate(String(p.review), 80)}`;
  else if (p.suggest) label = `wai suggest: ${truncate(String(p.suggest), 80)}`;
  else if (p.recommend) label = `wai recommend: ${truncate(String(p.recommend), 80)}`;
  else if (p.judge) label = `wai judge: ${truncate(String(p.judge), 80)}`;
  else if (p.scan) label = "wai scan";
  else if (p.test) label = `wai test: ${truncate(String(p.test), 80)}`;
  else if (p.security) label = `wai security: ${truncate(String(p.security), 80)}`;
  else label = "wai";

  const text = getTextComponent(context);
  text.setText(theme.fg("yoo", label));
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
    text.setText(theme.fg("dim", `wai ${r.action ? r.action + " " : ""}${stage}${message}`));
    return text;
  }

  const lines: string[] = [];
  const costLine = formatCostLine(r);
  if (costLine) {
    lines.push(theme.fg("dim", costLine));
  }

  if (r.plan) {
    lines.push(theme.fg("yoo", `wai plan${modelSuffix(r.model)}`));
    lines.push(`  ${r.plan.todo.length} step(s) planned`);
    lines.push(`  ${theme.fg("dim", r.plan.summary)}`);
  }

  if (r.review) {
    const icon = r.review.verdict === "pass" ? "✓" : r.review.verdict === "blocked" ? "✗" : "⚠";
    const color = r.review.verdict === "pass" ? "green" : r.review.verdict === "blocked" ? "error" : "yellow";
    lines.push(theme.fg(color, `wai review ${icon} ${r.review.verdict}${modelSuffix(r.model)}`));

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
    lines.push(theme.fg("yoo", `wai suggest${modelSuffix(r.model)}`));
    for (const a of r.suggest.approaches) {
      lines.push(`  • ${theme.fg("bold", a.title)}`);
    }
  }

  if (r.recommend) {
    lines.push(theme.fg("yoo", `wai recommend${modelSuffix(r.model)}`));
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
    lines.push(theme.fg("yoo", `wai scan${modelSuffix(r.model)}`));
    lines.push(`  ${r.scan.files.length} file(s) scanned`);
    lines.push(`  ${theme.fg("dim", `${r.scan.conventions.stack} • ${r.scan.conventions.naming}`)}`);
  }

  text.setText(lines.filter(Boolean).join("\n"));
  return text;
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + "...";
}
