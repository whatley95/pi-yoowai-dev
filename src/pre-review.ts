import { execSync } from "node:child_process";

export interface PreReviewOutput {
  command: string;
  output: string;
  exitCode: number;
}

export function runPreReviewCommands(cwd: string, commands: string[]): PreReviewOutput[] {
  const results: PreReviewOutput[] = [];
  for (const command of commands) {
    try {
      const output = execSync(command, {
        cwd,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeout: 60000,
      });
      results.push({ command, output: output.slice(0, 4000), exitCode: 0 });
    } catch (err) {
      const output = err instanceof Error && "stdout" in err && typeof (err as { stdout?: unknown }).stdout === "string"
        ? (err as { stdout: string }).stdout
        : "";
      const stderr = err instanceof Error && "stderr" in err && typeof (err as { stderr?: unknown }).stderr === "string"
        ? (err as { stderr: string }).stderr
        : "";
      const status = err instanceof Error && "status" in err && typeof (err as { status?: number }).status === "number"
        ? (err as { status: number }).status
        : 1;
      results.push({ command, output: (output + "\n" + stderr).slice(0, 4000), exitCode: status });
    }
  }
  return results;
}

export function formatPreReviewOutput(results: PreReviewOutput[]): string {
  if (results.length === 0) return "";
  const lines = ["Pre-review command output:"];
  for (const r of results) {
    lines.push(`\n$ ${r.command} (exit ${r.exitCode})`);
    lines.push(r.output || "(no output)");
  }
  return lines.join("\n");
}
