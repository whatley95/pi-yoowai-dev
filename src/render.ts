import type { YooToolParams, YooToolResult } from "./types.js";

interface Theme {
  fg(token: string, text: string): string;
  bg(token: string, text: string): string;
}

export function renderCall(params: unknown, theme: Theme): string {
  const p = params as YooToolParams;
  if (p.plan) return theme.fg("yoo", `yoo plan: ${truncate(String(p.plan), 80)}`);
  if (p.review) return theme.fg("yoo", `yoo review: ${truncate(String(p.review), 80)}`);
  if (p.suggest) return theme.fg("yoo", `yoo suggest: ${truncate(String(p.suggest), 80)}`);
  if (p.recommend) return theme.fg("yoo", `yoo recommend: ${truncate(String(p.recommend), 80)}`);
  if (p.judge) return theme.fg("yoo", `yoo judge: ${truncate(String(p.judge), 80)}`);
  return theme.fg("yoo", "yoo");
}

export function renderResult(result: unknown, _opts: { expanded: boolean }, theme: Theme): string {
  const r = result as YooToolResult;
  if (r.error) return theme.fg("error", `yoo error: ${r.error}`);

  const lines: string[] = [];

  if (r.plan) {
    lines.push(theme.fg("yoo", "yoo plan"));
    lines.push(`  ${r.plan.todo.length} step(s) planned`);
    lines.push(`  ${theme.fg("dim", r.plan.summary)}`);
  }

  if (r.review) {
    const icon = r.review.verdict === "pass" ? "✓" : r.review.verdict === "blocked" ? "✗" : "⚠";
    const color = r.review.verdict === "pass" ? "green" : r.review.verdict === "blocked" ? "error" : "yellow";
    lines.push(theme.fg(color, `yoo review ${icon} ${r.review.verdict}`));
    if (r.review.issues.length > 0) {
      lines.push(`  ${theme.fg("dim", `${r.review.issues.length} issue(s) found`)}`);
    }
    if (r.review.consensus) {
      lines.push(`  ${theme.fg("green", "consensus: both agents agree")}`);
      if (r.review.planProgress) lines.push(`  ${theme.fg("dim", r.review.planProgress)}`);
      if (r.review.nextStep) lines.push(`  ${theme.fg("bold", `next: ${r.review.nextStep}`)}`);
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
    if (r.judge.consensus) {
      lines.push(`  ${theme.fg("green", "consensus: both agents agree — work is complete")}`);
    }
  }

  if (r.scan) {
    lines.push(theme.fg("yoo", "yoo scan"));
    lines.push(`  ${r.scan.files.length} file(s) scanned`);
    lines.push(`  ${theme.fg("dim", `${r.scan.conventions.stack} • ${r.scan.conventions.naming}`)}`);
  }

  return lines.join("\n");
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + "...";
}