import { formatTokenCount } from "./actions/shared.js";
import { formatCost } from "./cost-tracker.js";
import { formatConventions } from "./conventions.js";
import { planStepDescription, isPlanStep } from "./types.js";
import type { StageProfile, YooToolResult } from "./types.js";

export function issueEmoji(severity: "high" | "medium" | "low"): string {
  switch (severity) {
    case "high":
      return "🔴";
    case "medium":
      return "🟡";
    default:
      return "💡";
  }
}

export function formatModelSuffix(model?: StageProfile): string {
  if (!model?.provider || !model.id) return "";
  const thinking = model.thinking && model.thinking.toLowerCase() !== "off" ? ` (${model.thinking})` : "";
  const backend = model.backend ? ` [${model.backend}]` : "";
  return ` · ${model.provider}:${model.id}${thinking}${backend}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatResultText(result: YooToolResult): string {
  if (result.error) return `yoo error: ${result.error}`;

  const lines: string[] = [];

  const metaParts: string[] = [];
  if (result.cost) {
    const inTokens = formatTokenCount(result.cost.estimatedInputTokens);
    const outTokens = formatTokenCount(result.cost.estimatedOutputTokens);
    const cost = formatCost(result.cost.estimatedCostUsd);
    const session = formatCost(result.cost.sessionCostUsd);
    metaParts.push(`${inTokens} in · ${outTokens} out · ${cost} (session ${session})`);
  }
  if (result.elapsedMs != null) {
    metaParts.push(`took ${formatDuration(result.elapsedMs)}`);
  }
  if (metaParts.length > 0) {
    lines.push(`_${metaParts.join(" · ")}_`);
    lines.push("");
  }

  if (result.plan) {
    lines.push(`## yoo plan${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(`**Summary:** ${result.plan.summary}`);
    lines.push("");
    lines.push("### Todo");
    for (let i = 0; i < result.plan.todo.length; i++) {
      const step = result.plan.todo[i];
      const desc = planStepDescription(step);
      const badges: string[] = [];
      if (isPlanStep(step)) {
        if (step.priority) {
          const icon = step.priority === "high" ? "🔴" : step.priority === "medium" ? "🟡" : "🟢";
          badges.push(`${icon} ${step.priority}`);
        }
        if (step.dependsOn && step.dependsOn.length > 0) {
          badges.push(`depends on ${step.dependsOn.map((n) => `#${n}`).join(", ")}`);
        }
      }
      lines.push(`${i + 1}. ${desc}${badges.length > 0 ? ` (${badges.join(" · ")})` : ""}`);
    }
    lines.push("");
    lines.push("### Acceptance Criteria");
    for (const c of result.plan.acceptanceCriteria) {
      lines.push(`- ${c}`);
    }
  }

  if (result.review) {
    const icon = result.review.verdict === "pass" ? "✓" : result.review.verdict === "blocked" ? "✗" : "⚠";
    lines.push(`## yoo review ${icon} ${result.review.verdict}${formatModelSuffix(result.model)}`);
    lines.push("");

    if (
      result.review.contextLimited ||
      result.review.truncated ||
      (result.review.droppedFiles && result.review.droppedFiles.length > 0)
    ) {
      const warnings: string[] = [];
      if (result.review.truncated) warnings.push("diff truncated");
      if (result.review.droppedFiles && result.review.droppedFiles.length > 0)
        warnings.push(`${result.review.droppedFiles.length} file(s) omitted from context`);
      if (result.review.contextLimited) warnings.push("context limited");
      lines.push(`⚠️ **Large change:** ${warnings.join(" · ")}`);
      lines.push("Some context was omitted; verify any surprising findings against the actual files before acting.");
      lines.push("");
    }

    if (result.review.planStale) {
      lines.push(
        "⚠️ **Plan stale:** The current plan step contradicts the actual code. The code is trusted; consider updating the plan with `/yoo plan ...` or `/yoo-clear` and re-planning.",
      );
      lines.push("");
    }

    if (result.review.issues.length > 0) {
      lines.push("### Issues");
      for (const issue of result.review.issues) {
        const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "unknown";
        lines.push(`- ${issueEmoji(issue.severity)} **${issue.severity}** ${loc}: ${issue.issue}`);
        if (issue.suggestion) lines.push(`  → ${issue.suggestion}`);
      }
      lines.push("");

      if (result.review.verdict !== "pass") {
        lines.push("### Fix plan");
        for (let i = 0; i < result.review.issues.length; i++) {
          const issue = result.review.issues[i];
          const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "unknown";
          lines.push(
            `${i + 1}. ${issueEmoji(issue.severity)} **${issue.severity}** ${loc}: ${issue.suggestion || issue.issue}`,
          );
        }
        lines.push("");
      }
    }

    if (result.review.suggestions.length > 0) {
      lines.push("### Suggestions");
      for (const s of result.review.suggestions) {
        lines.push(`- 💡 ${s}`);
      }
      lines.push("");
    }

    if (result.review.consensus) {
      lines.push("**Consensus:** Both agents agree — step is complete.");
      if (result.review.planProgress) {
        lines.push(`**Progress:** ${result.review.planProgress}`);
      }
      if (result.review.nextStep) {
        lines.push(`**Next step:** ${result.review.nextStep}`);
      }
      if (result.review.autoJudged) {
        lines.push("**Auto-judge:** Last step done — final review was run automatically.");
      }
    } else if (result.review.verdict === "needs-work" || result.review.verdict === "blocked") {
      lines.push("**Action:** Fix the issues above and call `yoo.review` again.");
      if (result.review.escalated) {
        lines.push(
          "⚠️ **Escalation:** This step has failed review 3+ times. Consider asking the user for guidance or a different approach.",
        );
      }
    }
  }

  if (result.suggest) {
    lines.push(`## yoo suggest${formatModelSuffix(result.model)}`);
    lines.push("");
    for (const a of result.suggest.approaches) {
      lines.push(`### ${a.title}`);
      lines.push(a.description);
      lines.push("");
      if (a.pros.length > 0) {
        lines.push("**Pros:**");
        for (const p of a.pros) lines.push(`- ${p}`);
        lines.push("");
      }
      if (a.cons.length > 0) {
        lines.push("**Cons:**");
        for (const c of a.cons) lines.push(`- ${c}`);
        lines.push("");
      }
    }
  }

  if (result.recommend) {
    lines.push(`## yoo recommend${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(`**Next step:** ${result.recommend.nextStep}`);
    lines.push("");
    lines.push(`**Reasoning:** ${result.recommend.reasoning}`);
    if (result.recommend.alternatives.length > 0) {
      lines.push("");
      lines.push("**Alternatives considered:**");
      for (const a of result.recommend.alternatives) {
        lines.push(`- ${a}`);
      }
    }
  }

  if (result.test) {
    const icon = result.test.verdict === "pass" ? "✓" : result.test.verdict === "blocked" ? "✗" : "⚠";
    lines.push(`## yoo test ${icon} ${result.test.verdict}${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(result.test.summary);
    lines.push("");

    if (result.test.missingTests.length > 0) {
      lines.push("### Missing tests");
      for (const item of result.test.missingTests) {
        const loc = item.file ? `\`${item.file}\`` : "general";
        lines.push(`- ${loc}: ${item.reason}`);
      }
      lines.push("");
    }

    if (result.test.findings.length > 0) {
      lines.push("### Findings");
      for (const finding of result.test.findings) {
        const loc = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "unknown";
        const category = finding.category ? ` · ${finding.category}` : "";
        lines.push(`- ${issueEmoji(finding.severity)} **${finding.severity}**${category} ${loc}: ${finding.issue}`);
        if (finding.suggestion) lines.push(`  → ${finding.suggestion}`);
      }
      lines.push("");
    }

    if (result.test.verdict === "pass" && result.test.findings.length === 0 && result.test.missingTests.length === 0) {
      lines.push("**Tests look good.**");
    }
  }

  if (result.security) {
    const icon = result.security.verdict === "pass" ? "✓" : "⚠";
    lines.push(`## yoo security ${icon} ${result.security.verdict}${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(result.security.summary);
    lines.push("");

    if (result.security.findings.length > 0) {
      lines.push("### Findings");
      for (const finding of result.security.findings) {
        const loc = finding.file ? `\`${finding.file}${finding.line ? `:${finding.line}` : ""}\`` : "unknown";
        const emoji =
          finding.severity === "critical"
            ? "🔴"
            : finding.severity === "high"
              ? "🟠"
              : finding.severity === "medium"
                ? "🟡"
                : "💡";
        lines.push(`- ${emoji} **${finding.severity}** · ${finding.category} ${loc}: ${finding.issue}`);
        if (finding.suggestion) lines.push(`  → ${finding.suggestion}`);
      }
      lines.push("");
    }

    if (result.security.verdict === "pass") {
      lines.push("**No significant security issues found.**");
    }
  }

  if (result.judge) {
    const icon = result.judge.verdict === "pass" ? "✓" : result.judge.verdict === "blocked" ? "✗" : "⚠";
    lines.push(`## yoo judge ${icon} ${result.judge.verdict}${formatModelSuffix(result.model)}`);
    lines.push("");

    if (
      result.judge.contextLimited ||
      result.judge.truncated ||
      (result.judge.droppedFiles && result.judge.droppedFiles.length > 0)
    ) {
      const warnings: string[] = [];
      if (result.judge.truncated) warnings.push("diff truncated");
      if (result.judge.droppedFiles && result.judge.droppedFiles.length > 0)
        warnings.push(`${result.judge.droppedFiles.length} file(s) omitted from context`);
      if (result.judge.contextLimited) warnings.push("context limited");
      lines.push(`⚠️ **Large change:** ${warnings.join(" · ")}`);
      lines.push("Some context was omitted; verify any surprising findings against the actual files before acting.");
      lines.push("");
    }

    if (result.judge.planStale) {
      lines.push(
        "⚠️ **Plan stale:** The original plan contradicts the final code. The code is trusted; consider updating the plan with `/yoo plan ...` or `/yoo-clear` and re-planning.",
      );
      lines.push("");
    }

    lines.push(result.judge.summary);
    lines.push("");

    if (result.judge.issues.length > 0) {
      lines.push("### Remaining Issues");
      for (const issue of result.judge.issues) {
        const loc = issue.file ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`` : "unknown";
        lines.push(`- ${issueEmoji(issue.severity)} **${issue.severity}** ${loc}: ${issue.issue}`);
      }
      lines.push("");
    }

    if (result.judge.consensus) {
      lines.push("**Consensus:** Both agents agree — all work is complete and meets criteria.");
    }
    lines.push(
      "**Workflow tip:** If this change completed multiple plan steps, mark them done with `/yoo-done` so the tracker stays in sync for the next review/judge.",
    );
  }

  if (result.done) {
    const header = result.action === "planUpdate" ? "yoo plan update" : "yoo done";
    lines.push(`## ${header}${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(result.done.message);
    lines.push(`**Progress:** ${result.done.completedStep}/${result.done.totalSteps} steps completed.`);
    if (result.done.nextStep) {
      lines.push(`**Next step:** ${result.done.nextStep}`);
    }
    if (result.done.allDone) {
      lines.push("All steps are complete. Run `/yoo judge` for a final review.");
    }
    lines.push("");
  }

  if (result.scan) {
    lines.push(`## yoo scan${formatModelSuffix(result.model)}`);
    lines.push("");
    lines.push(formatConventions(result.scan.conventions));
    lines.push("");
    lines.push(`Scanned ${result.scan.files.length} files.`);
  }

  if (result.verificationRequested) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push("### Main agent verification required");
    lines.push("");
    lines.push(
      "The user (or `verifyByDefault`) asked for explicit confirmation. Do **not** implement, edit, or merge anything based on this yoo result until you complete the verification below.",
    );
    lines.push("");
    lines.push("Reply with:");
    lines.push("- **Agreement:** `AGREE` / `DISAGREE` / `UNSURE`");
    lines.push(
      "- **Reasoning:** Why does or doesn't this finding make sense? Reference the relevant code, diff, plan step, or convention.",
    );
    lines.push(
      "- **Evidence:** Cite specific files, line numbers, test output, or facts from the context that support your position. Do not cite evidence you cannot see.",
    );
    lines.push("");
    lines.push(
      "If you DISAGREE or are UNSURE, explain the contradiction and ask the user for clarification rather than proceeding.",
    );
  }

  return lines.join("\n");
}
