import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { logEvent } from "./logger.js";
import { resolveProjectPath } from "./path-security.js";

const SHELL_METACHARACTERS = /[;|&$()`{}[\]<>]/;
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
  "svn",
  "cargo",
  "go",
  "python",
  "python3",
  "pytest",
  "rake",
  "bundle",
  "ruby",
]);

const KNOWN_NPX_PACKAGES = new Set([
  "eslint",
  "prettier",
  "typescript",
  "tsx",
  "vitest",
  "jest",
  "mocha",
  "cypress",
  "playwright",
  "knip",
  "astro",
  "next",
  "svelte",
  "vue-tsc",
  "tsc",
]);

export interface PreReviewOutput {
  command: string;
  output: string;
  exitCode: number;
}

const INTERPRETER_COMMANDS = new Set(["node", "python", "python3", "ruby"]);

export async function runPreReviewCommands(cwd: string, commands: string[]): Promise<PreReviewOutput[]> {
  const results = await Promise.all(
    commands.map(async (command) => {
      try {
        const { program, args } = parseCommand(command);
        if (!ALLOWED_COMMANDS.has(program)) {
          throw new Error(`Pre-review command "${program}" is not in the allowlist`);
        }
        if (INTERPRETER_COMMANDS.has(program)) {
          validateInterpreterArgs(program, args, cwd);
        }
        if (program === "npx") {
          validateNpxArgs(args);
        }
        const output = execProgram(program, args, cwd);
        return { command, output: truncateOutput(output), exitCode: 0 };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent(cwd, "warn", "Pre-review command failed", {
          command,
          error: message,
        });
        const execErr = err as { stdout?: string; stderr?: string; status?: number };
        const output = typeof execErr.stdout === "string" ? execErr.stdout : "";
        const stderr = typeof execErr.stderr === "string" ? execErr.stderr : "";
        const status = typeof execErr.status === "number" ? execErr.status : 1;
        return { command, output: truncateOutput(`${message}\n${output}\n${stderr}`), exitCode: status };
      }
    }),
  );
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

function execProgram(program: string, args: string[], cwd: string): string {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
    timeout: 60000,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
  try {
    return execFileSync(program, args, options);
  } catch (err) {
    if (process.platform !== "win32" || (err as { code?: string }).code !== "ENOENT") {
      throw err;
    }
    // Windows runs npm-style shims (npm, npx, pnpm, tsc, eslint, ...) as .cmd
    // files, which execFileSync cannot launch directly. Fall back to cmd.exe
    // with a conservatively sanitized command line: the allowlist check still
    // applies, and the remaining cmd.exe-sensitive characters (% ^ ") are
    // rejected outright so nothing is reinterpreted by the shell.
    const parts = [program, ...args];
    if (parts.some((part) => /[%^"]/.test(part))) {
      throw new Error(`Pre-review command uses characters not supported on Windows: ${parts.join(" ")}`, {
        cause: err,
      });
    }
    const commandLine = parts.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
    return execFileSync(commandLine, { ...options, shell: true });
  }
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

const FORBIDDEN_INTERPRETER_FLAGS = new Set(["-c", "-e", "--eval", "-exec", "--exec", "-Command", "-EncodedCommand"]);

function validateInterpreterArgs(program: string, args: string[], cwd: string): void {
  for (const arg of args) {
    if (FORBIDDEN_INTERPRETER_FLAGS.has(arg)) {
      throw new Error(`Pre-review ${program} command uses disallowed flag: ${arg}`);
    }
  }

  // For node/ruby/python, the first positional argument must be a safe relative script file.
  const scriptArg = args.find((a) => !a.startsWith("-"));
  if (scriptArg === undefined) {
    throw new Error(`Pre-review ${program} command must specify a relative script file`);
  }
  if (!resolveProjectPath(cwd, scriptArg)) {
    throw new Error(`Pre-review ${program} script path is not allowed: ${scriptArg}`);
  }
}

function validateNpxArgs(args: string[]): void {
  const packageArg = args.find((a) => !a.startsWith("-"));
  if (!packageArg) {
    throw new Error(`Pre-review npx command must specify a package`);
  }
  const packageName = packageArg.split("@")[0];
  if (!KNOWN_NPX_PACKAGES.has(packageName)) {
    throw new Error(`Pre-review npx package "${packageName}" is not in the allowlist`);
  }
}
