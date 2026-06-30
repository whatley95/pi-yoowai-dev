import { Text } from "@earendil-works/pi-tui";
import type { YooToolParams, YooToolResult, ReviewIssue } from "./types.js";

interface Theme {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
}

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

function resolveToolResult(result: unknown): {
  result: (YooToolResult & ProgressDetails) | undefined;
  isError: boolean;
} {
  if (!result || typeof result !== "object") {
    return { result: undefined, isError: true };
  }
  const candidate = result as Record<string, unknown>;
  if ("details" in candidate) {
    return {
      result: (candidate.details as (YooToolResult & ProgressDetails) | undefined) ?? undefined,
      isError: Boolean(candidate.isError),
    };
  }
  return { result: result as YooToolResult & ProgressDetails, isError: false };
}

function formatCostLine(result: YooToolResult): string | undefined {
  if (!result.cost) return undefined;
  const inTokens = formatTokenCount(result.cost.estimatedInputTokens);
  const outTokens = formatTokenCount(result.cost.estimatedOutputTokens);
  const cost = formatUsd(result.cost.estimatedCostUsd);
  return `${inTokens} in · ${outTokens} out · ${cost}`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function formatUsd(usd: number): string {
  if (usd < 0.001) return `${(usd * 1000).toFixed(2)}¢`;
  return `$${usd.toFixed(4)}`;
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

export function renderCall(params: unknown, theme: Theme, context?: ToolRenderContext): Text {
  const p = params as YooToolParams;
  let label: string;
  if (p.plan) label = `yoo plan: ${truncate(String(p.plan), 80)}`;
  else if (p.review) label = `yoo review: ${truncate(String(p.review), 80)}`;
  else if (p.suggest) label = `yoo suggest: ${truncate(String(p.suggest), 80)}`;
  else if (p.recommend) label = `yoo recommend: ${truncate(String(p.recommend), 80)}`;
  else if (p.judge) label = `yoo judge: ${truncate(String(p.judge), 80)}`;
  else if (p.scan) label = "yoo scan";
  else label = "yoo";

  const text = getTextComponent(context);
  text.setText(theme.fg("yoo", label));
  return text;
}

export function renderResult(
  result: unknown,
  opts: { expanded: boolean; isPartial?: boolean },
  theme: Theme,
  context?: ToolRenderContext,
): Text {
  const { result: r, isError } = resolveToolResult(result);
  const text = getTextComponent(context);

  if (!r || r.error || isError) {
    const message = r?.error ? `yoo error: ${r.error}` : "yoo error";
    text.setText(theme.fg("error", message));
    return text;
  }

  if (r.inProgress || opts.isPartial) {
    const stage = typeof r.stage === "number" && typeof r.total === "number" ? `[${r.stage}/${r.total}] ` : "";
    const message = r.progressMessage || "yoo is thinking…";
    text.setText(theme.fg("dim", `yoo ${r.action ? r.action + " " : ""}${stage}${message}`));
    return text;
  }

  const lines: string[] = [];
  const costLine = formatCostLine(r);
  if (costLine) {
    lines.push(theme.fg("dim", costLine));
  }

  if (r.plan) {
    lines.push(theme.fg("yoo", "yoo plan"));
    lines.push(`  ${r.plan.todo.length} step(s) planned`);
    lines.push(`  ${theme.fg("dim", r.plan.summary)}`);
  }

  if (r.review) {
    const icon = r.review.verdict === "pass" ? "✓" : r.review.verdict === "blocked" ? "✗" : "⚠";
    const color = r.review.verdict === "pass" ? "green" : r.review.verdict === "blocked" ? "error" : "yellow";
    lines.push(theme.fg(color, `yoo review ${icon} ${r.review.verdict}`));

    if (r.review.truncated || (r.review.droppedFiles && r.review.droppedFiles.length > 0)) {
      const warnings: string[] = [];
      if (r.review.truncated) warnings.push("diff truncated");
      if (r.review.droppedFiles && r.review.droppedFiles.length > 0)
        warnings.push(`${r.review.droppedFiles.length} file(s) omitted`);
      lines.push(`  ${theme.fg("yellow", `⚠ large change: ${warnings.join(" · ")}`)}`);
    }

    if (r.review.issues.length > 0) {
      lines.push(`  ${theme.fg("dim", `${r.review.issues.length} issue(s) found:`)}`);
      for (const issue of r.review.issues.slice(0, 5)) {
        const color = severityColor(issue.severity);
        const loc = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "unknown";
        lines.push(`    ${theme.fg(color, `${severityIcon(issue.severity)} ${loc}`)}: ${truncate(issue.issue, 70)}`);
      }
      if (r.review.issues.length > 5) {
        lines.push(`    ${theme.fg("dim", `… and ${r.review.issues.length - 5} more`)}`);
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
    lines.push(theme.fg("yoo", "yoo suggest"));
    for (const a of r.suggest.approaches) {
      lines.push(`  • ${theme.fg("bold", a.title)}`);
    }
  }

  if (r.recommend) {
    lines.push(theme.fg("yoo", "yoo recommend"));
    lines.push(`  → ${r.recommend.nextStep}`);
  }

  if (r.judge) {
    const icon = r.judge.verdict === "pass" ? "✓" : r.judge.verdict === "blocked" ? "✗" : "⚠";
    const color = r.judge.verdict === "pass" ? "green" : r.judge.verdict === "blocked" ? "error" : "yellow";
    lines.push(theme.fg(color, `yoo judge ${icon} ${r.judge.verdict}`));
    lines.push(`  ${theme.fg("dim", r.judge.summary)}`);
    if (r.judge.issues.length > 0) {
      lines.push(`  ${theme.fg("dim", `${r.judge.issues.length} remaining issue(s)`)}`);
    }
    if (r.judge.consensus) {
      lines.push(`  ${theme.fg("green", "consensus: both agents agree — work is complete")}`);
    }
  }

  if (r.scan) {
    lines.push(theme.fg("yoo", "yoo scan"));
    lines.push(`  ${r.scan.files.length} file(s) scanned`);
    lines.push(`  ${theme.fg("dim", `${r.scan.conventions.stack} • ${r.scan.conventions.naming}`)}`);
  }

  text.setText(lines.filter(Boolean).join("\n"));
  return text;
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + "...";
}
