import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { readFileSync } from "node:fs";
import { logEvent } from "./logger.js";
import { resolveProjectPath } from "./path-security.js";
import type { ReviewLevel } from "./types.js";

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

/** Common package.json script names per validation phase, in deterministic
 *  order. The first script found for a phase becomes the command for that
 *  phase; later aliases are only consulted when earlier ones are absent. */
const AUTO_SCRIPT_PHASES: Array<{ phase: "typecheck" | "lint" | "test"; names: string[] }> = [
  { phase: "typecheck", names: ["typecheck", "tsc", "check-types", "check:types"] },
  { phase: "lint", names: ["lint", "eslint", "lint:check"] },
  { phase: "test", names: ["test", "unit", "test:unit"] },
];

/** Which phases a review level auto-runs. min stays a cheap pass (no
 *  commands); med runs static checks; high also runs tests. */
const AUTO_PHASES_BY_LEVEL: Record<ReviewLevel, string[]> = {
  min: [],
  med: ["typecheck", "lint"],
  high: ["typecheck", "lint", "test"],
};

/** Auto-detect deterministic validation commands from the reviewed project's
 *  package.json scripts (e.g. `npm run typecheck` when a typecheck/tsc script
 *  exists). Used only when pi-yoowai.autoPreReviewCommands is enabled; runs
 *  the reviewed project's code, so it requires trusting the repository.
 *  Returns an empty list for min, a missing package.json, or projects with no
 *  recognized scripts. */
export function detectAutoPreReviewCommands(cwd: string, level: ReviewLevel): string[] {
  const phases = AUTO_PHASES_BY_LEVEL[level];
  if (phases.length === 0) return [];

  let scripts: Record<string, string> | undefined;
  try {
    const pkgPath = resolveProjectPath(cwd, "package.json");
    if (!pkgPath) return [];
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    scripts = parsed.scripts;
  } catch {
    return [];
  }
  if (!scripts || typeof scripts !== "object") return [];

  const commands: string[] = [];
  for (const { phase, names } of AUTO_SCRIPT_PHASES) {
    if (!phases.includes(phase)) continue;
    for (const name of names) {
      if (typeof scripts[name] === "string" && scripts[name].trim().length > 0) {
        commands.push(`npm run ${name}`);
        break;
      }
    }
  }
  return commands;
}

const INTERPRETER_COMMANDS = new Set(["node", "python", "python3", "ruby"]);

/** Subcommands that mutate state, destroy work, or reach outward (push/publish).
 *  Enforced only for model-generated commands (toolUseLoop); user-configured
 *  pre-review commands are trusted and keep full access. */
const DENIED_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    "push",
    "reset",
    "clean",
    "revert",
    "checkout",
    "switch",
    "restore",
    "rm",
    "mv",
    "commit",
    "merge",
    "rebase",
    "pull",
    "fetch",
    "am",
    "apply",
    "stash",
    "tag",
    "branch",
    "cherry-pick",
    "update-ref",
    "update-index",
    "config",
    "remote",
    "worktree",
    "submodule",
    "clone",
    "init",
    "gc",
    "prune",
  ]),
  svn: new Set([
    "commit",
    "ci",
    "revert",
    "update",
    "up",
    "merge",
    "switch",
    "delete",
    "remove",
    "del",
    "mkdir",
    "add",
    "copy",
    "cp",
    "move",
    "mv",
    "ren",
    "rename",
    "propset",
    "pset",
    "propdel",
    "pdel",
    "import",
    "checkout",
    "co",
    "lock",
    "unlock",
    "resolve",
    "resolved",
    "patch",
    "relocate",
    "cleanup",
  ]),
  npm: new Set([
    "publish",
    "install",
    "i",
    "add",
    "uninstall",
    "remove",
    "rm",
    "r",
    "update",
    "up",
    "upgrade",
    "link",
    "ln",
    "unlink",
    "exec",
    "init",
    "login",
    "logout",
    "token",
    "owner",
    "team",
    "deprecate",
    "dist-tag",
    "pack",
    "version",
    "ci",
  ]),
  pnpm: new Set([
    "publish",
    "install",
    "i",
    "add",
    "uninstall",
    "remove",
    "rm",
    "update",
    "up",
    "upgrade",
    "link",
    "ln",
    "unlink",
    "init",
    "login",
    "logout",
    "pack",
  ]),
  yarn: new Set([
    "publish",
    "add",
    "remove",
    "rm",
    "upgrade",
    "up",
    "link",
    "unlink",
    "init",
    "login",
    "logout",
    "version",
    "pack",
    "install",
  ]),
  bun: new Set(["publish", "add", "remove", "rm", "update", "link", "ln", "init", "x", "bunx", "install", "i"]),
  cargo: new Set(["publish", "install", "uninstall", "yank", "login", "logout", "owner"]),
  go: new Set(["install", "get", "generate", "mod"]),
};

/** Flags that consume the following argument as a value (so the value is not
 *  mistaken for the subcommand). Keyed per program; "*" applies to all. */
const VALUE_FLAGS: Record<string, Set<string>> = {
  git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]),
  "*": new Set(["--registry", "--prefix", "--cwd"]),
};

function firstSubcommand(program: string, args: string[]): string | undefined {
  const valueFlags = new Set([...(VALUE_FLAGS["*"] ?? []), ...(VALUE_FLAGS[program] ?? [])]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      // `--flag value` form consumes the next arg; `--flag=value` does not.
      if (valueFlags.has(arg) && !arg.includes("=")) i++;
      continue;
    }
    return arg;
  }
  return undefined;
}

function validateSubcommand(program: string, args: string[]): void {
  const denied = DENIED_SUBCOMMANDS[program];
  if (!denied) return;
  const subcommand = firstSubcommand(program, args)?.toLowerCase();
  if (subcommand && denied.has(subcommand)) {
    throw new Error(
      `Command "${program} ${subcommand}" is not allowed for model-generated tool calls: it may mutate state or affect remote systems`,
    );
  }
}

export interface PreReviewOptions {
  /** Restrict subcommands (git/svn/npm/...) to read-only ones. Used for
   *  model-generated commands in the tool loop; user-configured pre-review
   *  commands run unrestricted. */
  restrictSubcommands?: boolean;
}

export async function runPreReviewCommands(
  cwd: string,
  commands: string[],
  options: PreReviewOptions = {},
): Promise<PreReviewOutput[]> {
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
        if (options.restrictSubcommands) {
          validateSubcommand(program, args);
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
  // Keep head (~70%) and tail (~30%): command failures usually matter at the end.
  const headChars = Math.floor(MAX_OUTPUT_CHARS * 0.7);
  const tailChars = MAX_OUTPUT_CHARS - headChars;
  const elided = output.length - headChars - tailChars;
  return `${output.slice(0, headChars)}\n… (${elided} chars elided) …\n${output.slice(-tailChars)}`;
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
