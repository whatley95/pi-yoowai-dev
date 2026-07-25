import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseReviewCommandArgs, parseTestCommandArgs, parseSecurityCommandArgs } from "./commands/arg-parsers.js";
import { executeWaiReview } from "./actions/review.js";
import { executeWaiSecurity } from "./actions/security.js";
import { executeWaiTest } from "./actions/test.js";
import { formatResultText, formatDuration } from "./format.js";
import { formatCost } from "./cost-tracker.js";
import type { ProgressReporter } from "./progress.js";
import type { WaiToolResult } from "./types.js";

export interface AuditSection {
  name: "review" | "security" | "test";
  result?: WaiToolResult;
  error?: string;
}

/** Run the review, security, and test action executors concurrently over the
 *  same working-tree diff. A throwing executor does not fail the others — its
 *  section is returned with `error` set instead. */
export async function executeWaiAudit(
  cwd: string,
  input: string,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
): Promise<AuditSection[]> {
  const { description, options } = parseReviewCommandArgs(input);
  const testArgs = parseTestCommandArgs(input);
  const securityArgs = parseSecurityCommandArgs(input);

  const run = async (name: AuditSection["name"], fn: () => Promise<WaiToolResult>): Promise<AuditSection> => {
    try {
      return { name, result: await fn() };
    } catch (err) {
      return { name, error: err instanceof Error ? err.message : String(err) };
    }
  };

  return Promise.all([
    run("review", () => executeWaiReview(cwd, description, ctx, options, signal, progress)),
    run("security", () =>
      executeWaiSecurity(
        cwd,
        securityArgs.description || "security audit",
        ctx,
        securityArgs.options,
        signal,
        progress,
      ),
    ),
    run("test", () =>
      executeWaiTest(
        cwd,
        testArgs.description || "review test coverage",
        ctx,
        { ...testArgs.options, command: testArgs.command },
        signal,
        progress,
      ),
    ),
  ]);
}

export function formatAuditReport(sections: AuditSection[], elapsedMs?: number): string {
  const lines: string[] = ["## wai audit — review + security + test", ""];

  const totalCost = sections.reduce((sum, s) => sum + (s.result?.cost?.estimatedCostUsd ?? 0), 0);
  const metaParts: string[] = [];
  if (totalCost > 0) metaParts.push(formatCost(totalCost));
  if (elapsedMs != null) metaParts.push(`took ${formatDuration(elapsedMs)}`);
  if (metaParts.length > 0) {
    lines.push(`_${metaParts.join(" · ")}_`);
    lines.push("");
  }

  for (const section of sections) {
    const error = section.error ?? section.result?.error;
    if (error) {
      lines.push(`## wai ${section.name} ✗ failed`);
      lines.push("");
      lines.push(`wai error: ${error}`);
    } else if (section.result) {
      lines.push(formatResultText(section.result));
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
