import { execFileSync } from "node:child_process";
import { logEvent } from "./logger.js";

const SHELL_METACHARACTERS = /[;|&$()`{}[\]<>\\]/;
const MAX_OUTPUT_CHARS = 4000;

const ALLOWED_COMMANDS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "node",
  "npx",
  "tsc",
  "eslint",
  "prettier",
  "vitest",
  "jest",
  "mocha",
  "cypress",
  "playwright",
  "git",
  "cargo",
  "go",
  "python",
  "python3",
  "pytest",
  "rake",
  "bundle",
  "ruby",
]);

export interface PreReviewOutput {
  command: string;
  output: string;
  exitCode: number;
}

export function runPreReviewCommands(cwd: string, commands: string[]): PreReviewOutput[] {
  const results: PreReviewOutput[] = [];
  for (const command of commands) {
    try {
      const { program, args } = parseCommand(command);
      if (!ALLOWED_COMMANDS.has(program)) {
        throw new Error(`Pre-review command "${program}" is not in the allowlist`);
      }
      const output = execFileSync(program, args, {
        cwd,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeout: 60000,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      results.push({ command, output: truncateOutput(output), exitCode: 0 });
    } catch (err) {
      logEvent(cwd, "warn", "Pre-review command failed", {
        command,
        error: err instanceof Error ? err.message : String(err),
      });
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      const output = typeof execErr.stdout === "string" ? execErr.stdout : "";
      const stderr = typeof execErr.stderr === "string" ? execErr.stderr : "";
      const status = typeof execErr.status === "number" ? execErr.status : 1;
      results.push({ command, output: truncateOutput(`${output}\n${stderr}`), exitCode: status });
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

function parseCommand(command: string): { program: string; args: string[] } {
  const trimmed = command.trim();
  if (SHELL_METACHARACTERS.test(trimmed) || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("Pre-review command contains disallowed shell characters");
  }
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) throw new Error("Empty pre-review command");
  const [program, ...args] = tokens;
  return { program, args };
}

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;
  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  if (inQuote) throw new Error("Unclosed quote in pre-review command");
  return tokens;
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return output.slice(0, MAX_OUTPUT_CHARS) + "\n… (truncated)";
}
